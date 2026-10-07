// netlify/functions/generate.js
//
// Secure AI proxy + subscription verify (Netlify format).
// Required env: FIREBASE_SERVICE_ACCOUNT_JSON, GEMINI_SERVER_KEY
// Optional: PAYSTACK_SECRET_KEY (for verify_payment)

// firebase-admin must be in the ROOT package.json under "dependencies"
// (not only in netlify/functions). Netlify installs from the repo root.
//
// Loading strategy:
//  1) Try classic require("firebase-admin")
//  2) Fall back to modular firebase-admin/app + /auth + /firestore
// Either path must succeed; if both fail the package is not installed on the server.
var admin = null;
var db = null;
var firebaseInitError = null;
var firebaseLoadPath = null; // "classic" | "modular" — for health diagnostics
var firebaseRequireError = null;

function parseServiceAccountEnv() {
  // Prefer base64 — safest on Netlify (no broken newlines / quoting).
  var b64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64;
  if (b64 && String(b64).trim()) {
    try {
      var decoded = Buffer.from(String(b64).trim(), "base64").toString("utf8");
      return JSON.parse(decoded);
    } catch (e) {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 is set but not valid base64 JSON: " +
          (e && e.message ? e.message : e)
      );
    }
  }

  var raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw || !String(raw).trim()) {
    throw new Error("MISSING");
  }

  var text = String(raw).trim();
  // Strip accidental wrapping quotes from copy-paste
  if (text.length >= 2) {
    var first = text.charAt(0);
    var last = text.charAt(text.length - 1);
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      text = text.slice(1, -1).trim();
    }
  }

  try {
    return JSON.parse(text);
  } catch (e1) {
    try {
      text = text.replace(/^\uFEFF/, "").replace(/[\u200B-\u200D\uFEFF]/g, "");
      return JSON.parse(text);
    } catch (e2) {
      throw new Error(
        "INVALID_JSON: The FIREBASE_SERVICE_ACCOUNT_JSON value is not valid JSON. " +
          "Paste the full file contents, or use FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 instead. " +
          "Parse error: " +
          (e2 && e2.message ? e2.message : e2)
      );
    }
  }
}

function normalizeServiceAccount(serviceAccount) {
  if (!serviceAccount || typeof serviceAccount !== "object") {
    throw new Error("INVALID_JSON: Parsed service account is not an object.");
  }
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error(
      "INVALID_JSON: Service account JSON is missing client_email or private_key. Make sure you pasted the FULL file."
    );
  }
  // private_key must have real newlines for cert()
  if (typeof serviceAccount.private_key === "string") {
    if (
      serviceAccount.private_key.indexOf("\\n") !== -1 &&
      serviceAccount.private_key.indexOf("\n") === -1
    ) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    }
  }
  return serviceAccount;
}

try {
  // --- Path 1: classic monolithic require ---
  var classic = null;
  var classicErr = null;
  try {
    classic = require("firebase-admin");
    if (classic && classic.default && !classic.credential) {
      classic = classic.default;
    }
  } catch (e) {
    classicErr = e && e.message ? e.message : String(e);
  }

  if (
    classic &&
    classic.credential &&
    typeof classic.credential.cert === "function" &&
    typeof classic.initializeApp === "function"
  ) {
    firebaseLoadPath = "classic";
    var existingApps = classic.apps;
    var alreadyInitialized =
      existingApps && typeof existingApps.length === "number" && existingApps.length > 0;
    if (!alreadyInitialized) {
      classic.initializeApp({
        credential: classic.credential.cert(normalizeServiceAccount(parseServiceAccountEnv())),
      });
    }
    admin = classic;
    db = classic.firestore();
  } else {
    // --- Path 2: modular entry points ---
    var adminApp = null;
    var adminAuth = null;
    var adminFirestore = null;
    var modularErr = null;
    try {
      adminApp = require("firebase-admin/app");
      adminAuth = require("firebase-admin/auth");
      adminFirestore = require("firebase-admin/firestore");
    } catch (e) {
      modularErr = e && e.message ? e.message : String(e);
    }

    if (
      adminApp &&
      adminAuth &&
      adminFirestore &&
      typeof adminApp.initializeApp === "function" &&
      typeof adminApp.cert === "function" &&
      typeof adminAuth.getAuth === "function" &&
      typeof adminFirestore.getFirestore === "function"
    ) {
      firebaseLoadPath = "modular";
      var getApps = adminApp.getApps;
      var already =
        typeof getApps === "function" && Array.isArray(getApps()) && getApps().length > 0;
      if (!already) {
        adminApp.initializeApp({
          credential: adminApp.cert(normalizeServiceAccount(parseServiceAccountEnv())),
        });
      }
      admin = {
        auth: function () {
          return adminAuth.getAuth();
        },
        firestore: function () {
          return adminFirestore.getFirestore();
        },
      };
      db = adminFirestore.getFirestore();
    } else {
      firebaseRequireError =
        "classic: " +
        (classicErr ||
          (classic
            ? "loaded but credential.cert/initializeApp missing"
            : "null")) +
        " | modular: " +
        (modularErr || "incomplete exports");
      throw new Error(
        "PACKAGE_MISSING: firebase-admin is not available on the server. " +
          "Add \"firebase-admin\" to the ROOT package.json dependencies (not only in a subfolder), " +
          "commit, then Clear cache and deploy site. Require details: " +
          firebaseRequireError
      );
    }
  }
} catch (e) {
  firebaseInitError = e && e.message ? e.message : String(e);
  console.error("Firebase Admin init failed:", firebaseInitError);
  admin = null;
  db = null;
}

// Prefer high-throughput Flash-Lite models first (better under free-tier spikes),
// then full Flash models. Order is intentional — when one model is "high demand",
// we fall through to the next instead of failing the student immediately.
const GEMINI_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-2.5-flash",
];
const GEMINI_KEY = process.env.GEMINI_SERVER_KEY;

// Gemini 3 models think by default. With a small maxOutputTokens (e.g. 800–1500),
// thinking can consume the whole budget and return empty text → "No response from SAM-X".
// MINIMAL keeps latency low for study chat while still leaving room for the answer.
function buildGenerationConfig(maxTokens) {
  var out = Math.max(Number(maxTokens) || 800, 1024);
  // Give headroom so thinking + answer both fit when the model must think a little.
  if (out < 2048) out = 2048;
  return {
    maxOutputTokens: out,
    thinkingConfig: { thinkingLevel: "MINIMAL" },
  };
}

// Pull visible answer text from a Gemini response (skip pure thought parts).
function extractGeminiText(data) {
  if (!data) return { text: null, reason: "EMPTY_RESPONSE" };
  if (data.promptFeedback && data.promptFeedback.blockReason) {
    return { text: null, reason: "BLOCKED:" + data.promptFeedback.blockReason };
  }
  var cands = data.candidates;
  if (!cands || !cands.length) {
    return { text: null, reason: "NO_CANDIDATES" };
  }
  var cand = cands[0] || {};
  var finish = cand.finishReason || "";
  if (finish === "SAFETY" || finish === "BLOCKLIST" || finish === "PROHIBITED_CONTENT") {
    return { text: null, reason: "SAFETY:" + finish };
  }
  var parts = (cand.content && cand.content.parts) || [];
  var chunks = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (!p) continue;
    // Skip internal thought-only parts when the API surfaces them separately
    if (p.thought === true) continue;
    if (typeof p.text === "string" && p.text.length) chunks.push(p.text);
  }
  var text = chunks.join("").trim();
  if (!text) {
    return {
      text: null,
      reason: finish ? "EMPTY_TEXT:" + finish : "EMPTY_TEXT",
    };
  }
  return { text: text, reason: finish || "OK" };
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// Turn Google's raw "high demand / resource exhausted" text into a clear student message.
function friendlyAiError(raw) {
  var msg = (raw || "").toString();
  var lower = msg.toLowerCase();
  if (
    lower.indexOf("high demand") !== -1 ||
    lower.indexOf("resource exhausted") !== -1 ||
    lower.indexOf("resource_exhausted") !== -1 ||
    lower.indexOf("quota") !== -1 ||
    lower.indexOf("rate limit") !== -1 ||
    lower.indexOf("too many requests") !== -1 ||
    lower.indexOf("overloaded") !== -1 ||
    lower.indexOf("temporarily unavailable") !== -1
  ) {
    return "SAM-X is busy right now (high demand). Please wait about 30–60 seconds and try again.";
  }
  if (lower.indexOf("not found") !== -1 || lower.indexOf("not_found") !== -1) {
    return "That AI model is temporarily unavailable. Please try again in a moment.";
  }
  // Keep message short for UI — don't dump a full Google stack trace.
  if (msg.length > 160) return "Couldn't reach SAM-X right now. Please try again in a minute.";
  return msg || "AI is busy — please try again in a minute.";
}

// Call Gemini with retries on 429/503 and fallback models for free-tier spikes.
async function callGeminiWithRetry(geminiBody) {
  var lastError = null;
  var lastStatus = 500;
  var lastData = null;

  for (var m = 0; m < GEMINI_MODELS.length; m++) {
    var model = GEMINI_MODELS[m];
    var url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      model +
      ":generateContent?key=" +
      GEMINI_KEY;

    // More attempts on the first (preferred) models, fewer on later fallbacks.
    var maxAttempts = m < 2 ? 4 : 2;

    for (var attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        var geminiRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(geminiBody),
        });
        var data = await geminiRes.json();

        if (geminiRes.ok) {
          return { ok: true, data: data, model: model };
        }

        lastStatus = geminiRes.status;
        lastData = data;
        lastError =
          (data && data.error && data.error.message) || "AI request failed";

        // Overloaded / rate-limited — exponential backoff, then next model
        if (geminiRes.status === 429 || geminiRes.status === 503) {
          // 1.5s, 3s, 6s, 10s — gives free-tier capacity time to recover
          var delay = Math.min(10000, Math.round(1500 * Math.pow(2, attempt)));
          await sleep(delay);
          continue;
        }

        // Model missing / not allowed for this key — try next model, don't fail hard
        if (geminiRes.status === 404 || geminiRes.status === 403) {
          break; // move to next model in outer loop
        }

        // Other client errors (400 bad request) — don't keep retrying this model
        if (geminiRes.status >= 400 && geminiRes.status < 500) {
          return {
            ok: false,
            status: lastStatus,
            error: friendlyAiError(lastError),
            data: lastData,
          };
        }

        // 5xx — brief pause then retry / next model
        await sleep(1500 * (attempt + 1));
      } catch (e) {
        lastError = e && e.message ? e.message : "Network error";
        lastStatus = 500;
        await sleep(1500 * (attempt + 1));
      }
    }
  }

  return {
    ok: false,
    status: lastStatus === 429 || lastStatus === 503 ? 503 : lastStatus,
    error: friendlyAiError(lastError),
    data: lastData,
  };
}

const CREDIT_COSTS = {
  chat: 1,
  summary: 5,
  quiz: 8,
  flashcards: 8,
  pdf_analysis: 20,
  transcribe: 15,
};
const PLAN_MONTHLY_CREDITS = { free: 60, pro: 400, premium: 1500 };
const PLANS = {
  free:    { monthlyCredits: 60,   priceMonthly: 0,    priceYearly: 0 },
  pro:     { monthlyCredits: 400,  priceMonthly: 550,  priceYearly: 5500 },
  premium: { monthlyCredits: 1500, priceMonthly: 1500, priceYearly: 15000 },
};

function monthKey() {
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

async function refundCredits(accountRef, cost, plan, thisMonth) {
  try {
    await db.runTransaction(async function (t) {
      var snap = await t.get(accountRef);
      var data = snap.exists ? snap.data() : {};
      var credits = typeof data.credits === "number" ? data.credits : 0;
      var currentKey = data.creditsMonthKey || thisMonth;
      t.set(
        accountRef,
        {
          plan: data.plan || plan || "free",
          credits: credits + cost,
          creditsMonthKey: currentKey,
          lastRefundAt: Date.now(),
        },
        { merge: true }
      );
    });
  } catch (e) {
    console.error("Credit refund failed:", e);
  }
}

async function handleSubscription(uid, body) {
  var accountRef = db.collection("accounts").doc(uid);
  var action = body.action;

  if (action === "downgrade") {
    var freeUpdate = {
      plan: "free",
      credits: PLANS.free.monthlyCredits,
      creditsMonthKey: monthKey(),
    };
    await accountRef.set(freeUpdate, { merge: true });
    return jsonResponse(200, freeUpdate);
  }

  if (action === "verify_payment") {
    var reference = body.reference;
    var planId = body.planId;
    var cycle = body.cycle || "monthly";

    if (!reference) {
      return jsonResponse(400, { error: "Missing payment reference" });
    }
    if (!process.env.PAYSTACK_SECRET_KEY) {
      return jsonResponse(500, {
        error: "Payments aren't configured on the server yet (PAYSTACK_SECRET_KEY missing).",
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
        console.error("Paystack verify response unexpected:", parsed);
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
      return jsonResponse(402, {
        error: "Payment was not successful (status: " + (paystackData.status || "unknown") + ")",
      });
    }

    // Prefer client planId; fall back to Paystack metadata if missing/stale.
    var meta = paystackData.metadata || {};
    if ((!planId || planId === "free") && meta.planId) {
      planId = meta.planId;
    }
    if ((!cycle || cycle === "yearly") && meta.cycle) {
      cycle = meta.cycle;
    }
    // Yearly locked for now
    if (cycle === "yearly") {
      return jsonResponse(400, {
        error: "Yearly plans are not available yet. Please choose a monthly plan.",
      });
    }

    var targetPlan = PLANS[planId];
    if (!targetPlan || planId === "free") {
      // Last resort: infer plan from amount paid (kobo)
      var paidNaira = Math.round((paystackData.amount || 0) / 100);
      if (paidNaira >= PLANS.premium.priceMonthly) planId = "premium";
      else if (paidNaira >= PLANS.pro.priceMonthly) planId = "pro";
      else {
        return jsonResponse(400, {
          error: "Couldn't determine which plan was paid for. Reference: " + reference,
        });
      }
      targetPlan = PLANS[planId];
    }

    var expectedNaira =
      cycle === "yearly" ? targetPlan.priceYearly : targetPlan.priceMonthly;
    // Allow 1 Naira tolerance for rounding; reject clearly underpaid amounts.
    if (paystackData.amount < expectedNaira * 100 - 100) {
      return jsonResponse(402, {
        error:
          "The amount paid (₦" +
          Math.round(paystackData.amount / 100) +
          ") doesn't match the " +
          planId +
          " plan price (₦" +
          expectedNaira +
          ")",
      });
    }

    if (meta.uid && meta.uid !== uid) {
      return jsonResponse(403, {
        error: "This payment isn't linked to your account",
      });
    }

    var update = {
      plan: planId,
      credits: targetPlan.monthlyCredits,
      creditsMonthKey: monthKey(),
      lastPaymentRef: reference,
      lastPaymentAt: Date.now(),
      lastPaymentCycle: cycle || "monthly",
    };
    try {
      await accountRef.set(update, { merge: true });
    } catch (e) {
      console.error("Firestore account upgrade failed:", e);
      // Still return success with the verified plan — client will persist
      // local entitlement so the student is not left on Free after paying.
      return jsonResponse(200, {
        plan: update.plan,
        credits: update.credits,
        warning: "Plan verified, but cloud sync was delayed. Your access is active on this device.",
      });
    }
    return jsonResponse(200, { plan: update.plan, credits: update.credits });
  }

  return jsonResponse(400, { error: "Unknown action" });
}

exports.handler = async function (event) {
  try {
    if (event.httpMethod === "GET") {
      // Public health check — no secrets, safe to open in browser.
      // Visit: https://notewave12.netlify.app/api/generate
      return jsonResponse(200, {
        ok: true,
        function: "generate",
        firebaseAdminLoaded: !!admin,
        firebaseDbReady: !!db,
        firebaseInitError: firebaseInitError || null,
        firebaseLoadPath: firebaseLoadPath || null,
        firebaseRequireError: firebaseRequireError || null,
        hasServiceAccountJson: !!(
          process.env.FIREBASE_SERVICE_ACCOUNT_JSON &&
          String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON).trim()
        ),
        hasServiceAccountBase64: !!(
          process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 &&
          String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64).trim()
        ),
        hasGeminiKey: !!(
          process.env.GEMINI_SERVER_KEY &&
          String(process.env.GEMINI_SERVER_KEY).trim()
        ),
        hasPaystackSecret: !!(
          process.env.PAYSTACK_SECRET_KEY &&
          String(process.env.PAYSTACK_SECRET_KEY).trim()
        ),
      });
    }

    if (event.httpMethod !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }

    var body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return jsonResponse(400, { error: "Invalid JSON body" });
    }

    var idToken = body.idToken;
    var action = body.action || "chat";

    // POST health (optional) — same info, no auth required
    if (action === "health") {
      return jsonResponse(200, {
        ok: true,
        function: "generate",
        firebaseAdminLoaded: !!admin,
        firebaseDbReady: !!db,
        firebaseInitError: firebaseInitError || null,
        firebaseLoadPath: firebaseLoadPath || null,
        firebaseRequireError: firebaseRequireError || null,
        hasServiceAccountJson: !!(
          process.env.FIREBASE_SERVICE_ACCOUNT_JSON &&
          String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON).trim()
        ),
        hasServiceAccountBase64: !!(
          process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 &&
          String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64).trim()
        ),
        hasGeminiKey: !!(
          process.env.GEMINI_SERVER_KEY &&
          String(process.env.GEMINI_SERVER_KEY).trim()
        ),
        hasPaystackSecret: !!(
          process.env.PAYSTACK_SECRET_KEY &&
          String(process.env.PAYSTACK_SECRET_KEY).trim()
        ),
      });
    }

    if (!db) {
      var detail = firebaseInitError || "unknown";
      if (detail === "MISSING") {
        return jsonResponse(500, {
          error:
            "FIREBASE_SERVICE_ACCOUNT_JSON is missing on Netlify. Add it (or FIREBASE_SERVICE_ACCOUNT_JSON_BASE64), then redeploy.",
        });
      }
      if (String(detail).indexOf("PACKAGE_MISSING") === 0) {
        return jsonResponse(500, {
          error:
            "firebase-admin package is missing on the server. Add firebase-admin to package.json dependencies, commit, and redeploy.",
        });
      }
      if (String(detail).indexOf("PACKAGE_BROKEN") === 0) {
        return jsonResponse(500, {
          error:
            "firebase-admin is installed but broken on the server (credential.cert missing). " +
            "Keep firebase-admin in package.json dependencies and in netlify.toml external_node_modules, " +
            "then Clear cache and deploy site. Details: " +
            detail,
        });
      }
      if (String(detail).indexOf("INVALID_JSON") === 0) {
        return jsonResponse(500, {
          error:
            "FIREBASE_SERVICE_ACCOUNT_JSON is invalid JSON on Netlify. Re-paste the full service account file, or use FIREBASE_SERVICE_ACCOUNT_JSON_BASE64. Details: " +
            detail,
        });
      }
      return jsonResponse(500, {
        error:
          "Firebase Admin failed to start. Check Netlify env and function logs. Details: " +
          detail,
      });
    }

    if (!idToken) {
      return jsonResponse(401, { error: "Please log in and try again." });
    }

    var uid;
    try {
      var decoded = await admin.auth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (e) {
      return jsonResponse(401, {
        error: "Your session expired — please log in again.",
      });
    }

    if (action === "verify_payment" || action === "downgrade") {
      return await handleSubscription(uid, body);
    }

    if (!GEMINI_KEY) {
      return jsonResponse(500, { error: "Gemini server key is not configured." });
    }

    var contents = body.contents;
    var systemInstruction = body.systemInstruction;
    var maxTokens = body.maxTokens || 800;

    if (!contents) {
      return jsonResponse(400, { error: "Missing request content" });
    }

    var cost = CREDIT_COSTS[action] != null ? CREDIT_COSTS[action] : 1;
    var accountRef = db.collection("accounts").doc(uid);
    var thisMonth = monthKey();
    var deduction;

    try {
      deduction = await db.runTransaction(async function (t) {
        var snap = await t.get(accountRef);
        var data = snap.exists ? snap.data() : {};
        var plan = data.plan || "free";
        var monthlyAllowance =
          PLAN_MONTHLY_CREDITS[plan] || PLAN_MONTHLY_CREDITS.free;

        var credits =
          typeof data.credits === "number" ? data.credits : monthlyAllowance;
        if (data.creditsMonthKey !== thisMonth) {
          credits = monthlyAllowance;
        }

        if (credits < cost) {
          t.set(
            accountRef,
            { plan: plan, credits: credits, creditsMonthKey: thisMonth },
            { merge: true }
          );
          return { ok: false, remaining: credits, plan: plan };
        }

        var newBalance = credits - cost;
        t.set(
          accountRef,
          {
            plan: plan,
            credits: newBalance,
            creditsMonthKey: thisMonth,
            lastUsedAt: Date.now(),
          },
          { merge: true }
        );
        return { ok: true, remaining: newBalance, plan: plan };
      });
    } catch (e) {
      console.error("Credit transaction failed:", e);
      return jsonResponse(500, { error: "Server error — please try again." });
    }

    if (!deduction.ok) {
      return jsonResponse(402, {
        error: "OUT_OF_CREDITS",
        remaining: deduction.remaining,
      });
    }

    try {
      db.collection("usageLogs")
        .add({ uid: uid, action: action, cost: cost, ts: Date.now() })
        .catch(function () {});
    } catch (e) {}

    try {
      // Normalize contents: Gemini expects role "user" | "model" only.
      var normalizedContents = (contents || []).map(function (c) {
        var role = c && c.role === "model" ? "model" : "user";
        var parts = (c && c.parts) || [];
        return { role: role, parts: parts };
      }).filter(function (c) {
        return c.parts && c.parts.length > 0;
      });

      if (!normalizedContents.length) {
        await refundCredits(accountRef, cost, deduction.plan, thisMonth);
        return jsonResponse(400, { error: "Missing request content" });
      }

      var geminiBody = {
        contents: normalizedContents,
        generationConfig: buildGenerationConfig(maxTokens),
      };
      if (systemInstruction) {
        geminiBody.systemInstruction = {
          parts: [{ text: String(systemInstruction) }],
        };
      }

      var result = await callGeminiWithRetry(geminiBody);

      if (!result.ok) {
        await refundCredits(accountRef, cost, deduction.plan, thisMonth);
        return jsonResponse(result.status || 503, {
          error:
            result.error ||
            "SAM-X is busy right now (high demand). Please wait about 30–60 seconds and try again.",
        });
      }

      var data = result.data || {};
      var extracted = extractGeminiText(data);

      if (!extracted.text) {
        console.error("Gemini returned no usable text:", extracted.reason, JSON.stringify(data).slice(0, 500));
        await refundCredits(accountRef, cost, deduction.plan, thisMonth);
        var reason = extracted.reason || "";
        if (reason.indexOf("SAFETY") === 0 || reason.indexOf("BLOCKED") === 0) {
          return jsonResponse(422, {
            error: "SAM-X couldn't answer that request. Try rephrasing your question.",
          });
        }
        return jsonResponse(503, {
          error: "SAM-X returned an empty answer. Please try again in a moment.",
        });
      }

      // Ensure the client always finds text at the standard path.
      data.candidates = [
        {
          content: { role: "model", parts: [{ text: extracted.text }] },
          finishReason: extracted.reason || "STOP",
        },
      ];
      data.creditsRemaining = deduction.remaining;
      return jsonResponse(200, data);
    } catch (e) {
      console.error("Gemini call failed:", e);
      await refundCredits(accountRef, cost, deduction.plan, thisMonth);
      return jsonResponse(500, {
        error: "Couldn't reach the AI — please try again.",
      });
    }
  } catch (e) {
    console.error("Unhandled function error:", e);
    return jsonResponse(500, {
      error: "Server error — please try again.",
    });
  }
};
