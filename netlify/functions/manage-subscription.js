// api/manage-subscription.js
//
// This is Vercel's version of the exact same secure subscription manager as
// netlify/functions/manage-subscription.js — same logic, just written in the
// request/response shape Vercel expects instead of Netlify's event-based shape.
// Both need to exist because each hosting platform only recognizes its own
// convention (see api/generate.js, which follows this exact same pairing).
//
// This is the ONLY code allowed to write to Firestore's `accounts/{uid}` doc
// (plan + credits) — same rule generate.js already follows for AI credits, and
// for the same reason: if the browser could set its own plan, a technical
// student could just grant themselves unlimited Premium.
//
//   1. action:"verify_payment" — a student just went through Paystack's popup.
//      We take the reference THEY give us, but we never trust anything else
//      they say (amount, plan, "it worked") — we ask Paystack directly, with
//      the secret key, what that reference actually paid, and only upgrade
//      the account if that checks out.
//   2. action:"downgrade" — no payment involved, so this is safe to run
//      directly off a client request; it only ever *reduces* what an account
//      can do.
//
// CREDENTIALS: reuses the exact same three env vars api/generate.js already
// uses (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY) —
// generate.js already calls admin.auth().verifyIdToken() with this same
// service account, so it already carries Auth + Firestore access; no new
// environment variable needs to be added in Vercel for this function.
// (The Netlify twin uses a single FIREBASE_SERVICE_ACCOUNT_JSON var instead —
// that's a Netlify-side setup detail, not something this file needs to match.)
//
// Required environment variables (Vercel dashboard -> Project Settings ->
// Environment Variables), same as api/generate.js:
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
// Plus, specific to this function:
//   PAYSTACK_SECRET_KEY — from Paystack dashboard -> Settings -> API Keys (secret, NOT the public key used client-side)
//
// Uses the global `fetch` available in Node 18+ (Vercel's default function runtime).

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

// Keep this in sync with the PLANS object in App_login.js and with
// netlify/functions/manage-subscription.js — if you add/change a plan there,
// mirror it here too, same as the existing credit-cost mapping convention in
// generate.js.
const PLANS = {
  free:    { monthlyCredits: 60,   priceMonthly: 0,    priceYearly: 0 },
  pro:     { monthlyCredits: 400,  priceMonthly: 550,  priceYearly: 5500 },
  premium: { monthlyCredits: 1500, priceMonthly: 1500, priceYearly: 15000 },
};

function currentMonthKey() {
  var d = new Date();
  return d.getFullYear() + "-" + d.getMonth();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  var body = req.body || {};
  var idToken = body.idToken;
  var action = body.action;
  if (!idToken) return res.status(401).json({ error: "Not signed in" });

  var decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: "Invalid session — please sign in again" });
  }
  var uid = decoded.uid;
  var accountRef = db.collection("accounts").doc(uid);

  // ── Downgrade to Free — no payment involved, safe to run straight off the request. ──
  if (action === "downgrade") {
    var freeUpdate = { plan: "free", credits: PLANS.free.monthlyCredits, creditsMonthKey: currentMonthKey() };
    await accountRef.set(freeUpdate, { merge: true });
    return res.status(200).json(freeUpdate);
  }

  // ── Verify a Paystack payment before granting a paid plan. ───────────────────────────
  if (action === "verify_payment") {
    var reference = body.reference;
    var planId = body.planId;
    var cycle = body.cycle;
    var targetPlan = PLANS[planId];

    if (!targetPlan || planId === "free") return res.status(400).json({ error: "Invalid plan" });
    if (!reference) return res.status(400).json({ error: "Missing payment reference" });
    if (!process.env.PAYSTACK_SECRET_KEY) return res.status(500).json({ error: "Payments aren't configured on the server yet" });

    var paystackData;
    try {
      var paystackRes = await fetch(
        "https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference),
        { headers: { Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY } }
      );
      var parsed = await paystackRes.json();
      paystackData = parsed && parsed.data;
      if (!parsed || !parsed.status || !paystackData) return res.status(402).json({ error: "Couldn't verify this payment with Paystack" });
    } catch (e) {
      return res.status(502).json({ error: "Couldn't reach Paystack — try again in a moment" });
    }

    if (paystackData.status !== "success") return res.status(402).json({ error: "Payment was not successful" });

    // Trust ONLY what Paystack itself reports as paid — never the amount the client told
    // the popup to charge, which a tampered client could have lowered before opening it.
    var expectedNaira = cycle === "yearly" ? targetPlan.priceYearly : targetPlan.priceMonthly;
    var expectedKobo = expectedNaira * 100;
    if (paystackData.amount < expectedKobo) {
      return res.status(402).json({ error: "The amount paid doesn't match the " + planId + " plan price" });
    }

    // The reference is tied to a uid via metadata set when the checkout was opened
    // client-side — reject if it doesn't match the signed-in user, so one paid
    // reference can't be replayed against a different account.
    var meta = paystackData.metadata || {};
    if (meta.uid && meta.uid !== uid) return res.status(403).json({ error: "This payment isn't linked to your account" });

    var update = {
      plan: planId,
      credits: targetPlan.monthlyCredits,
      creditsMonthKey: currentMonthKey(),
      lastPaymentRef: reference,
      lastPaymentAt: Date.now(),
    };
    await accountRef.set(update, { merge: true });
    return res.status(200).json({ plan: update.plan, credits: update.credits });
  }

  return res.status(400).json({ error: "Unknown action" });
};