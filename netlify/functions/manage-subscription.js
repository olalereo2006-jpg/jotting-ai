// netlify/functions/manage-subscription.js
//
// The ONLY code allowed to write to Firestore's `accounts/{uid}` doc (plan + credits) —
// same rule generate.js already follows for AI credits, and for the same reason: if the
// browser could set its own plan, a technical student could just grant themselves
// unlimited Premium. Two things happen here:
//
//   1. action:"verify_payment" — a student just went through Paystack's popup. We take
//      the reference THEY give us, but we never trust anything else they say (amount,
//      plan, "it worked") — we ask Paystack directly, with the secret key, what that
//      reference actually paid, and only upgrade the account if that checks out.
//   2. action:"downgrade" — no payment involved, so this is safe to run directly off a
//      client request; it only ever *reduces* what an account can do.
//
// ⚠️ INTEGRATION NOTE FOR WHOEVER WIRES THIS IN:
// I don't have visibility into your existing netlify/functions/generate.js in this
// project, so I can't confirm how you're already initializing firebase-admin there.
// The block below initializes it fresh (guarded by `admin.apps.length` so it's safe to
// deploy as-is), but if generate.js already sets up firebase-admin, pull that init into
// a shared file (e.g. netlify/functions/_firebaseAdmin.js) and `require()` it from both
// functions instead — two independent admin.initializeApp() calls in the same Netlify
// deployment can behave inconsistently depending on how functions get bundled.
//
// Required environment variables (Netlify dashboard → Site settings → Environment):
//   PAYSTACK_SECRET_KEY          — from Paystack dashboard → Settings → API Keys (secret, NOT the public key used client-side)
//   FIREBASE_SERVICE_ACCOUNT_JSON — the full service-account JSON (as a single-line string) for a Firebase service account with Firestore + Auth access

// Uses the global `fetch` available in Node 18+ (Netlify's default function runtime).
// If your site is pinned to an older Node runtime, add `node-fetch` and
// `const fetch = require("node-fetch");` at the top instead.
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
  });
}
const db = admin.firestore();

// Keep this in sync with the PLANS object in App_login.js — if you add/change a plan
// there, mirror it here too, same as the existing credit-cost mapping convention.
const PLANS = {
  free:    { monthlyCredits: 60,   priceMonthly: 0,    priceYearly: 0 },
  pro:     { monthlyCredits: 400,  priceMonthly: 550,  priceYearly: 5500 },
  premium: { monthlyCredits: 1500, priceMonthly: 1500, priceYearly: 15000 },
};

function currentMonthKey() {
  var d = new Date();
  return d.getFullYear() + "-" + d.getMonth();
}

function json(statusCode, body) {
  return { statusCode: statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  var body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Invalid request body" });
  }

  var idToken = body.idToken;
  var action = body.action;
  if (!idToken) return json(401, { error: "Not signed in" });

  var decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return json(401, { error: "Invalid session — please sign in again" });
  }
  var uid = decoded.uid;
  var accountRef = db.collection("accounts").doc(uid);

  // ── Downgrade to Free — no payment involved, safe to run straight off the request. ──
  if (action === "downgrade") {
    var freeUpdate = { plan: "free", credits: PLANS.free.monthlyCredits, creditsMonthKey: currentMonthKey() };
    await accountRef.set(freeUpdate, { merge: true });
    return json(200, freeUpdate);
  }

  // ── Verify a Paystack payment before granting a paid plan. ───────────────────────────
  if (action === "verify_payment") {
    var reference = body.reference;
    var planId = body.planId;
    var cycle = body.cycle;
    var targetPlan = PLANS[planId];

    if (!targetPlan || planId === "free") return json(400, { error: "Invalid plan" });
    if (!reference) return json(400, { error: "Missing payment reference" });
    if (!process.env.PAYSTACK_SECRET_KEY) return json(500, { error: "Payments aren't configured on the server yet" });

    var paystackData;
    try {
      var paystackRes = await fetch(
        "https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference),
        { headers: { Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY } }
      );
      var parsed = await paystackRes.json();
      paystackData = parsed && parsed.data;
      if (!parsed || !parsed.status || !paystackData) return json(402, { error: "Couldn't verify this payment with Paystack" });
    } catch (e) {
      return json(502, { error: "Couldn't reach Paystack — try again in a moment" });
    }

    if (paystackData.status !== "success") return json(402, { error: "Payment was not successful" });

    // Trust ONLY what Paystack itself reports as paid — never the amount the client told
    // the popup to charge, which a tampered client could have lowered before opening it.
    var expectedNaira = cycle === "yearly" ? targetPlan.priceYearly : targetPlan.priceMonthly;
    var expectedKobo = expectedNaira * 100;
    if (paystackData.amount < expectedKobo) {
      return json(402, { error: "The amount paid doesn't match the " + planId + " plan price" });
    }

    // The reference is tied to a uid via metadata set when the checkout was opened
    // client-side — reject if it doesn't match the signed-in user, so one paid
    // reference can't be replayed against a different account.
    var meta = paystackData.metadata || {};
    if (meta.uid && meta.uid !== uid) return json(403, { error: "This payment isn't linked to your account" });

    var update = {
      plan: planId,
      credits: targetPlan.monthlyCredits,
      creditsMonthKey: currentMonthKey(),
      lastPaymentRef: reference,
      lastPaymentAt: Date.now(),
    };
    await accountRef.set(update, { merge: true });
    return json(200, { plan: update.plan, credits: update.credits });
  }

  return json(400, { error: "Unknown action" });
};
