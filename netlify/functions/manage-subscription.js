// netlify/functions/manage-subscription.js
//
// Secure subscription manager for Jotting AI (Netlify Functions format).
//
// This is the ONLY code allowed to write plan + credits to accounts/{uid}.
//
// Actions:
//   1. "verify_payment" — student finished Paystack checkout. We verify the
//      reference with Paystack's secret key, then upgrade the account.
//   2. "downgrade" — switch back to free (safe; only reduces access).
//
// Required Netlify environment variables:
//   FIREBASE_SERVICE_ACCOUNT_JSON  — full service-account JSON as a string
//   PAYSTACK_SECRET_KEY            — from Paystack → Settings → API Keys (secret)
//
// Keep PLANS in sync with App_login.js and generate.js.

const admin = require("firebase-admin");

if (!admin.apps.length) {
  try {
    var serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } catch (e) {
    console.error("Firebase Admin init failed — check FIREBASE_SERVICE_ACCOUNT_JSON:", e.message);
  }
}

const db = admin.firestore();

// Must stay in sync with App_login.js PLANS and generate.js PLAN_MONTHLY_CREDITS
const PLANS = {
  free:    { monthlyCredits: 60,   priceMonthly: 0,    priceYearly: 0 },
  pro:     { monthlyCredits: 400,  priceMonthly: 550,  priceYearly: 5500 },
  premium: { monthlyCredits: 1500, priceMonthly: 1500, priceYearly: 15000 },
};

function currentMonthKey() {
  var d = new Date();
  return d.getFullYear() + "-" + d.getMonth();
}

function jsonResponse(statusCode, body) {
  return {
    statusCode: statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  if (!admin.apps.length) {
    console.error("Firebase Admin is not initialized");
    return jsonResponse(500, {
      error: "Server auth is not configured. Check FIREBASE_SERVICE_ACCOUNT_JSON.",
    });
  }

  var body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  var idToken = body.idToken;
  var action = body.action;

  if (!idToken) {
    return jsonResponse(401, { error: "Not signed in" });
  }

  var decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return jsonResponse(401, { error: "Invalid session — please sign in again" });
  }

  var uid = decoded.uid;
  var accountRef = db.collection("accounts").doc(uid);

  // ── Downgrade to Free ─────────────────────────────────────────────────────
  if (action === "downgrade") {
    var freeUpdate = {
      plan: "free",
      credits: PLANS.free.monthlyCredits,
      creditsMonthKey: currentMonthKey(),
    };
    await accountRef.set(freeUpdate, { merge: true });
    return jsonResponse(200, freeUpdate);
  }

  // ── Verify Paystack payment and upgrade ───────────────────────────────────
  if (action === "verify_payment") {
    var reference = body.reference;
    var planId = body.planId;
    var cycle = body.cycle;
    var targetPlan = PLANS[planId];

    if (!targetPlan || planId === "free") {
      return jsonResponse(400, { error: "Invalid plan" });
    }
    // Yearly billing is locked for now — only monthly Pro / Premium are sold.
    if (cycle === "yearly") {
      return jsonResponse(400, {
        error: "Yearly plans are not available yet. Please choose a monthly plan.",
      });
    }
    if (!reference) {
      return jsonResponse(400, { error: "Missing payment reference" });
    }
    if (!process.env.PAYSTACK_SECRET_KEY) {
      return jsonResponse(500, {
        error: "Payments aren't configured on the server yet",
      });
    }

    var paystackData;
    try {
      var paystackRes = await fetch(
        "https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference),
        { headers: { Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY } }
      );
      var parsed = await paystackRes.json();
      paystackData = parsed && parsed.data;
      if (!parsed || !parsed.status || !paystackData) {
        return jsonResponse(402, {
          error: "Couldn't verify this payment with Paystack",
        });
      }
    } catch (e) {
      console.error("Paystack verify failed:", e);
      return jsonResponse(502, {
        error: "Couldn't reach Paystack — try again in a moment",
      });
    }

    if (paystackData.status !== "success") {
      return jsonResponse(402, { error: "Payment was not successful" });
    }

    // Trust only what Paystack reports as paid
    var expectedNaira =
      cycle === "yearly" ? targetPlan.priceYearly : targetPlan.priceMonthly;
    var expectedKobo = expectedNaira * 100;
    if (paystackData.amount < expectedKobo) {
      return jsonResponse(402, {
        error: "The amount paid doesn't match the " + planId + " plan price",
      });
    }

    // Reject if payment metadata uid doesn't match the signed-in user
    var meta = paystackData.metadata || {};
    if (meta.uid && meta.uid !== uid) {
      return jsonResponse(403, {
        error: "This payment isn't linked to your account",
      });
    }

    var update = {
      plan: planId,
      credits: targetPlan.monthlyCredits,
      creditsMonthKey: currentMonthKey(),
      lastPaymentRef: reference,
      lastPaymentAt: Date.now(),
    };
    await accountRef.set(update, { merge: true });
    return jsonResponse(200, { plan: update.plan, credits: update.credits });
  }

  return jsonResponse(400, { error: "Unknown action" });
};
