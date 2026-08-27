// api/generate.js
//
// This is Vercel's version of the exact same secure AI proxy as
// netlify/functions/generate.js — same logic, just written in the request/response
// shape Vercel expects instead of Netlify's event-based shape. Both need to exist
// because each hosting platform only recognizes its own convention.
//
// Setup needed (same as the Netlify one, but set separately in Vercel's dashboard):
//   - npm install firebase-admin
//   - Environment variables in Vercel (Project Settings -> Environment Variables):
//     FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, GEMINI_SERVER_KEY
//   - No redirect file needed — Vercel automatically turns anything in /api into a
//     function reachable at /api/<filename>, so /api/generate.js -> /api/generate

const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();
const GEMINI_KEY = process.env.GEMINI_SERVER_KEY;

// Keep these numbers in sync with PLANS near the top of src/App.js, and with
// netlify/functions/generate.js — this is the copy that actually gets enforced here.
const CREDIT_COSTS = { chat: 1, summary: 5, quiz: 8, flashcards: 8, pdf_analysis: 20, transcribe: 15 };
const PLAN_MONTHLY_CREDITS = { free: 60, pro: 400, premium: 1500 };

function monthKey() {
  var d = new Date();
  return d.getFullYear() + "-" + d.getMonth();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  var body = req.body || {};
  var idToken = body.idToken;
  var action = body.action || "chat";
  var contents = body.contents;
  var systemInstruction = body.systemInstruction;
  var maxTokens = body.maxTokens || 800;

  if (!idToken) return res.status(401).json({ error: "Please log in and try again." });
  if (!contents) return res.status(400).json({ error: "Missing request content" });

  var uid;
  try {
    var decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (e) {
    return res.status(401).json({ error: "Your session expired — please log in again." });
  }

  var cost = CREDIT_COSTS[action] != null ? CREDIT_COSTS[action] : 1;
  var accountRef = db.collection("accounts").doc(uid);

  var deduction;
  try {
    deduction = await db.runTransaction(async function (t) {
      var snap = await t.get(accountRef);
      var data = snap.exists ? snap.data() : {};
      var plan = data.plan || "free";
      var monthlyAllowance = PLAN_MONTHLY_CREDITS[plan] || PLAN_MONTHLY_CREDITS.free;
      var thisMonth = monthKey();

      var credits = typeof data.credits === "number" ? data.credits : monthlyAllowance;
      if (data.creditsMonthKey !== thisMonth) {
        credits = monthlyAllowance;
      }

      if (credits < cost) {
        t.set(accountRef, { plan: plan, credits: credits, creditsMonthKey: thisMonth }, { merge: true });
        return { ok: false, remaining: credits };
      }

      var newBalance = credits - cost;
      t.set(accountRef, { plan: plan, credits: newBalance, creditsMonthKey: thisMonth, lastUsedAt: Date.now() }, { merge: true });
      return { ok: true, remaining: newBalance };
    });
  } catch (e) {
    console.error("Credit transaction failed:", e);
    return res.status(500).json({ error: "Server error — please try again." });
  }

  if (!deduction.ok) {
    return res.status(402).json({ error: "OUT_OF_CREDITS", remaining: deduction.remaining });
  }

  db.collection("usageLogs").add({ uid: uid, action: action, cost: cost, ts: Date.now() }).catch(function () {});

  try {
    var geminiBody = { contents: contents, generationConfig: { maxOutputTokens: maxTokens } };
    if (systemInstruction) geminiBody.systemInstruction = { parts: [{ text: systemInstruction }] };

    var url = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent?key=" + GEMINI_KEY;
    var geminiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody),
    });
    var data = await geminiRes.json();

    if (!geminiRes.ok) {
      return res.status(geminiRes.status).json({ error: (data && data.error && data.error.message) || "AI request failed" });
    }

    data.creditsRemaining = deduction.remaining;
    return res.status(200).json(data);
  } catch (e) {
    console.error("Gemini call failed:", e);
    return res.status(500).json({ error: "Couldn't reach the AI — please try again." });
  }
};
