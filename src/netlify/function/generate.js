// netlify/functions/generate.js
//
// This is the ONLY place the real Gemini API key ever lives. The browser never
// sees it. Every AI feature in the app (chat, summaries, quizzes, scan doc,
// voice transcription) sends its request here instead of calling Gemini directly.
//
// What this function does, in order:
//   1. Verifies the caller is really logged in (checks their Firebase ID token)
//   2. Looks up how many AI credits they have left, resetting monthly if needed
//   3. Refuses the request (402 Payment Required style) if they're out of credits
//   4. Deducts the credit cost BEFORE calling Gemini, inside a Firestore transaction
//      (so two requests firing at once can't both slip through on the same credit)
//   5. Calls Gemini with the private key and returns the answer, plus the new balance
//
// Setup needed (see the message alongside this file for full instructions):
//   - npm install firebase-admin
//   - Environment variables in Netlify: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL,
//     FIREBASE_PRIVATE_KEY, GEMINI_SERVER_KEY
//   - netlify.toml redirect so /api/generate reaches this function

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
const GEMINI_MODEL = "gemini-flash-latest";
const GEMINI_KEY = process.env.GEMINI_SERVER_KEY;

// Keep these numbers in sync with PLANS / CREDIT_COSTS near the top of src/App.js —
// this is the copy that actually gets enforced, since nothing from the browser can
// be trusted for billing-relevant numbers.
const CREDIT_COSTS = { chat: 1, summary: 5, quiz: 8, flashcards: 8, pdf_analysis: 20, transcribe: 15 };
const PLAN_MONTHLY_CREDITS = { free: 60, pro: 400, premium: 1500 };

function monthKey() {
  var d = new Date();
  return d.getFullYear() + "-" + d.getMonth();
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  var body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Malformed request" }) };
  }

  var idToken = body.idToken;
  var action = body.action || "chat";
  var contents = body.contents;
  var systemInstruction = body.systemInstruction;
  var maxTokens = body.maxTokens || 800;

  if (!idToken) {
    return { statusCode: 401, body: JSON.stringify({ error: "Please log in and try again." }) };
  }
  if (!contents) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing request content" }) };
  }

  var uid;
  try {
    var decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (e) {
    return { statusCode: 401, body: JSON.stringify({ error: "Your session expired — please log in again." }) };
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
      // Reset credits automatically at the start of a new month.
      if (data.creditsMonthKey !== thisMonth) {
        credits = monthlyAllowance;
      }

      if (credits < cost) {
        // Still write the reset (if one happened) so the balance is accurate next time,
        // even though this particular request is being declined.
        t.set(accountRef, { plan: plan, credits: credits, creditsMonthKey: thisMonth }, { merge: true });
        return { ok: false, remaining: credits };
      }

      var newBalance = credits - cost;
      t.set(accountRef, { plan: plan, credits: newBalance, creditsMonthKey: thisMonth, lastUsedAt: Date.now() }, { merge: true });
      return { ok: true, remaining: newBalance };
    });
  } catch (e) {
    console.error("Credit transaction failed:", e);
    return { statusCode: 500, body: JSON.stringify({ error: "Server error — please try again." }) };
  }

  if (!deduction.ok) {
    return { statusCode: 402, body: JSON.stringify({ error: "OUT_OF_CREDITS", remaining: deduction.remaining }) };
  }

  // Best-effort usage log for future admin analytics — never blocks the response.
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
      return { statusCode: geminiRes.status, body: JSON.stringify({ error: (data && data.error && data.error.message) || "AI request failed" }) };
    }

    data.creditsRemaining = deduction.remaining;
    return { statusCode: 200, body: JSON.stringify(data) };
  } catch (e) {
    console.error("Gemini call failed:", e);
    return { statusCode: 500, body: JSON.stringify({ error: "Couldn't reach the AI — please try again." }) };
  }
};
