import { useState, useEffect, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, updateProfile, sendPasswordResetEmail, sendEmailVerification, GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import { getFirestore, collection, addDoc, getDocs, getDoc, deleteDoc, doc, setDoc, query, where } from "firebase/firestore";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import mammoth from "mammoth";
import { notesRepository } from "./repositories/notesRepository";
import { assignmentsRepository } from "./repositories/assignmentsRepository";
import { flashcardsRepository } from "./repositories/flashcardsRepository";
import { quizzesRepository } from "./repositories/quizzesRepository";
import { studyPlansRepository } from "./repositories/studyPlansRepository";
import { studySessionsRepository } from "./repositories/studySessionsRepository";
import { recordingsRepository } from "./repositories/recordingsRepository";
import { topicMasteryRepository } from "./repositories/topicMasteryRepository";
import { buildRecommendations, WEAK_TOPIC_MASTERY_THRESHOLD, EXAM_PREP_MASTERY_THRESHOLD } from "./services/recommendationService";
import { updateTopicMasteryFromQuizAttempt } from "./services/topicMasteryService";
import { materialsRepository, MATERIAL_TYPES } from "./repositories/materialsRepository";
import { coursesRepository } from "./repositories/coursesRepository";
import { semestersRepository } from "./repositories/semestersRepository";

// ── Firebase Config ───────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyDZvegplN8qtBdbaOZ0DLkypKBZzYBZviA",
  authDomain: "jotting-ai.firebaseapp.com",
  projectId: "jotting-ai",
  storageBucket: "jotting-ai.firebasestorage.app",
  messagingSenderId: "28663802288",
  appId: "1:28663802288:web:7d44d165e8b31a17b7ce75",
  measurementId: "G-H1K6JYLS3C"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
// NOTE: deliberately no Firebase Storage client here. Cloud Storage needs the paid
// Blaze plan just to provision a bucket, and this app stays on the free Spark plan —
// lecture recording audio is persisted in the browser's IndexedDB instead (see the
// "Local audio storage" section below). Firestore, Auth, and everything else are
// completely unaffected by this.
const googleProvider = new GoogleAuthProvider();

// Paystack PUBLIC key — safe to ship in client code, it can only open a checkout
// popup, never move money or touch account data on its own. Get this from your
// Paystack dashboard (Settings → API Keys) and swap in your live key when ready.
// The matching SECRET key belongs only on the server — see netlify/functions/manage-subscription.js.
//const PAYSTACK_PUBLIC_KEY = "pk_test_REPLACE_WITH_YOUR_PAYSTACK_PUBLIC_KEY";
const PAYSTACK_PUBLIC_KEY = "pk_live_35f814871b22cf97cf0fdf9007d2be2e82300aca";

// Web Push VAPID public key — identifies your server to browsers' push services so a
// push subscription can only be used by you, not anyone who happens to see the endpoint
// URL. Safe to ship client-side (that's the whole point of the public/private split).
// This one was freshly generated for you — pair it with the matching VAPID_PRIVATE_KEY
// set as a Netlify env var for netlify/functions/send-reminders.js. Regenerate anytime
// with `npx web-push generate-vapid-keys` if you'd rather use your own.
//const VAPID_PUBLIC_KEY = "BCewO3bPQScLntwHiEpsHOCfNSPtl5I7CaqnbkE_dQk12bh9bbuyVsyYxAFkoNgifT1eD9wXTFyDfDksrvE1SsY";
const VAPID_PUBLIC_KEY = "BFedshU80TzJPnPEB0FQHUMpQ3CMxuA9ObT84auybyoLBwix2g8zvwf02j-tFlffG6OGA3Z-T7WxrcOx5l7pOwU";

// ── Theme system ────────────────────────────────────────────────────────────
// `C` is read all over the app as plain property access (C.bg, C.text, ...) at
// render time rather than being destructured once — so switching themes is just
// mutating the same object's values in place and re-rendering. No context or
// prop-drilling needed to reach every screen.
var THEMES = {
  dark: {
    name:"dark",
    bg: "#0A0F1E", card: "#111827", card2: "#1E293B",
    border: "rgba(255,255,255,0.06)", cyan: "#06B6D4",
    purple: "#A78BFA", amber: "#F59E0B", green: "#34D399",
    red: "#F87171", text: "#F1F5F9", muted: "#64748B", soft: "#94A3B8",
  },
  light: {
    name:"light",
    bg: "#F4F6FB", card: "#FFFFFF", card2: "#EEF1F8",
    border: "rgba(15,23,42,0.08)", cyan: "#0891B2",
    purple: "#7C3AED", amber: "#D97706", green: "#059669",
    red: "#DC2626", text: "#0F172A", muted: "#64748B", soft: "#334155",
  },
};
function loadSavedThemeName(){
  try{ var t = localStorage.getItem("jotting_theme"); return (t==="light"||t==="dark") ? t : "dark"; }
  catch(e){ return "dark"; }
}
// Mutable — kept as the same object reference for the whole app's lifetime so every
// screen's C.xxx lookups automatically pick up the latest colors after a theme switch.
var C = { ...THEMES[loadSavedThemeName()] };
function applyTheme(name){
  Object.assign(C, THEMES[name] || THEMES.dark);
}

// ── Subscription plans & AI credit costs ───────────────────────────────────────
// Adding a new plan later is just adding a new key here — nothing else needs to change.
// IMPORTANT: netlify/functions/generate.js keeps its own matching copy of the credit
// allocations (server-side enforcement can't trust anything sent from the browser),
// so if you change numbers here, update that file too.
const PLANS = {
  free:    { id:"free",    name:"Free",    priceMonthly:0,   priceYearly:0,     monthlyCredits:60,   color:C.muted,  tagline:"Get started",          features:["Unlimited notes & Library","60 AI credits / month","Voice recording & transcription","AI Chat, Scan Doc & quizzes"] },
  pro:     { id:"pro",     name:"Pro",     priceMonthly:550, priceYearly:5500,  monthlyCredits:400,  color:C.cyan,   tagline:"For regular studying",   features:["Everything in Free","400 AI credits / month","Faster, priority AI responses","Priority support","AI Study Planner","Advanced AI Tutor","Advanced Analytics","More cloud storage"] },
  premium: { id:"premium", name:"Premium", priceMonthly:1500,priceYearly:15000, monthlyCredits:1500, color:C.purple, tagline:"For serious exam prep",  features:["Everything in Pro","1,500 AI credits / month","Exam Mode","Maximum storage"] },
};
const LOW_CREDIT_WARNING_THRESHOLD = 10;

async function getIdToken(){
  try{ return auth.currentUser ? await auth.currentUser.getIdToken() : null; }catch(e){ return null; }
}

// ── Paystack checkout ────────────────────────────────────────────────────────
// Loads Paystack's inline popup script on demand (only when a student actually opens
// the pricing page) instead of a new npm dependency — keeps the single-file setup
// simple and avoids paying the script's load cost for students who never upgrade.
var paystackScriptPromise = null;
function loadPaystackScript(){
  if (paystackScriptPromise) return paystackScriptPromise;
  paystackScriptPromise = new Promise(function(resolve, reject){
    if (window.PaystackPop) { resolve(); return; }
    var s = document.createElement("script");
    s.src = "https://js.paystack.co/v1/inline.js";
    s.onload = function(){ resolve(); };
    s.onerror = function(){ paystackScriptPromise = null; reject(new Error("Couldn't load the payment window — check your connection.")); };
    document.body.appendChild(s);
  });
  return paystackScriptPromise;
}

// Talks to the server-side subscription manager (netlify/functions/manage-subscription.js).
// This is the ONLY place plan/credits ever change — same "server is the sole writer to
// accounts/{uid}" rule the AI credit system already follows, so a payment can't be faked
// by editing anything in the browser.
async function callSubscriptionApi(payload){
  var idToken = await getIdToken();
  var res = await fetch("/api/manage-subscription", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ idToken:idToken, ...payload })
  });
  var data = await res.json();
  if (!res.ok) throw new Error((data&&data.error)||"Something went wrong");
  return data;
}

// ── Background push notifications ────────────────────────────────────────────
// The in-app reminder checks (Study/Daily/Assignment/Recording) only run while a tab
// is open, since they're plain JS on a timer. Real "even when the app is fully closed"
// delivery needs three parts working together:
//   1. A service worker (public/sw.js) that can receive push events without the app open
//   2. A push subscription for this browser/device, stored in Firestore so the server
//      can address it later (pushSubscriptions/{uid} — safe for the client to write
//      directly, unlike accounts/{uid}: a subscription can only be used to send THIS
//      device notifications, there's no credit/plan fraud risk in owning one)
//   3. netlify/functions/send-reminders.js running on a schedule, doing the same
//      eligibility checks server-side and calling the Web Push API directly

// Converts a base64url VAPID key into the Uint8Array format PushManager.subscribe expects.
function urlBase64ToUint8Array(base64String) {
  var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  var rawData = window.atob(base64);
  var outputArray = new Uint8Array(rawData.length);
  for (var i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function registerServiceWorker(onUpdateAvailable){
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register("/sw.js").then(function(reg){
    // A new version may already be sitting there waiting (e.g. it finished installing
    // while this tab was in the background) — surface that immediately too.
    if (reg.waiting && navigator.serviceWorker.controller) { onUpdateAvailable && onUpdateAvailable(reg); }
    reg.addEventListener("updatefound", function(){
      var installing = reg.installing;
      if (!installing) return;
      installing.addEventListener("statechange", function(){
        // "installed" + an existing controller means this is an UPDATE to an app that
        // was already running, not the very first install — that distinction matters so
        // brand-new users never see an "update available" prompt for nothing.
        if (installing.state==="installed" && navigator.serviceWorker.controller) {
          onUpdateAvailable && onUpdateAvailable(reg);
        }
      });
    });
    return reg;
  }).catch(function(e){ console.error("Service worker registration failed:", e); return null; });
}

// Subscribes this device to push and saves the subscription so the scheduled server
// function can find it later. Returns true on success so the caller can reflect it in UI.
async function subscribeToPush(uid){
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("Push notifications aren't supported in this browser.");
  if (Notification.permission === "default") await Notification.requestPermission();
  if (Notification.permission !== "granted") throw new Error("Notification permission was not granted.");
  var reg = await navigator.serviceWorker.ready;
  var existing = await reg.pushManager.getSubscription();
  var sub = existing || await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:urlBase64ToUint8Array(VAPID_PUBLIC_KEY) });
  var subId = simpleHash(sub.endpoint); // stable per-device doc id, lets one account have several devices
  await setDoc(doc(db, "pushSubscriptions", uid+"_"+subId), { uid:uid, subscription:sub.toJSON(), updatedAt:Date.now() });
  return true;
}

async function unsubscribeFromPush(uid){
  if (!("serviceWorker" in navigator)) return;
  var reg = await navigator.serviceWorker.ready.catch(function(){ return null; });
  if (!reg) return;
  var sub = await reg.pushManager.getSubscription();
  if (sub) {
    var subId = simpleHash(sub.endpoint);
    try{ await deleteDoc(doc(db, "pushSubscriptions", uid+"_"+subId)); }catch(e){}
    try{ await sub.unsubscribe(); }catch(e){}
  }
}

// Thrown when the secure proxy reports the user is out of AI credits, so screens can
// show the Upgrade page instead of a generic error message.
function OutOfCreditsError(remaining){
  var err = new Error("OUT_OF_CREDITS");
  err.code = "OUT_OF_CREDITS";
  err.remaining = remaining;
  return err;
}

// Gemini's servers occasionally return 503 (temporarily overloaded) — this retries
// a couple of times with a short growing delay before giving up for real.
async function fetchWithRetry(url, options, retries) {
  retries = retries==null ? 2 : retries;
  for (let attempt=0; attempt<=retries; attempt++) {
    var res = await fetch(url, options);
    if (res.status !== 503 || attempt===retries) return res;
    await new Promise(function(r){ setTimeout(r, 800*(attempt+1)); });
  }
}

// Every AI feature in the app calls this same secure endpoint instead of Gemini
// directly — the real API key lives only on the server (netlify/functions/generate.js),
// which also checks and deducts the student's AI credits before answering.
async function callProxy(action, payload, onCreditsUpdate) {
  var idToken = await getIdToken();
  var res = await fetchWithRetry("/api/generate", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ idToken:idToken, action:action, ...payload })
  });
  var data = await res.json();
  if (res.status===402 || (data&&data.error==="OUT_OF_CREDITS")) throw OutOfCreditsError(data&&data.remaining);
  if (!res.ok) throw new Error((data&&data.error)||"Something went wrong reaching SAM-X");
  if (onCreditsUpdate && data && typeof data.creditsRemaining==="number") onCreditsUpdate(data.creditsRemaining);
  var text = data&&data.candidates&&data.candidates[0]&&data.candidates[0].content&&data.candidates[0].content.parts&&data.candidates[0].content.parts[0]&&data.candidates[0].content.parts[0].text;
  if (!text) throw new Error("No response from SAM-X");
  return text;
}

// ── AI Settings: Writing Style / Summary Length / Response Language ────────────
// A tiny global object (same "set once in App, read everywhere" pattern as
// updateGlobalCredits/triggerUpgradeScreen below) so every screen's existing
// callGeminiText/callGeminiVision/callGeminiChatStream calls automatically pick this
// up — no need to touch AI Write, AI Chat, Study Planner, Flashcards, AI Tutor, etc.
// individually. Deliberately excluded from two actions where it would be actively
// wrong to apply: "transcribe" (must reproduce spoken audio faithfully, not translate
// or restyle it) and "pdf_analysis" (Scan Doc extracts a document's actual text —
// changing its language/style would corrupt what it's meant to capture).
var aiPreferences = { style:"Academic", length:"Medium", language:"English" };
var AI_STYLE_INSTRUCTIONS = {
  Academic: "Write in a formal, academic tone suitable for university-level study.",
  Simple: "Write in simple, plain language, as if explaining to someone new to the topic — short sentences, minimal jargon.",
  Detailed: "Write in a thorough, detailed way — don't skip nuance, include relevant context and examples.",
};
var AI_LENGTH_INSTRUCTIONS = {
  Short: "Keep your response concise — favor brevity over completeness.",
  Medium: "Use a moderate length — cover the essentials without padding.",
  Long: "Be thorough — don't cut length short if the topic warrants more detail.",
};
function buildPreferenceInstruction(action){
  if (action==="transcribe" || action==="pdf_analysis") return "";
  var parts = [];
  if (aiPreferences.style && AI_STYLE_INSTRUCTIONS[aiPreferences.style]) parts.push(AI_STYLE_INSTRUCTIONS[aiPreferences.style]);
  if (aiPreferences.length && AI_LENGTH_INSTRUCTIONS[aiPreferences.length]) parts.push(AI_LENGTH_INSTRUCTIONS[aiPreferences.length]);
  if (aiPreferences.language && aiPreferences.language!=="English") {
    parts.push("Respond in "+aiPreferences.language+" for any natural-language text you write. If asked to return JSON, you must still return ONLY valid JSON using the exact structure and key names requested — only translate/adjust the text VALUES inside it, never the keys or the format.");
  }
  return parts.join(" ");
}

async function callGeminiText(promptText, maxTokens, action) {
  var pref = buildPreferenceInstruction(action);
  var finalPrompt = pref ? (pref+"\n\n"+promptText) : promptText;
  return await callProxy(action||"chat", { contents:[{role:"user",parts:[{text:finalPrompt}]}], maxTokens:maxTokens||800 }, updateGlobalCredits);
}

// Full multi-turn chat: `contents` is the whole conversation so far (each turn
// {role:"user"|"model", parts:[{text}]}), so SAM-X actually remembers context
// across messages instead of treating every question in isolation.
// The real Gemini key can't be relayed as a raw token-stream through a standard
// serverless function, so the proxy returns the complete answer in one shot and
// this reveals it word-by-word client-side — same smooth feel, secure underneath.
async function callGeminiChatStream(contents, systemInstruction, onChunk, signal, maxTokens, action) {
  var pref = buildPreferenceInstruction(action);
  var combinedSystemInstruction = pref ? ((systemInstruction||"")+" "+pref).trim() : systemInstruction;
  var text = await callProxy(action||"chat", { contents:contents, systemInstruction:combinedSystemInstruction, maxTokens:maxTokens||1200 }, updateGlobalCredits);
  var words = text.split(" ");
  var acc = "";
  for (var i=0;i<words.length;i++){
    if (signal && signal.aborted) { var abortErr=new Error("Aborted"); abortErr.name="AbortError"; throw abortErr; }
    acc += (i===0?"":" ") + words[i];
    onChunk(acc);
    await new Promise(function(r){ setTimeout(r, 16); });
  }
  return acc;
}

async function callGeminiVision(base64, mediaType, promptText, maxTokens, action) {
  var pref = buildPreferenceInstruction(action);
  var finalPrompt = pref ? (pref+"\n\n"+promptText) : promptText;
  return await callProxy(action||"pdf_analysis", { contents:[{role:"user",parts:[{inline_data:{mime_type:mediaType,data:base64}},{text:finalPrompt}]}], maxTokens:maxTokens||1200 }, updateGlobalCredits);
}

// SAM-X can listen to real recorded audio directly and produce text from it —
// this powers the record-then-transcribe flow (full transcript / smart notes / summary).
// NOTE: this is always called with action "transcribe" in this app, so
// buildPreferenceInstruction() always returns "" here — verbatim transcription is
// never restyled or translated. Left as a real call (not hardcoded skip) so this stays
// correct automatically if a non-transcribe use of this helper is ever added later.
async function callGeminiAudio(base64, mediaType, promptText, maxTokens, action) {
  var pref = buildPreferenceInstruction(action);
  var finalPrompt = pref ? (pref+"\n\n"+promptText) : promptText;
  return await callProxy(action||"transcribe", { contents:[{role:"user",parts:[{inline_data:{mime_type:mediaType,data:base64}},{text:finalPrompt}]}], maxTokens:maxTokens||2000 }, updateGlobalCredits);
}

// A tiny global hook so any of the helpers above can push a fresh credit balance up
// to the App component after a successful call, without threading props through
// every single screen. Set once, in the App component, right after login.
var updateGlobalCredits = function(){};
// Same pattern: lets any screen jump straight to the upgrade page the moment a
// student runs out of credits, instead of every screen needing its own navigation logic.
var triggerUpgradeScreen = function(){};

// ── Firestore helpers ─────────────────────────────────────────────────────────
async function saveNoteToCloud(userId, note) {
  try {
    var writePromise = addDoc(collection(db, "notes"), { ...note, userId, createdAt: Date.now() });
    var timeoutPromise = new Promise(function(_, reject){ setTimeout(function(){ reject(new Error("Firestore write timed out")); }, 8000); });
    var docRef = await Promise.race([writePromise, timeoutPromise]);
    return docRef.id;
  } catch(e) { console.error("Save error:", e); return null; }
}

async function loadNotesFromCloud(userId) {
  try {
    var q = query(collection(db, "notes"), where("userId","==",userId));
    var snap = await getDocs(q);
    var list = snap.docs.map(function(d){ return {...d.data(), firestoreId:d.id}; });
    list.sort(function(a,b){ return (b.createdAt||0) - (a.createdAt||0); });
    return list;
  } catch(e) { console.error("Load error:", e); return []; }
}

async function deleteNoteFromCloud(firestoreId) {
  try { await deleteDoc(doc(db, "notes", firestoreId)); } catch(e) { console.error("Delete error:", e); }
}
async function updateNoteInCloud(firestoreId, fields) {
  await setDoc(doc(db, "notes", firestoreId), fields, { merge:true });
}

// ── Lecture Recordings (persistent audio library) ───────────────────────────────
// Every recording made inside the app is saved locally in this browser's IndexedDB and
// tracked as a small Firestore doc here (metadata only — title/course/duration/
// transcribed flag), so students can find, rename, delete, or transcribe it whenever
// they're ready, even after closing the app. Mirrors the notes/chats pattern above,
// except the actual AUDIO stays device-local instead of syncing to the cloud (see the
// "Local audio storage" section further down for why).
function guessAudioMime(filename){
  var ext = (filename.split(".").pop()||"").toLowerCase();
  if(ext==="mp3") return "audio/mpeg";
  if(ext==="wav") return "audio/wav";
  if(ext==="m4a") return "audio/mp4";
  return "";
}
async function saveRecordingMeta(userId, meta){
  try{ await setDoc(doc(db,"recordings",meta.id), {...meta, userId}); }catch(e){ console.error("Recording meta save error:", e); }
}
async function updateRecordingMeta(recordingId, fields){
  try{ await setDoc(doc(db,"recordings",recordingId), fields, {merge:true}); }catch(e){ console.error("Recording meta update error:", e); }
}
async function deleteRecordingMeta(recordingId){
  try{ await deleteDoc(doc(db,"recordings",recordingId)); }catch(e){ console.error("Recording meta delete error:", e); }
}
async function loadRecordingsFromCloud(userId){
  var q = query(collection(db,"recordings"), where("userId","==",userId));
  var snap = await getDocs(q);
  var list = snap.docs.map(function(d){ return d.data(); });
  list.sort(function(a,b){ return (b.createdAt||0)-(a.createdAt||0); });
  return list;
}
// ── Recording metadata: local durable cache — now IndexedDB via recordingsRepository ──
// Recording METADATA (title/course/duration/size/mimeType/transcribed/noteId) used
// to have a "jotting_recordings_{uid}" localStorage cache (the old
// loadRecordingsLocal/persistRecordingsLocal helpers that lived here). That cache
// has been replaced by recordingsRepository (src/repositories/recordingsRepository.js),
// which stores metadata in IndexedDB. This is METADATA ONLY — the actual audio
// Blobs still live exclusively in the separate jotting_audio_db further down
// (openAudioDb/saveAudioBlobLocal/etc.), completely untouched, and still never
// uploaded to Firebase. Firestore's "recordings" collection just above
// (saveRecordingMeta etc.) is also untouched and still the cloud source of truth.

var RECORDINGS_MIGRATION_FLAG_PREFIX = "jotting_recordings_migrated_";

// One-time per-user migration: copies whatever was sitting in the OLD localStorage
// metadata cache into the repository, then remembers it's done so this never
// re-scans localStorage for this user again. Deliberately does NOT delete the old
// "jotting_recordings_{uid}" key — left alone as an inert backup. Also deliberately
// does NOT touch jotting_audio_db in any way — audio was never in localStorage to
// begin with, so there's nothing audio-related to migrate here.
async function migrateRecordingsFromLocalStorage(uid){
  if (localStorage.getItem(RECORDINGS_MIGRATION_FLAG_PREFIX+uid) === "1") return; // already migrated

  var rawRecordings = [];
  try{
    var raw = localStorage.getItem("jotting_recordings_"+uid);
    var parsed = raw ? JSON.parse(raw) : [];
    rawRecordings = Array.isArray(parsed) ? parsed : [];
  }catch(e){
    console.error("Old recordings metadata cache was corrupt — skipping it (Firestore still has the real metadata):", e);
  }

  for (var i=0; i<rawRecordings.length; i++){
    var r = rawRecordings[i];
    if (!r || typeof r!=="object" || r.id==null) continue; // skip a corrupt/malformed entry without losing the rest
    try{
      var already = await recordingsRepository.get(r.id);
      if (!already) await recordingsRepository.create(r); // never overwrite something already migrated (or since changed)
    }catch(e){ console.error("Couldn't migrate recording metadata "+r.id+" — it's still safe in Firestore/the old cache:", e); }
  }

  try{ localStorage.setItem(RECORDINGS_MIGRATION_FLAG_PREFIX+uid, "1"); }catch(e){}
}

// Reconciles the repository with a freshly computed "merged" recordings list
// (local ∪ Firestore) — the same full-replace job persistRecordingsLocal used to
// do against localStorage: anything CONFIRMED no longer valid is removed
// locally too, everything else is written/updated.
//
// baselineIds: the ids recordingsRepository.list() returned at the very start
// of this login/reload cycle, BEFORE the Firestore fetch that produced
// `recordingsList` ran — same protection as assignmentsRepository's equivalent
// sync function, and for the same reason. This matters MORE here than
// anywhere else: a recording's metadata entry is the only thing that makes
// its audio Blob (in the separate jotting_audio_db) reachable at all. A
// student very often opens Jotting specifically to record a lecture — if
// this reconcile treats "not in my merge result yet" as "confirmed gone" and
// purges a just-saved recording's metadata, the actual audio bytes are left
// behind as an orphaned, unreachable Blob nobody can get back to. Only a
// record that was part of the STARTING snapshot and is now missing from
// `recordingsList` counts as "confirmed gone" (e.g. deleted on another
// device); anything created mid-cycle is left alone.
async function syncRecordingsToRepository(uid, recordingsList, baselineIds){
  var existing = await recordingsRepository.list(uid);
  var keepIds = {};
  recordingsList.forEach(function(r){ keepIds[r.id] = true; });
  var stale = existing.filter(function(r){ return baselineIds[r.id] && !keepIds[r.id]; });
  await Promise.all(stale.map(function(r){ return recordingsRepository.delete(r.id); }));
  await Promise.all(recordingsList.map(function(r){ return recordingsRepository.create(r); }));
}

// ── Local audio storage (IndexedDB) ─────────────────────────────────────────
// Recording AUDIO lives only in this browser's IndexedDB — not Firebase Cloud Storage,
// which needs the paid Blaze plan just to provision a bucket. localStorage can't be used
// instead: it's string-only and capped around 5-10MB total, nowhere near enough for
// audio blobs. IndexedDB has no such practical limit and stores Blobs natively.
// Trade-off, and it's a real one: audio is now DEVICE-LOCAL, not cloud-synced. Switching
// devices or clearing browser data loses the raw audio (though any notes/transcripts
// already generated from it stay completely safe in Firestore, same as always) —
// RecordingsScreen surfaces this to students directly so it isn't a silent surprise.
var AUDIO_DB_NAME = "jotting_audio_db";
var AUDIO_STORE_NAME = "recordings";
var audioDbPromise = null;
function openAudioDb(){
  if (audioDbPromise) return audioDbPromise;
  audioDbPromise = new Promise(function(resolve, reject){
    if (!("indexedDB" in window)) { reject(new Error("This browser doesn't support local audio storage.")); return; }
    var req = indexedDB.open(AUDIO_DB_NAME, 1);
    req.onupgradeneeded = function(){ req.result.createObjectStore(AUDIO_STORE_NAME); };
    req.onsuccess = function(){ resolve(req.result); };
    req.onerror = function(){ audioDbPromise = null; reject(req.error || new Error("Couldn't open local audio storage.")); };
  });
  return audioDbPromise;
}
async function saveAudioBlobLocal(recordingId, blob, mimeType){
  var idb = await openAudioDb();
  return new Promise(function(resolve, reject){
    var tx = idb.transaction(AUDIO_STORE_NAME, "readwrite");
    tx.objectStore(AUDIO_STORE_NAME).put({ blob:blob, mimeType:mimeType }, recordingId);
    tx.oncomplete = function(){ resolve(true); };
    tx.onerror = function(){ reject(tx.error || new Error("Couldn't save audio locally.")); };
  });
}
async function getAudioBlobLocal(recordingId){
  var idb = await openAudioDb();
  return new Promise(function(resolve, reject){
    var tx = idb.transaction(AUDIO_STORE_NAME, "readonly");
    var req = tx.objectStore(AUDIO_STORE_NAME).get(recordingId);
    req.onsuccess = function(){ resolve(req.result ? req.result.blob : null); };
    req.onerror = function(){ reject(req.error || new Error("Couldn't load audio.")); };
  });
}
async function deleteAudioBlobLocal(recordingId){
  try{
    var idb = await openAudioDb();
    return new Promise(function(resolve){
      var tx = idb.transaction(AUDIO_STORE_NAME, "readwrite");
      tx.objectStore(AUDIO_STORE_NAME).delete(recordingId);
      tx.oncomplete = function(){ resolve(true); };
      tx.onerror = function(){ resolve(false); };
    });
  }catch(e){ return false; }
}

// Notes store their real creation time in `id` (Date.now()) — this turns that into
// a human label that actually updates as time passes, instead of a frozen "Today".
function formatRelativeDate(ts) {
  if (!ts) return "";
  var now = new Date();
  var d = new Date(ts);
  var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  var startOfNoteDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  var dayDiff = Math.round((startOfToday - startOfNoteDay) / 86400000);
  if (dayDiff === 0) {
    var minsAgo = Math.floor((now.getTime() - ts) / 60000);
    if (minsAgo < 1) return "Just now";
    if (minsAgo < 60) return minsAgo + "m ago";
    return "Today";
  }
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff < 7) return dayDiff + " days ago";
  return d.toLocaleDateString(undefined, { month:"short", day:"numeric", year: d.getFullYear()!==now.getFullYear()?"numeric":undefined });
}

// ── Note export (PDF / Word) ────────────────────────────────────────────────
// A tiny hand-rolled Markdown reader shared by both formats — notes are plain
// Markdown strings (same content ReactMarkdown already renders in-app), and jsPDF/docx
// each need it broken into typed blocks (heading level, bullet, paragraph) rather than
// raw text, so headings/bullets actually look like headings/bullets in the exported file.
function parseMarkdownBlocks(markdown){
  var lines = (markdown||"").split("\n");
  var blocks = [];
  lines.forEach(function(line){
    var t = line.trim();
    if (!t) { blocks.push({type:"space"}); return; }
    if (/^### /.test(t)) { blocks.push({type:"h3", text:t.replace(/^### /,"")}); return; }
    if (/^## /.test(t)) { blocks.push({type:"h2", text:t.replace(/^## /,"")}); return; }
    if (/^# /.test(t)) { blocks.push({type:"h1", text:t.replace(/^# /,"")}); return; }
    if (/^[-*] /.test(t)) { blocks.push({type:"bullet", text:t.replace(/^[-*] /,"")}); return; }
    if (/^\d+\.\s/.test(t)) { blocks.push({type:"bullet", text:t.replace(/^\d+\.\s/,"")}); return; }
    blocks.push({type:"p", text:t});
  });
  return blocks;
}
// Strips inline emphasis markers (**bold**, *italic*, `code`) down to plain text — jsPDF/docx
// can't easily mix bold/italic runs mid-line without much more work, so this keeps exported
// text clean and readable rather than showing literal asterisks and backticks.
function stripInlineMd(text){
  return (text||"").replace(/\*\*(.*?)\*\*/g,"$1").replace(/\*(.*?)\*/g,"$1").replace(/`([^`]*)`/g,"$1");
}
function sanitizeFilename(name){
  return ((name||"export").replace(/[\\/:*?"<>|]/g,"").trim() || "export").slice(0,80);
}

// Dynamically imported (not a static top-of-file import) so jsPDF's ~200KB only loads
// for the students who actually use Export — everyone else's bundle stays smaller.
async function exportNotesToPDF(notesArr, docTitle){
  var mod = await import("jspdf");
  var JsPDF = mod.jsPDF || mod.default;
  var pdfDoc = new JsPDF({ unit:"pt", format:"a4" });
  var pageWidth = pdfDoc.internal.pageSize.getWidth();
  var pageHeight = pdfDoc.internal.pageSize.getHeight();
  var margin = 48;
  var maxWidth = pageWidth - margin*2;
  var y = margin;

  function ensureSpace(lineHeight){
    if (y + lineHeight > pageHeight - margin) { pdfDoc.addPage(); y = margin; }
  }
  function writeLines(text, fontSize, style, extraGap, indent){
    pdfDoc.setFont("helvetica", style||"normal");
    pdfDoc.setFontSize(fontSize);
    var lines = pdfDoc.splitTextToSize(text, maxWidth-(indent||0));
    lines.forEach(function(ln){
      ensureSpace(fontSize*1.35);
      pdfDoc.text(ln, margin+(indent||0), y);
      y += fontSize*1.35;
    });
    y += extraGap||0;
  }

  pdfDoc.setFont("helvetica","bold"); pdfDoc.setFontSize(20);
  pdfDoc.text(docTitle, margin, y); y += 28;
  pdfDoc.setFont("helvetica","normal"); pdfDoc.setFontSize(10); pdfDoc.setTextColor(120);
  pdfDoc.text("Exported from Jotting AI — "+new Date().toLocaleDateString(), margin, y); y += 26;
  pdfDoc.setTextColor(0);

  notesArr.forEach(function(note, idx){
    if (idx>0) { pdfDoc.addPage(); y = margin; }
    writeLines(note.title||"Untitled", 16, "bold", 4);
    writeLines((note.course||"General")+" · "+formatRelativeDate(note.id), 9, "italic", 14);
    if (note.type==="drawing") {
      writeLines("[Drawing note — open in Jotting AI to view]", 11, "italic", 0);
    } else {
      parseMarkdownBlocks(note.content).forEach(function(b){
        if (b.type==="space") { y += 6; return; }
        var clean = stripInlineMd(b.text);
        if (b.type==="h1") writeLines(clean, 15, "bold", 6);
        else if (b.type==="h2") writeLines(clean, 13, "bold", 5);
        else if (b.type==="h3") writeLines(clean, 12, "bold", 4);
        else if (b.type==="bullet") writeLines("•  "+clean, 11, "normal", 2, 14);
        else writeLines(clean, 11, "normal", 4);
      });
    }
  });

  pdfDoc.save(sanitizeFilename(docTitle)+".pdf");
}

// Same lazy-import approach as the PDF path. Produces a real, editable .docx — not a
// rasterized image — so students can keep annotating it after export.
async function exportNotesToDocx(notesArr, docTitle){
  var mod = await import("docx");
  var Document=mod.Document, Packer=mod.Packer, Paragraph=mod.Paragraph, TextRun=mod.TextRun, HeadingLevel=mod.HeadingLevel;
  var children = [];
  children.push(new Paragraph({ text:docTitle, heading:HeadingLevel.TITLE }));
  children.push(new Paragraph({ children:[new TextRun({text:"Exported from Jotting AI — "+new Date().toLocaleDateString(), italics:true, color:"888888"})] }));

  notesArr.forEach(function(note, idx){
    children.push(new Paragraph({ text:"", pageBreakBefore: idx>0 }));
    children.push(new Paragraph({ text:note.title||"Untitled", heading:HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({ children:[new TextRun({text:(note.course||"General")+" · "+formatRelativeDate(note.id), italics:true, color:"888888"})] }));
    if (note.type==="drawing") {
      children.push(new Paragraph({ text:"[Drawing note — open in Jotting AI to view]" }));
    } else {
      parseMarkdownBlocks(note.content).forEach(function(b){
        if (b.type==="space") { children.push(new Paragraph({text:""})); return; }
        var clean = stripInlineMd(b.text);
        if (b.type==="h1") children.push(new Paragraph({ text:clean, heading:HeadingLevel.HEADING_2 }));
        else if (b.type==="h2") children.push(new Paragraph({ text:clean, heading:HeadingLevel.HEADING_3 }));
        else if (b.type==="h3") children.push(new Paragraph({ text:clean, heading:HeadingLevel.HEADING_4 }));
        else if (b.type==="bullet") children.push(new Paragraph({ text:clean, bullet:{level:0} }));
        else children.push(new Paragraph({ text:clean }));
      });
    }
  });

  var wordDoc = new Document({ sections:[{ children:children }] });
  var blob = await Packer.toBlob(wordDoc);
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url; a.download = sanitizeFilename(docTitle)+".docx";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
}

// Small reusable "Export as PDF / Word" popup, used from both Library (multi-select)
// and NoteDetail (single note) so the interaction only needs to be built once.
function ExportPicker({ onExportPDF, onExportWord, label, compact }) {
  var [open, setOpen] = useState(false);
  var [busy, setBusy] = useState(false);
  async function run(fn){
    setBusy(true); setOpen(false);
    try{ await fn(); }catch(e){ console.error("Export failed:", e); alert("Couldn't export — make sure jspdf/docx are installed, then try again."); }
    setBusy(false);
  }
  var triggerStyle = compact
    ? { background:C.card2,border:"none",borderRadius:8,width:32,height:32,cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center" }
    : { background:C.card2,border:"1px solid "+C.border,borderRadius:8,padding:"6px 12px",color:C.text,fontSize:11,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:6,whiteSpace:"nowrap" };
  return (
    <div style={{ position:"relative" }}>
      <button onClick={function(){setOpen(!open);}} disabled={busy} title="Export" style={triggerStyle}>{busy?(compact?"⏳":"Exporting..."):(label||(compact?"📤":"📤 Export"))}</button>
      {open && !busy && (
        <>
          <div onClick={function(){setOpen(false);}} style={{ position:"fixed", inset:0, zIndex:29 }}/>
          <div style={{ position:"absolute", top:"110%", right:0, background:C.card, border:"1px solid "+C.border, borderRadius:10, boxShadow:"0 8px 24px rgba(0,0,0,0.4)", zIndex:30, minWidth:170, overflow:"hidden" }}>
            <button onClick={function(){run(onExportPDF);}} style={{ display:"block", width:"100%", textAlign:"left", padding:"11px 14px", background:"none", border:"none", color:C.text, fontSize:13, fontWeight:600, cursor:"pointer" }}>📄 Export as PDF</button>
            <button onClick={function(){run(onExportWord);}} style={{ display:"block", width:"100%", textAlign:"left", padding:"11px 14px", background:"none", border:"none", color:C.text, fontSize:13, fontWeight:600, cursor:"pointer", borderTop:"1px solid "+C.border }}>📝 Export as Word</button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Notes: local durable cache — now IndexedDB via notesRepository, not localStorage ──
// Notes used to have a "jotting_notes_{uid}" localStorage cache (the old
// loadNotesLocal/persistNotesLocal helpers that lived here). That cache has been
// replaced by notesRepository (src/repositories/notesRepository.js), which stores
// notes in IndexedDB. Nothing else about how notes work changes — Firestore is
// still the source of truth, still the thing that survives a wiped/private browser,
// and the merge-on-login logic below is the same, just reconciling against the
// repository instead of a localStorage blob.

var NOTES_MIGRATION_FLAG_PREFIX = "jotting_notes_migrated_";

// One-time per-user migration: copies whatever was sitting in the OLD localStorage
// note cache into the repository, then remembers it's done so this never re-scans
// localStorage for this user again. Deliberately does NOT delete the old
// "jotting_notes_{uid}" key — it's left alone as an inert backup, nothing reads or
// writes it going forward. Safe even with no old cache (fresh install/new device)
// or a corrupt one: either way nothing gets migrated, and Firestore (loaded right
// after this, in the effect below) still has every note that ever made it to the
// cloud regardless. The only notes truly at risk here are ones created while
// offline that never synced to Firestore yet — this is what carries those forward.
async function migrateNotesFromLocalStorage(uid){
  if (localStorage.getItem(NOTES_MIGRATION_FLAG_PREFIX+uid) === "1") return; // already migrated, nothing to do

  var rawNotes = [];
  try{
    var raw = localStorage.getItem("jotting_notes_"+uid);
    var parsed = raw ? JSON.parse(raw) : [];
    rawNotes = Array.isArray(parsed) ? parsed : [];
  }catch(e){
    console.error("Old note cache was corrupt — skipping it (Firestore still has the real notes):", e);
  }

  for (var i=0; i<rawNotes.length; i++){
    var n = rawNotes[i];
    if (!n || typeof n!=="object" || n.id==null) continue; // skip a corrupt/malformed entry without losing the rest
    try{
      var already = await notesRepository.get(n.id);
      if (!already) await notesRepository.create(n); // never overwrite something already migrated (or since changed)
    }catch(e){ console.error("Couldn't migrate note "+n.id+" — it's still safe in Firestore/the old cache:", e); }
  }

  try{ localStorage.setItem(NOTES_MIGRATION_FLAG_PREFIX+uid, "1"); }catch(e){}
}

// Reconciles the repository with a freshly computed "merged" notes list (unsynced
// local notes ∪ Firestore notes) — the same full-replace job persistNotesLocal used
// to do against localStorage: anything no longer in the merged list is removed
// locally too (e.g. deleted from another device), everything else is written/updated.
async function syncNotesToRepository(uid, notesList){
  var existing = await notesRepository.list(uid);
  var keepIds = {};
  notesList.forEach(function(n){ keepIds[n.id] = true; });
  var stale = existing.filter(function(n){ return !keepIds[n.id]; });
  await Promise.all(stale.map(function(n){ return notesRepository.delete(n.id); }));
  await Promise.all(notesList.map(function(n){ return notesRepository.create(n); }));
}

// ── Chat session persistence (SAM-X AI chat history) ───────────────────────────
// Each session keeps its own stable id (client-generated), so saving is just an
// upsert to that same Firestore doc — no separate firestoreId bookkeeping needed.
async function saveChatToCloud(userId, session) {
  await setDoc(doc(db, "chats", session.id), { ...session, userId });
}
async function loadChatsFromCloud(userId) {
  try {
    var q = query(collection(db, "chats"), where("userId","==",userId));
    var snap = await getDocs(q);
    var list = snap.docs.map(function(d){ return d.data(); });
    list.sort(function(a,b){ return (b.updatedAt||0) - (a.updatedAt||0); });
    return list;
  } catch(e) { console.error("Chat load error:", e); return []; }
}
async function deleteChatFromCloud(sessionId) {
  try { await deleteDoc(doc(db, "chats", sessionId)); } catch(e) { console.error("Chat delete error:", e); }
}
function loadChatsLocal(userId) {
  try {
    var raw = localStorage.getItem("jotting_chats_"+userId);
    return raw ? JSON.parse(raw) : [];
  } catch(e) { return []; }
}
function persistChatsLocal(userId, sessions) {
  try { localStorage.setItem("jotting_chats_"+userId, JSON.stringify(sessions)); } catch(e){}
}

// ── Assignments (due-date tracker behind the real "Assignment Reminder") ───────
async function saveAssignmentToCloud(userId, assignment) {
  try {
    var writePromise = addDoc(collection(db, "assignments"), { ...assignment, userId, createdAt: Date.now() });
    var timeoutPromise = new Promise(function(_, reject){ setTimeout(function(){ reject(new Error("Firestore write timed out")); }, 8000); });
    var docRef = await Promise.race([writePromise, timeoutPromise]);
    return docRef.id;
  } catch(e) { console.error("Assignment save error:", e); return null; }
}
async function loadAssignmentsFromCloud(userId) {
  var q = query(collection(db, "assignments"), where("userId","==",userId));
  var snap = await getDocs(q);
  var list = snap.docs.map(function(d){ return {...d.data(), firestoreId:d.id}; });
  list.sort(function(a,b){ return (a.dueDate||"").localeCompare(b.dueDate||""); });
  return list;
}
async function deleteAssignmentFromCloud(firestoreId) {
  try { await deleteDoc(doc(db, "assignments", firestoreId)); } catch(e) { console.error("Assignment delete error:", e); }
}
async function updateAssignmentInCloud(firestoreId, fields) {
  await setDoc(doc(db, "assignments", firestoreId), fields, { merge:true });
}
// ── Assignments: local durable cache — now IndexedDB via assignmentsRepository ─────
// Assignments used to have a "jotting_assignments_{uid}" localStorage cache (the old
// loadAssignmentsLocal/persistAssignmentsLocal helpers that lived here). That cache
// has been replaced by assignmentsRepository (src/repositories/assignmentsRepository.js),
// which stores assignments in IndexedDB. Nothing else changes — Firestore is still
// the source of truth, and the merge-on-login logic below is the same, just
// reconciling against the repository instead of a localStorage blob.

var ASSIGNMENTS_MIGRATION_FLAG_PREFIX = "jotting_assignments_migrated_";

// One-time per-user migration: copies whatever was sitting in the OLD localStorage
// assignment cache into the repository, then remembers it's done so this never
// re-scans localStorage for this user again. Deliberately does NOT delete the old
// "jotting_assignments_{uid}" key — left alone as an inert backup. Safe with no old
// cache, or a corrupt one: either way nothing gets migrated, and Firestore (loaded
// right after this, in the effect below) still has every assignment that ever made
// it to the cloud regardless — the only ones truly at risk here are assignments
// created while offline that never synced to Firestore yet.
async function migrateAssignmentsFromLocalStorage(uid){
  if (localStorage.getItem(ASSIGNMENTS_MIGRATION_FLAG_PREFIX+uid) === "1") return; // already migrated

  var rawAssignments = [];
  try{
    var raw = localStorage.getItem("jotting_assignments_"+uid);
    var parsed = raw ? JSON.parse(raw) : [];
    rawAssignments = Array.isArray(parsed) ? parsed : [];
  }catch(e){
    console.error("Old assignment cache was corrupt — skipping it (Firestore still has the real data):", e);
  }

  for (var i=0; i<rawAssignments.length; i++){
    var a = rawAssignments[i];
    if (!a || typeof a!=="object" || a.id==null) continue; // skip a corrupt/malformed entry without losing the rest
    try{
      var already = await assignmentsRepository.get(a.id);
      if (!already) await assignmentsRepository.create(a); // never overwrite something already migrated (or since changed)
    }catch(e){ console.error("Couldn't migrate assignment "+a.id+" — it's still safe in Firestore/the old cache:", e); }
  }

  try{ localStorage.setItem(ASSIGNMENTS_MIGRATION_FLAG_PREFIX+uid, "1"); }catch(e){}
}

// Reconciles the repository with a freshly computed "merged" assignments list
// (unsynced local ∪ Firestore) — the same full-replace job persistAssignmentsLocal
// used to do against localStorage: anything CONFIRMED no longer valid is removed
// locally too (e.g. deleted from another device), everything else written/updated.
//
// baselineIds: the ids assignmentsRepository.list() returned at the very start
// of this login/reload cycle, BEFORE the Firestore fetch that produced
// `assignmentsList` ran. Only a record that was part of THAT starting
// snapshot and is now missing from `assignmentsList` counts as "confirmed
// gone" and gets purged. A record NOT in the baseline — created locally
// while this reconcile was still in flight (e.g. the student added an
// assignment moments after opening the app) — is left alone even though
// this particular merge doesn't know about it yet. Not knowing about
// something yet is never the same as it being deleted; treating the two the
// same is what let a brand-new assignment get wiped from IndexedDB before it
// ever reached Firestore.
async function syncAssignmentsToRepository(uid, assignmentsList, baselineIds){
  var existing = await assignmentsRepository.list(uid);
  var keepIds = {};
  assignmentsList.forEach(function(a){ keepIds[a.id] = true; });
  var stale = existing.filter(function(a){ return baselineIds[a.id] && !keepIds[a.id]; });
  await Promise.all(stale.map(function(a){ return assignmentsRepository.delete(a.id); }));
  await Promise.all(assignmentsList.map(function(a){ return assignmentsRepository.create(a); }));
}

// ── Exam results (behind Advanced Analytics' score history) ────────────────────
// Exam Mode used to be entirely ephemeral — score shown once, then gone. Persisting a
// lightweight result doc per attempt is what makes "score trend over time" and
// "average by course" in Advanced Analytics real numbers instead of nothing.
async function saveExamResultToCloud(userId, result) {
  try {
    var docRef = await addDoc(collection(db, "examResults"), { ...result, userId, createdAt: Date.now() });
    return docRef.id;
  } catch(e) { console.error("Exam result save error:", e); return null; }
}
async function loadExamResultsFromCloud(userId) {
  try {
    var q = query(collection(db, "examResults"), where("userId","==",userId));
    var snap = await getDocs(q);
    var list = snap.docs.map(function(d){ return {...d.data(), firestoreId:d.id}; });
    list.sort(function(a,b){ return (b.createdAt||0)-(a.createdAt||0); });
    return list;
  } catch(e) { console.error("Exam results load error:", e); return []; }
}
function loadExamResultsLocal(userId) {
  try { var raw = localStorage.getItem("jotting_examResults_"+userId); return raw ? JSON.parse(raw) : []; } catch(e) { return []; }
}
function persistExamResultsLocal(userId, list) {
  try { localStorage.setItem("jotting_examResults_"+userId, JSON.stringify(list)); } catch(e){}
}

// ── Subscription account (plan + AI credits) ───────────────────────────────────
// Read-only by design: the client is never allowed to create or modify its own
// plan/credits document. The server (netlify/functions/generate.js, using the
// Firebase Admin SDK) is the only thing that creates this doc and changes credits —
// otherwise a technical user could just write themselves unlimited credits directly.
async function loadOrInitAccount(userId) {
  try {
    var ref = doc(db, "accounts", userId);
    var snap = await getDoc(ref);
    if (snap.exists()) return snap.data();
    return { plan:"free", credits:PLANS.free.monthlyCredits, creditsMonthKey:currentMonthKey() };
  } catch(e) { console.error("Account load error:", e); return { plan:"free", credits:PLANS.free.monthlyCredits, creditsMonthKey:currentMonthKey() }; }
}
function currentMonthKey(){ var d=new Date(); return d.getFullYear()+"-"+d.getMonth(); }

// ── Local plan entitlement (Paystack verification durability) ──────────────────
// loadOrInitAccount above is correctly Firestore-only for CREDITS — that's a
// metered, server-consumed resource, and the server must stay the sole writer.
// But it means the student's unlocked PLAN has exactly one path to survive a
// refresh or re-login: a specific Firestore write on the server completing
// successfully. If that write is ever delayed, dropped, or fails for any
// reason after a payment that genuinely WAS verified moments earlier
// (verifyAndApply below did get a success response from the server), the
// plan silently reverts to Free next time the account loads — the student
// paid, the payment was verified, and the app still shows them as Free.
//
// This is a local, durable record of a server-verified entitlement, so the
// unlock survives independently of that one Firestore write. It is written
// in exactly one place (verifyAndApply's success path) — directly after a
// genuine server verify_payment success — never from Paystack's own
// client-side popup callback alone, and never from merely tapping Upgrade.
// Firestore/loadOrInitAccount is untouched and still runs on every login;
// this only steps in when its result would otherwise contradict a payment
// this same device already had verified.
var PLAN_RANK = { free:0, pro:1, premium:2 };
// Shared "does this plan meet or exceed this tier" check, used by every feature
// gate below instead of each screen re-deriving its own plan==="premium" string
// comparison. Pass tier "pro" for a feature Pro-and-above can use (Advanced AI
// Tutor, AI Study Planner, Advanced Analytics); pass tier "premium" for a
// feature that stays genuinely Premium-only (Exam Mode).
function planAtLeast(plan, tier){ return (PLAN_RANK[plan]||0) >= (PLAN_RANK[tier]||0); }
function loadLocalEntitlement(userId){
  try{ var raw = localStorage.getItem("jotting_entitlement_"+userId); return raw ? JSON.parse(raw) : null; }
  catch(e){ return null; }
}
function persistLocalEntitlement(userId, entitlement){
  try{ localStorage.setItem("jotting_entitlement_"+userId, JSON.stringify(entitlement)); }catch(e){}
}
function clearLocalEntitlement(userId){
  try{ localStorage.removeItem("jotting_entitlement_"+userId); }catch(e){}
}
// Resolves the plan/credits to actually use at login: Firestore's account
// data, unless a locally-verified entitlement outranks it — the one case
// that matters is exactly the bug above (Firestore says Free, but this
// device verified a paid plan). A local entitlement can never rank BELOW
// what Firestore reports without an explicit downgrade clearing it (see
// startDowngrade in PricingScreen), so this never fights a Firestore value
// that's already correct or has since moved further ahead (e.g. upgraded
// again from a different device).
function resolveAccountWithLocalEntitlement(userId, account){
  var monthKey = currentMonthKey();
  var resolvedPlan = account.plan||"free";
  var displayCredits = account.creditsMonthKey !== monthKey
    ? (PLANS[resolvedPlan]||PLANS.free).monthlyCredits
    : (typeof account.credits==="number" ? account.credits : PLANS.free.monthlyCredits);
  var localEntitlement = loadLocalEntitlement(userId);
  if (localEntitlement && (PLAN_RANK[localEntitlement.plan]||0) > (PLAN_RANK[resolvedPlan]||0)) {
    resolvedPlan = localEntitlement.plan;
    // This branch only fires when Firestore's plan is STRICTLY lower-ranked
    // than the verified local entitlement — meaning Firestore's account doc
    // doesn't reflect this plan at all yet, so whatever credit number it
    // has belongs to that lower (wrong) plan and is never usable here,
    // current month or not. Always use the correct plan's own allotment.
    // (If Firestore ever does catch up and report this same plan, ranks
    // become equal, this branch stops firing, and Firestore's own
    // server-tracked live balance takes over naturally — see below.)
    displayCredits = localEntitlement.monthlyCredits;
  }
  return { plan:resolvedPlan, credits:displayCredits };
}

// ── Profile (school/faculty/department/level) + daily study streak ────────────
// Unlike credits, a streak is just a motivational number — no real harm if a
// student could nudge it, so this collection can be read/written directly by its
// own owner (unlike the locked-down `accounts` collection).
function dayKey(d){ d=d||new Date(); return d.getFullYear()+"-"+d.getMonth()+"-"+d.getDate(); }

async function loadOrInitProfile(userId) {
  try {
    var ref = doc(db, "profiles", userId);
    var snap = await getDoc(ref);
    var today = dayKey();
    if (!snap.exists()) {
      var fresh = { school:"", faculty:"", department:"", level:"", streak:1, lastActiveDay:today };
      await setDoc(ref, fresh);
      return fresh;
    }
    var data = snap.data();
    if (data.lastActiveDay !== today) {
      var yesterday = dayKey(new Date(Date.now()-86400000));
      var newStreak = data.lastActiveDay===yesterday ? (data.streak||0)+1 : 1;
      var updated = { ...data, streak:newStreak, lastActiveDay:today };
      await setDoc(ref, updated, { merge:true });
      return updated;
    }
    return data;
  } catch(e) { console.error("Profile load error:", e); return { school:"", faculty:"", department:"", level:"", streak:1, lastActiveDay:dayKey() }; }
}
async function saveProfileFields(userId, fields) {
  try { await setDoc(doc(db, "profiles", userId), fields, { merge:true }); } catch(e) { console.error("Profile save error:", e); }
}

// ── Notification Center ─────────────────────────────────────────────────────────
// Lightweight in-app notification feed — separate from browser push notifications
// (those are handled elsewhere for reminders). This is the bell icon's history list.
function loadNotifsLocal(userId) {
  try { var raw = localStorage.getItem("jotting_notifcenter_"+userId); return raw ? JSON.parse(raw) : []; } catch(e) { return []; }
}
function persistNotifsLocal(userId, list) {
  try { localStorage.setItem("jotting_notifcenter_"+userId, JSON.stringify(list)); } catch(e){}
}
function makeNotif(type, title, message, route){
  return { id:"n_"+Date.now()+"_"+Math.floor(Math.random()*1000), type:type, title:title, message:message, ts:Date.now(), read:false, route:route||null };
}

// ── PIN Lock (device-level convenience lock, not encryption) ───────────────────
// Deliberately NOT a security/encryption feature — it's a quick screen-lock so a
// classmate borrowing your phone for a second can't casually flip through your
// notes. The "hash" below is a simple non-cryptographic checksum, good enough to
// avoid storing the PIN in plain text locally, but it is not meant to resist a
// determined attacker. Real encryption would need proper key management and is
// listed as "Coming Soon" in Settings rather than faked here.
function simpleHash(str){
  var h=0; for(var i=0;i<str.length;i++){ h=((h<<5)-h+str.charCodeAt(i))|0; }
  return String(h);
}
function loadPrivacySettings(userId){
  try{ var raw=localStorage.getItem("jotting_privacy_"+userId); return raw?JSON.parse(raw):{pinEnabled:false,pinHash:"",autoLock:true,hiddenFolder:false}; }
  catch(e){ return {pinEnabled:false,pinHash:"",autoLock:true,hiddenFolder:false}; }
}
function persistPrivacySettings(userId, settings){
  try{ localStorage.setItem("jotting_privacy_"+userId, JSON.stringify(settings)); }catch(e){}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// ── Browser push notifications (for study reminders) ───────────────────────────
// Permission is now requested inside subscribeToPush() as part of the real push
// subscription flow, so there's no separate standalone "just ask permission" step.
function sendNotification(title, body){
  if ("Notification" in window && Notification.permission==="granted") {
    try{ new Notification(title, { body:body, icon:"/favicon.ico" }); }catch(e){}
  }
}

// ── LOCK SCREEN ───────────────────────────────────────────────────────────────
function LockScreen({ verifyPin, onUnlock, onForgot }) {
  var [pin, setPin] = useState("");
  var [error, setError] = useState("");
  function tap(d){
    if (pin.length>=4) return;
    var next = pin+d;
    setPin(next);
    setError("");
    if (next.length===4) {
      setTimeout(function(){
        if (verifyPin(next)) onUnlock();
        else { setError("Incorrect PIN"); setPin(""); }
      }, 150);
    }
  }
  return (
    <div style={{ height:"100dvh",background:"#06081A",display:"flex",justifyContent:"center",alignItems:"center",overflow:"hidden" }}>
      <div style={{ width:"100%",maxWidth:400,height:"100dvh",background:C.bg,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,boxSizing:"border-box" }}>
        <div style={{ fontSize:52,marginBottom:16 }}>🔒</div>
        <div style={{ fontWeight:800,fontSize:18,color:C.text,marginBottom:20 }}>Enter your PIN</div>
        <div style={{ display:"flex",gap:12,marginBottom:24 }}>
          {[0,1,2,3].map(function(i){return<div key={i} style={{ width:16,height:16,borderRadius:"50%",background:pin.length>i?C.cyan:C.card2,border:"1px solid "+C.border }}/>;})}
        </div>
        {error&&<div style={{ color:C.red,fontSize:13,fontWeight:700,marginBottom:14 }}>{error}</div>}
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14,marginBottom:20 }}>
          {["1","2","3","4","5","6","7","8","9","","0","⌫"].map(function(k,i){
            if(k==="") return <div key={i}/>;
            return <button key={i} onClick={function(){ k==="⌫" ? setPin(function(p){return p.slice(0,-1);}) : tap(k); }} style={{ width:60,height:60,borderRadius:"50%",background:C.card,border:"1px solid "+C.border,color:C.text,fontSize:20,fontWeight:700,cursor:"pointer" }}>{k}</button>;
          })}
        </div>
        <button onClick={onForgot} style={{ background:"none",border:"none",color:C.muted,fontSize:13,fontWeight:600,cursor:"pointer" }}>Forgot PIN? Log out</button>
      </div>
    </div>
  );
}

function Wave({ active, color, size }) {
  var c=color||"#06B6D4"; var s=size||1;
  return (
    <div style={{ display:"flex",alignItems:"center",gap:2.5,height:20*s }}>
      {[0.5,1,1.6,1,0.7,1.4,0.9,1.2,0.6,1.1,0.8].map(function(h,i){
        return <div key={i} style={{ width:2.5*s,borderRadius:99,background:active?c:"#374151",height:active?(h*16*s)+"px":(3*s)+"px",transition:"height 0.3s ease",animation:active?("wv "+(0.35+i*0.07)+"s ease-in-out infinite alternate"):"none" }}/>;
      })}
    </div>
  );
}

function Toggle({ value, onChange, color }) {
  var c=color||"#06B6D4";
  return (
    <div onClick={function(){onChange(!value);}} style={{ width:46,height:26,borderRadius:13,background:value?c:"#374151",cursor:"pointer",position:"relative",transition:"background 0.25s",flexShrink:0 }}>
      <div style={{ position:"absolute",top:3,left:value?23:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left 0.25s" }}/>
    </div>
  );
}

function Row({ icon, label, sub, right, danger, onPress }) {
  return<div onClick={onPress} style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:"13px 0",borderBottom:"1px solid "+C.border,cursor:onPress?"pointer":"default" }}><div style={{ display:"flex",alignItems:"center",gap:10 }}>{icon&&<span style={{ fontSize:18 }}>{icon}</span>}<div><div style={{ fontSize:14,fontWeight:600,color:danger?C.red:C.text }}>{label}</div>{sub&&<div style={{ fontSize:11,color:C.muted,marginTop:1 }}>{sub}</div>}</div></div>{right!==undefined?right:<span style={{ color:C.muted,fontSize:16 }}>›</span>}</div>;
}

var backBtn = { background:"rgba(255,255,255,0.08)",border:"none",borderRadius:10,width:36,height:36,cursor:"pointer",color:"#fff",fontSize:18,display:"flex",alignItems:"center",justifyContent:"center" };
function actionBtn(color){ return { background:color+"15",border:"1px solid "+color+"40",borderRadius:12,padding:"12px",fontSize:13,fontWeight:700,color:color,cursor:"pointer",fontFamily:"inherit" }; }

// ── Shared Course picker (real Course IDs) ──────────────────────────────────
// One picker, used everywhere a screen previously had its own ad-hoc course
// list — VoiceNoteScreen's own working-but-ephemeral "+Add Course" (never
// persisted, reset on remount), ScanDocScreen/DrawScreen/CreateNoteScreen/
// AIWriteScreen's fully hardcoded ["General","PHY 101",...] arrays (unrelated
// to the student's real data), and AssignmentsScreen/StudyPlannerScreen/
// ExamModeScreen's note-derived-only lists. That fragmentation — seven
// independent course-list derivations, only one of which ever wrote anywhere
// real — is exactly what real Course records (coursesRepository) fix.
//
// `realCourses` — the actual persisted Course records (App's `courses` state).
// `legacyNames` — optional plain-text course names from existing notes/
// assignments/recordings that predate real Course records — still shown so
// nothing a student already typed disappears from any picker, purely additive
// display, never written back as a Course unless the student explicitly adds it.
// `value`/`onSelect` for single-select; `values`/`onToggle` for multi-select
// (StudyPlannerScreen). `onCreateCourse(codeText)` calls App's real addCourse
// handler — from here on, "Add Course" persists for real instead of resetting
// the moment the screen unmounts.
//
// Deliberately NO inline delete/remove chip here (VoiceNoteScreen's old
// removeCourse() only ever deleted from that screen's own local, ephemeral
// list — harmless). A real Course is a persisted entity now; removing one is a
// deliberate action that belongs in a dedicated course-management surface, not
// a stray "X" a student can tap by accident while jotting a lecture note.
// updateCourseRecord/deleteCourseRecord already exist at the App level, ready
// for that surface whenever it's built — just not wired to any UI yet.
function CourseChipPicker({ realCourses, legacyNames, value, values, multi, onSelect, onToggle, onCreateCourse, color }){
  var accent = color || C.cyan;
  var [showAdd, setShowAdd] = useState(false);
  var [draft, setDraft] = useState("");
  var realNames = (realCourses||[]).map(function(c){ return c.code || c.title; }).filter(Boolean);
  var allNames = Array.from(new Set(["General"].concat(realNames).concat(legacyNames||[])));
  var isSelected = multi
    ? function(n){ return (values||[]).includes(n); }
    : function(n){ return value===n; };
  function pick(n){ multi ? onToggle(n) : onSelect(n); }
  async function submitAdd(){
    var code = draft.trim().toUpperCase();
    if (!code) return;
    if (allNames.includes(code)) { pick(code); setDraft(""); setShowAdd(false); return; }
    var created = await onCreateCourse(code);
    pick(code);
    setDraft(""); setShowAdd(false);
    return created;
  }
  return (
    <div>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
        <span style={{ fontSize:13,fontWeight:700,color:C.soft }}>{multi?"Select Courses":"Select Course"}</span>
        <button onClick={function(){setShowAdd(function(s){return !s;});}} style={{ background:accent+"20",border:"1px solid "+accent+"40",borderRadius:8,padding:"5px 12px",color:accent,fontSize:12,fontWeight:700,cursor:"pointer" }}>+ Add Course</button>
      </div>
      {showAdd&&(<div style={{ background:C.card2,borderRadius:14,padding:14,marginBottom:12,border:"1px solid "+accent+"30" }}><div style={{ display:"flex",gap:8 }}><input value={draft} onChange={function(e){setDraft(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")submitAdd();}} placeholder="e.g. BIO 201" style={{ flex:1,padding:"10px 14px",borderRadius:10,border:"1px solid "+C.border,background:C.bg,color:C.text,outline:"none",fontSize:14 }}/><button onClick={submitAdd} style={{ background:accent,border:"none",borderRadius:10,padding:"10px 16px",color:"#0A0F1E",fontWeight:800,cursor:"pointer" }}>Add</button><button onClick={function(){setShowAdd(false);}} style={{ background:C.card,border:"1px solid "+C.border,borderRadius:10,padding:"10px 12px",color:C.muted,cursor:"pointer" }}>X</button></div></div>)}
      <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>{allNames.map(function(n){ var sel=isSelected(n); return(
        <button key={n} onClick={function(){pick(n);}} style={{ padding:"7px 14px",borderRadius:99,border:"2px solid",borderColor:sel?accent:C.border,background:sel?accent:C.card,color:sel?"#0A0F1E":C.muted,fontSize:12,fontWeight:700,cursor:"pointer" }}>{n}</button>
      );})}</div>
    </div>
  );
}

// ── ONBOARDING SCREEN ─────────────────────────────────────────────────────────
function OnboardingScreen({ onDone }) {
  var [page, setPage] = useState(0);
  var pages = [
    { icon:"🎵", iconImg:"/jotting-logo.png", title:"Welcome to Jotting AI", desc:"The smartest note-taking app for Nigerian university students", color:"#06B6D4", bg:"linear-gradient(135deg,#0A0F1E,#1E1B4B)" },
    { icon:"🎙️", title:"Record Your Lectures", desc:"Record your lecturer's voice and our AI converts it to perfect notes automatically", color:"#A78BFA", bg:"linear-gradient(135deg,#0A0F1E,#1E0B4B)" },
    { icon:"🤖", iconImg:"/samx-logo.png", title:"AI-Powered Learning", desc:"Get instant summaries, quizzes, and flashcards from your notes using SAM-X AI", color:"#34D399", bg:"linear-gradient(135deg,#0A0F1E,#0B1E1B)" },
    { icon:"📚", title:"Study Smarter", desc:"Library, Dashboard, Push Notifications — everything you need to ace your exams", color:"#F59E0B", bg:"linear-gradient(135deg,#0A0F1E,#1E1A0A)" },
  ];
  var p = pages[page];
  return (
    <div style={{ flex:1,background:p.bg,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,textAlign:"center" }}>
      {p.iconImg
        ? <div style={{ width:96,height:96,borderRadius:26,overflow:"hidden",marginBottom:24 }}><img src={p.iconImg} alt="" style={{ width:"100%",height:"100%",objectFit:"cover" }}/></div>
        : <div style={{ fontSize:80,marginBottom:24 }}>{p.icon}</div>}
      <h1 style={{ color:C.text,fontSize:26,fontWeight:800,margin:"0 0 14px",letterSpacing:-0.5 }}>{p.title}</h1>
      <p style={{ color:C.muted,fontSize:15,lineHeight:1.7,margin:"0 0 40px" }}>{p.desc}</p>
      {/* Dots */}
      <div style={{ display:"flex",gap:8,marginBottom:40 }}>
        {pages.map(function(_,i){ return <div key={i} style={{ width:i===page?24:8,height:8,borderRadius:4,background:i===page?p.color:"rgba(255,255,255,0.2)",transition:"all 0.3s" }}/>; })}
      </div>
      <button onClick={function(){ if(page<pages.length-1){setPage(page+1);}else{onDone();} }} style={{ width:"100%",background:"linear-gradient(135deg,"+p.color+","+C.purple+")",color:"#fff",border:"none",borderRadius:16,padding:"16px",fontWeight:800,fontSize:16,cursor:"pointer",boxShadow:"0 8px 32px rgba(6,182,212,0.3)" }}>
        {page<pages.length-1?"Next →":"Get Started 🚀"}
      </button>
      {page<pages.length-1&&(
        <button onClick={onDone} style={{ background:"none",border:"none",color:C.muted,cursor:"pointer",marginTop:16,fontSize:14,fontWeight:600 }}>Skip</button>
      )}
    </div>
  );
}

// ── LOGIN SCREEN ──────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  var [mode, setMode] = useState("login"); // login | signup | forgot
  var [name, setName] = useState("");
  var [email, setEmail] = useState("");
  var [password, setPassword] = useState("");
  var [loading, setLoading] = useState(false);
  var [error, setError] = useState("");
  var [success, setSuccess] = useState("");
  var [showPass, setShowPass] = useState(false);

  function getErrorMsg(code) {
    var msgs = {
      "auth/email-already-in-use": "This email is already registered. Try logging in!",
      "auth/invalid-email": "Please enter a valid email address.",
      "auth/weak-password": "Password must be at least 6 characters.",
      "auth/user-not-found": "No account found with this email.",
      "auth/wrong-password": "Incorrect password. Try again!",
      "auth/too-many-requests": "Too many attempts. Please wait and try again.",
      "auth/network-request-failed": "No internet connection. Check your network.",
      "auth/popup-closed-by-user": "Google sign-in was cancelled.",
      "auth/popup-blocked": "Your browser blocked the sign-in popup. Please allow popups for this site and try again.",
      "auth/cancelled-popup-request": "Please wait for the current sign-in attempt to finish before trying again.",
      "auth/account-exists-with-different-credential": "This email is already registered with a password. Try logging in with your email and password instead.",
    };
    return msgs[code] || "Something went wrong. Please try again.";
  }

  async function handleEmailAuth() {
    if (!email.trim() || !password.trim()) { setError("Please fill in all fields!"); return; }
    if (mode==="signup" && !name.trim()) { setError("Please enter your name!"); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters!"); return; }
    setLoading(true); setError(""); setSuccess("");
    try {
      if (mode === "signup") {
        var cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await updateProfile(cred.user, { displayName: name.trim() });
        try{ await sendEmailVerification(cred.user); }catch(e){ console.error("Verification email send failed:", e); }
        setSuccess("Account created! We've sent a verification link to your email.");
        onLogin(cred.user, { justSignedUp:true });
      } else {
        var loginCred = await signInWithEmailAndPassword(auth, email.trim(), password);
        onLogin(loginCred.user);
      }
    } catch(e) {
      setError(getErrorMsg(e.code));
    }
    setLoading(false);
  }

  async function handleGoogle() {
    setLoading(true); setError(""); setSuccess("");
    try {
      var result = await signInWithPopup(auth, googleProvider);
      onLogin(result.user);
    } catch(e) {
      // Some hosting setups (Netlify's default headers among them) send a
      // Cross-Origin-Opener-Policy that blocks the channel Firebase uses to
      // confirm the popup's result, so it falls back to polling
      // window.closed — which COOP also blocks — and reports
      // "popup-closed-by-user" even when sign-in genuinely succeeded and
      // Firebase's own auth state already updated. Trusting that code at
      // face value was showing "cancelled" for logins that actually worked.
      // auth.currentUser reflects Firebase's real internal state regardless
      // of whether the popup could report back, so check that before
      // concluding the person actually cancelled.
      if (e.code==="auth/popup-closed-by-user" && auth.currentUser) {
        onLogin(auth.currentUser);
      } else {
        setError(getErrorMsg(e.code));
      }
    }
    setLoading(false);
  }

  async function handleForgot() {
    if (!email.trim()) { setError("Enter your email address first!"); return; }
    setLoading(true); setError(""); setSuccess("");
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setSuccess("Password reset email sent! Check your inbox.");
    } catch(e) {
      setError(getErrorMsg(e.code));
    }
    setLoading(false);
  }

  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      {/* Header */}
      <div style={{ background:"linear-gradient(135deg,#0A0F1E,#1E1B4B)",padding:"40px 24px 32px",textAlign:"center" }}>
        <div style={{ width:70,height:70,borderRadius:20,overflow:"hidden",margin:"0 auto 16px" }}><img src="/jotting-logo.png" alt="Jotting AI" style={{ width:"100%",height:"100%",objectFit:"cover" }}/></div>
        <h1 style={{ color:C.text,fontSize:26,fontWeight:800,margin:"0 0 6px" }}>Jotting <span style={{ color:C.cyan }}>AI</span></h1>
        <p style={{ color:C.muted,fontSize:13,margin:0 }}>Smart notes for Nigerian students</p>
      </div>

      <div style={{ flex:1,overflowY:"auto",padding:24 }}>
        {/* Tab switcher */}
        {mode!=="forgot"&&(
          <div style={{ display:"flex",background:C.card,borderRadius:14,padding:4,marginBottom:24 }}>
            <button onClick={function(){setMode("login");setError("");setSuccess("");}} style={{ flex:1,padding:"11px",borderRadius:11,border:"none",background:mode==="login"?"linear-gradient(135deg,#06B6D4,#A78BFA)":"transparent",color:mode==="login"?"#fff":C.muted,fontWeight:700,fontSize:14,cursor:"pointer" }}>Log In</button>
            <button onClick={function(){setMode("signup");setError("");setSuccess("");}} style={{ flex:1,padding:"11px",borderRadius:11,border:"none",background:mode==="signup"?"linear-gradient(135deg,#06B6D4,#A78BFA)":"transparent",color:mode==="signup"?"#fff":C.muted,fontWeight:700,fontSize:14,cursor:"pointer" }}>Sign Up</button>
          </div>
        )}

        {mode==="forgot"&&(
          <div style={{ marginBottom:24 }}>
            <button onClick={function(){setMode("login");setError("");setSuccess("");}} style={{ background:"none",border:"none",color:C.cyan,cursor:"pointer",fontSize:14,fontWeight:700,display:"flex",alignItems:"center",gap:6,padding:0 }}>← Back to Login</button>
            <h2 style={{ color:C.text,fontSize:20,fontWeight:800,margin:"16px 0 6px" }}>Reset Password</h2>
            <p style={{ color:C.muted,fontSize:13,margin:0 }}>Enter your email and we will send a reset link</p>
          </div>
        )}

        {/* Name field (signup only) */}
        {mode==="signup"&&(
          <div style={{ marginBottom:14 }}>
            <label style={{ fontSize:12,fontWeight:700,color:C.soft,display:"block",marginBottom:6 }}>FULL NAME</label>
            <input value={name} onChange={function(e){setName(e.target.value);}} placeholder="e.g. Samuel Oluwaseun" style={{ width:"100%",padding:"14px 16px",borderRadius:12,border:"1px solid "+C.border,fontSize:14,background:C.card,color:C.text,outline:"none",boxSizing:"border-box" }}/>
          </div>
        )}

        {/* Email */}
        <div style={{ marginBottom:14 }}>
          <label style={{ fontSize:12,fontWeight:700,color:C.soft,display:"block",marginBottom:6 }}>EMAIL ADDRESS</label>
          <input value={email} onChange={function(e){setEmail(e.target.value);}} type="email" placeholder="samuel@gmail.com" style={{ width:"100%",padding:"14px 16px",borderRadius:12,border:"1px solid "+C.border,fontSize:14,background:C.card,color:C.text,outline:"none",boxSizing:"border-box" }}/>
        </div>

        {/* Password */}
        {mode!=="forgot"&&(
          <div style={{ marginBottom:8 }}>
            <label style={{ fontSize:12,fontWeight:700,color:C.soft,display:"block",marginBottom:6 }}>PASSWORD</label>
            <div style={{ position:"relative" }}>
              <input value={password} onChange={function(e){setPassword(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")handleEmailAuth();}} type={showPass?"text":"password"} placeholder="At least 6 characters" style={{ width:"100%",padding:"14px 50px 14px 16px",borderRadius:12,border:"1px solid "+C.border,fontSize:14,background:C.card,color:C.text,outline:"none",boxSizing:"border-box" }}/>
              <button onClick={function(){setShowPass(!showPass);}} style={{ position:"absolute",right:14,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",fontSize:18,color:C.muted }}>
                {showPass?"🙈":"👁️"}
              </button>
            </div>
          </div>
        )}

        {/* Forgot password link */}
        {mode==="login"&&(
          <button onClick={function(){setMode("forgot");setError("");setSuccess("");}} style={{ background:"none",border:"none",color:C.cyan,cursor:"pointer",fontSize:12,fontWeight:600,padding:"4px 0",marginBottom:20,display:"block" }}>
            Forgot password?
          </button>
        )}

        {mode!=="login"&&<div style={{ marginBottom:20 }}/>}

        {/* Error / Success messages */}
        {error&&(
          <div style={{ background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:13,color:C.red,fontWeight:600 }}>
            ⚠️ {error}
          </div>
        )}
        {success&&(
          <div style={{ background:"rgba(52,211,153,0.1)",border:"1px solid rgba(52,211,153,0.3)",borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:13,color:C.green,fontWeight:600 }}>
            ✅ {success}
          </div>
        )}

        {/* Main action button */}
        <button onClick={mode==="forgot"?handleForgot:handleEmailAuth} disabled={loading} style={{ width:"100%",background:loading?"#374151":"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:14,padding:"15px",fontWeight:800,fontSize:15,cursor:loading?"not-allowed":"pointer",marginBottom:16,display:"flex",alignItems:"center",justifyContent:"center",gap:10 }}>
          {loading?(<><div style={{ width:18,height:18,borderRadius:"50%",border:"2px solid rgba(255,255,255,0.3)",borderTop:"2px solid #fff",animation:"spin 1s linear infinite" }}/>Please wait...</>)
          :mode==="login"?"Log In →":mode==="signup"?"Create Account →":"Send Reset Email"}
        </button>

        {/* Divider */}
        {mode!=="forgot"&&(
          <>
            <div style={{ display:"flex",alignItems:"center",gap:12,marginBottom:16 }}>
              <div style={{ flex:1,height:1,background:C.border }}/>
              <span style={{ fontSize:12,color:C.muted,fontWeight:600 }}>OR</span>
              <div style={{ flex:1,height:1,background:C.border }}/>
            </div>

            {/* Google Sign In */}
            <button onClick={handleGoogle} disabled={loading} style={{ width:"100%",background:C.card,color:C.text,border:"1px solid "+C.border,borderRadius:14,padding:"14px",fontWeight:700,fontSize:14,cursor:loading?"not-allowed":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10,marginBottom:24 }}>
              <span style={{ fontSize:20 }}>🔵</span>
              Continue with Google
            </button>
          </>
        )}

        {/* Terms */}
        {mode==="signup"&&(
          <p style={{ textAlign:"center",fontSize:11,color:C.muted,lineHeight:1.6 }}>
            By creating an account, you agree to our Terms of Service and Privacy Policy
          </p>
        )}

        {/* Bottom info */}
        <div style={{ textAlign:"center",marginTop:16,padding:"16px",background:C.card,borderRadius:14,border:"1px solid "+C.border }}>
          <div style={{ fontSize:13,color:C.text,fontWeight:700,marginBottom:4 }}>🎓 Built for Nigerian Students</div>
          <div style={{ fontSize:11,color:C.muted }}>AI notes • Voice recording • Study reminders</div>
        </div>
      </div>
    </div>
  );
}

// ── VOICE SCREEN ──────────────────────────────────────────────────────────────
function VoiceNoteScreen({ onBack, onSave, recQuality, recSettings, onSaveRecording, onDeleteRecording, onMarkTranscribed, onOpenRecordings, resumeAudio, courses, onCreateCourse }) {
  recQuality = recQuality || "Medium";
  recSettings = recSettings || { noise:true, autoTranscribe:false, speakerID:false, autoSave:false };
  var QUALITY_BITRATE = { Low:16000, Medium:32000, High:64000 };
  var MAX_AUDIO_BYTES = 18 * 1024 * 1024; // safety margin under Gemini's 20MB inline request cap
  // Each recording is auto-split into segments of this length behind the scenes — keeps
  // every individual upload small/reliable regardless of how long the actual lecture runs.
  // 25 min sits comfortably inside the 20–30 min target and well under MAX_AUDIO_BYTES at any quality.
  var SEGMENT_SECONDS = 25 * 60;
  var STAGES = [
    ["uploading","📤 Uploading audio..."],
    ["speech2text","🎧 Converting speech to text..."],
    ["cleaning","🧹 Cleaning notes..."],
    ["organizing","✨ Generating organised study notes..."],
    ["done","✅ Completed successfully"],
  ];

  var [phase,setPhase]=useState("idle"); // idle | recording | paused | interrupted | deciding | stopped | transcribing | reviewing
  var [elapsed,setElapsed]=useState(0);
  var [title,setTitle]=useState("");var [course,setCourse]=useState("General");
  var [status,setStatus]=useState("Tap the mic to start recording");
  var [wantFull,setWantFull]=useState(true);var [wantSmart,setWantSmart]=useState(true);var [wantSummary,setWantSummary]=useState(true);
  var [outputs,setOutputs]=useState({full:"",smart:"",summary:""});
  var [activeTab,setActiveTab]=useState(null);
  var [audioSizeWarning,setAudioSizeWarning]=useState("");
  var [saving,setSaving]=useState(false);
  var [partCount,setPartCount]=useState(0); // how many segments recorded so far (auto-split, invisible to the workflow)
  var [stage,setStage]=useState(null); // uploading | speech2text | cleaning | organizing | done
  var [stageDetail,setStageDetail]=useState("");

  var timerRef=useRef(null);
  var mediaRecorderRef=useRef(null);
  var streamRef=useRef(null);
  var chunksRef=useRef([]);
  var partsRef=useRef([]); // ordered list of recorded segment Blobs for this session
  var segTimeRef=useRef(0); // seconds recorded in the current segment
  var keepGoingRef=useRef(false); // true while an internal segment-rotation should auto-continue recording
  var mimeTypeRef=useRef("audio/webm");
  var savedRecordingIdRef=useRef(null); // id of the Lecture Recordings entry auto-saved for this session
  var audioInputRef=useRef(null);
  // true while WE are the ones deliberately stopping the track/recorder
  // (Stop Recording, or unmounting this screen) — so the track's own "ended"
  // event that naturally follows isn't mistaken for an unexpected interruption.
  var intentionalStopRef=useRef(false);

  var fmt=function(s){return String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");};

  // If we arrived here via "Transcribe" on a previously saved-for-later recording, load
  // its audio straight in and skip live recording entirely. Deliberately mount-once:
  // this screen is freshly mounted each time it's navigated to (conditionally rendered
  // by App based on `screen`), so resumeAudio is only ever meant to be consumed once,
  // at open time — re-running this on every resumeAudio identity change isn't wanted.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(function(){
    if (resumeAudio && resumeAudio.blob) {
      partsRef.current = [resumeAudio.blob];
      mimeTypeRef.current = resumeAudio.mimeType || "audio/mpeg";
      setTitle(resumeAudio.title||"");
      setCourse(resumeAudio.course||"General");
      setPhase("stopped");
      setStatus("Recording loaded — choose what kind of notes you'd like.");
    }
  }, []);

  useEffect(function(){
    return function(){
      intentionalStopRef.current = true;
      keepGoingRef.current = false;
      clearInterval(timerRef.current);
      try{ mediaRecorderRef.current && mediaRecorderRef.current.state!=="inactive" && mediaRecorderRef.current.stop(); }catch(e){}
      try{ streamRef.current && streamRef.current.getTracks().forEach(function(t){t.stop();}); }catch(e){}
    };
  }, []);

  // Attaches interruption watchers to the live mic track. Screen-lock is the
  // most common real-world trigger: many phones suspend or fully end mic
  // capture the moment the screen locks, especially in a browser tab rather
  // than an installed PWA. We never try to fight that or force background
  // capture — we only react to what the browser actually reports.
  function attachTrackWatchers(track){
    if (!track) return; // defensive — getAudioTracks()[0] should always exist after a successful getUserMedia({audio:true}), but never assume
    track.onended = handleMicInterrupted;
    track.onmute = handleMicInterrupted;
  }
  // Fires when the mic track ends/mutes unexpectedly, or MediaRecorder itself
  // errors, while we're actively recording — most commonly the phone's screen
  // locking. Stops cleanly (the recorder's own onstop below still fires,
  // preserving whatever audio was captured so far into partsRef.current — no
  // audio is lost), then hands control back to the student: a clear message
  // plus a manual Resume button once they're back with the screen on.
  // Recovery is always a deliberate tap, never automatic.
  function handleMicInterrupted(){
    if (intentionalStopRef.current) return; // we caused this ourselves (Stop/unmount) — not an interruption
    clearInterval(timerRef.current);
    keepGoingRef.current = false;
    try{ mediaRecorderRef.current && mediaRecorderRef.current.state!=="inactive" && mediaRecorderRef.current.stop(); }catch(e){}
    try{ streamRef.current && streamRef.current.getTracks().forEach(function(t){t.stop();}); }catch(e){}
    setPhase("interrupted");
    setStatus("Recording paused — the microphone became unavailable. This usually happens when the screen locks. Keep your screen on, then tap Resume.");
  }

  // Builds a fresh MediaRecorder on the existing mic stream and starts it. Used both for
  // the very first segment and to silently pick back up right after an internal rotation.
  function beginSegment(){
    var stream = streamRef.current;
    chunksRef.current = [];
    var recorder = new MediaRecorder(stream, { mimeType: mimeTypeRef.current, audioBitsPerSecond: QUALITY_BITRATE[recQuality]||32000 });
    recorder.ondataavailable = function(e){ if(e.data && e.data.size>0) chunksRef.current.push(e.data); };
    recorder.onerror = function(){ handleMicInterrupted(); };
    recorder.onstop = function(){
      var blob = new Blob(chunksRef.current, { type: mimeTypeRef.current });
      chunksRef.current = [];
      partsRef.current.push(blob);
      setPartCount(partsRef.current.length);
      setAudioSizeWarning(blob.size > MAX_AUDIO_BYTES ? "One part of this recording came out larger than expected — transcription may take a little longer for it." : "");
      if (keepGoingRef.current) beginSegment(); // rotation — student never notices this happen
    };
    mediaRecorderRef.current = recorder;
    recorder.start();
  }

  function startTicking(){
    timerRef.current = setInterval(function(){
      setElapsed(function(e){return e+1;});
      segTimeRef.current += 1;
      // Long lecture — silently close this segment and open a new one so no single
      // upload ever gets too big. Nothing changes from the student's point of view.
      if (segTimeRef.current >= SEGMENT_SECONDS && mediaRecorderRef.current && mediaRecorderRef.current.state==="recording") {
        segTimeRef.current = 0;
        mediaRecorderRef.current.stop();
      }
    }, 1000);
  }

  async function startRecording(){
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){ setStatus("Your browser doesn't support audio recording."); return; }
    try{
      var stream = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: !!recSettings.noise, echoCancellation:true } });
      streamRef.current = stream;
      intentionalStopRef.current = false;
      attachTrackWatchers(stream.getAudioTracks()[0]);
      var mimeType = "audio/webm";
      if (window.MediaRecorder && MediaRecorder.isTypeSupported){
        if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) mimeType = "audio/webm;codecs=opus";
        else if (MediaRecorder.isTypeSupported("audio/mp4")) mimeType = "audio/mp4";
      }
      mimeTypeRef.current = mimeType;
      partsRef.current = [];
      segTimeRef.current = 0;
      setPartCount(0);
      keepGoingRef.current = true;
      beginSegment();
      setPhase("recording");
      setElapsed(0);
      setStatus("Recording...");
      startTicking();
    }catch(e){
      setStatus("Couldn't access the microphone — check your browser's mic permission.");
    }
  }
  function pauseRecording(){
    try{ mediaRecorderRef.current.pause(); }catch(e){}
    clearInterval(timerRef.current);
    setPhase("paused");
    setStatus("Paused");
  }
  function resumeRecording(){
    try{ mediaRecorderRef.current.resume(); }catch(e){}
    startTicking();
    setPhase("recording");
    setStatus("Recording...");
  }
  // Recovery from an interruption (see handleMicInterrupted above) — re-acquires
  // the microphone fresh and starts a new segment that continues appending to
  // the SAME partsRef.current array, so the final recording still stitches
  // together everything from before and after the interruption. Always a
  // deliberate tap, never automatic — matches "recover when microphone capture
  // resumes," not "keep trying to record in the background."
  async function resumeAfterInterruption(){
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){ setStatus("Your browser doesn't support audio recording."); return; }
    setStatus("Reconnecting to your microphone...");
    try{
      var stream = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: !!recSettings.noise, echoCancellation:true } });
      streamRef.current = stream;
      intentionalStopRef.current = false;
      attachTrackWatchers(stream.getAudioTracks()[0]);
      keepGoingRef.current = true;
      beginSegment();
      setPhase("recording");
      setStatus("Recording...");
      startTicking();
    }catch(e){
      setStatus("Still couldn't reach the microphone — make sure your screen is on and unlocked, then tap Resume again.");
    }
  }
  // Bundles all auto-split segments into one file and uploads it to the Lecture Recordings
  // library — this is the "every recording is saved automatically" behaviour. Runs in the
  // background so it never blocks the student from moving on.
  // Returns the underlying save Promise (see saveRecordingFromSession in App) instead of
  // firing it and forgetting — stopRecording() below now actually waits for it.
  function finalizeRecordingSave(){
    if(!onSaveRecording || partsRef.current.length===0) return Promise.resolve();
    var combined = new Blob(partsRef.current, { type: mimeTypeRef.current });
    var recordingId = "rec_"+Date.now();
    savedRecordingIdRef.current = recordingId; // set synchronously — Delete works even before upload finishes
    return onSaveRecording(recordingId, combined, mimeTypeRef.current, {
      title: title || ("Lecture Recording - "+new Date().toLocaleDateString()),
      course: course,
      durationSeconds: elapsed
    });
  }

  function stopRecording(){
    intentionalStopRef.current = true; // the mic track ending as a result of this is expected, not an interruption
    clearInterval(timerRef.current);
    keepGoingRef.current = false; // this stop is final — don't auto-open another segment
    try{ mediaRecorderRef.current && mediaRecorderRef.current.stop(); }catch(e){}
    try{ streamRef.current && streamRef.current.getTracks().forEach(function(t){t.stop();}); }catch(e){}
    // small delay so the final segment's onstop finishes building its blob first
    setTimeout(function(){
      var savePromise = finalizeRecordingSave();
      // Previously: finalizeRecordingSave() was fired and immediately ignored,
      // then the "✅ Your recording has been saved" modal (phase "deciding")
      // appeared right away — including a "Save Recording for Later" button
      // that navigates straight away via onBack. If the student tapped that
      // (reasonably, since they'd just been told it was saved) while the
      // metadata/audio IndexedDB writes were still in flight, closing the
      // screen could abort those writes before they committed, and the
      // recording would be gone despite the confirmation shown moments
      // earlier — exactly the "disappears after reopen" symptom.
      //
      // The autoTranscribe branch never shows that modal at all (it goes
      // straight into transcription), so the false-claim bug doesn't apply
      // there — left exactly as it was, still firing the save in the
      // background without waiting on it. Only the "deciding" modal is now
      // gated on the save having genuinely finished.
      if (recSettings.autoTranscribe) {
        savePromise.catch(function(){
          setAudioSizeWarning("Couldn't save this recording to your library — check your device storage. Your notes below are safe either way.");
        });
        setPhase("stopped");
        setStatus("Nice! Now choose what kind of notes you'd like.");
        transcribe();
      } else {
        savePromise.then(function(){
          setPhase("deciding");
        }).catch(function(){
          // Genuinely failed to save (not just slow) — never claim success.
          // The in-memory audio (partsRef.current) is still intact though, so
          // the student can still convert straight to notes from it; they
          // just won't get an automatic Lecture Recordings library backup.
          // Reuses the existing amber warning-banner UI (same one used for
          // the "large part" notice below) rather than adding new UI.
          setAudioSizeWarning("Couldn't save this recording to your library — check your device storage. You can still convert it to notes now.");
          setPhase("stopped");
          setStatus("Nice! Now choose what kind of notes you'd like.");
        });
      }
    }, 300);
  }

  // "Delete Recording" from the post-recording prompt — undoes the automatic save above.
  function discardJustSavedRecording(){
    if (savedRecordingIdRef.current && onDeleteRecording) onDeleteRecording(savedRecordingIdRef.current);
    onBack();
  }

  function blobToBase64(blob){
    return new Promise(function(resolve,reject){
      var reader = new FileReader();
      reader.onloadend = function(){ resolve(reader.result.split(",")[1]); };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // Lets a student bring in an existing MP3/M4A/WAV lecture recording instead of recording
  // live. Feeds straight into the same review → transcribe → save pipeline as a live recording.
  function handleAudioUpload(e){
    var file = e.target.files && e.target.files[0];
    e.target.value = "";
    if(!file) return;
    var ext = (file.name.split(".").pop()||"").toLowerCase();
    var looksLikeAudio = ["mp3","m4a","wav"].indexOf(ext)!==-1 || /audio\/(mpeg|mp4|wav|x-m4a)/.test(file.type||"");
    if(!looksLikeAudio){ alert("Please choose an MP3, M4A, or WAV audio file."); return; }
    if(file.size > MAX_AUDIO_BYTES){ alert("That file is too large to process (max ~18MB). Try a shorter clip or a lower-quality export."); return; }
    partsRef.current = [file];
    mimeTypeRef.current = file.type || guessAudioMime(file.name) || "audio/mpeg";
    if(!title) setTitle(file.name.replace(/\.[^/.]+$/,""));
    setPhase("stopped");
    setStatus("Audio file ready — choose what kind of notes you'd like.");
  }

  function wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

  async function transcribe(){
    if(partsRef.current.length===0){ setStatus("Record something first!"); return; }
    if(!wantFull && !wantSmart && !wantSummary){ setStatus("Pick at least one output type."); return; }
    setPhase("transcribing");
    setStatus("");
    var totalParts = partsRef.current.length;
    try{
      var mediaType = mimeTypeRef.current.split(";")[0];

      // 1 & 2 — send each auto-split segment up and turn it into a verbatim transcript.
      // This always runs (even if "Full Transcript" isn't checked) because Smart Notes and
      // the Summary are generated from this merged text rather than from raw audio again —
      // cheaper and more reliable than re-sending audio once per output type.
      // Billed as "transcribe" (the real audio-decoding cost) — this is the only step that
      // should carry that price; everything below is plain text-in/text-out.
      var partTranscripts = [];
      for (var i=0; i<totalParts; i++){
        setStage("uploading");
        setStageDetail(totalParts>1 ? "Part "+(i+1)+" of "+totalParts : "");
        var base64 = await blobToBase64(partsRef.current[i]);
        setStage("speech2text");
        var partText = await callGeminiAudio(base64, mediaType, "Transcribe this lecture audio verbatim, word for word, as accurately as you can. Add natural paragraph breaks where the speaker's train of thought shifts. Return only the transcript, no preamble.", 3000, "transcribe");
        partTranscripts.push(partText);
      }
      var rawTranscript = partTranscripts.join("\n\n");

      // 3 — merge + clean. For a long lecture that was auto-split, this stitches the
      // segments into one coherent transcript. For a single segment it's just a light pass.
      // Billed as "summary" (text-only work), not "transcribe" — see credit-cost note above.
      setStage("cleaning");
      setStageDetail("");
      var fullTranscript;
      if (totalParts>1){
        fullTranscript = await callGeminiText("These are "+totalParts+" back-to-back segments of one continuous lecture recording, transcribed separately. Merge them into a single, clean, continuous transcript — fix any awkward breaks or repeated words at the joins, but stay faithful to what was said; don't summarize or shorten it. Return only the merged transcript, no preamble.\n\n"+rawTranscript, 3500, "summary");
      } else {
        await wait(300);
        fullTranscript = rawTranscript.trim();
      }

      // 4 — organise into Smart Notes / Summary from the clean text (fast, cheap text calls,
      // billed at the "summary" rate rather than "transcribe" — same reasoning as step 3).
      setStage("organizing");
      setStageDetail("");
      var jobs=[];
      if(wantSmart) jobs.push(["smart", callGeminiText("Turn the following lecture transcript into clean, well-organized study notes — headers and bullet points, only the important points, skip filler and repetition. Return only the notes, no preamble.\n\nTRANSCRIPT:\n"+fullTranscript, 2000, "summary")]);
      if(wantSummary) jobs.push(["summary", callGeminiText("Write a concise one-page revision summary of the following lecture transcript, covering only the core ideas and key takeaways a student needs to remember. Return only the summary, no preamble.\n\nTRANSCRIPT:\n"+fullTranscript, 900, "summary")]);
      var results = jobs.length ? await Promise.allSettled(jobs.map(function(j){return j[1];})) : [];
      var outOfCredits = results.some(function(r){ return r.status==="rejected" && r.reason && r.reason.code==="OUT_OF_CREDITS"; });
      if (outOfCredits) { triggerUpgradeScreen(); setPhase("stopped"); setStage(null); return; }

      var next = {full:fullTranscript,smart:"",summary:""};
      var firstKey = wantFull ? "full" : null;
      results.forEach(function(r,i){
        var key=jobs[i][0];
        if(r.status==="fulfilled"){ next[key]=r.value; if(!firstKey)firstKey=key; }
        else { next[key]="⚠️ Couldn't generate this — "+(r.reason&&r.reason.message?r.reason.message:"try again."); }
      });
      if(!firstKey) firstKey="full";
      setOutputs(next);
      setActiveTab(firstKey);

      // 5 — done. Briefly show the completed checkmark before moving into review.
      setStage("done");
      await wait(500);
      setPhase("reviewing");
      setStatus("Review below, edit anything, then save.");
      if (recSettings.autoSave) {
        setTimeout(function(){ saveNote(next[firstKey]); }, 300);
      }
    }catch(e){
      setStatus("Couldn't reach SAM-X to convert this — check your connection and try again.");
      setStage(null);
      setPhase("stopped");
    }
  }

  function saveNote(overrideContent){
    var content = overrideContent!=null ? overrideContent : (activeTab?outputs[activeTab]:"");
    if(!content || !content.trim()){ alert("Nothing to save yet!"); return; }
    setSaving(true);
    try{
      var newId = Date.now();
      onSave({id:newId,title:title||("Voice Note - "+new Date().toLocaleDateString()),course,color:"#06B6D4",bg:"rgba(6,182,212,0.12)",tag:"Lecture",words:content.split(" ").length,preview:content.slice(0,100),content:content});
      var linkedRecordingId = (resumeAudio && resumeAudio.recordingId) || savedRecordingIdRef.current;
      if(linkedRecordingId && onMarkTranscribed) onMarkTranscribed(linkedRecordingId, newId);
    }catch(e){ alert("Couldn't save the note — check your connection and try again."); }
    setSaving(false);
  }

  var TAB_LABELS = { full:"📝 Full Transcript", smart:"📚 Smart Notes", summary:"📄 Summary" };
  var checkedTabs = ["full","smart","summary"].filter(function(k){ return (k==="full"&&wantFull)||(k==="smart"&&wantSmart)||(k==="summary"&&wantSummary); });

  return(
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column",position:"relative" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>Record Lecture</span>
        {phase==="reviewing"
          ? <button onClick={function(){saveNote();}} disabled={saving} style={{ background:saving?C.card2:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:saving?C.muted:"#fff",border:"none",borderRadius:10,padding:"8px 18px",fontWeight:800,fontSize:14,cursor:saving?"default":"pointer" }}>{saving?"Saving...":"Save"}</button>
          : onOpenRecordings ? <button onClick={onOpenRecordings} title="Lecture Recordings" style={{ background:"rgba(255,255,255,0.08)",border:"none",borderRadius:10,width:36,height:36,cursor:"pointer",fontSize:16 }}>📁</button> : <div style={{ width:64 }}/>}
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        {phase==="idle"&&(
          <div style={{ background:"linear-gradient(135deg,rgba(6,182,212,0.1),rgba(167,139,250,0.1))",borderRadius:14,padding:"14px 16px",marginBottom:16,border:"1px solid rgba(6,182,212,0.2)",display:"flex",alignItems:"flex-start",gap:10 }}>
            <span style={{ fontSize:26 }}>🎤</span>
            <div>
              <div style={{ fontWeight:800,fontSize:14,color:C.cyan,marginBottom:3 }}>Record Lecture</div>
              <div style={{ fontSize:12,color:C.muted,lineHeight:1.5 }}>Record your lecture or explanation. Jotting AI will automatically convert it into organised study notes — no typing needed.</div>
              <div style={{ fontSize:11,color:C.amber,lineHeight:1.5,marginTop:8,fontWeight:600 }}>📱 Keep your screen on while recording — locking it can interrupt the microphone on some phones.</div>
            </div>
          </div>
        )}
        {phase==="idle"&&(
          <div style={{ fontSize:11,color:C.muted,lineHeight:1.5,marginBottom:8,textAlign:"center" }}>Recording a long lecture? Your phone's built-in voice recorder works too — just upload the file below afterward for transcription and organised notes.</div>
        )}
        {phase==="idle"&&(
          <button onClick={function(){audioInputRef.current&&audioInputRef.current.click();}} style={{ width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:C.card,border:"1px dashed "+C.border,borderRadius:12,padding:"11px",color:C.soft,fontSize:13,fontWeight:700,cursor:"pointer",marginBottom:16 }}>📁 Upload an MP3, M4A, or WAV instead</button>
        )}
        <input ref={audioInputRef} type="file" accept="audio/mpeg,audio/mp4,audio/wav,audio/x-m4a,.mp3,.m4a,.wav" onChange={handleAudioUpload} style={{display:"none"}}/>
        <input value={title} onChange={function(e){setTitle(e.target.value);}} placeholder="Note title (optional)..." style={{ width:"100%",padding:"13px 16px",borderRadius:12,border:"1px solid "+C.border,fontSize:15,fontWeight:700,background:C.card,color:C.text,outline:"none",marginBottom:14,boxSizing:"border-box" }}/>
        <div style={{ marginBottom:16 }}>
          <CourseChipPicker realCourses={courses} value={course} onSelect={setCourse} onCreateCourse={onCreateCourse} color={C.cyan}/>
        </div>

        <div style={{ background:C.card,borderRadius:24,padding:"28px 20px",border:"2px solid "+(phase==="recording"?C.red:(phase==="paused"||phase==="interrupted")?C.amber:C.border),marginBottom:16,textAlign:"center" }}>
          <div onClick={phase==="idle"?startRecording:undefined} style={{ width:110,height:110,borderRadius:"50%",background:phase==="recording"?"linear-gradient(135deg,#EF4444,#F87171)":(phase==="paused"||phase==="interrupted")?"linear-gradient(135deg,#F59E0B,#FCD34D)":"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 20px",cursor:phase==="idle"?"pointer":"default",fontSize:46,boxShadow:phase==="recording"?"0 0 0 14px rgba(239,68,68,0.12)":"0 8px 32px rgba(6,182,212,0.35)",animation:phase==="recording"?"pulse 1.5s ease-in-out infinite":"none" }}>{phase==="interrupted"?"📱":phase==="paused"?"⏸":"🎙️"}</div>
          {(phase==="recording"||phase==="paused"||phase==="interrupted")&&<div style={{ fontSize:40,fontWeight:800,color:(phase==="paused"||phase==="interrupted")?C.amber:C.red,marginBottom:12,fontFamily:"monospace",letterSpacing:3 }}>⏱ {fmt(elapsed)}</div>}
          {(phase==="recording"||phase==="paused")&&partCount>0&&<div style={{ fontSize:11,color:C.muted,marginBottom:8 }}>🔄 Long recording detected — continuing automatically (part {partCount+1})</div>}
          <div style={{ display:"flex",justifyContent:"center",marginBottom:14 }}><Wave active={phase==="recording"} color={phase==="recording"?"#EF4444":C.cyan} size={1.6}/></div>
          <p style={{ color:phase==="recording"?C.red:(phase==="paused"||phase==="interrupted")?C.amber:C.muted,fontSize:14,fontWeight:600,margin:"0 0 20px" }}>{status}</p>
          <div style={{ display:"flex",gap:10,justifyContent:"center" }}>
            {phase==="idle"&&<button onClick={startRecording} style={{ background:"linear-gradient(135deg,#EF4444,#F87171)",color:"#fff",border:"none",borderRadius:14,padding:"14px 36px",fontWeight:800,fontSize:15,cursor:"pointer",boxShadow:"0 4px 20px rgba(239,68,68,0.4)" }}>🎤 Start Recording</button>}
            {(phase==="recording"||phase==="paused")&&<div style={{ display:"flex",gap:10 }}>
              {phase==="recording"?<button onClick={pauseRecording} style={{ background:C.amber,color:"#0A0F1E",border:"none",borderRadius:14,padding:"13px 24px",fontWeight:800,fontSize:14,cursor:"pointer" }}>⏸ Pause</button>:<button onClick={resumeRecording} style={{ background:C.green,color:"#0A0F1E",border:"none",borderRadius:14,padding:"13px 24px",fontWeight:800,fontSize:14,cursor:"pointer" }}>▶ Resume</button>}
              <button onClick={stopRecording} style={{ background:"rgba(248,113,113,0.15)",color:C.red,border:"2px solid "+C.red+"40",borderRadius:14,padding:"13px 24px",fontWeight:800,fontSize:14,cursor:"pointer" }}>⏹ Stop Recording</button>
            </div>}
            {phase==="interrupted"&&<div style={{ display:"flex",gap:10,flexWrap:"wrap",justifyContent:"center" }}>
              <button onClick={resumeAfterInterruption} style={{ background:C.green,color:"#0A0F1E",border:"none",borderRadius:14,padding:"13px 24px",fontWeight:800,fontSize:14,cursor:"pointer" }}>🔄 Resume Recording</button>
              <button onClick={stopRecording} style={{ background:"rgba(248,113,113,0.15)",color:C.red,border:"2px solid "+C.red+"40",borderRadius:14,padding:"13px 24px",fontWeight:800,fontSize:14,cursor:"pointer" }}>⏹ Finish &amp; Save</button>
            </div>}
          </div>
        </div>

        {(phase==="stopped"||phase==="reviewing")&&(
          <div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.border,marginBottom:16 }}>
            {audioSizeWarning&&<div style={{ background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:10,padding:10,fontSize:12,color:C.amber,marginBottom:14 }}>⚠️ {audioSizeWarning}</div>}
            <div style={{ fontWeight:800,fontSize:14,color:C.text,marginBottom:2 }}>What kind of notes do you want?</div>
            <div style={{ fontSize:11,color:C.muted,marginBottom:12 }}>Pick one or more — SAM-X will turn your recording into these</div>
            {[["full",wantFull,setWantFull,"📝 Full Transcript","Everything the lecturer said"],["smart",wantSmart,setWantSmart,"📚 Smart Notes","Only the important points"],["summary",wantSummary,setWantSummary,"📄 Summary","One-page revision notes"]].map(function(item){return(
              <label key={item[0]} style={{ display:"flex",alignItems:"center",gap:12,padding:"10px 0",cursor:"pointer" }}>
                <input type="checkbox" checked={item[1]} onChange={function(e){item[2](e.target.checked);}} style={{ width:20,height:20,accentColor:C.cyan }}/>
                <div><div style={{ fontWeight:700,fontSize:14,color:C.text }}>{item[3]}</div><div style={{ fontSize:12,color:C.muted }}>{item[4]}</div></div>
              </label>
            );})}
            {phase!=="reviewing"&&<button onClick={transcribe} style={{ width:"100%",marginTop:14,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:14,padding:"14px",fontWeight:800,fontSize:15,cursor:"pointer" }}>✨ Convert to Notes</button>}
          </div>
        )}

        {phase==="transcribing"&&(
          <div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.border,marginBottom:16 }}>
            <div style={{ fontWeight:800,fontSize:14,color:C.text,marginBottom:4 }}>Creating your notes</div>
            <div style={{ fontSize:11,color:C.muted,marginBottom:14 }}>You can leave this screen open — it only takes a moment</div>
            {STAGES.map(function(s,i){
              var currentIdx = STAGES.findIndex(function(x){return x[0]===stage;});
              var isDone = stage==="done" ? true : i<currentIdx;
              var isActive = s[0]===stage && stage!=="done";
              return(
                <div key={s[0]} style={{ display:"flex",alignItems:"center",gap:12,padding:"9px 0" }}>
                  <span style={{ width:24,height:24,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800,flexShrink:0,background:isDone?C.green:isActive?C.cyan:C.card2,color:isDone||isActive?"#0A0F1E":C.muted,transition:"background 0.25s" }}>{isDone?"✓":isActive?<span style={{ display:"inline-block",animation:"spin 1s linear infinite" }}>◐</span>:i+1}</span>
                  <div>
                    <div style={{ fontSize:13,fontWeight:isActive?800:600,color:isActive||isDone?C.text:C.muted }}>{s[1]}</div>
                    {isActive&&stageDetail&&<div style={{ fontSize:11,color:C.muted,marginTop:2 }}>{stageDetail}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {phase==="reviewing"&&(
          <div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.cyan+"40" }}>
            <div style={{ display:"flex",gap:8,marginBottom:14,flexWrap:"wrap" }}>
              {checkedTabs.map(function(k){return<button key={k} onClick={function(){setActiveTab(k);}} style={{ padding:"7px 14px",borderRadius:99,border:"none",background:activeTab===k?C.cyan:C.card2,color:activeTab===k?"#0A0F1E":C.muted,fontSize:12,fontWeight:700,cursor:"pointer" }}>{TAB_LABELS[k]}</button>;})}
            </div>
            <textarea value={activeTab?outputs[activeTab]:""} onChange={function(e){var v=e.target.value;setOutputs(function(o){var n={...o};n[activeTab]=v;return n;});}} style={{ width:"100%",minHeight:280,background:"transparent",border:"none",color:C.text,fontSize:14,lineHeight:1.9,outline:"none",resize:"none",fontFamily:"inherit",boxSizing:"border-box" }}/>
            <div style={{ marginTop:10,paddingTop:10,borderTop:"1px solid "+C.border,display:"flex",justifyContent:"space-between" }}>
              <span style={{ fontSize:11,color:C.muted }}>{(activeTab&&outputs[activeTab]?outputs[activeTab].split(" ").filter(function(w){return w;}).length:0)} words</span>
              <button onClick={function(){navigator.clipboard&&activeTab&&navigator.clipboard.writeText(outputs[activeTab]);}} style={{ background:"none",border:"none",color:C.cyan,cursor:"pointer",fontSize:12,fontWeight:600 }}>Copy</button>
            </div>
          </div>
        )}
      </div>
      {phase==="deciding"&&(
        <div style={{ position:"absolute",inset:0,background:"rgba(10,15,30,0.85)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:30 }}>
          <div style={{ background:C.card,borderRadius:"20px 20px 0 0",padding:24,width:"100%" }}>
            <div style={{ fontWeight:800,fontSize:17,color:C.text,marginBottom:6,textAlign:"center" }}>What would you like to do?</div>
            <div style={{ fontSize:12,color:C.muted,marginBottom:20,textAlign:"center" }}>✅ Your recording has been saved to 📁 Lecture Recordings</div>
            <button onClick={function(){ setPhase("stopped"); setStatus("Nice! Now choose what kind of notes you'd like."); }} style={{ width:"100%",background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:14,padding:"14px",fontWeight:800,fontSize:15,cursor:"pointer",marginBottom:10 }}>✨ Transcribe Now</button>
            <button onClick={onBack} style={{ width:"100%",background:C.card2,color:C.text,border:"1px solid "+C.border,borderRadius:14,padding:"14px",fontWeight:700,fontSize:15,cursor:"pointer",marginBottom:10 }}>📁 Save Recording for Later</button>
            <button onClick={discardJustSavedRecording} style={{ width:"100%",background:"rgba(248,113,113,0.1)",color:C.red,border:"1px solid "+C.red+"40",borderRadius:14,padding:"14px",fontWeight:700,fontSize:15,cursor:"pointer" }}>🗑 Delete Recording</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── LECTURE RECORDINGS LIBRARY ──────────────────────────────────────────────────
// Loads a recording's audio from IndexedDB on demand and turns it into a playable
// object URL — the recordings list only stores metadata, so each row fetches its own
// audio lazily rather than the parent holding every blob in memory at once.
function LocalAudioPlayer({ recordingId }) {
  var [url, setUrl] = useState(null);
  var [status, setStatus] = useState("loading"); // loading | ready | unavailable
  useEffect(function(){
    var objectUrl = null;
    var cancelled = false;
    getAudioBlobLocal(recordingId).then(function(blob){
      if (cancelled) return;
      // A blob that's missing entirely, or present but empty (e.g. an
      // interrupted save left a zero-byte entry), is caught here. A blob
      // that has bytes but isn't valid decodable audio only reveals itself
      // once the browser actually tries to play it — see the <audio>
      // element's onError below for that case.
      if (!blob || !(blob instanceof Blob) || blob.size===0) { setStatus("unavailable"); return; }
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
      setStatus("ready");
    }).catch(function(){ if (!cancelled) setStatus("unavailable"); });
    return function(){ cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [recordingId]);
  if (status==="loading") return <div style={{ fontSize:12,color:C.muted,marginBottom:10 }}>Loading audio...</div>;
  if (status==="unavailable") return <div style={{ fontSize:12,color:C.amber,marginBottom:10 }}>🎧 This audio can't be played — it may be missing from this device or the file may be damaged.</div>;
  return <audio controls preload="none" src={url} onError={function(){ setStatus("unavailable"); }} style={{ width:"100%",height:36,marginBottom:10 }}/>;
}

function RecordingsScreen({ onBack, recordings, onRename, onDelete, onTranscribe }) {
  var [renamingId,setRenamingId]=useState(null);
  var [renameText,setRenameText]=useState("");
  var [loadingId,setLoadingId]=useState(null);

  function fmtDuration(s){ s=s||0; return String(Math.floor(s/60)).padStart(2,"0")+":"+String(Math.floor(s%60)).padStart(2,"0"); }
  function fmtSize(bytes){ if(!bytes) return ""; var mb=bytes/1024/1024; return mb<1?Math.round(bytes/1024)+" KB":mb.toFixed(1)+" MB"; }
  function startRename(r){ setRenamingId(r.id); setRenameText(r.title||""); }
  function saveRename(r){ var t=renameText.trim()||r.title; onRename(r.id,t); setRenamingId(null); }
  function confirmDelete(r){ if(window.confirm("Delete \""+r.title+"\"? This can't be undone.")) onDelete(r.id); }
  async function handleTranscribe(r){ setLoadingId(r.id); await onTranscribe(r); setLoadingId(null); }

  return(
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>📁 Lecture Recordings</span>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        <div style={{ fontSize:12,color:C.muted,marginBottom:16,lineHeight:1.5 }}>Every recording you make is saved here automatically — play it back, rename it, or turn it into notes whenever you're ready. Audio is stored on this device only (not the cloud), so it won't follow you to a different device or survive clearing browser data — but any notes you've already generated from it stay safe either way.</div>
        {recordings.length===0 ? (
          <div style={{ textAlign:"center",padding:"60px 20px" }}>
            <div style={{ fontSize:48,marginBottom:12 }}>📁</div>
            <div style={{ fontWeight:800,fontSize:16,color:C.text,marginBottom:6 }}>No recordings yet</div>
            <div style={{ fontSize:13,color:C.muted }}>Record a lecture and it'll show up here automatically.</div>
          </div>
        ) : recordings.map(function(r){
          var isRenaming = renamingId===r.id;
          return(
            <div key={r.id} style={{ background:C.card,borderRadius:16,padding:16,marginBottom:12,border:"1px solid "+C.border }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,marginBottom:10 }}>
                {isRenaming ? (
                  <div style={{ display:"flex",gap:8,flex:1,minWidth:0 }}>
                    <input autoFocus value={renameText} onChange={function(e){setRenameText(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")saveRename(r);}} style={{ flex:1,minWidth:0,background:C.card2,border:"1px solid "+C.cyan,borderRadius:8,padding:"6px 10px",color:C.text,fontSize:14,outline:"none" }}/>
                    <button onClick={function(){saveRename(r);}} style={{ background:C.cyan,border:"none",borderRadius:8,padding:"6px 12px",color:"#0A0F1E",fontWeight:700,fontSize:12,cursor:"pointer",flexShrink:0 }}>Save</button>
                  </div>
                ) : (
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                      <span style={{ fontWeight:800,fontSize:14,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{r.title}</span>
                      <button onClick={function(){startRename(r);}} style={{ background:"none",border:"none",color:C.muted,fontSize:12,cursor:"pointer",flexShrink:0,padding:0 }}>✏️</button>
                    </div>
                    <div style={{ display:"flex",gap:8,alignItems:"center",marginTop:4,flexWrap:"wrap" }}>
                      <span style={{ fontSize:10,color:C.cyan,fontWeight:700,background:"rgba(6,182,212,0.12)",borderRadius:99,padding:"2px 8px" }}>{r.course}</span>
                      <span style={{ fontSize:11,color:C.muted }}>{formatRelativeDate(r.createdAt)}</span>
                      <span style={{ fontSize:11,color:C.muted }}>⏱ {fmtDuration(r.durationSeconds)}</span>
                      {r.sizeBytes?<span style={{ fontSize:11,color:C.muted }}>{fmtSize(r.sizeBytes)}</span>:null}
                    </div>
                  </div>
                )}
                <button onClick={function(){confirmDelete(r);}} style={{ background:"rgba(248,113,113,0.12)",border:"none",borderRadius:8,width:30,height:30,cursor:"pointer",fontSize:13,flexShrink:0 }}>🗑</button>
              </div>
              {r.uploadFailed
                ? <div style={{ fontSize:12,color:C.red,marginBottom:10 }}>⚠️ Couldn't save this recording's audio — try recording it again.</div>
                : r.audioReady
                  ? <LocalAudioPlayer recordingId={r.id}/>
                  : <div style={{ fontSize:12,color:C.amber,marginBottom:10 }}>💾 Saving locally...</div>}
              {r.transcribed
                ? <div style={{ display:"flex",alignItems:"center",gap:6,fontSize:12,color:C.green,fontWeight:700 }}>✓ Already turned into a note</div>
                : <button onClick={function(){handleTranscribe(r);}} disabled={!r.audioReady||loadingId===r.id} style={{ width:"100%",background:r.audioReady?"linear-gradient(135deg,#06B6D4,#A78BFA)":C.card2,color:r.audioReady?"#fff":C.muted,border:"none",borderRadius:10,padding:"10px",fontWeight:800,fontSize:13,cursor:r.audioReady?"pointer":"default" }}>{loadingId===r.id?"Loading...":"✨ Transcribe"}</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── SCAN DOC ──────────────────────────────────────────────────────────────────
function ScanDocScreen({ onBack, onSave, courses, onCreateCourse }) {
  var [image,setImage]=useState(null); // final (possibly cropped) image data URL, or null while a PDF is loaded
  var [pdfFile,setPdfFile]=useState(null); // {dataUrl, name} when a PDF was chosen instead of an image
  var [cropping,setCropping]=useState(false);
  var [rawImage,setRawImage]=useState(null); // uncropped source, kept so "Re-crop" can start over
  var [box,setBox]=useState({x:20,y:20,w:200,h:200}); // crop rectangle, in on-screen px relative to the preview
  var [extracting,setExtracting]=useState(false);var [extracted,setExtracted]=useState("");var [title,setTitle]=useState("");var [course,setCourse]=useState("General");var [status,setStatus]=useState("Take a photo or upload an image or PDF");
  var fileRef=useRef(null); var imgRef=useRef(null); var dragRef=useRef(null);

  function handleFile(file){
    if(!file) return;
    setExtracted(""); setImage(null); setPdfFile(null);
    if (file.type==="application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      var reader=new FileReader();
      reader.onload=function(e){ setPdfFile({dataUrl:e.target.result, name:file.name}); setStatus("PDF ready! Tap Extract Text."); };
      reader.readAsDataURL(file);
      return;
    }
    var reader2=new FileReader();
    reader2.onload=function(e){
      setRawImage(e.target.result);
      setImage(e.target.result);
      setStatus("Image ready! Crop it or extract text directly.");
    };
    reader2.readAsDataURL(file);
  }

  function startCrop(){
    if(!rawImage) return;
    setBox({x:20,y:20,w:200,h:200});
    setCropping(true);
  }

  function onDragStart(e, mode){
    e.preventDefault();
    var startPt = e.touches ? e.touches[0] : e;
    var startBox = {...box};
    var startX = startPt.clientX, startY = startPt.clientY;
    dragRef.current = { mode:mode, startX:startX, startY:startY, startBox:startBox };
  }
  function onDragMove(e){
    if(!dragRef.current) return;
    e.preventDefault();
    var pt = e.touches ? e.touches[0] : e;
    var dx = pt.clientX - dragRef.current.startX;
    var dy = pt.clientY - dragRef.current.startY;
    var sb = dragRef.current.startBox;
    var container = imgRef.current;
    var maxW = container ? container.clientWidth : 320;
    var maxH = container ? container.clientHeight : 320;
    if (dragRef.current.mode==="move") {
      var nx = Math.max(0, Math.min(maxW-sb.w, sb.x+dx));
      var ny = Math.max(0, Math.min(maxH-sb.h, sb.y+dy));
      setBox({x:nx,y:ny,w:sb.w,h:sb.h});
    } else {
      var nw = Math.max(40, Math.min(maxW-sb.x, sb.w+dx));
      var nh = Math.max(40, Math.min(maxH-sb.y, sb.h+dy));
      setBox({x:sb.x,y:sb.y,w:nw,h:nh});
    }
  }
  function onDragEnd(){ dragRef.current=null; }

  function confirmCrop(){
    var img = imgRef.current;
    if(!img){ setCropping(false); return; }
    var scaleX = img.naturalWidth / img.clientWidth;
    var scaleY = img.naturalHeight / img.clientHeight;
    var canvas = document.createElement("canvas");
    canvas.width = box.w*scaleX; canvas.height = box.h*scaleY;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(img, box.x*scaleX, box.y*scaleY, box.w*scaleX, box.h*scaleY, 0, 0, canvas.width, canvas.height);
    setImage(canvas.toDataURL("image/jpeg", 0.92));
    setCropping(false);
    setStatus("Cropped! Ready to extract text.");
  }

  async function extractText(){
    var source = image || (pdfFile&&pdfFile.dataUrl);
    if(!source) return;
    setExtracting(true);setStatus("Reading text using AI...");
    try{
      var base64=source.split(",")[1];
      var mimeType=source.split(";")[0].split(":")[1];
      var text=await callGeminiVision(base64,mimeType,"Extract all text from this "+(pdfFile?"document":"image")+". Format it as clean study notes with proper headings and bullet points. Return ONLY the extracted text.",1500,"pdf_analysis");
      setExtracted(text);setStatus("Text extracted successfully!");
    }catch(e){
      if(e.code==="OUT_OF_CREDITS"){triggerUpgradeScreen();setStatus("");}else{setStatus("Error: "+e.message);}
    }
    setExtracting(false);
  }

  function saveNote(){if(!extracted.trim()){alert("Extract text first!");return;}onSave({id:Date.now(),title:title||("Scanned Note - "+new Date().toLocaleDateString()),course,color:"#06B6D4",bg:"rgba(6,182,212,0.12)",tag:"Lecture",words:extracted.split(" ").length,preview:extracted.slice(0,100),content:extracted});}

  var hasSource = image || pdfFile;

  return(
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>Scan Document</span>
        {extracted&&<button onClick={saveNote} style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:10,padding:"8px 16px",fontWeight:800,fontSize:13,cursor:"pointer" }}>Save</button>}
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        <div style={{ background:"linear-gradient(135deg,rgba(6,182,212,0.1),rgba(167,139,250,0.1))",borderRadius:14,padding:"12px 16px",marginBottom:16,border:"1px solid rgba(6,182,212,0.2)",display:"flex",alignItems:"center",gap:10 }}>
          <span style={{ fontSize:24 }}>📷</span>
          <div><div style={{ fontWeight:700,fontSize:13,color:C.cyan }}>AI Document Scanner</div><div style={{ fontSize:11,color:C.muted }}>Scan notes, textbooks, whiteboards, or upload a PDF — AI extracts all text</div></div>
        </div>
        <input value={title} onChange={function(e){setTitle(e.target.value);}} placeholder="Note title (optional)..." style={{ width:"100%",padding:"13px 16px",borderRadius:12,border:"1px solid "+C.border,fontSize:15,fontWeight:700,background:C.card,color:C.text,outline:"none",marginBottom:12,boxSizing:"border-box" }}/>
        <div style={{ marginBottom:16 }}><CourseChipPicker realCourses={courses} value={course} onSelect={setCourse} onCreateCourse={onCreateCourse} color={C.cyan}/></div>

        {!cropping && (
          <div onClick={function(){if(!hasSource)fileRef.current&&fileRef.current.click();}} style={{ background:C.card,borderRadius:20,padding:hasSource?12:"28px 20px",border:"2px dashed "+(hasSource?C.cyan:C.border),marginBottom:16,textAlign:"center",cursor:hasSource?"default":"pointer" }}>
            {image?(<div><img ref={imgRef} src={image} alt="scan" style={{ maxWidth:"100%",maxHeight:240,borderRadius:12,objectFit:"contain" }}/><p style={{ color:C.green,fontSize:13,fontWeight:600,marginTop:12 }}>Image ready!</p></div>)
            :pdfFile?(<div style={{ padding:"20px 0" }}><div style={{ fontSize:44,marginBottom:10 }}>📄</div><div style={{ color:C.text,fontWeight:700,fontSize:14 }}>{pdfFile.name}</div><p style={{ color:C.green,fontSize:13,fontWeight:600,marginTop:8 }}>PDF ready!</p></div>)
            :(<div><div style={{ fontSize:52,marginBottom:12 }}>📷</div><div style={{ fontWeight:700,fontSize:16,color:C.text,marginBottom:8 }}>Tap to Upload</div><div style={{ fontSize:13,color:C.muted }}>Image or PDF — from camera or gallery</div></div>)}
          </div>
        )}

        {cropping && (
          <div style={{ marginBottom:16 }}>
            <div style={{ position:"relative",display:"inline-block",width:"100%",touchAction:"none" }}
                 onMouseMove={onDragMove} onMouseUp={onDragEnd} onMouseLeave={onDragEnd}
                 onTouchMove={onDragMove} onTouchEnd={onDragEnd}>
              <img ref={imgRef} src={rawImage} alt="crop source" style={{ width:"100%",borderRadius:12,display:"block" }}/>
              <div style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.5)",clipPath:"polygon(0 0,100% 0,100% 100%,0 100%,0 "+box.y+"px,"+ (box.x+box.w) +"px "+box.y+"px,"+(box.x+box.w)+"px "+(box.y+box.h)+"px,"+box.x+"px "+(box.y+box.h)+"px,"+box.x+"px "+box.y+"px,0 "+box.y+"px)" }}/>
              <div onMouseDown={function(e){onDragStart(e,"move");}} onTouchStart={function(e){onDragStart(e,"move");}} style={{ position:"absolute",left:box.x,top:box.y,width:box.w,height:box.h,border:"2px solid "+C.cyan,cursor:"move" }}/>
              <div onMouseDown={function(e){onDragStart(e,"resize");}} onTouchStart={function(e){onDragStart(e,"resize");}} style={{ position:"absolute",left:box.x+box.w-14,top:box.y+box.h-14,width:28,height:28,borderRadius:"50%",background:C.cyan,border:"3px solid #fff",cursor:"nwse-resize" }}/>
            </div>
            <div style={{ fontSize:12,color:C.muted,textAlign:"center",margin:"10px 0" }}>Drag the box to move it, drag the blue dot to resize</div>
            <div style={{ display:"flex",gap:10 }}>
              <button onClick={function(){setCropping(false);}} style={{ flex:1,background:C.card2,color:C.muted,border:"1px solid "+C.border,borderRadius:12,padding:"12px",fontWeight:700,cursor:"pointer" }}>Cancel</button>
              <button onClick={confirmCrop} style={{ flex:2,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:12,padding:"12px",fontWeight:800,cursor:"pointer" }}>✂️ Crop</button>
            </div>
          </div>
        )}

        <input ref={fileRef} type="file" accept="image/*,application/pdf,.pdf" onChange={function(e){handleFile(e.target.files[0]);}} style={{ display:"none" }}/>

        {!cropping && (
          <div style={{ display:"flex",gap:10,marginBottom:16 }}>
            <button onClick={function(){fileRef.current&&fileRef.current.click();}} style={{ flex:1,background:C.card2,color:C.text,border:"1px solid "+C.border,borderRadius:12,padding:"12px",fontWeight:700,fontSize:14,cursor:"pointer" }}>📁 Choose File</button>
            <button onClick={function(){var input=document.createElement("input");input.type="file";input.accept="image/*";input.capture="environment";input.onchange=function(e){handleFile(e.target.files[0]);};input.click();}} style={{ flex:1,background:C.card2,color:C.text,border:"1px solid "+C.border,borderRadius:12,padding:"12px",fontWeight:700,fontSize:14,cursor:"pointer" }}>📸 Camera</button>
          </div>
        )}

        {image && !cropping && <button onClick={startCrop} style={{ width:"100%",background:"none",border:"1px solid "+C.border,borderRadius:12,padding:"10px",color:C.cyan,fontWeight:700,fontSize:13,cursor:"pointer",marginBottom:12 }}>✂️ Crop Image</button>}

        {hasSource && !cropping && <button onClick={extractText} disabled={extracting} style={{ width:"100%",background:extracting?"#374151":"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:14,padding:"15px",fontWeight:800,fontSize:15,cursor:extracting?"not-allowed":"pointer",marginBottom:16,display:"flex",alignItems:"center",justifyContent:"center",gap:10 }}>{extracting?(<><div style={{ width:18,height:18,borderRadius:"50%",border:"2px solid rgba(255,255,255,0.3)",borderTop:"2px solid #fff",animation:"spin 1s linear infinite" }}/>Reading text...</>):"✨ Extract Text"}</button>}
        <p style={{ textAlign:"center",color:extracting?C.cyan:C.muted,fontSize:13,fontWeight:600,marginBottom:16 }}>{status}</p>
        {extracted&&(<div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.cyan+"40" }}><div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12 }}><span style={{ fontWeight:700,fontSize:14,color:C.cyan }}>📝 Extracted Text</span><button onClick={function(){navigator.clipboard&&navigator.clipboard.writeText(extracted);}} style={{ background:C.card2,border:"none",borderRadius:8,padding:"4px 10px",color:C.cyan,cursor:"pointer",fontSize:12,fontWeight:600 }}>Copy</button></div><textarea value={extracted} onChange={function(e){setExtracted(e.target.value);}} style={{ width:"100%",minHeight:200,background:"transparent",border:"none",color:C.text,fontSize:14,lineHeight:1.9,outline:"none",resize:"none",fontFamily:"inherit",boxSizing:"border-box" }}/></div>)}
      </div>
    </div>
  );
}
// ── DRAW ──────────────────────────────────────────────────────────────────────
function DrawScreen({ onBack, onSave, courses, onCreateCourse }) {
  var canvasRef=useRef(null);var [drawing,setDrawing]=useState(false);var [color,setColor]=useState("#06B6D4");var [size,setSize]=useState(4);var [tool,setTool]=useState("pen");
  var [title,setTitle]=useState("");var [course,setCourse]=useState("General");var [hasContent,setHasContent]=useState(false);
  var colors=["#06B6D4","#A78BFA","#F59E0B","#34D399","#F87171","#fff"];
  // Sourced from real Course records now (coursesRepository), not a hardcoded
  // list unrelated to the student's actual data. Kept as a <select> rather than
  // switching to the shared chip picker — this toolbar is a tight single row,
  // and a chip picker would break that layout; "+ Add new course" below is the
  // compact-toolbar equivalent of the chip picker's "+ Add Course" button.
  var courseNames = Array.from(new Set(["General"].concat((courses||[]).map(function(c){return c.code||c.title;}).filter(Boolean))));
  async function handleCourseChange(e){
    var v = e.target.value;
    if (v==="__add__") {
      var name = window.prompt("New course code (e.g. BIO 201):");
      if (name && name.trim()) { var code=name.trim().toUpperCase(); await onCreateCourse(code); setCourse(code); }
      return;
    }
    setCourse(v);
  }
  function getPos(e,c){var r=c.getBoundingClientRect();var s=e.touches?e.touches[0]:e;return{x:(s.clientX-r.left)*(c.width/r.width),y:(s.clientY-r.top)*(c.height/r.height)};}
  function startDraw(e){e.preventDefault();var c=canvasRef.current;var ctx=c.getContext("2d");var p=getPos(e,c);ctx.beginPath();ctx.moveTo(p.x,p.y);setDrawing(true);setHasContent(true);}
  function draw(e){e.preventDefault();if(!drawing)return;var c=canvasRef.current;var ctx=c.getContext("2d");var p=getPos(e,c);ctx.globalCompositeOperation=tool==="eraser"?"destination-out":"source-over";ctx.strokeStyle=color;ctx.lineWidth=tool==="eraser"?28:size;ctx.lineCap="round";ctx.lineJoin="round";ctx.lineTo(p.x,p.y);ctx.stroke();}
  function saveDrawing(){
    if(!hasContent){ alert("Draw something first!"); return; }
    var c=canvasRef.current;
    var dataUrl=c.toDataURL("image/png");
    onSave({ id:Date.now(), title:title||("Drawing - "+new Date().toLocaleDateString()), course, color:"#06B6D4", bg:"rgba(6,182,212,0.12)", tag:"Study", type:"drawing", words:0, preview:"🎨 Drawing", content:dataUrl });
  }
  return(
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>Draw</span>
        <div style={{ display:"flex",gap:8 }}><button onClick={function(){var c=canvasRef.current;c.getContext("2d").clearRect(0,0,c.width,c.height);setHasContent(false);}} style={{ background:C.card2,border:"none",borderRadius:8,padding:"7px 12px",color:C.muted,fontSize:12,fontWeight:700,cursor:"pointer" }}>Clear</button><button onClick={saveDrawing} style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)",border:"none",borderRadius:8,padding:"7px 12px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer" }}>Save</button></div>
      </div>
      <div style={{ background:C.card,padding:"10px 16px",borderBottom:"1px solid "+C.border,display:"flex",gap:8,alignItems:"center" }}>
        <input value={title} onChange={function(e){setTitle(e.target.value);}} placeholder="Title (optional)..." style={{ flex:1,padding:"9px 12px",borderRadius:10,border:"1px solid "+C.border,fontSize:13,background:C.bg,color:C.text,outline:"none" }}/>
        <select value={course} onChange={handleCourseChange} style={{ padding:"9px 10px",borderRadius:10,border:"1px solid "+C.border,fontSize:12,background:C.bg,color:C.text,outline:"none" }}>{courseNames.map(function(c){return<option key={c} value={c}>{c}</option>;})}<option value="__add__">+ Add new course...</option></select>
      </div>
      <div style={{ background:C.card,padding:"12px 16px",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid "+C.border,flexWrap:"wrap" }}>
        <div style={{ display:"flex",gap:6 }}>{colors.map(function(c){return<button key={c} onClick={function(){setColor(c);setTool("pen");}} style={{ width:26,height:26,borderRadius:"50%",background:c,border:color===c&&tool!=="eraser"?"3px solid #fff":"2px solid rgba(255,255,255,0.15)",cursor:"pointer" }}/>;})}</div>
        <div style={{ display:"flex",gap:6,marginLeft:"auto" }}>{[["pen","✏️"],["eraser","⭕"]].map(function(item){return<button key={item[0]} onClick={function(){setTool(item[0]);}} style={{ background:tool===item[0]?C.cyan:C.card2,border:"none",borderRadius:8,padding:"6px 10px",cursor:"pointer",fontSize:16 }}>{item[1]}</button>;})}</div>
        <input type="range" min="2" max="24" value={size} onChange={function(e){setSize(Number(e.target.value));}} style={{ width:80,accentColor:C.cyan }}/>
      </div>
      <div style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",background:"#06081A",padding:10 }}>
        <canvas ref={canvasRef} width={360} height={500} style={{ background:"#111827",borderRadius:16,border:"1px solid "+C.border,cursor:tool==="eraser"?"cell":"crosshair",touchAction:"none",maxWidth:"100%" }} onMouseDown={startDraw} onMouseMove={draw} onMouseUp={function(){setDrawing(false);}} onMouseLeave={function(){setDrawing(false);}} onTouchStart={startDraw} onTouchMove={draw} onTouchEnd={function(){setDrawing(false);}}/>
      </div>
    </div>
  );
}

// ── CREATE NOTE (manual) ─────────────────────────────────────────────────────
// The one note-creation path in this app that ISN'T AI-driven — Record
// Lecture transcribes, AI Write generates from a prompt, Scan Doc extracts via
// vision, Draw is a canvas. There was no "just type a note" screen anywhere.
// This is only an input form: saving calls the SAME onSave (App's saveNote)
// every one of those four screens already calls — same id/course/tag shape,
// same local+cloud persistence, same landing on NoteDetail afterward. Nothing
// about how a note gets saved is reimplemented here.
function CreateNoteScreen({ onBack, onSave, courses, onCreateCourse }) {
  var [title,setTitle]=useState("");var [content,setContent]=useState("");var [course,setCourse]=useState("General");
  function save(){
    if(!content.trim()){ alert("Write something first!"); return; }
    onSave({ id:Date.now(), title:title||("Note - "+new Date().toLocaleDateString()), course, color:"#06B6D4", bg:"rgba(6,182,212,0.12)", tag:"Study", words:content.split(" ").length, preview:content.slice(0,100), content:content });
  }
  return(
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>Create Note</span>
        <button onClick={save} style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:10,padding:"8px 16px",fontWeight:800,fontSize:13,cursor:"pointer" }}>Save</button>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        <input value={title} onChange={function(e){setTitle(e.target.value);}} placeholder="Note title (optional)..." style={{ width:"100%",padding:"13px 16px",borderRadius:12,border:"1px solid "+C.border,fontSize:15,fontWeight:700,background:C.card,color:C.text,outline:"none",marginBottom:14,boxSizing:"border-box" }}/>
        <div style={{ marginBottom:16 }}><CourseChipPicker realCourses={courses} value={course} onSelect={setCourse} onCreateCourse={onCreateCourse} color={C.cyan}/></div>
        <textarea value={content} onChange={function(e){setContent(e.target.value);}} placeholder="Start typing your note..." style={{ width:"100%",minHeight:320,padding:16,borderRadius:16,border:"1px solid "+C.border,background:C.card,color:C.text,fontSize:14,lineHeight:1.9,outline:"none",resize:"none",fontFamily:"inherit",boxSizing:"border-box" }}/>
      </div>
    </div>
  );
}

// ── UPLOAD MATERIAL ───────────────────────────────────────────────────────────
// materialsRepository has existed since earlier this session (the "PDFs /
// Handouts / Past Questions" sections in Study Vault and Course Overview both
// already read from it) but never had a UI writer anywhere — this is that
// writer, nothing more. Saving calls App's addMaterial(), which follows the
// exact same optimistic-local-update-then-persist shape addAssignment()
// already uses; it isn't a new persistence pattern, just applied to a store
// that never had one wired in.
function UploadMaterialScreen({ onBack, onSave, courses, onCreateCourse }) {
  var [title,setTitle]=useState("");var [type,setType]=useState("pdf");var [course,setCourse]=useState("General");var [tagsText,setTagsText]=useState("");var [error,setError]=useState("");
  // Materials need a REAL Course id — materialsRepository's own documented
  // contract calls courseId "id of the Course this material belongs to," not a
  // name — but until now nothing ever gave it one (the old free-text input just
  // shoved the typed string straight into courseId). Resolve the picked name to
  // an existing Course, or create one on the fly (covers "General," or any
  // legacy name that's never been a real Course before) so courseId is always
  // real going forward, with zero extra steps for the student.
  async function save(){
    if(!title.trim()){ setError("Give this material a title."); return; }
    if(!course){ setError("Which course is this for?"); return; }
    var tags = tagsText.split(",").map(function(t){return t.trim();}).filter(Boolean);
    var match = (courses||[]).find(function(c){ return (c.code||c.title)===course; });
    var courseRecord = match || await onCreateCourse(course);
    onSave({ title:title.trim(), type:type, courseId:courseRecord.id, courseName:course, tags:tags });
  }
  return(
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>Upload Material</span>
        <button onClick={save} style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:10,padding:"8px 16px",fontWeight:800,fontSize:13,cursor:"pointer" }}>Save</button>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        <div style={{ background:"rgba(6,182,212,0.08)",border:"1px solid rgba(6,182,212,0.2)",borderRadius:12,padding:"10px 14px",marginBottom:16,fontSize:12,color:C.muted,lineHeight:1.5 }}>📌 This saves the material's details — there's no file upload yet, so nothing is attached.</div>
        <input value={title} onChange={function(e){setTitle(e.target.value);}} placeholder="Material title (e.g. Chapter 4 Handout)" style={{ width:"100%",padding:"13px 16px",borderRadius:12,border:"1px solid "+C.border,fontSize:15,fontWeight:700,background:C.card,color:C.text,outline:"none",marginBottom:14,boxSizing:"border-box" }}/>
        <div style={{ marginBottom:14 }}>
          <label style={{ fontSize:12,fontWeight:700,color:C.soft,display:"block",marginBottom:8 }}>TYPE</label>
          <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>{MATERIAL_TYPES.map(function(t){return<button key={t} onClick={function(){setType(t);}} style={{ padding:"7px 14px",borderRadius:99,border:"2px solid",borderColor:type===t?C.cyan:C.border,background:type===t?C.cyan:C.card,color:type===t?"#0A0F1E":C.muted,fontSize:12,fontWeight:700,cursor:"pointer" }}>{MATERIAL_TYPE_ICON[t]+" "+MATERIAL_TYPE_LABEL[t]}</button>;})}</div>
        </div>
        <div style={{ marginBottom:14 }}><CourseChipPicker realCourses={courses} value={course} onSelect={setCourse} onCreateCourse={onCreateCourse} color={C.cyan}/></div>
        <input value={tagsText} onChange={function(e){setTagsText(e.target.value);}} placeholder="Tags, comma separated (optional)" style={{ width:"100%",padding:"11px 14px",borderRadius:12,border:"1px solid "+C.border,fontSize:13,background:C.card,color:C.text,outline:"none",marginBottom:14,boxSizing:"border-box" }}/>
        {error&&<div style={{ background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:13,color:C.red,fontWeight:600 }}>⚠️ {error}</div>}
      </div>
    </div>
  );
}

// ── AI WRITE ──────────────────────────────────────────────────────────────────
function AIWriteScreen({ onBack, onSave, courses, onCreateCourse }) {
  var [prompt,setPrompt]=useState("");var [result,setResult]=useState("");var [loading,setLoading]=useState(false);var [course,setCourse]=useState("General");
  var suggestions=["Summarize Newton laws of motion","Write notes on Data Structures","Explain Organic Chemistry basics","Create outline for Kinematics"];
  async function generate(text){var q=text||prompt;if(!q.trim())return;setLoading(true);setResult("");try{var res=await callGeminiText("You are writing formal university lecture notes for a student — not a chatbot reply. Do not include any introduction, preamble, or closing remarks (no phrases like \"Here are your notes\" or \"I hope this helps\"). Start immediately with the title heading and follow this exact structure using Markdown headers:\n\n# [Title of the topic]\n## Definition\n## Introduction\n## Main Explanation\n## Key Points\n## Advantages\n## Disadvantages\n## Examples\n## Important Exam Questions\n## Summary\n\nIf a section like Advantages/Disadvantages doesn't naturally apply to this specific topic, still include the header and briefly explain why it's less relevant rather than skipping it. Use bullet points under each header where appropriate.\n\nTopic: "+q,1400,"chat");setResult(res);}catch(e){if(e.code==="OUT_OF_CREDITS"){triggerUpgradeScreen();}else{setResult("Couldn't reach SAM-X — check your connection and try again.");}}setLoading(false);}
  return(
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>AI Write</span>
        {result&&<button onClick={function(){var m=result.match(/^#\s+(.+)/m);var noteTitle=(m&&m[1].trim())||prompt.slice(0,40)||"AI Note";onSave({id:Date.now(),title:noteTitle,course,color:"#A78BFA",bg:"rgba(167,139,250,0.12)",tag:"Study",words:result.split(" ").length,preview:result.replace(/[#*_>-]/g,"").slice(0,100),content:result});}} style={{ background:"linear-gradient(135deg,#A78BFA,#06B6D4)",color:"#fff",border:"none",borderRadius:10,padding:"8px 16px",fontWeight:800,fontSize:13,cursor:"pointer" }}>Save</button>}
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        <div style={{ marginBottom:14 }}><CourseChipPicker realCourses={courses} value={course} onSelect={setCourse} onCreateCourse={onCreateCourse} color={C.purple}/></div>
        <div style={{ display:"flex",gap:10,marginBottom:16 }}><input value={prompt} onChange={function(e){setPrompt(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")generate();}} placeholder="What should I write notes about?" style={{ flex:1,padding:"13px 16px",borderRadius:14,border:"1px solid "+C.border,fontSize:14,background:C.card,color:C.text,outline:"none" }}/><button onClick={function(){generate();}} disabled={loading} style={{ width:48,height:48,borderRadius:14,background:"linear-gradient(135deg,#A78BFA,#06B6D4)",border:"none",cursor:"pointer",fontSize:20,flexShrink:0 }}>✨</button></div>
        {!result&&!loading&&suggestions.map(function(s){return<button key={s} onClick={function(){setPrompt(s);generate(s);}} style={{ width:"100%",textAlign:"left",background:C.card,border:"1px solid "+C.border,borderRadius:12,padding:"12px 16px",color:C.soft,fontSize:13,cursor:"pointer",marginBottom:8,fontFamily:"inherit" }}>{s}</button>;})}
        {loading&&<div style={{ textAlign:"center",padding:"40px 20px" }}><div style={{ fontSize:48,animation:"spin 2s linear infinite" }}>✨</div><p style={{ color:C.muted }}>Writing your notes...</p></div>}
        {result&&<div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.border }}><textarea value={result} onChange={function(e){setResult(e.target.value);}} style={{ width:"100%",minHeight:280,background:"transparent",border:"none",color:C.text,fontSize:14,lineHeight:1.9,outline:"none",resize:"none",fontFamily:"inherit",boxSizing:"border-box" }}/></div>}
      </div>
    </div>
  );
}

// ── Quiz JSON parsing & validation (shared by Quiz Me + Exam Mode) ─────────────
// Two failure modes this fixes:
//   1) The model wraps the array in code fences with inconsistent casing/whitespace,
//      or adds a sentence of preamble/trailing text around the JSON despite being
//      told not to — naive string splitting used to choke on this.
//   2) Even once parsed, a truncated/partially-malformed response can contain a
//      question missing `options`, a bad `answer` index, etc. Every question is
//      now validated individually instead of trusting the whole array blindly.
function extractJSONArrayText(raw){
  var text = (raw||"").trim();
  var fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  var start = text.indexOf("[");
  var end = text.lastIndexOf("]");
  if (start!==-1 && end!==-1 && end>start) text = text.slice(start, end+1);
  return text.trim();
}

function parseQuizQuestions(raw){
  var jsonText = extractJSONArrayText(raw);
  var parsed;
  try{ parsed = JSON.parse(jsonText); }
  catch(e){ throw new Error("SAM-X's response wasn't valid quiz JSON — try generating again."); }
  if (!Array.isArray(parsed)) throw new Error("SAM-X didn't return a list of questions — try generating again.");
  var valid = parsed.filter(function(q){
    return q && typeof q.question==="string" && q.question.trim()
      && Array.isArray(q.options) && q.options.length>=2
      && q.options.every(function(o){ return typeof o==="string" && o.trim(); })
      && typeof q.answer==="number" && q.answer>=0 && q.answer<q.options.length;
  });
  if (valid.length===0) throw new Error("SAM-X's response didn't contain any valid questions — try generating again.");
  // Reject generic meta-questions ("What is the topic?", "What is this about?") —
  // these are what a content-starved or under-specified request degrades to, and
  // silently showing one as if it were a real quiz question is worse than an
  // honest error. Anchored to match the WHOLE question, not just "contains this
  // wording", so a genuinely specific question that happens to use the word
  // "topic" in context (e.g. "What is the main topic of the Krebs cycle's third
  // stage?") is never wrongly rejected — only the bare, content-free template is.
  var substantive = valid.filter(function(q){ return !isGenericMetaQuestion(q.question); });
  if (substantive.length===0) throw new Error("SAM-X could only come up with a generic question, not specific ones from your notes — try adding more content to this note, or generate again.");
  return substantive;
}
var GENERIC_QUIZ_QUESTION_PATTERNS = [
  /^what\s+is\s+the\s+(main\s+)?topic\??$/i,
  /^what\s+is\s+this\s+(note\s+)?about\??$/i,
  /^what\s+topic\s+does\s+this\s+(note\s+)?cover\??$/i,
  /^what\s+is\s+being\s+discussed\??$/i,
  /^what\s+subject\s+is\s+this\??$/i,
  /^what\s+is\s+the\s+subject\s+of\s+(this|these)\s+notes\??$/i,
];
function isGenericMetaQuestion(questionText){
  var t = (questionText||"").trim();
  return GENERIC_QUIZ_QUESTION_PATTERNS.some(function(re){ return re.test(t); });
}

// ── Flashcard JSON parsing & validation ─────────────────────────────────────
// Reuses extractJSONArrayText (same fence/prose-stripping fix as quizzes) rather
// than the old naive `raw.split("```json")...` — that approach left any preamble
// text intact and caused a hard parse failure instead of a clean extraction.
// Each card is validated individually (non-empty front AND back) so one malformed
// entry doesn't take down the whole deck.
function parseFlashcards(raw){
  var jsonText = extractJSONArrayText(raw);
  var parsed;
  try{ parsed = JSON.parse(jsonText); }
  catch(e){ throw new Error("SAM-X's response wasn't valid flashcard JSON — try generating again."); }
  if (!Array.isArray(parsed)) throw new Error("SAM-X didn't return a list of flashcards — try generating again.");
  var valid = parsed.filter(function(c){
    return c && typeof c.front==="string" && c.front.trim() && typeof c.back==="string" && c.back.trim();
  }).map(function(c){ return { front:c.front.trim(), back:c.back.trim() }; });
  if (valid.length===0) throw new Error("SAM-X's response didn't contain any valid flashcards — try generating again.");
  return valid;
}

// Token budget scaled to the number of cards actually requested, instead of the
// old flat 1800-token cap. That flat cap is the real root cause of "only 1-8
// cards even when asking for more": ~1800 tokens is roughly enough room for a
// complete, well-formed JSON array of about 8 short front/back cards, so for
// bigger requests (15/20/30) the model would produce a smaller-but-VALID array
// that fits the budget and stop there — no error, just silently fewer cards.
// ~110 tokens covers a typical {"front":"...","back":"..."} entry (short prompt
// + a 1-2 sentence answer + JSON punctuation); 200 tokens covers the array
// brackets/formatting overhead. This is a per-request calculation, not a single
// enlarged constant, so it scales correctly whether 8 or 30 cards are asked for.
var FLASHCARD_TOKENS_PER_CARD = 110;
var FLASHCARD_TOKEN_OVERHEAD = 200;
function flashcardMaxTokens(numCards){
  return FLASHCARD_TOKEN_OVERHEAD + numCards*FLASHCARD_TOKENS_PER_CARD;
}

// ── NOTE DETAIL ───────────────────────────────────────────────────────────────
function NoteDetail({ note, onBack, onDelete, onUpdate, onSaveQuiz }) {
  var [view,setView]=useState("note");var [summary,setSummary]=useState(null);var [quiz,setQuiz]=useState([]);var [quizIdx,setQuizIdx]=useState(0);var [selected,setSelected]=useState(null);var [score,setScore]=useState(0);var [quizDone,setQuizDone]=useState(false);var [loading,setLoading]=useState(false);var [quizError,setQuizError]=useState(null);
  var [displayTitle,setDisplayTitle]=useState(note.title);
  var [displayContent,setDisplayContent]=useState(note.content);
  var [renaming,setRenaming]=useState(false);var [titleDraft,setTitleDraft]=useState(note.title);
  var [editingContent,setEditingContent]=useState(false);var [contentDraft,setContentDraft]=useState(note.content);
  var [displayHidden,setDisplayHidden]=useState(!!note.hidden);
  function toggleHidden(){ var next=!displayHidden; setDisplayHidden(next); onUpdate&&onUpdate(note.id,{hidden:next}); }
  function saveRename(){ var t=titleDraft.trim()||displayTitle; setDisplayTitle(t); setRenaming(false); onUpdate&&onUpdate(note.id,{title:t}); }
  function saveContentEdit(){ var c=contentDraft; if(!c||!c.trim()){setEditingContent(false);return;} setDisplayContent(c); setEditingContent(false); onUpdate&&onUpdate(note.id,{content:c,words:c.split(" ").length,preview:c.slice(0,100)}); }
  async function generateSummary(){setLoading(true);setView("summary");try{var raw=await callGeminiText("Summarize these notes. Return ONLY JSON: {\"summary\":\"...\",\"keyPoints\":[\"...\"],\"tags\":[\"...\"]} NOTES: "+displayContent,800,"summary");setSummary(JSON.parse(raw.split("```json").join("").split("```").join("").trim()));}catch(e){if(e.code==="OUT_OF_CREDITS"){triggerUpgradeScreen();}else{setSummary({summary:"This covers "+displayTitle+".",keyPoints:["Review definitions","Practice problems"],tags:[note.course,note.tag]});}}setLoading(false);}
  async function generateQuiz(){
    // Guard against generating a quiz from a note that doesn't have enough
    // real content to draw questions from (a near-empty note, or — since the
    // Quiz tab is reachable even for a drawing note, whose `content` is a
    // base64 image data URL, not text — content that isn't actually prose at
    // all). Sending that to the AI is exactly what produces a single generic
    // "What is the topic?" filler question; catching it here means the
    // student gets an honest, specific message instead, and no AI call (and
    // no credit) is spent on a request that can't succeed.
    var wordCount = (displayContent||"").trim().split(/\s+/).filter(Boolean).length;
    if (note.type==="drawing" || wordCount<30) {
      setView("quiz"); setQuizError(null);
      setQuiz([]);
      setQuizError(note.type==="drawing"
        ? "This is a drawing note — Quiz Me needs written content to generate questions from."
        : "This note doesn't have enough content yet to generate a meaningful quiz. Add more detail, then try again.");
      return;
    }
    setLoading(true);setView("quiz");setQuizError(null);
    try{
      var raw=await callGeminiText("Create 10 multiple choice questions covering a good spread of the material below — not just the first section. Every question must test a specific fact, term, definition, process, or claim that actually appears in these notes. Never include a generic question like \"What is the topic?\" or \"What is this about?\" — if you can't find enough distinct, specific things to ask about, return fewer questions rather than padding with a generic one. Return ONLY a JSON array, no preamble: [{\"question\":\"...\",\"options\":[\"A\",\"B\",\"C\",\"D\"],\"answer\":0}]\n\nNOTES:\n"+displayContent,1600,"quiz");
      var q=parseQuizQuestions(raw);
      setQuiz(q);
      if(onSaveQuiz)onSaveQuiz(q,{noteId:note.id,course:note.course,source:"quizme"});
      setQuizIdx(0);setSelected(null);setScore(0);setQuizDone(false);
    }catch(e){
      if(e.code==="OUT_OF_CREDITS"){triggerUpgradeScreen();}
      else{ setQuiz([]); setQuizError(e.message||"Couldn't generate a quiz — check your connection and try again."); }
    }
    setLoading(false);
  }
  function pick(i){if(selected!==null)return;setSelected(i);if(i===quiz[quizIdx].answer)setScore(function(s){return s+1;});setTimeout(function(){if(quizIdx+1<quiz.length){setQuizIdx(function(q){return q+1;});setSelected(null);}else setQuizDone(true);},900);}
  return(
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border,position:"sticky",top:0,zIndex:10,gap:8 }}>
        <button onClick={onBack} style={backBtn}>←</button>
        {renaming ? (
          <input autoFocus value={titleDraft} onChange={function(e){setTitleDraft(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")saveRename();if(e.key==="Escape"){setTitleDraft(displayTitle);setRenaming(false);}}} onBlur={saveRename} style={{ flex:1,minWidth:0,background:C.card2,border:"1px solid "+C.cyan,borderRadius:8,padding:"6px 10px",color:C.text,fontSize:14,fontWeight:700,outline:"none" }}/>
        ) : (
          <button onClick={function(){setTitleDraft(displayTitle);setRenaming(true);}} style={{ flex:1,minWidth:0,background:"none",border:"none",display:"flex",alignItems:"center",gap:6,cursor:"pointer",padding:0 }}>
            <span style={{ fontWeight:800,fontSize:15,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{displayTitle}</span>
            <span style={{ fontSize:12,color:C.muted,flexShrink:0 }}>✏️</span>
          </button>
        )}
        <div style={{ display:"flex",gap:6,flexShrink:0 }}><button onClick={toggleHidden} title={displayHidden?"Unhide note":"Hide from Library & Home"} style={{ background:displayHidden?"rgba(245,158,11,0.15)":C.card2,border:"none",borderRadius:8,width:32,height:32,cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center" }}>{displayHidden?"🙈":"👁️"}</button><ExportPicker compact={true} label="⬇️" onExportPDF={function(){return exportNotesToPDF([{...note,title:displayTitle,content:displayContent}], displayTitle);}} onExportWord={function(){return exportNotesToDocx([{...note,title:displayTitle,content:displayContent}], displayTitle);}}/><button onClick={function(){if(navigator.share)navigator.share({title:displayTitle,text:displayContent});else{navigator.clipboard&&navigator.clipboard.writeText(displayContent);alert("Copied!");}}} style={{ background:C.card2,border:"none",borderRadius:8,width:32,height:32,cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center" }}>📤</button><button onClick={function(){onDelete(note.id);}} style={{ background:"rgba(248,113,113,0.12)",border:"none",borderRadius:8,width:32,height:32,cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center" }}>🗑</button></div>
      </div>
      {displayHidden&&<div style={{ background:"rgba(245,158,11,0.1)",borderBottom:"1px solid rgba(245,158,11,0.2)",padding:"8px 20px",fontSize:12,color:C.amber,fontWeight:600 }}>🙈 This note is hidden from Library & Home (Settings → Privacy and Security).</div>}
      <div style={{ background:C.card,padding:"0 20px 12px",display:"flex",gap:6,borderBottom:"1px solid "+C.border }}>
        {[["📝","note","Note"],["📋","summary","Summary"],["🧠","quiz","Quiz"]].map(function(item){return<button key={item[1]} onClick={function(){setView(item[1]);if(item[1]==="summary"&&!summary)generateSummary();if(item[1]==="quiz"&&quiz.length===0)generateQuiz();}} style={{ padding:"7px 16px",borderRadius:99,border:"none",background:view===item[1]?note.color:C.card2,color:view===item[1]?"#0A0F1E":C.muted,fontSize:13,fontWeight:700,cursor:"pointer",marginTop:12 }}>{item[0]+" "+item[2]}</button>;})}
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        {view==="note"&&(<div><div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16 }}><div style={{ display:"flex",alignItems:"center",gap:8 }}><span style={{ fontSize:11,fontWeight:700,color:note.color,background:note.bg,borderRadius:99,padding:"3px 12px" }}>{note.course}</span><span style={{ fontSize:11,color:C.muted }}>{formatRelativeDate(note.id)}</span></div>{note.type!=="drawing"&&!editingContent&&<button onClick={function(){setContentDraft(displayContent);setEditingContent(true);}} style={{ background:"none",border:"1px solid "+C.border,borderRadius:8,padding:"5px 12px",color:C.cyan,fontSize:12,fontWeight:700,cursor:"pointer" }}>✏️ Edit</button>}</div>
          <div style={{ background:C.card,borderRadius:18,padding:note.type==="drawing"?12:20,border:"1px solid "+C.border,marginBottom:16 }}>
            {note.type==="drawing"
              ?<img src={note.content} alt={displayTitle} style={{ width:"100%",borderRadius:12,display:"block" }}/>
              :editingContent
                ?(<div>
                    <textarea value={contentDraft} onChange={function(e){setContentDraft(e.target.value);}} style={{ width:"100%",minHeight:280,background:"transparent",border:"none",color:C.text,fontSize:14,lineHeight:1.9,outline:"none",resize:"none",fontFamily:"inherit",boxSizing:"border-box" }}/>
                    <div style={{ display:"flex",gap:8,justifyContent:"flex-end",marginTop:10,paddingTop:10,borderTop:"1px solid "+C.border }}>
                      <button onClick={function(){setEditingContent(false);}} style={{ background:"none",border:"1px solid "+C.border,borderRadius:10,padding:"8px 16px",color:C.muted,fontSize:13,fontWeight:700,cursor:"pointer" }}>Cancel</button>
                      <button onClick={saveContentEdit} style={{ background:C.cyan,border:"none",borderRadius:10,padding:"8px 16px",color:"#0A0F1E",fontSize:13,fontWeight:800,cursor:"pointer" }}>Save Changes</button>
                    </div>
                  </div>)
                :<div className="samx-md" style={{ fontSize:14,color:"#CBD5E1",lineHeight:1.9 }}><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{displayContent}</ReactMarkdown></div>}
          </div>
          {note.type!=="drawing"&&!editingContent&&<div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10 }}><button onClick={function(){setView("summary");if(!summary)generateSummary();}} style={actionBtn(note.color)}>📋 AI Summary</button><button onClick={function(){setView("quiz");if(quiz.length===0)generateQuiz();}} style={actionBtn(C.purple)}>🧠 Quiz Me</button></div>}
        </div>)}
        {view==="summary"&&(loading?<div style={{ textAlign:"center",padding:"60px 20px" }}><div style={{ fontSize:48,animation:"spin 2s linear infinite" }}>✨</div><p style={{ color:C.muted,marginTop:16 }}>Generating...</p></div>:summary?(<div><div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.border,marginBottom:14 }}><div style={{ fontSize:11,fontWeight:700,color:C.green,letterSpacing:1,marginBottom:10 }}>OVERVIEW</div><p style={{ margin:0,fontSize:14,color:"#CBD5E1",lineHeight:1.8 }}>{summary.summary}</p></div><div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.border,marginBottom:14 }}><div style={{ fontSize:11,fontWeight:700,color:C.amber,letterSpacing:1,marginBottom:12 }}>KEY POINTS</div>{summary.keyPoints&&summary.keyPoints.map(function(p,i){return<div key={i} style={{ display:"flex",gap:10,marginBottom:10 }}><div style={{ width:6,height:6,borderRadius:3,background:C.amber,marginTop:7,flexShrink:0 }}/><p style={{ margin:0,fontSize:14,color:"#CBD5E1",lineHeight:1.7 }}>{p}</p></div>;})}</div><div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>{summary.tags&&summary.tags.map(function(t){return<span key={t} style={{ background:C.card2,color:C.cyan,borderRadius:99,padding:"4px 14px",fontSize:12,fontWeight:700 }}>{t}</span>;})}</div></div>):null)}
        {view==="quiz"&&(loading?<div style={{ textAlign:"center",padding:"60px 20px" }}><div style={{ fontSize:48,animation:"spin 2s linear infinite" }}>🧠</div><p style={{ color:C.muted,marginTop:16 }}>Generating quiz...</p></div>:quizError?(<div style={{ textAlign:"center",padding:"40px 20px" }}><div style={{ fontSize:48,marginBottom:12 }}>⚠️</div><div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:8 }}>Couldn't generate a quiz</div><p style={{ color:C.muted,fontSize:13,marginBottom:20 }}>{quizError}</p><button onClick={generateQuiz} style={{ background:"linear-gradient(135deg,"+note.color+",#A78BFA)",color:"#fff",border:"none",borderRadius:14,padding:"12px 28px",fontWeight:800,fontSize:14,cursor:"pointer" }}>Try Again</button></div>):quizDone?(<div style={{ textAlign:"center",padding:"40px 20px" }}><div style={{ fontSize:64,marginBottom:16 }}>{score===quiz.length?"🏆":"📖"}</div><div style={{ fontSize:40,fontWeight:800,color:C.text }}>{score}/{quiz.length}</div><p style={{ color:C.muted,marginTop:8 }}>{score===quiz.length?"Perfect! 🔥":"Keep studying! 💪"}</p><button onClick={function(){setQuizIdx(0);setSelected(null);setScore(0);setQuizDone(false);}} style={{ marginTop:20,background:"linear-gradient(135deg,"+note.color+",#A78BFA)",color:"#fff",border:"none",borderRadius:14,padding:"13px 32px",fontWeight:800,fontSize:15,cursor:"pointer" }}>Try Again</button></div>):quiz.length>0?(<div><div style={{ display:"flex",justifyContent:"space-between",marginBottom:8 }}><span style={{ fontSize:13,color:C.muted }}>Question {quizIdx+1}/{quiz.length}</span><span style={{ fontSize:13,fontWeight:700,color:C.text }}>Score: {score}</span></div><div style={{ height:4,background:C.border,borderRadius:2,marginBottom:20 }}><div style={{ height:4,background:note.color,borderRadius:2,width:(quizIdx/quiz.length*100)+"%",transition:"width 0.3s" }}/></div><div style={{ background:C.card,borderRadius:16,padding:20,marginBottom:16,border:"1px solid "+C.border }}><p style={{ margin:0,fontSize:16,fontWeight:600,color:C.text,lineHeight:1.6 }}>{quiz[quizIdx].question}</p></div>{quiz[quizIdx].options.map(function(opt,i){var bg=C.card,border=C.border,color=C.text;if(selected!==null){if(i===quiz[quizIdx].answer){bg="rgba(52,211,153,0.15)";border="#34D399";color="#34D399";}else if(i===selected){bg="rgba(248,113,113,0.15)";border="#F87171";color="#F87171";}}return<button key={i} onClick={function(){pick(i);}} disabled={selected!==null} style={{ width:"100%",textAlign:"left",background:bg,border:"2px solid "+border,borderRadius:12,padding:"13px 16px",marginBottom:10,fontSize:14,color:color,cursor:selected!==null?"default":"pointer",fontWeight:500,display:"flex",gap:10,fontFamily:"inherit" }}><span style={{opacity:0.5}}>{String.fromCharCode(65+i)}.</span>{opt}</button>;})}</div>):null)}
      </div>
    </div>
  );
}

// ── LIBRARY ───────────────────────────────────────────────────────────────────
function LibraryScreen({ notes, hiddenNotes, hiddenFolderEnabled, pinEnabled, verifyPin, onNote, onDelete }) {
  var [search,setSearch]=useState("");var [sort,setSort]=useState("date");var [filter,setFilter]=useState("All");var [courseFilter,setCourseFilter]=useState("All Courses");var [view,setView]=useState("list");var [selected,setSelected]=useState([]);
  var [showHidden,setShowHidden]=useState(false);
  hiddenNotes = hiddenNotes || [];
  var baseNotes = showHidden ? notes.concat(hiddenNotes) : notes;
  function toggleShowHidden(){
    if(showHidden){ setShowHidden(false); return; }
    if(pinEnabled){
      var entered = window.prompt("Enter your 4-digit PIN to view hidden notes:");
      if(entered==null) return;
      if(!verifyPin(entered)){ alert("Incorrect PIN."); return; }
    }
    setShowHidden(true);
  }
  var filters=["All","Lecture","Study","Business","Personal"];
  var sorts=[["date","📅 Date"],["title","🔤 Title"],["course","📚 Course"],["words","💬 Words"]];
  var courseOptions=["All Courses"].concat(Array.from(new Set(baseNotes.map(function(n){return n.course;}))).sort());
  var filtered=baseNotes.filter(function(n){var ms=n.title.toLowerCase().includes(search.toLowerCase())||n.course.toLowerCase().includes(search.toLowerCase())||n.content.toLowerCase().includes(search.toLowerCase());var mf=filter==="All"||n.tag===filter;var mc=courseFilter==="All Courses"||n.course===courseFilter;return ms&&mf&&mc;});
  filtered=filtered.slice().sort(function(a,b){if(sort==="title")return a.title.localeCompare(b.title);if(sort==="course")return a.course.localeCompare(b.course);if(sort==="words")return(b.words||0)-(a.words||0);return (b.id||0)-(a.id||0);});
  function toggleSelect(id){setSelected(function(s){return s.includes(id)?s.filter(function(x){return x!==id;}):[...s,id];});}
  function deleteSelected(){selected.forEach(function(id){onDelete(id);});setSelected([]);}
  return(
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:"linear-gradient(135deg,#0A0F1E,#1E1B4B)",padding:"20px 20px 0" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
          <div><h2 style={{ color:C.text,fontSize:22,fontWeight:800,margin:0 }}>Library 📚</h2><p style={{ color:C.muted,fontSize:12,margin:"4px 0 0" }}>{notes.length} notes saved{hiddenFolderEnabled&&hiddenNotes.length>0?" · "+hiddenNotes.length+" hidden":""}</p></div>
          <button onClick={function(){setView(view==="list"?"grid":"list");}} style={{ background:"rgba(255,255,255,0.08)",border:"none",borderRadius:10,width:36,height:36,cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center" }}>{view==="list"?"⊞":"☰"}</button>
        </div>
        <div style={{ position:"relative",marginBottom:14 }}><span style={{ position:"absolute",left:14,top:"50%",transform:"translateY(-50%)" }}>🔍</span><input value={search} onChange={function(e){setSearch(e.target.value);}} placeholder="Search notes, courses, content..." style={{ width:"100%",padding:"11px 14px 11px 42px",borderRadius:12,border:"1px solid rgba(255,255,255,0.1)",fontSize:13,background:"rgba(255,255,255,0.07)",color:C.text,outline:"none",boxSizing:"border-box" }}/></div>
        <div style={{ display:"flex",gap:6,overflowX:"auto",paddingBottom:10 }}>{filters.map(function(f){return<button key={f} onClick={function(){setFilter(f);}} style={{ padding:"6px 14px",borderRadius:99,border:"none",background:filter===f?C.cyan:"rgba(255,255,255,0.07)",color:filter===f?"#0A0F1E":C.muted,fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0 }}>{f}</button>;})}
          {hiddenFolderEnabled&&hiddenNotes.length>0&&<button onClick={toggleShowHidden} style={{ padding:"6px 14px",borderRadius:99,border:"1px solid "+(showHidden?C.red:"rgba(255,255,255,0.12)"),background:showHidden?C.red+"25":"transparent",color:showHidden?C.red:C.muted,fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0 }}>{showHidden?"🙈 Hide again":"🔓 Show Hidden ("+hiddenNotes.length+")"}</button>}
        </div>
        {courseOptions.length>1&&<div style={{ display:"flex",gap:6,overflowX:"auto",paddingBottom:14 }}>{courseOptions.map(function(c){return<button key={c} onClick={function(){setCourseFilter(c);}} style={{ padding:"5px 12px",borderRadius:99,border:"1px solid "+(courseFilter===c?C.purple:"rgba(255,255,255,0.12)"),background:courseFilter===c?C.purple+"25":"transparent",color:courseFilter===c?C.purple:C.muted,fontSize:11,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0 }}>{c}</button>;})}</div>}
      </div>
      <div style={{ background:C.card,padding:"10px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <div style={{ display:"flex",gap:6,overflowX:"auto" }}>{sorts.map(function(s){return<button key={s[0]} onClick={function(){setSort(s[0]);}} style={{ padding:"5px 12px",borderRadius:99,border:"none",background:sort===s[0]?C.purple+"30":"transparent",color:sort===s[0]?C.purple:C.muted,fontSize:11,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap" }}>{s[1]}</button>;})}</div>
        {selected.length>0&&<div style={{ display:"flex",gap:8,alignItems:"center",flexShrink:0 }}>
          <ExportPicker label={"📤 Export ("+selected.length+")"} onExportPDF={function(){return exportNotesToPDF(baseNotes.filter(function(n){return selected.includes(n.id);}), "Jotting AI Notes");}} onExportWord={function(){return exportNotesToDocx(baseNotes.filter(function(n){return selected.includes(n.id);}), "Jotting AI Notes");}}/>
          <button onClick={deleteSelected} style={{ background:"rgba(248,113,113,0.15)",border:"1px solid "+C.red+"40",borderRadius:8,padding:"5px 12px",color:C.red,fontSize:11,fontWeight:700,cursor:"pointer" }}>🗑 Delete {selected.length}</button>
        </div>}
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:16 }}>
        {filtered.length===0?(notes.length===0?(
          <div style={{ textAlign:"center",padding:"60px 20px" }}><div style={{ fontSize:52,marginBottom:12 }}>📝</div><div style={{ fontWeight:800,fontSize:18,color:C.text,marginBottom:6 }}>No notes yet</div><div style={{ fontSize:13,color:C.muted }}>Record a lecture, scan a page, or write one — it'll show up here.</div></div>
        ):(
          <div style={{ textAlign:"center",padding:"60px 20px" }}><div style={{ fontSize:52,marginBottom:12 }}>🔍</div><div style={{ fontWeight:800,fontSize:18,color:C.text,marginBottom:6 }}>No matches</div><div style={{ fontSize:13,color:C.muted }}>Try a different search term or clear your filters.</div></div>
        ))
        :view==="grid"?(<div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10 }}>{filtered.map(function(note){var isSelected=selected.includes(note.id);return<div key={note.id} style={{ background:C.card,border:"2px solid "+(isSelected?C.cyan:note.color+"22"),borderRadius:16,padding:14,cursor:"pointer",position:"relative" }} onClick={function(){onNote(note);}}><div onClick={function(e){e.stopPropagation();toggleSelect(note.id);}} style={{ position:"absolute",top:10,right:10,width:20,height:20,borderRadius:"50%",border:"2px solid "+(isSelected?C.cyan:C.border),background:isSelected?C.cyan:"transparent",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11 }}>{isSelected?"✓":""}</div><div style={{ width:36,height:36,borderRadius:10,background:note.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,marginBottom:10 }}>{note.type==="drawing"?"🎨":note.tag==="Lecture"?"📚":note.tag==="Study"?"💡":note.tag==="Business"?"💼":"📝"}</div><div style={{ fontWeight:700,fontSize:13,color:C.text,marginBottom:4 }}>{note.title}</div><div style={{ fontSize:10,color:note.color,fontWeight:700,background:note.bg,borderRadius:99,padding:"2px 8px",display:"inline-block",marginBottom:6 }}>{note.course}</div><div style={{ fontSize:11,color:C.muted }}>{formatRelativeDate(note.id)}</div></div>;})}</div>)
        :(filtered.map(function(note){var isSelected=selected.includes(note.id);return<div key={note.id} style={{ background:C.card,border:"2px solid "+(isSelected?C.cyan:note.color+"22"),borderRadius:16,padding:16,marginBottom:10,cursor:"pointer",display:"flex",gap:12,alignItems:"flex-start" }} onClick={function(){onNote(note);}}><div onClick={function(e){e.stopPropagation();toggleSelect(note.id);}} style={{ width:22,height:22,borderRadius:"50%",border:"2px solid "+(isSelected?C.cyan:C.border),background:isSelected?C.cyan:"transparent",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,flexShrink:0,marginTop:2 }}>{isSelected?"✓":""}</div><div style={{ width:42,height:42,borderRadius:12,background:note.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0 }}>{note.type==="drawing"?"🎨":note.tag==="Lecture"?"📚":note.tag==="Study"?"💡":note.tag==="Business"?"💼":"📝"}</div><div style={{ flex:1 }}><div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4 }}><div style={{ fontWeight:800,fontSize:14,color:C.text }}>{note.title}</div><div style={{ fontSize:11,color:C.muted,flexShrink:0,marginLeft:8 }}>{formatRelativeDate(note.id)}</div></div><div style={{ display:"flex",gap:6,marginBottom:6 }}><span style={{ fontSize:10,color:note.color,fontWeight:700,background:note.bg,borderRadius:99,padding:"2px 8px" }}>{note.course}</span><span style={{ fontSize:10,color:C.muted,background:"rgba(255,255,255,0.04)",borderRadius:99,padding:"2px 8px" }}>{note.tag}</span></div><div style={{ fontSize:12,color:C.muted,lineHeight:1.5,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden" }}>{note.preview}</div><div style={{ display:"flex",gap:12,marginTop:8 }}><span style={{ fontSize:11,color:C.soft }}>{note.type==="drawing"?"🎨 Drawing":"💬 "+(note.words||note.content.split(" ").length)+" words"}</span><span style={{ fontSize:11,color:note.color,marginLeft:"auto" }}>Open →</span></div></div></div>;}))}
      </div>
    </div>
  );
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
function DashboardScreen({ notes, user, credits, plan, profile, onOpenAnalytics, onOpenProgress }) {
  var totalWords=notes.reduce(function(sum,n){return sum+(n.words||n.content.split(" ").length);},0);
  var totalNotes=notes.length;
  var todayNotes=notes.filter(function(n){return formatRelativeDate(n.id)==="Just now"||/m ago$/.test(formatRelativeDate(n.id))||formatRelativeDate(n.id)==="Today";}).length;
  var courseCounts={};notes.forEach(function(n){courseCounts[n.course]=(courseCounts[n.course]||0)+1;});
  var tagCounts={Lecture:0,Study:0,Business:0,Personal:0};notes.forEach(function(n){if(tagCounts[n.tag]!==undefined)tagCounts[n.tag]++;});
  // Real rolling 7-day activity, counted from each note's actual creation timestamp
  // (`id`/`createdAt` — same source formatRelativeDate already uses above) rather than a fixed sample array.
  var today0=new Date();today0=new Date(today0.getFullYear(),today0.getMonth(),today0.getDate());
  var last7Days=[];for(var di=6;di>=0;di--){last7Days.push(new Date(today0.getTime()-di*86400000));}
  var weekDays=last7Days.map(function(d,i){return i===6?"Today":d.toLocaleDateString(undefined,{weekday:"short"});});
  var weekActivity=last7Days.map(function(d){var start=d.getTime();var end=start+86400000;return notes.filter(function(n){var t=n.id||n.createdAt||0;return t>=start&&t<end;}).length;});
  var maxActivity=Math.max.apply(null,weekActivity);
  var tagColors={Lecture:C.cyan,Study:C.purple,Business:C.amber,Personal:C.green};
  var streakVal=(profile&&profile.streak)||0;
  return(
    <div style={{ flex:1,overflowY:"auto",background:C.bg }}>
      <div style={{ background:"linear-gradient(135deg,#0A0F1E,#1E1B4B)",padding:"20px 20px 24px" }}>
        <div style={{ display:"flex",alignItems:"center",gap:12,marginBottom:4 }}>
          <div style={{ width:44,height:44,borderRadius:14,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20 }}>
            {user&&user.photoURL?<img src={user.photoURL} alt="avatar" style={{ width:44,height:44,borderRadius:14,objectFit:"cover" }}/>:"👤"}
          </div>
          <div>
            <div style={{ fontWeight:800,fontSize:16,color:C.text }}>{user&&user.displayName?user.displayName.split(" ")[0]:"Student"}</div>
            <div style={{ fontSize:11,color:C.muted }}>{user&&user.email}</div>
          </div>
        </div>
        <h2 style={{ color:C.text,fontSize:22,fontWeight:800,margin:"12px 0 4px" }}>Your Dashboard 📊</h2>
        <p style={{ color:C.muted,fontSize:13,margin:0 }}>Track your study progress</p>
      </div>
      <div style={{ padding:"16px 16px 100px" }}>
        <div style={{ background:"linear-gradient(135deg,#F59E0B,#EF4444)",borderRadius:20,padding:"20px",marginBottom:16,display:"flex",justifyContent:"space-between",alignItems:"center" }}>
          <div><div style={{ fontSize:13,color:"rgba(255,255,255,0.8)",fontWeight:600,marginBottom:4 }}>Study Streak 🔥</div><div style={{ fontSize:40,fontWeight:800,color:"#fff" }}>{streakVal} Day{streakVal===1?"":"s"}</div><div style={{ fontSize:12,color:"rgba(255,255,255,0.7)",marginTop:4 }}>{streakVal>=3?"Keep it up! You're on fire!":streakVal===0?"Use the app today to start a streak.":"Come back tomorrow to keep it going!"}</div></div>
          <div style={{ fontSize:64 }}>🔥</div>
        </div>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16 }}>
          {[["📝",totalNotes,"Total Notes",C.cyan],["💬",totalWords,"Total Words",C.purple],["📅",todayNotes,"Notes Today",C.green],["⚡",credits,"AI Credits Left",credits<=LOW_CREDIT_WARNING_THRESHOLD?C.red:C.amber]].map(function(item){return<div key={item[2]} style={{ background:C.card,borderRadius:16,padding:"16px",border:"1px solid "+C.border }}><div style={{ fontSize:24,marginBottom:8 }}>{item[0]}</div><div style={{ fontSize:28,fontWeight:800,color:item[3] }}>{item[1]}</div><div style={{ fontSize:12,color:C.muted,fontWeight:600,marginTop:2 }}>{item[2]}</div></div>;}) }
        </div>
        <div style={{ background:C.card,borderRadius:18,padding:"20px",marginBottom:16,border:"1px solid "+C.border }}>
          <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:16 }}>Weekly Activity 📈</div>
          <div style={{ display:"flex",alignItems:"flex-end",gap:8,height:80 }}>{weekDays.map(function(day,i){var height=maxActivity>0?(weekActivity[i]/maxActivity)*70:4;return<div key={day} style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:6 }}><div style={{ width:"100%",height:height+"px",background:weekActivity[i]>0?"linear-gradient(135deg,#06B6D4,#A78BFA)":"rgba(255,255,255,0.05)",borderRadius:6,minHeight:4 }}/><span style={{ fontSize:10,color:C.muted,fontWeight:600 }}>{day}</span></div>;})}</div>
        </div>
        <div style={{ background:C.card,borderRadius:18,padding:"20px",marginBottom:16,border:"1px solid "+C.border }}>
          <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:16 }}>Notes by Course 📚</div>
          {Object.keys(courseCounts).map(function(course){var count=courseCounts[course];var pct=Math.round((count/totalNotes)*100);var note=notes.find(function(n){return n.course===course;});var color=note?note.color:C.cyan;return<div key={course} style={{ marginBottom:14 }}><div style={{ display:"flex",justifyContent:"space-between",marginBottom:6 }}><span style={{ fontSize:13,fontWeight:700,color:C.text }}>{course}</span><span style={{ fontSize:13,color:C.muted }}>{count} notes · {pct}%</span></div><div style={{ height:8,background:"rgba(255,255,255,0.05)",borderRadius:4 }}><div style={{ height:8,width:pct+"%",background:color,borderRadius:4,transition:"width 0.5s" }}/></div></div>;})}
        </div>
        <div style={{ background:C.card,borderRadius:18,padding:"20px",border:"1px solid "+C.border,marginBottom:16 }}>
          <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:16 }}>Notes by Type 🏷️</div>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10 }}>{Object.keys(tagCounts).map(function(tag){var count=tagCounts[tag];var color=tagColors[tag]||C.cyan;var icons={Lecture:"📚",Study:"💡",Business:"💼",Personal:"📝"};return<div key={tag} style={{ background:color+"15",borderRadius:14,padding:"14px",border:"1px solid "+color+"30" }}><div style={{ fontSize:24,marginBottom:6 }}>{icons[tag]}</div><div style={{ fontSize:22,fontWeight:800,color:color }}>{count}</div><div style={{ fontSize:11,color:C.muted,fontWeight:600 }}>{tag}</div></div>;})}</div>
        </div>
        <button onClick={onOpenProgress} style={{ width:"100%",display:"flex",alignItems:"center",gap:14,background:"linear-gradient(135deg,rgba(6,182,212,0.12),rgba(167,139,250,0.12))",border:"1px solid rgba(6,182,212,0.3)",borderRadius:18,padding:"18px",cursor:"pointer",textAlign:"left",marginBottom:16 }}>
          <div style={{ width:44,height:44,borderRadius:12,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0 }}>📈</div>
          <div style={{ flex:1 }}>
            <span style={{ fontWeight:800,fontSize:14,color:C.text }}>Progress &amp; Insights</span>
            <div style={{ fontSize:12,color:C.muted,marginTop:2 }}>This week's study time, sessions, quiz scores &amp; weakest topics</div>
          </div>
          <span style={{ color:C.muted,fontSize:18 }}>›</span>
        </button>
        <button onClick={onOpenAnalytics} style={{ width:"100%",display:"flex",alignItems:"center",gap:14,background:"linear-gradient(135deg,rgba(245,158,11,0.12),rgba(239,68,68,0.12))",border:"1px solid rgba(245,158,11,0.3)",borderRadius:18,padding:"18px",cursor:"pointer",textAlign:"left" }}>
          <div style={{ width:44,height:44,borderRadius:12,background:"linear-gradient(135deg,#F59E0B,#EF4444)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0 }}>📊</div>
          <div style={{ flex:1 }}>
            <div style={{ display:"flex",alignItems:"center",gap:8 }}><span style={{ fontWeight:800,fontSize:14,color:C.text }}>Advanced Analytics</span>{!planAtLeast(plan,"pro")&&<span style={{ fontSize:9,fontWeight:800,color:C.amber,background:"rgba(245,158,11,0.15)",borderRadius:99,padding:"2px 7px" }}>PRO</span>}</div>
            <div style={{ fontSize:12,color:C.muted,marginTop:2 }}>30-day trends, course health, exam score history &amp; more</div>
          </div>
          <span style={{ color:C.muted,fontSize:18 }}>›</span>
        </button>
      </div>
    </div>
  );
}

// ── ADVANCED ANALYTICS (Premium) ────────────────────────────────────────────────
// Genuinely deeper than the basic Dashboard, not a reskin: a 30-day trend instead of
// 7 days, a time-of-day study pattern, a course "needs attention" breakdown, assignment
// on-time completion tracking, and real Exam Mode score history — the last of which
// required Exam Mode to actually start persisting results (it was fully ephemeral
// before this), so this is the first place that data has ever been usable.
function AdvancedAnalyticsScreen({ notes, assignments, examResults, plan, onBack, onUpgrade }) {
  if (!planAtLeast(plan, "pro")) {
    return (
      <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
        <div style={{ background:C.card,padding:"16px 20px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid "+C.border }}>
          <button onClick={onBack} style={backBtn}>←</button>
          <span style={{ fontWeight:800,fontSize:16,color:C.text }}>📊 Advanced Analytics</span>
        </div>
        <div style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,textAlign:"center" }}>
          <div style={{ fontSize:56,marginBottom:16 }}>📊</div>
          <div style={{ fontWeight:800,fontSize:18,color:C.text,marginBottom:8 }}>Advanced Analytics is a Pro feature</div>
          <p style={{ color:C.muted,fontSize:13,lineHeight:1.6,marginBottom:24,maxWidth:280 }}>30-day trends, study time patterns, course health, and real exam score history — not just the basics.</p>
          <button onClick={onUpgrade} style={{ background:"linear-gradient(135deg,#F59E0B,#EF4444)",color:"#fff",border:"none",borderRadius:14,padding:"14px 32px",fontWeight:800,fontSize:15,cursor:"pointer" }}>🚀 Upgrade to Pro</button>
        </div>
      </div>
    );
  }

  // 30-day activity trend
  var today0 = new Date(); today0.setHours(0,0,0,0);
  var last30 = []; for (var i=29;i>=0;i--){ last30.push(new Date(today0.getTime()-i*86400000)); }
  var dailyCounts = last30.map(function(d){ var start=d.getTime(), end=start+86400000; return notes.filter(function(n){ var t=n.id||n.createdAt||0; return t>=start&&t<end; }).length; });
  var maxDaily = Math.max.apply(null, dailyCounts.concat([1]));
  var total30 = dailyCounts.reduce(function(s,c){return s+c;},0);

  // Study time-of-day pattern
  var PERIODS = [["🌅","Morning",5,11],["☀️","Afternoon",12,16],["🌆","Evening",17,21],["🌙","Night",22,4]];
  var periodCounts = PERIODS.map(function(p){
    return notes.filter(function(n){
      var h = new Date(n.id||n.createdAt||0).getHours();
      return p[2]<=p[3] ? (h>=p[2]&&h<=p[3]) : (h>=p[2]||h<=p[3]);
    }).length;
  });
  var maxPeriod = Math.max.apply(null, periodCounts.concat([1]));
  var peakIdx = notes.length ? periodCounts.indexOf(Math.max.apply(null,periodCounts)) : -1;

  // Course deep-dive, stalest first
  var courseStats = {};
  notes.forEach(function(n){
    if (!courseStats[n.course]) courseStats[n.course] = { count:0, words:0, lastActive:0 };
    courseStats[n.course].count++;
    courseStats[n.course].words += (n.words||n.content.split(" ").length);
    courseStats[n.course].lastActive = Math.max(courseStats[n.course].lastActive, n.id||0);
  });
  var courseRows = Object.keys(courseStats).map(function(c){
    var s = courseStats[c];
    var daysSince = Math.floor((Date.now()-s.lastActive)/86400000);
    var status = daysSince<=3 ? {label:"🟢 Active",color:C.green} : daysSince<=7 ? {label:"🟡 Cooling",color:C.amber} : {label:"🔴 Needs Attention",color:C.red};
    return { course:c, count:s.count, words:s.words, daysSince:daysSince, status:status };
  }).sort(function(a,b){ return b.daysSince-a.daysSince; });

  // Assignment completion
  var completedAssignments = assignments.filter(function(a){return a.completed;});
  var completionRate = assignments.length ? Math.round((completedAssignments.length/assignments.length)*100) : null;
  var onTimeCount = completedAssignments.filter(function(a){
    if (!a.completedAt || !a.dueDate) return false;
    return a.completedAt <= new Date(a.dueDate+"T23:59:59").getTime();
  }).length;
  var onTimeRate = completedAssignments.length ? Math.round((onTimeCount/completedAssignments.length)*100) : null;
  var overdueCount = assignments.filter(function(a){ return !a.completed && a.dueDate && new Date(a.dueDate+"T23:59:59").getTime()<Date.now(); }).length;

  // Exam Mode score history
  var examAvg = examResults.length ? Math.round(examResults.reduce(function(s,r){return s+r.percentage;},0)/examResults.length) : null;
  var trend = null;
  if (examResults.length>=4) {
    var recent3 = examResults.slice(0,3).reduce(function(s,r){return s+r.percentage;},0)/3;
    var priorSlice = examResults.slice(3,6);
    var prior3 = priorSlice.length ? priorSlice.reduce(function(s,r){return s+r.percentage;},0)/priorSlice.length : null;
    if (prior3!=null) {
      trend = recent3>prior3+3 ? {text:"📈 Improving",color:C.green} : recent3<prior3-3 ? {text:"📉 Slipping",color:C.red} : {text:"➡️ Steady",color:C.muted};
    }
  }

  var cardStyle = { background:C.card,borderRadius:18,padding:20,marginBottom:16,border:"1px solid "+C.border };
  var headingStyle = { fontWeight:800,fontSize:15,color:C.text,marginBottom:16 };

  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>📊 Advanced Analytics</span>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>

        <div style={cardStyle}>
          <div style={headingStyle}>30-Day Activity <span style={{fontWeight:600,color:C.muted,fontSize:12}}>· {total30} notes</span></div>
          <div style={{ display:"flex",alignItems:"flex-end",gap:2,height:70,overflowX:"auto" }}>
            {dailyCounts.map(function(c,idx){ var h = maxDaily>0 ? (c/maxDaily)*60 : 2; return <div key={idx} title={c+" notes"} style={{ flex:"1 0 6px",minWidth:6,height:h+"px",background:c>0?"linear-gradient(135deg,#06B6D4,#A78BFA)":"rgba(255,255,255,0.06)",borderRadius:2 }}/>; })}
          </div>
          <div style={{ display:"flex",justifyContent:"space-between",marginTop:8 }}><span style={{ fontSize:10,color:C.muted }}>30 days ago</span><span style={{ fontSize:10,color:C.muted }}>Today</span></div>
        </div>

        <div style={cardStyle}>
          <div style={headingStyle}>Study Time Pattern</div>
          <div style={{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:peakIdx>=0?12:0 }}>
            {PERIODS.map(function(p,idx){ var h = maxPeriod>0 ? (periodCounts[idx]/maxPeriod)*50 : 2; return(
              <div key={p[1]} style={{ textAlign:"center" }}>
                <div style={{ height:56,display:"flex",alignItems:"flex-end",justifyContent:"center",marginBottom:6 }}><div style={{ width:"70%",height:h+"px",background:idx===peakIdx?"linear-gradient(135deg,#06B6D4,#A78BFA)":"rgba(255,255,255,0.08)",borderRadius:4 }}/></div>
                <div style={{ fontSize:16 }}>{p[0]}</div>
                <div style={{ fontSize:10,color:C.muted,fontWeight:600 }}>{p[1]}</div>
              </div>
            );})}
          </div>
          {peakIdx>=0 && <div style={{ fontSize:12,color:C.cyan,fontWeight:700,textAlign:"center" }}>You study most in the {PERIODS[peakIdx][1]}</div>}
        </div>

        <div style={cardStyle}>
          <div style={headingStyle}>Course Health</div>
          {courseRows.length===0 && <p style={{ color:C.muted,fontSize:13 }}>No notes yet.</p>}
          {courseRows.map(function(r){return(
            <div key={r.course} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:"1px solid "+C.border }}>
              <div>
                <div style={{ fontSize:13,fontWeight:700,color:C.text }}>{r.course}</div>
                <div style={{ fontSize:11,color:C.muted,marginTop:2 }}>{r.count} notes · {r.words} words</div>
              </div>
              <span style={{ fontSize:11,fontWeight:700,color:r.status.color,background:r.status.color+"18",borderRadius:99,padding:"4px 10px",whiteSpace:"nowrap" }}>{r.status.label}</span>
            </div>
          );})}
        </div>

        <div style={cardStyle}>
          <div style={headingStyle}>Assignments</div>
          {assignments.length===0 ? <p style={{ color:C.muted,fontSize:13 }}>No assignments tracked yet.</p> : (
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10 }}>
              <div><div style={{ fontSize:22,fontWeight:800,color:C.cyan }}>{completionRate}%</div><div style={{ fontSize:10,color:C.muted,fontWeight:600 }}>Completed</div></div>
              <div><div style={{ fontSize:22,fontWeight:800,color:onTimeRate==null?C.muted:C.green }}>{onTimeRate==null?"—":onTimeRate+"%"}</div><div style={{ fontSize:10,color:C.muted,fontWeight:600 }}>On Time</div></div>
              <div><div style={{ fontSize:22,fontWeight:800,color:overdueCount>0?C.red:C.muted }}>{overdueCount}</div><div style={{ fontSize:10,color:C.muted,fontWeight:600 }}>Overdue</div></div>
            </div>
          )}
        </div>

        <div style={{ ...cardStyle, marginBottom:20 }}>
          <div style={headingStyle}>Exam Mode Performance</div>
          {examResults.length===0 ? (
            <p style={{ color:C.muted,fontSize:13,lineHeight:1.6 }}>No exam attempts yet — take a practice exam in Exam Mode and your scores will show up here.</p>
          ) : (
            <div>
              <div style={{ display:"flex",alignItems:"center",gap:16,marginBottom:16 }}>
                <div><div style={{ fontSize:28,fontWeight:800,color:C.text }}>{examAvg}%</div><div style={{ fontSize:10,color:C.muted,fontWeight:600 }}>Average Score</div></div>
                {trend && <span style={{ fontSize:12,fontWeight:700,color:trend.color,background:trend.color+"18",borderRadius:99,padding:"5px 12px" }}>{trend.text}</span>}
              </div>
              {examResults.slice(0,8).map(function(r){return(
                <div key={r.id} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid "+C.border }}>
                  <div style={{ fontSize:12,color:C.text,fontWeight:600 }}>{r.course}</div>
                  <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                    <span style={{ fontSize:11,color:C.muted }}>{formatRelativeDate(r.createdAt)}</span>
                    <span style={{ fontSize:12,fontWeight:800,color:r.percentage>=70?C.green:r.percentage>=50?C.amber:C.red }}>{r.percentage}%</span>
                  </div>
                </div>
              );})}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
// ── COMMAND CENTER (Home) ─────────────────────────────────────────────────────
// Focused replacement for the stats-heavy Home screen below: exactly the
// sections asked for — greeting/date, attention summary, Today's Mission,
// courses, weak topics, upcoming, quick actions — nothing else (no stats row,
// no "Your Day" grid, no recent-notes list). HomeScreen right below this is
// left completely untouched and unused; this is a new, separate component,
// not an edit of it.
//
// Today's Mission, attention summary, and weak topics are all powered by
// buildRecommendations() (src/services/recommendationService.js), the
// deterministic, non-AI rule engine built earlier this session. Two honest
// gaps carried over from that file, not papered over here either:
//   - exams: no wired data source yet (see recommendationService.js's own
//     comment on this), so exam_prep recommendations never fire until a real
//     exam concept with a courseId exists. Passed as [] below.
//   - topicMastery reads back empty until something actually calls
//     updateTopicMasteryFromQuizAttempt() after a quiz completes — that's a
//     quiz-flow change, and the quiz UI stays untouched here on purpose. The
//     Weak Topics section has an honest "no data yet" empty state for this,
//     not a fake one.
function daysUntilDateStr(dateStr){
  var today = new Date(); today.setHours(0,0,0,0);
  var d = new Date(dateStr+"T00:00:00");
  return Math.round((d.getTime()-today.getTime())/86400000);
}
function fmtUpcomingDate(dateStr){
  var d = new Date(dateStr+"T00:00:00");
  return d.toLocaleDateString(undefined,{ weekday:"short", month:"short", day:"numeric" });
}
function missionCtaFor(type){
  return ({
    assignment_due_soon: { label:"View Assignment" },
    weak_topic:           { label:"Practice with AI Tutor" },
    exam_prep:            { label:"Start Exam Mode" },
    study_reminder:       { label:"Record a Lecture" },
  })[type] || { label:"Open" };
}

function CommandCenterScreen({ notes, recordings, assignments, topicMastery, courses, user, plan, onVoice, onDraw, onAIWrite, onScan, onChat, onRecordings, onStudyPlanner, onExamMode, onAssignments, onFlashcards, onAITutor, onSearch, onNotifications, onProfile, unreadCount, onOpenMission, onOpenCourse, onOpenTopic, onStartStudySession, onOpenVault, onOpenUpcoming, onOpenProgress, onCreateNote, onUploadMaterial, onAddAssignmentDirect }) {
  var [showAddMenu, setShowAddMenu] = useState(false);
  var [showAskMenu, setShowAskMenu] = useState(false);
  var [askMenuPhase, setAskMenuPhase] = useState("options"); // "options" | "course" — course sub-step only shown for "Ask about this course" when there's more than one course
  var hour = new Date().getHours();
  var greeting = hour<12?"Good morning":hour<17?"Good afternoon":"Good evening";
  var firstName = user&&user.displayName ? user.displayName.split(" ")[0] : "Student";
  var todayLabel = new Date().toLocaleDateString(undefined,{ weekday:"long", month:"long", day:"numeric" });

  // Best-available "last studied" signal from data already loaded — same
  // notes/recordings this screen already receives, no extra fetch needed.
  var lastStudyActivityAt = notes.concat(recordings).reduce(function(max,item){ var t=item.createdAt||item.id||0; return t>max?t:max; }, 0) || null;

  var recommendations = buildRecommendations({
    assignments: assignments,
    topicMastery: topicMastery,
    exams: [], // no wired exam-date source yet — see file header above
    lastStudyActivityAt: lastStudyActivityAt,
  });

  var mission = recommendations.length ? recommendations[0] : null;
  var missionHandler = onAssignments;
  if (mission) {
    if (mission.type==="weak_topic") missionHandler = onAITutor;
    else if (mission.type==="exam_prep") missionHandler = onExamMode;
    else if (mission.type==="study_reminder") missionHandler = onVoice;
    else missionHandler = onAssignments;
  }
  var missionLabel = mission ? missionCtaFor(mission.type).label : null;

  var highCount = recommendations.filter(function(r){return r.priority==="high";}).length;
  var medCount = recommendations.filter(function(r){return r.priority==="medium";}).length;
  var lowCount = recommendations.filter(function(r){return r.priority==="low";}).length;

  // Widened to include real Course records (not just note-derived names) so a
  // course with materials/a study plan but not a single note yet still shows
  // up as a chip here — real courses first, then any legacy note-only names.
  var courseList = Array.from(new Set((courses||[]).map(function(c){return c.code||c.title;}).filter(Boolean).concat(notes.map(function(n){return n.course;}))));
  var courseCounts = {};
  notes.forEach(function(n){ courseCounts[n.course]=(courseCounts[n.course]||0)+1; });

  var weakTopics = topicMastery.filter(function(m){ return typeof m.masteryScore==="number" && m.masteryScore<50; })
    .slice().sort(function(a,b){ return a.masteryScore-b.masteryScore; }).slice(0,4);

  var upcomingAssignments = assignments.filter(function(a){ return !a.completed && a.dueDate; })
    .slice().sort(function(a,b){ return (a.dueDate||"").localeCompare(b.dueDate||""); }).slice(0,4);

  // 5th element is the required plan tier for a locked action: false = no gate,
  // "pro" = Pro-and-above (Study Planner, AI Tutor), "premium" = Premium-only
  // (Exam Mode) — checked against planAtLeast() below, not a plain "premium" string.
  var QUICK_ACTIONS = [["🎤","Record\nLecture",C.cyan,onVoice,false],["✨","AI\nWrite",C.purple,onAIWrite,false],["💬","Ask\nJotting",C.cyan,function(){setShowAskMenu(true);},false],["📷","Scan\nDoc",C.amber,onScan,false],["🖊️","Draw",C.green,onDraw,false],["📁","My\nRecordings",C.purple,onRecordings,false],["🗓️","Study\nPlanner",C.amber,onStudyPlanner,"pro"],["🎯","Exam\nMode",C.red,onExamMode,"premium"],["📋","Assignments",C.green,onAssignments,false],["🗂️","Flashcards",C.purple,onFlashcards,false],["🎓","AI\nTutor",C.amber,onAITutor,"pro"],["🧭","Study\nSession",C.cyan,onStartStudySession,false],["🗄️","Study\nVault",C.cyan,onOpenVault,false],["📅","Upcoming",C.purple,onOpenUpcoming,false],["📈","Progress",C.cyan,onOpenProgress,false]];

  // Every option here funnels into the SAME AIScreen instance via onChat(seed)
  // — this is a launcher for different ways to start talking to SAM-X, not a
  // dispatcher across the app. initialPicker reuses AIScreen's own existing
  // note-attachment flow (same as its "Explain a note"/"Quiz me"/"Study plan"
  // suggestion chips); initialSend reuses its normal send() path, just fired
  // immediately; initialPrefill just fills the input box for the student to
  // finish and send themselves. None of these are new chat/AI logic.
  var ASK_MENU_OPTIONS = [
    ["💡","Explain something","Get a concept broken down step by step", function(){setShowAskMenu(false);onChat({initialPrefill:"Explain "});}],
    ["🧭","Help me study","Get a quick nudge on what to focus on", function(){setShowAskMenu(false);onChat({initialSend:"Help me figure out what to study right now."});}],
    ["❓","Quiz me","Get quizzed conversationally on one of your notes", function(){setShowAskMenu(false);onChat({initialPicker:"quiz"});}],
    ["📝","Help with notes","Attach a note and talk through it", function(){setShowAskMenu(false);onChat({initialPicker:"discuss"});}],
    ["🗓️","Create a study plan","Turn a note into a review schedule", function(){setShowAskMenu(false);onChat({initialPicker:"studyplan"});}],
    ["🎓","Ask about this course","Start a conversation about a specific course", function(){
      if (courseList.length<=1) { setShowAskMenu(false); onChat({initialPrefill:"I have a question about "+(courseList[0]||"my course")+": "}); }
      else { setAskMenuPhase("course"); }
    }],
  ];

  // icon, label, description, handler — each handler is either an existing
  // screen's existing prop called as-is (Record Lecture/Add Exam/Add
  // Resource), an existing screen's existing add-form opened directly
  // (Add Assignment), or a thin new input form that hands off to an already-
  // existing save function (Upload Material/Create Note) — see those two
  // screens' own header comments for why they're new UI but not new logic.
  var ADD_MENU_OPTIONS = [
    ["🎤","Record Lecture","Record and auto-transcribe a class", function(){setShowAddMenu(false);onVoice();}],
    ["📎","Upload Material","Save details for a PDF, handout, or past paper", function(){setShowAddMenu(false);onUploadMaterial();}],
    ["📝","Create Note","Write a note from scratch", function(){setShowAddMenu(false);onCreateNote();}],
    ["📋","Add Assignment","Track a due date", function(){setShowAddMenu(false);onAddAssignmentDirect();}],
    ["🎯","Add Exam","Set an exam date and build a study plan", function(){setShowAddMenu(false);onStudyPlanner();}],
    ["📷","Add Resource","Scan or upload a document to pull notes from", function(){setShowAddMenu(false);onScan();}],
  ];

  return (
    <div style={{ flex:1,position:"relative",overflow:"hidden",display:"flex",flexDirection:"column" }}>
    <div style={{ flex:1,overflowY:"auto" }}>
      {/* Header + greeting/date */}
      <div style={{ background:"linear-gradient(135deg,#0A0F1E 0%,#1E1B4B 60%,#0A0F1E 100%)",padding:"24px 20px 28px",position:"relative",overflow:"hidden" }}>
        <div style={{ position:"absolute",top:-40,right:-40,width:160,height:160,borderRadius:"50%",background:"rgba(6,182,212,0.07)" }}/>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,position:"relative" }}>
          <div style={{ display:"flex",alignItems:"center",gap:10 }}>
            <div style={{ width:40,height:40,borderRadius:12,overflow:"hidden" }}><img src="/jotting-logo.png" alt="Jotting AI" style={{ width:"100%",height:"100%",objectFit:"cover" }}/></div>
            <span style={{ fontWeight:800,fontSize:20,color:C.text }}>Jotting <span style={{ color:C.cyan }}>AI</span></span>
          </div>
          <div style={{ display:"flex",gap:8 }}>
            <button onClick={function(){setShowAddMenu(true);}} title="Add" style={{ background:"rgba(255,255,255,0.08)",border:"none",borderRadius:10,width:38,height:38,cursor:"pointer",fontSize:20,fontWeight:700,color:C.text,lineHeight:1 }}>+</button>
            <button onClick={onSearch} title="Search everything" style={{ background:"rgba(255,255,255,0.08)",border:"none",borderRadius:10,width:38,height:38,cursor:"pointer",fontSize:17 }}>🔍</button>
            <button onClick={onNotifications} style={{ position:"relative",background:"rgba(255,255,255,0.08)",border:"none",borderRadius:10,width:38,height:38,cursor:"pointer",fontSize:17 }}>🔔{unreadCount>0&&<span style={{ position:"absolute",top:-2,right:-2,background:C.red,color:"#fff",borderRadius:99,minWidth:16,height:16,fontSize:9,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 3px" }}>{unreadCount>9?"9+":unreadCount}</span>}</button>
            <button onClick={onProfile} style={{ width:38,height:38,borderRadius:"50%",overflow:"hidden",background:"linear-gradient(135deg,#06B6D4,#A78BFA)",border:"none",display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,cursor:"pointer",padding:0 }}>
              {user&&user.photoURL?<img src={user.photoURL} alt="u" style={{ width:38,height:38,objectFit:"cover" }}/>:"👤"}
            </button>
          </div>
        </div>
        <p style={{ color:"rgba(255,255,255,0.45)",fontSize:13,margin:"0 0 4px" }}>{todayLabel}</p>
        <h2 style={{ color:C.text,fontSize:24,fontWeight:800,margin:0,letterSpacing:-0.5 }}>{greeting}, <span style={{ color:C.cyan }}>{firstName}</span></h2>
      </div>

      <div style={{ padding:"20px 20px 100px" }}>

        {/* Attention summary */}
        <div style={{ background:recommendations.length?C.card:"rgba(52,211,153,0.1)",border:"1px solid "+(recommendations.length?C.border:"rgba(52,211,153,0.3)"),borderRadius:16,padding:"14px 16px",marginBottom:20,display:"flex",alignItems:"center",gap:12 }}>
          <span style={{ fontSize:26 }}>{recommendations.length?"⚠️":"🎉"}</span>
          <div style={{ flex:1 }}>
            {recommendations.length ? (
              <div>
                <div style={{ fontWeight:800,fontSize:14,color:C.text }}>{recommendations.length} thing{recommendations.length===1?"":"s"} need{recommendations.length===1?"s":""} your attention</div>
                <div style={{ fontSize:12,color:C.muted,marginTop:2,display:"flex",gap:10 }}>
                  {highCount>0&&<span style={{ color:C.red,fontWeight:700 }}>● {highCount} high</span>}
                  {medCount>0&&<span style={{ color:C.amber,fontWeight:700 }}>● {medCount} medium</span>}
                  {lowCount>0&&<span style={{ color:C.muted,fontWeight:700 }}>● {lowCount} low</span>}
                </div>
              </div>
            ) : (
              <div style={{ fontWeight:800,fontSize:14,color:C.green }}>You're all caught up — nothing urgent today.</div>
            )}
          </div>
        </div>

        {/* Today's Mission — the main focus */}
        <div style={{ marginBottom:24 }}>
          <div style={{ fontSize:11,fontWeight:800,color:C.muted,letterSpacing:1,marginBottom:10,textTransform:"uppercase" }}>Today's Mission</div>
          {mission ? (
            <div style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)",borderRadius:22,padding:24,boxShadow:"0 12px 40px rgba(6,182,212,0.3)" }}>
              <div style={{ fontSize:11,fontWeight:800,color:"rgba(255,255,255,0.75)",letterSpacing:0.5,marginBottom:8,textTransform:"uppercase" }}>{mission.priority} priority</div>
              <div style={{ fontWeight:800,fontSize:20,color:"#fff",marginBottom:8,lineHeight:1.3 }}>{mission.title}</div>
              <div style={{ fontSize:14,color:"rgba(255,255,255,0.9)",lineHeight:1.6,marginBottom:20 }}>{mission.message}</div>
              <div style={{ display:"flex",alignItems:"center",gap:18,flexWrap:"wrap" }}>
                <button onClick={missionHandler} style={{ background:"#fff",color:"#0A0F1E",border:"none",borderRadius:14,padding:"13px 22px",fontWeight:800,fontSize:14,cursor:"pointer" }}>{missionLabel} →</button>
                <button onClick={onOpenMission} style={{ background:"none",border:"none",color:"rgba(255,255,255,0.85)",fontWeight:700,fontSize:13,cursor:"pointer",textDecoration:"underline",padding:0 }}>View all tasks</button>
              </div>
            </div>
          ) : (
            <div style={{ background:"linear-gradient(135deg,#34D399,#06B6D4)",borderRadius:22,padding:24,boxShadow:"0 12px 40px rgba(52,211,153,0.25)" }}>
              <div style={{ fontWeight:800,fontSize:20,color:"#fff",marginBottom:8 }}>🎉 All clear!</div>
              <div style={{ fontSize:14,color:"rgba(255,255,255,0.9)",lineHeight:1.6,marginBottom:20 }}>No urgent assignments, weak topics, or exam prep right now. Good time to get ahead — record a lecture or write some notes.</div>
              <div style={{ display:"flex",alignItems:"center",gap:18,flexWrap:"wrap" }}>
                <button onClick={onVoice} style={{ background:"#fff",color:"#0A0F1E",border:"none",borderRadius:14,padding:"13px 22px",fontWeight:800,fontSize:14,cursor:"pointer" }}>Record a Lecture →</button>
                <button onClick={onOpenMission} style={{ background:"none",border:"none",color:"rgba(255,255,255,0.85)",fontWeight:700,fontSize:13,cursor:"pointer",textDecoration:"underline",padding:0 }}>View all tasks</button>
              </div>
            </div>
          )}
        </div>

        {/* Courses */}
        <div style={{ marginBottom:24 }}>
          <div style={{ fontWeight:800,fontSize:16,color:C.text,margin:"0 0 12px" }}>Courses</div>
          {courseList.length===0 ? (
            <div style={{ fontSize:13,color:C.muted }}>No courses yet — save a note and it'll show up here.</div>
          ) : (
            <div style={{ display:"flex",gap:10,overflowX:"auto",paddingBottom:4 }}>
              {courseList.map(function(c){ return(
                <button key={c} onClick={function(){onOpenCourse(c);}} style={{ background:C.card,border:"1px solid "+C.border,borderRadius:14,padding:"12px 16px",flexShrink:0,minWidth:100,cursor:"pointer",textAlign:"left",fontFamily:"inherit" }}>
                  <div style={{ fontWeight:800,fontSize:13,color:C.text,whiteSpace:"nowrap" }}>{c}</div>
                  <div style={{ fontSize:11,color:C.muted,marginTop:3 }}>{courseCounts[c]||0} note{courseCounts[c]===1?"":"s"}</div>
                </button>
              );})}
            </div>
          )}
        </div>

        {/* Weak topics */}
        <div style={{ marginBottom:24 }}>
          <div style={{ fontWeight:800,fontSize:16,color:C.text,margin:"0 0 12px" }}>Weak Topics</div>
          {weakTopics.length===0 ? (
            <div style={{ background:C.card,borderRadius:14,padding:16,border:"1px solid "+C.border,fontSize:13,color:C.muted,lineHeight:1.5 }}>
              {topicMastery.length===0 ? "No topic mastery data yet — this fills in once quiz results start feeding it." : "No weak topics right now — nice work."}
            </div>
          ) : weakTopics.map(function(m){ return(
            <div key={m.id} style={{ background:C.card,border:"1px solid "+C.border,borderRadius:14,padding:14,marginBottom:10 }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
                <div style={{ fontWeight:700,fontSize:14,color:C.text }}>{m.topic}</div>
                <div style={{ fontWeight:800,fontSize:14,color:C.red }}>{m.masteryScore}%</div>
              </div>
              <div style={{ height:6,background:C.card2,borderRadius:99,overflow:"hidden",marginBottom:10 }}><div style={{ height:"100%",width:m.masteryScore+"%",background:C.red,borderRadius:99 }}/></div>
              <div style={{ display:"flex",gap:14,alignItems:"center" }}>
                <button onClick={onAITutor} style={{ background:"none",border:"none",color:C.cyan,fontSize:12,fontWeight:700,cursor:"pointer",padding:0 }}>Practice with AI Tutor →</button>
                <button onClick={function(){onOpenTopic(m);}} style={{ background:"none",border:"none",color:C.muted,fontSize:12,fontWeight:700,cursor:"pointer",padding:0 }}>View Details</button>
              </div>
            </div>
          );})}
        </div>

        {/* Upcoming */}
        <div style={{ marginBottom:24 }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",margin:"0 0 12px" }}>
            <div style={{ fontWeight:800,fontSize:16,color:C.text }}>Upcoming</div>
            <button onClick={onOpenUpcoming} style={{ background:"none",border:"none",color:C.cyan,fontWeight:700,fontSize:12,cursor:"pointer",padding:0 }}>View all →</button>
          </div>
          {upcomingAssignments.length===0 ? (
            <div style={{ background:C.card,borderRadius:14,padding:16,border:"1px solid "+C.border,fontSize:13,color:C.muted }}>Nothing due — you're clear.</div>
          ) : upcomingAssignments.map(function(a){
            var d = daysUntilDateStr(a.dueDate);
            var dueColor = d<0?C.red:d<=1?C.amber:C.muted;
            return(
              <button key={a.id} onClick={onAssignments} style={{ width:"100%",textAlign:"left",background:C.card,border:"1px solid "+C.border,borderRadius:14,padding:14,marginBottom:10,cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",gap:10 }}>
                <div style={{ minWidth:0 }}>
                  <div style={{ fontWeight:700,fontSize:14,color:C.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{a.title}</div>
                  <div style={{ fontSize:11,color:C.purple,fontWeight:700,marginTop:3 }}>{a.course}</div>
                </div>
                <div style={{ fontSize:12,color:dueColor,fontWeight:800,flexShrink:0 }}>{d<0?"Overdue":fmtUpcomingDate(a.dueDate)}</div>
              </button>
            );
          })}
        </div>

        {/* Quick actions */}
        <div>
          <div style={{ fontWeight:800,fontSize:16,color:C.text,margin:"0 0 12px" }}>Quick Actions</div>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10 }}>
            {QUICK_ACTIONS.map(function(item){ var locked=item[4]&&!planAtLeast(plan,item[4]); return(
              <button key={item[1]} onClick={item[3]} style={{ position:"relative",background:C.card,border:"1px solid "+item[2]+"30",borderRadius:14,padding:"14px 8px",cursor:"pointer",textAlign:"center" }}>
                {locked&&<span style={{ position:"absolute",top:6,right:6,fontSize:9,fontWeight:800,color:C.amber,background:"rgba(245,158,11,0.15)",borderRadius:99,padding:"2px 6px" }}>PRO</span>}
                <div style={{ width:38,height:38,borderRadius:10,background:item[2]+"20",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 8px",fontSize:20 }}>{item[0]}</div>
                <span style={{ fontSize:11,fontWeight:700,color:C.soft,whiteSpace:"pre-line",lineHeight:1.3 }}>{item[1]}</span>
              </button>
            );})}
          </div>
        </div>

      </div>
    </div>

      {showAddMenu && (
        <div style={{ position:"absolute",inset:0,background:"rgba(10,15,30,0.85)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:30 }} onClick={function(){setShowAddMenu(false);}}>
          <div style={{ background:C.card,borderRadius:"20px 20px 0 0",padding:20,width:"100%",maxHeight:"75vh",overflowY:"auto",boxSizing:"border-box" }} onClick={function(e){e.stopPropagation();}}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
              <span style={{ fontWeight:800,fontSize:16,color:C.text }}>Add to Jotting AI</span>
              <button onClick={function(){setShowAddMenu(false);}} style={{ background:"none",border:"none",color:C.muted,fontSize:18,cursor:"pointer" }}>✕</button>
            </div>
            {ADD_MENU_OPTIONS.map(function(opt){return(
              <button key={opt[1]} onClick={opt[3]} style={{ width:"100%",display:"flex",alignItems:"center",gap:14,textAlign:"left",background:C.card2,border:"1px solid "+C.border,borderRadius:14,padding:"14px 16px",marginBottom:10,cursor:"pointer",fontFamily:"inherit" }}>
                <div style={{ width:38,height:38,borderRadius:10,background:C.cyan+"20",display:"flex",alignItems:"center",justifyContent:"center",fontSize:19,flexShrink:0 }}>{opt[0]}</div>
                <div style={{ minWidth:0 }}>
                  <div style={{ fontWeight:700,fontSize:14,color:C.text }}>{opt[1]}</div>
                  <div style={{ fontSize:12,color:C.muted,marginTop:2 }}>{opt[2]}</div>
                </div>
              </button>
            );})}
          </div>
        </div>
      )}

      {showAskMenu && (
        <div style={{ position:"absolute",inset:0,background:"rgba(10,15,30,0.85)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:30 }} onClick={function(){setShowAskMenu(false);setAskMenuPhase("options");}}>
          <div style={{ background:C.card,borderRadius:"20px 20px 0 0",padding:20,width:"100%",maxHeight:"75vh",overflowY:"auto",boxSizing:"border-box" }} onClick={function(e){e.stopPropagation();}}>
            {askMenuPhase==="options" ? (
              <div>
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
                  <span style={{ fontWeight:800,fontSize:16,color:C.text }}>💬 Ask Jotting</span>
                  <button onClick={function(){setShowAskMenu(false);}} style={{ background:"none",border:"none",color:C.muted,fontSize:18,cursor:"pointer" }}>✕</button>
                </div>
                {ASK_MENU_OPTIONS.map(function(opt){return(
                  <button key={opt[1]} onClick={opt[3]} style={{ width:"100%",display:"flex",alignItems:"center",gap:14,textAlign:"left",background:C.card2,border:"1px solid "+C.border,borderRadius:14,padding:"14px 16px",marginBottom:10,cursor:"pointer",fontFamily:"inherit" }}>
                    <div style={{ width:38,height:38,borderRadius:10,background:C.cyan+"20",display:"flex",alignItems:"center",justifyContent:"center",fontSize:19,flexShrink:0 }}>{opt[0]}</div>
                    <div style={{ minWidth:0 }}>
                      <div style={{ fontWeight:700,fontSize:14,color:C.text }}>{opt[1]}</div>
                      <div style={{ fontSize:12,color:C.muted,marginTop:2 }}>{opt[2]}</div>
                    </div>
                  </button>
                );})}
              </div>
            ) : (
              <div>
                <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:16 }}>
                  <button onClick={function(){setAskMenuPhase("options");}} style={{ background:"none",border:"none",color:C.cyan,fontSize:14,fontWeight:700,cursor:"pointer",padding:0 }}>← Back</button>
                  <span style={{ fontWeight:800,fontSize:16,color:C.text }}>Which course?</span>
                </div>
                {courseList.map(function(c){return(
                  <button key={c} onClick={function(){setShowAskMenu(false);setAskMenuPhase("options");onChat({initialPrefill:"I have a question about "+c+": "});}} style={{ width:"100%",textAlign:"left",background:C.card2,border:"1px solid "+C.border,borderRadius:14,padding:"14px 16px",marginBottom:10,cursor:"pointer",fontFamily:"inherit",fontWeight:700,fontSize:14,color:C.text }}>{c}</button>
                );})}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── TODAY'S MISSION (detail screen) ─────────────────────────────────────────
// Full task-list view behind the Command Center's Today's Mission card. Every
// task here is DERIVED, not stored — no new repository, no new IndexedDB
// store, nothing persisted anywhere. Exactly two existing sources, as asked:
//   - buildRecommendations() (src/services/recommendationService.js) for
//     assignment/weak-topic/exam-prep/reminder tasks — the same rule engine
//     the Command Center's hero card already uses.
//   - studyPlansRepository records whose exam date hasn't passed yet, one
//     task per active plan.
//
// TASK STATUS is inferred from real signals already on the underlying
// records — a topic's lastStudiedAt being today's date, or overall study
// activity today — not tracked separately. There are exactly two states,
// not_started/in_progress. A task that gets fully resolved (assignment
// completed, mastery crosses its threshold) simply stops appearing on the
// next render, since buildRecommendations() itself stops returning it — that
// disappearance IS the "done" signal, rather than a third status this screen
// would otherwise have to invent and persist somewhere just to display it.
//
// ESTIMATED TIME is a fixed-per-type heuristic (below), not a measured
// duration — there's no timer anywhere in this app to measure one from, so
// pretending otherwise would be dishonest, not "simple". A study-plan task
// is the one exception: it uses the plan's own real hoursPerDay.
var ESTIMATED_MINUTES_BY_TYPE = {
  assignment_due_soon: 30,
  weak_topic: 20,
  exam_prep: 45,
  study_reminder: 15,
};
var TASK_TYPE_ICON = {
  assignment_due_soon: "📋",
  weak_topic: "📉",
  exam_prep: "🎯",
  study_reminder: "🔔",
  study_plan: "🗓️",
};
function isSameCalendarDay(ts, ref){
  if (ts==null) return false;
  var d = new Date(ts), r = ref || new Date();
  return d.getFullYear()===r.getFullYear() && d.getMonth()===r.getMonth() && d.getDate()===r.getDate();
}
function formatMinutes(mins){
  if (mins < 60) return mins+" min";
  var h = Math.floor(mins/60), m = mins%60;
  return m>0 ? h+"h "+m+"m" : h+"h";
}
function handlerForTaskType(type, h){
  if (type==="weak_topic") return h.onAITutor;
  if (type==="exam_prep") return h.onExamMode;
  if (type==="study_reminder") return h.onVoice;
  if (type==="study_plan") return h.onStudyPlanner;
  return h.onAssignments; // assignment_due_soon + fallback
}
// buildTodaysTasks — pure, no repository calls. `recommendations` is the
// already-computed buildRecommendations() output (so this file doesn't call
// it twice); topicMastery/studyPlans/lastStudyActivityAt are the same
// existing-repository data CommandCenterScreen already reads.
function buildTodaysTasks(recommendations, topicMastery, studyPlans, lastStudyActivityAt){
  var now = Date.now();
  var tasks = [];

  recommendations.forEach(function(r, idx){
    var status = "not_started";
    if (r.type==="weak_topic" || r.type==="exam_prep") {
      var topicRecord = topicMastery.find(function(m){ return m.courseId===r.courseId && m.topic===r.topic; });
      if (topicRecord && isSameCalendarDay(topicRecord.lastStudiedAt)) status = "in_progress";
    }
    tasks.push({
      id: "rec_"+idx,
      type: r.type,
      title: r.title,
      message: r.message,
      priority: r.priority,
      status: status,
      estimatedMinutes: ESTIMATED_MINUTES_BY_TYPE[r.type] || 20,
    });
  });

  studyPlans.forEach(function(p){
    var examDate = p.examDate ? new Date(p.examDate+"T00:00:00").getTime() : null;
    if (examDate!=null && examDate < now) return; // this plan's exam already happened
    tasks.push({
      id: "plan_"+p.id,
      type: "study_plan",
      title: "Follow your study plan",
      message: (p.courses&&p.courses.length ? p.courses.join(", ") : "General")+" — "+(p.hoursPerDay||1)+"h planned today.",
      priority: "medium",
      status: isSameCalendarDay(lastStudyActivityAt) ? "in_progress" : "not_started",
      estimatedMinutes: (p.hoursPerDay||1)*60,
    });
  });

  var PRIORITY_WEIGHT = { high:3, medium:2, low:1 };
  tasks.sort(function(a,b){ return PRIORITY_WEIGHT[b.priority]-PRIORITY_WEIGHT[a.priority]; });
  return tasks;
}

function TodaysMissionScreen({ onBack, notes, recordings, assignments, topicMastery, studyPlans, onAssignments, onAITutor, onExamMode, onVoice, onStudyPlanner }) {
  var lastStudyActivityAt = notes.concat(recordings).reduce(function(max,item){ var t=item.createdAt||item.id||0; return t>max?t:max; }, 0) || null;

  var recommendations = buildRecommendations({
    assignments: assignments,
    topicMastery: topicMastery,
    exams: [], // no wired exam-date source yet — same gap as recommendationService.js / CommandCenterScreen
    lastStudyActivityAt: lastStudyActivityAt,
  });

  var tasks = buildTodaysTasks(recommendations, topicMastery, studyPlans, lastStudyActivityAt);
  var inProgressCount = tasks.filter(function(t){return t.status==="in_progress";}).length;
  var remainingMinutes = tasks.reduce(function(s,t){return s+(t.estimatedMinutes||0);},0);
  var progressPct = tasks.length ? Math.round((inProgressCount/tasks.length)*100) : 0;

  var handlers = { onAssignments:onAssignments, onAITutor:onAITutor, onExamMode:onExamMode, onVoice:onVoice, onStudyPlanner:onStudyPlanner };

  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>🎯 Today's Mission</span>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>

        {tasks.length>0 && (
          <div style={{ background:C.card,borderRadius:16,padding:18,border:"1px solid "+C.border,marginBottom:20 }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
              <span style={{ fontSize:13,fontWeight:700,color:C.text }}>{inProgressCount} of {tasks.length} in progress</span>
              <span style={{ fontSize:13,fontWeight:700,color:C.cyan }}>⏱ {formatMinutes(remainingMinutes)} total</span>
            </div>
            <div style={{ height:8,background:C.card2,borderRadius:99,overflow:"hidden" }}>
              <div style={{ height:"100%",width:progressPct+"%",background:"linear-gradient(90deg,#06B6D4,#A78BFA)",borderRadius:99,transition:"width 0.3s" }}/>
            </div>
          </div>
        )}

        {tasks.length===0 ? (
          <div style={{ textAlign:"center",padding:"60px 20px" }}>
            <div style={{ fontSize:52,marginBottom:12 }}>🎉</div>
            <div style={{ fontWeight:800,fontSize:16,color:C.text,marginBottom:6 }}>Nothing on today's mission</div>
            <div style={{ fontSize:13,color:C.muted }}>No urgent assignments, weak topics, exam prep, or active study plans right now.</div>
          </div>
        ) : tasks.map(function(t){
          var priorityColor = t.priority==="high"?C.red:t.priority==="medium"?C.amber:C.muted;
          var inProgress = t.status==="in_progress";
          return(
            <div key={t.id} style={{ background:C.card,border:"1px solid "+C.border,borderRadius:16,padding:16,marginBottom:12 }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,marginBottom:10 }}>
                <div style={{ display:"flex",gap:10,minWidth:0 }}>
                  <div style={{ width:36,height:36,borderRadius:10,background:priorityColor+"18",display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,flexShrink:0 }}>{TASK_TYPE_ICON[t.type]||"📌"}</div>
                  <div style={{ minWidth:0 }}>
                    <div style={{ fontWeight:700,fontSize:14,color:C.text }}>{t.title}</div>
                    <div style={{ fontSize:12,color:C.muted,marginTop:3,lineHeight:1.5 }}>{t.message}</div>
                  </div>
                </div>
                <span style={{ fontSize:9,fontWeight:800,color:priorityColor,background:priorityColor+"18",borderRadius:99,padding:"3px 8px",flexShrink:0,textTransform:"uppercase" }}>{t.priority}</span>
              </div>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8 }}>
                <div style={{ display:"flex",gap:8,alignItems:"center" }}>
                  <span style={{ fontSize:11,color:C.muted,fontWeight:600 }}>⏱ {formatMinutes(t.estimatedMinutes)}</span>
                  <span style={{ fontSize:11,fontWeight:700,color:inProgress?C.cyan:C.muted,background:inProgress?"rgba(6,182,212,0.12)":C.card2,borderRadius:99,padding:"3px 9px" }}>{inProgress?"In Progress":"Not Started"}</span>
                </div>
                <button onClick={handlerForTaskType(t.type, handlers)} style={{ background:inProgress?"linear-gradient(135deg,#06B6D4,#A78BFA)":C.card2, color:inProgress?"#fff":C.text, border:inProgress?"none":"1px solid "+C.border, borderRadius:10, padding:"7px 16px", fontWeight:700, fontSize:12, cursor:"pointer" }}>{inProgress?"Continue":"Start"}</button>
              </div>
            </div>
          );
        })}

      </div>
    </div>
  );
}

// ── UPCOMING ──────────────────────────────────────────────────────────────────
// The next 7 days — exams, assignments, and planned study sessions in one flat,
// day-grouped list. Deliberately NOT a calendar: no grid, no month view, no
// date picker — just a scroll, same shape as Today's Mission and Assignments'
// grouped lists already use elsewhere in this app.
//
// Reuses data straight from App's existing `assignments`/`studyPlans` state —
// nothing new is fetched, stored, or generated:
//   - Assignments: dueDate, same field Assignments/Command Center already use.
//   - Exams: studyPlansRepository's own `examDate` field. This is the ONLY
//     real exam-date source anywhere in Jotting — Exam Mode has no scheduling,
//     it's always "take one right now" — and it's never been surfaced as an
//     upcoming event before. Same honest join-key gap flagged elsewhere
//     (recommendationService.js, Course Overview): a plan's `courses` field is
//     free-text names, not courseId-linked, so this can't be more precise than
//     "exam covering these course names."
//   - Study sessions: one entry per day, per ACTIVE plan (examDate today or
//     later), for each day this week that falls within that plan's
//     today→examDate window — using the plan's own hoursPerDay/courses
//     fields, nothing invented. Bounded to the 7-day window regardless of how
//     long the plan actually runs, so this can't ever balloon into a big list.
//
// SORT: chronological (soonest first) is "urgency" for anything date-bound.
// Within the same day, exams sort before assignments before study sessions —
// a stated assumption (exam > assignment > planned study time, by stakes),
// not a hidden one.
function dateStrFromOffset(offset){
  var d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()+offset);
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
var UPCOMING_TYPE_ICON = { exam:"🎯", assignment:"📋", study_session:"🧭" };
var UPCOMING_TYPE_LABEL = { exam:"Exam", assignment:"Assignment", study_session:"Study Session" };
var UPCOMING_TYPE_PRIORITY = { exam:0, assignment:1, study_session:2 };

function buildUpcomingItems(assignments, studyPlans){
  var todayStr = dateStrFromOffset(0);
  var horizonStr = dateStrFromOffset(6);
  var items = [];

  studyPlans.forEach(function(p){
    if (!p.examDate) return;
    if (p.examDate<todayStr || p.examDate>horizonStr) return;
    items.push({
      id: "exam_"+p.id, type:"exam", date:p.examDate,
      title: (p.courses&&p.courses.length ? p.courses.join(", ") : "Exam"),
      sub: null,
    });
  });

  assignments.forEach(function(a){
    if (a.completed || !a.dueDate) return;
    if (a.dueDate<todayStr || a.dueDate>horizonStr) return;
    items.push({ id:"assignment_"+a.id, type:"assignment", date:a.dueDate, title:a.title, sub:a.course, refId:a.id });
  });

  studyPlans.forEach(function(p){
    if (!p.examDate || p.examDate<todayStr) return; // exam already passed — nothing left to schedule
    for (var i=0;i<7;i++){
      var d = dateStrFromOffset(i);
      if (d>p.examDate) break;
      items.push({
        id: "study_"+p.id+"_"+d, type:"study_session", date:d,
        title: "Study session",
        sub: (p.hoursPerDay||1)+"h · "+(p.courses&&p.courses.length ? p.courses.join(", ") : "General"),
      });
    }
  });

  items.sort(function(a,b){
    if (a.date!==b.date) return a.date<b.date ? -1 : 1;
    return UPCOMING_TYPE_PRIORITY[a.type]-UPCOMING_TYPE_PRIORITY[b.type];
  });
  return items;
}

function UpcomingScreen({ assignments, studyPlans, onBack, onOpenAssignment }) {
  var items = buildUpcomingItems(assignments, studyPlans);
  var typeColors = { exam:C.red, assignment:C.purple, study_session:C.cyan };

  var dayOrder = [];
  var dayGroups = {};
  for (var i=0;i<7;i++){ var d=dateStrFromOffset(i); dayOrder.push(d); dayGroups[d]=[]; }
  items.forEach(function(it){ if (dayGroups[it.date]) dayGroups[it.date].push(it); });

  function dayLabel(offset, dateStr){
    if (offset===0) return "Today";
    if (offset===1) return "Tomorrow";
    return fmtUpcomingDate(dateStr);
  }

  var examCount = items.filter(function(i){return i.type==="exam";}).length;
  var assignmentCount = items.filter(function(i){return i.type==="assignment";}).length;
  var studyCount = items.filter(function(i){return i.type==="study_session";}).length;

  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>📅 Upcoming</span>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>

        {items.length>0 && (
          <div style={{ background:C.card,border:"1px solid "+C.border,borderRadius:16,padding:"14px 16px",marginBottom:20,display:"flex",gap:16,flexWrap:"wrap" }}>
            {examCount>0 && <span style={{ fontSize:12,fontWeight:700,color:C.red }}>🎯 {examCount} exam{examCount===1?"":"s"}</span>}
            {assignmentCount>0 && <span style={{ fontSize:12,fontWeight:700,color:C.purple }}>📋 {assignmentCount} assignment{assignmentCount===1?"":"s"}</span>}
            {studyCount>0 && <span style={{ fontSize:12,fontWeight:700,color:C.cyan }}>🧭 {studyCount} study session{studyCount===1?"":"s"}</span>}
          </div>
        )}

        {items.length===0 ? (
          <div style={{ textAlign:"center",padding:"60px 20px" }}>
            <div style={{ fontSize:48,marginBottom:12 }}>🎉</div>
            <div style={{ fontWeight:800,fontSize:16,color:C.text,marginBottom:6 }}>Nothing in the next 7 days</div>
            <div style={{ fontSize:13,color:C.muted }}>Exams, assignments, and planned study sessions will show up here as they come up.</div>
          </div>
        ) : dayOrder.map(function(d, offset){
          var dayItems = dayGroups[d];
          if (dayItems.length===0) return null;
          return (
            <div key={d} style={{ marginBottom:22 }}>
              <div style={{ fontSize:12,fontWeight:800,color:offset===0?C.cyan:C.muted,letterSpacing:0.5,marginBottom:10,textTransform:"uppercase" }}>{dayLabel(offset,d)}</div>
              {dayItems.map(function(it){
                var color = typeColors[it.type];
                var tappable = it.type==="assignment";
                return (
                  <div key={it.id} onClick={tappable?function(){onOpenAssignment(it.refId);}:undefined} style={{ background:C.card,border:"1px solid "+C.border,borderRadius:14,padding:14,marginBottom:10,display:"flex",gap:12,alignItems:"center",cursor:tappable?"pointer":"default" }}>
                    <div style={{ width:36,height:36,borderRadius:10,background:color+"18",display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,flexShrink:0 }}>{UPCOMING_TYPE_ICON[it.type]}</div>
                    <div style={{ minWidth:0,flex:1 }}>
                      <div style={{ fontWeight:700,fontSize:14,color:C.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{it.title}</div>
                      <div style={{ fontSize:11,color:C.muted,marginTop:2 }}>{UPCOMING_TYPE_LABEL[it.type]}{it.sub?" · "+it.sub:""}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}

      </div>
    </div>
  );
}

// ── PROGRESS & INSIGHTS ──────────────────────────────────────────────────────
// A simple, chart-free weekly summary — NOT a redo of Advanced Analytics,
// which is left completely untouched (30-day trends, Premium-gated, its own
// bar/pattern visuals). This is free, scoped to a rolling 7 days (same
// "today minus 6" window Dashboard's own Weekly Activity already uses), and
// only ever shows a number, a percentage, or a single progress bar — no
// line/bar graphs.
//
// Every number reuses data already loaded elsewhere, nothing new fetched:
//   - Study Time / Sessions: studySessionsRepository — completed Study
//     Session records (App's finishStudySession()). Duration is wall-clock
//     start-to-finish time; there's no per-step or idle tracking, so a
//     session left open in the background reads as longer than actually
//     studied — an honest limitation, not corrected for here.
//   - Questions Answered / Avg Quiz Score: examResults — every recorded Exam
//     Mode attempt this week, in or out of a Study Session.
//   - Course Progress / Weakest Topics: topicMastery, same averaging and the
//     same WEAK_TOPIC_MASTERY_THRESHOLD Command Center/Course Overview
//     already use — not a second definition of "weak."
//   - Biggest Improvement: topicMastery stores no history, only a CURRENT
//     masteryScore plus a trend label from its last update — there's no
//     score-over-time snapshot anywhere to compute a real point delta from.
//     So this picks the highest-scoring topic that trended up AND was
//     studied this week — the best honest signal available, not a
//     fabricated "+12 points."
function ProgressInsightsScreen({ studySessions, examResults, topicMastery, onBack, onOpenTopic }) {
  var today0 = new Date(); today0.setHours(0,0,0,0);
  var weekStartMs = today0.getTime() - 6*86400000;

  var weekSessions = studySessions.filter(function(s){ return (s.completedAt||s.createdAt||0)>=weekStartMs; });
  var weeklyMinutes = weekSessions.reduce(function(sum,s){ return sum+Math.max(0, Math.round(((s.completedAt||0)-(s.startedAt||0))/60000)); }, 0);
  var sessionCount = weekSessions.length;

  var weekExamResults = examResults.filter(function(r){ return (r.id||0)>=weekStartMs; });
  var questionsAnswered = weekExamResults.reduce(function(sum,r){ return sum+(r.totalQuestions||0); }, 0);
  var avgQuizScore = weekExamResults.length ? Math.round(weekExamResults.reduce(function(s,r){return s+(r.percentage||0);},0)/weekExamResults.length) : null;

  var courseNames = Array.from(new Set(topicMastery.map(function(m){return m.courseId;}).filter(Boolean))).sort();
  var courseProgress = courseNames.map(function(name){
    var topics = topicMastery.filter(function(m){return m.courseId===name;});
    var avg = topics.length ? Math.round(topics.reduce(function(s,m){return s+(m.masteryScore||0);},0)/topics.length) : 0;
    return { course:name, avg:avg };
  }).sort(function(a,b){ return b.avg-a.avg; });

  var improvingThisWeek = topicMastery.filter(function(m){ return m.trend==="up" && (m.lastStudiedAt||0)>=weekStartMs; })
    .slice().sort(function(a,b){ if ((b.masteryScore||0)!==(a.masteryScore||0)) return (b.masteryScore||0)-(a.masteryScore||0); return (b.lastStudiedAt||0)-(a.lastStudiedAt||0); });
  var biggestImprovement = improvingThisWeek.length ? improvingThisWeek[0] : null;

  var weakestTopics = topicMastery.filter(function(m){ return typeof m.masteryScore==="number" && m.masteryScore<WEAK_TOPIC_MASTERY_THRESHOLD; })
    .slice().sort(function(a,b){ return (a.masteryScore||0)-(b.masteryScore||0); }).slice(0,5);

  var STAT_CARDS = [
    ["⏱", formatMinutes(weeklyMinutes), "Study Time", C.cyan],
    ["🧭", sessionCount, "Sessions", C.purple],
    ["❓", questionsAnswered, "Questions Answered", C.amber],
    ["🎯", avgQuizScore==null?"—":avgQuizScore+"%", "Avg Quiz Score", C.green],
  ];

  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>📈 Progress &amp; Insights</span>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>

        <div style={{ fontSize:11,fontWeight:800,color:C.muted,letterSpacing:1,marginBottom:12,textTransform:"uppercase" }}>Last 7 Days</div>

        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:24 }}>
          {STAT_CARDS.map(function(s){return(
            <div key={s[2]} style={{ background:C.card,borderRadius:16,padding:16,border:"1px solid "+C.border }}>
              <div style={{ fontSize:22,marginBottom:8 }}>{s[0]}</div>
              <div style={{ fontSize:24,fontWeight:800,color:s[3] }}>{s[1]}</div>
              <div style={{ fontSize:11,color:C.muted,fontWeight:600,marginTop:2 }}>{s[2]}</div>
            </div>
          );})}
        </div>

        <div style={{ marginBottom:24 }}>
          <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:10 }}>Course Progress</div>
          {courseProgress.length===0 ? (
            <div style={{ background:C.card,borderRadius:16,padding:16,border:"1px solid "+C.border,fontSize:13,color:C.muted }}>No tracked courses yet — take a quiz and mastery will start filling in here.</div>
          ) : (
            <div style={{ background:C.card,borderRadius:16,padding:18,border:"1px solid "+C.border }}>
              {courseProgress.map(function(c,i){return(
                <div key={c.course} style={{ marginBottom:i<courseProgress.length-1?16:0 }}>
                  <div style={{ display:"flex",justifyContent:"space-between",marginBottom:6 }}>
                    <span style={{ fontSize:13,fontWeight:700,color:C.text }}>{c.course}</span>
                    <span style={{ fontSize:13,color:C.muted }}>{c.avg}%</span>
                  </div>
                  <div style={{ height:8,background:C.card2,borderRadius:4 }}><div style={{ height:8,width:c.avg+"%",background:C.cyan,borderRadius:4 }}/></div>
                </div>
              );})}
            </div>
          )}
        </div>

        <div style={{ marginBottom:24 }}>
          <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:10 }}>Biggest Improvement</div>
          {biggestImprovement ? (
            <div onClick={function(){onOpenTopic(biggestImprovement);}} style={{ background:"rgba(52,211,153,0.1)",border:"1px solid rgba(52,211,153,0.3)",borderRadius:16,padding:16,display:"flex",alignItems:"center",gap:12,cursor:"pointer" }}>
              <div style={{ width:40,height:40,borderRadius:12,background:"rgba(52,211,153,0.2)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0 }}>📈</div>
              <div style={{ minWidth:0,flex:1 }}>
                <div style={{ fontWeight:700,fontSize:14,color:C.text }}>{biggestImprovement.topic}</div>
                <div style={{ fontSize:11,color:C.muted,marginTop:2 }}>{biggestImprovement.courseId} · Trending up</div>
              </div>
              <div style={{ fontWeight:800,fontSize:16,color:C.green,flexShrink:0 }}>{biggestImprovement.masteryScore}%</div>
            </div>
          ) : (
            <div style={{ background:C.card,borderRadius:16,padding:16,border:"1px solid "+C.border,fontSize:13,color:C.muted }}>No topics improved this week yet — keep practicing and it'll show up here.</div>
          )}
        </div>

        <div>
          <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:10 }}>Weakest Topics</div>
          {weakestTopics.length===0 ? (
            <div style={{ background:C.card,borderRadius:16,padding:16,border:"1px solid "+C.border,fontSize:13,color:C.muted }}>{topicMastery.length===0?"No topics tracked yet.":"No weak topics right now — nice work."}</div>
          ) : (
            <div style={{ background:C.card,borderRadius:16,padding:"0 16px",border:"1px solid "+C.border }}>
              {weakestTopics.map(function(m){return(
                <Row key={m.id} icon="📉" label={m.topic} sub={m.courseId} right={<span style={{ color:C.red,fontWeight:800,fontSize:13 }}>{m.masteryScore}%</span>} onPress={function(){onOpenTopic(m);}}/>
              );})}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

// ── COURSE OVERVIEW ──────────────────────────────────────────────────────────
// Per-course detail screen, reached by tapping a course chip on the Command
// Center. Reuses existing components rather than reinventing list rows: Row
// (already used by Settings/Profile), formatRelativeDate, backBtn, and
// daysUntilDateStr/fmtUpcomingDate (already defined above for Today's
// Mission) are all the SAME functions/components those screens use, not
// copies.
//
// IDENTIFIER NOTE, same honest gap flagged in recommendationService.js and
// CommandCenterScreen: topicMastery/materials are keyed by `courseId`, but no
// screen anywhere in this app creates a real Course record with its own id —
// every existing screen (StudyPlanner, ExamMode, AI Tutor, this one) only
// ever has the free-text course NAME to work with. So `course` (the name)
// is used as the join key against `courseId` below. If a real Course/id
// concept gets built later, this join is the one place that would need to
// change to use it instead.
//
// Materials will read back empty right now — nothing in the app creates a
// Material yet (materialsRepository has never had a UI writer). Same
// treatment as Weak Topics elsewhere this session: built honestly with a
// real empty state, not faked, ready for whenever that gets built.
var MATERIAL_TYPE_ICON = { lecture_note:"📝", lecture_slide:"🖼️", handout:"📄", pdf:"📕", document:"📃", image:"🖼️", recording:"🎙️", transcript:"📜", past_question:"❓", assignment:"📋", other:"📦" };
var MATERIAL_TYPE_LABEL = { lecture_note:"Lecture Note", lecture_slide:"Slide", handout:"Handout", pdf:"PDF", document:"Document", image:"Image", recording:"Recording", transcript:"Transcript", past_question:"Past Question", assignment:"Assignment", other:"Material" };

function CourseOverviewScreen({ course, courses, assignments, topicMastery, materials, onBack, onAITutor, onFlashcards, onExamMode, onOpenTopic }) {
  var [tab, setTab] = useState("overview");
  var [materialSearch, setMaterialSearch] = useState("");
  var [materialTypeFilter, setMaterialTypeFilter] = useState("All");
  var [detailMaterial, setDetailMaterial] = useState(null);

  // Materials may be keyed by the OLD shim (courseId === course NAME, from
  // before real Course ids existed) or the NEW real Course id
  // (UploadMaterialScreen, going forward) — match either, so nothing already
  // saved silently disappears from this screen now that real ids exist.
  // topicMastery/assignments are UNCHANGED — still name-matched, since that
  // migration is blocked pending topicMasteryRepository.js/
  // topicMasteryService.js/recommendationService.js (not available to inspect).
  var matchingCourseRecord = (courses||[]).find(function(c){ return (c.code||c.title)===course; });
  var myMastery = topicMastery.filter(function(m){ return m.courseId===course; });
  var myAssignments = assignments.filter(function(a){ return a.course===course; });
  var myMaterials = materials.filter(function(m){ return m.courseId===course || (matchingCourseRecord && m.courseId===matchingCourseRecord.id); }).slice().sort(function(a,b){ return (b.updatedAt||b.createdAt||0)-(a.updatedAt||a.createdAt||0); });

  // Recent = the actual most-recently-touched materials, independent of any
  // search/filter below — myMaterials is already sorted newest-first, so this
  // is just its head. Only shown while browsing (no active search/filter) so
  // it doesn't compete for space with search results on a small screen.
  var recentMaterials = myMaterials.slice(0,5);
  var showRecent = !materialSearch.trim() && materialTypeFilter==="All" && recentMaterials.length>0;

  var materialSearchQ = materialSearch.trim().toLowerCase();
  var filteredMaterials = myMaterials.filter(function(m){
    var matchesType = materialTypeFilter==="All" || m.type===materialTypeFilter;
    if (!matchesType) return false;
    if (!materialSearchQ) return true;
    var haystack = (m.title||"")+" "+(m.tags||[]).join(" ")+" "+(MATERIAL_TYPE_LABEL[m.type]||"");
    return haystack.toLowerCase().includes(materialSearchQ);
  });

  var avgMastery = myMastery.length ? Math.round(myMastery.reduce(function(s,m){return s+(m.masteryScore||0);},0)/myMastery.length) : null;
  var weakTopics = myMastery.filter(function(m){ return typeof m.masteryScore==="number" && m.masteryScore<50; }).slice().sort(function(a,b){return a.masteryScore-b.masteryScore;});
  var upcomingWork = myAssignments.filter(function(a){ return !a.completed && a.dueDate; }).slice().sort(function(a,b){ return (a.dueDate||"").localeCompare(b.dueDate||""); });
  var completedCount = myAssignments.filter(function(a){return a.completed;}).length;

  var TABS = [["overview","📊","Overview"],["materials","📚","Materials"],["practice","🎯","Practice"],["progress","📈","Progress"]];

  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column",position:"relative" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>{course}</span>
      </div>
      <div style={{ background:C.card,padding:"0 20px 12px",display:"flex",gap:6,borderBottom:"1px solid "+C.border,overflowX:"auto" }}>
        {TABS.map(function(t){return<button key={t[0]} onClick={function(){setTab(t[0]);}} style={{ padding:"7px 16px",borderRadius:99,border:"none",background:tab===t[0]?C.cyan:C.card2,color:tab===t[0]?"#0A0F1E":C.muted,fontSize:13,fontWeight:700,cursor:"pointer",marginTop:12,whiteSpace:"nowrap" }}>{t[1]+" "+t[2]}</button>;})}
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>

        {tab==="overview" && (
          <div>
            <div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.border,marginBottom:20 }}>
              <div style={{ fontSize:11,fontWeight:800,color:C.muted,letterSpacing:1,marginBottom:10,textTransform:"uppercase" }}>Course Progress</div>
              {avgMastery==null ? (
                <div style={{ fontSize:13,color:C.muted }}>No mastery data yet for this course.</div>
              ) : (
                <div>
                  <div style={{ fontSize:32,fontWeight:800,color:C.text,marginBottom:10 }}>{avgMastery}%</div>
                  <div style={{ height:8,background:C.card2,borderRadius:99,overflow:"hidden" }}><div style={{ height:"100%",width:avgMastery+"%",background:"linear-gradient(90deg,#06B6D4,#A78BFA)",borderRadius:99 }}/></div>
                  <div style={{ fontSize:11,color:C.muted,marginTop:8 }}>Average across {myMastery.length} tracked topic{myMastery.length===1?"":"s"}</div>
                </div>
              )}
            </div>

            <div style={{ marginBottom:20 }}>
              <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:8 }}>Weak Topics</div>
              <div style={{ background:C.card,borderRadius:16,padding:"0 16px",border:"1px solid "+C.border }}>
                {weakTopics.length===0 ? (
                  <div style={{ padding:"16px 0",fontSize:13,color:C.muted }}>{myMastery.length===0?"No topics tracked yet.":"No weak topics — nice work."}</div>
                ) : weakTopics.slice(0,5).map(function(m){return(
                  <Row key={m.id} icon="📉" label={m.topic} sub={m.masteryScore+"% mastery"} right={<span style={{ color:C.red,fontWeight:800,fontSize:13 }}>{m.masteryScore}%</span>}/>
                );})}
              </div>
            </div>

            <div style={{ marginBottom:20 }}>
              <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:8 }}>Upcoming Work</div>
              <div style={{ background:C.card,borderRadius:16,padding:"0 16px",border:"1px solid "+C.border }}>
                {upcomingWork.length===0 ? (
                  <div style={{ padding:"16px 0",fontSize:13,color:C.muted }}>Nothing due for this course.</div>
                ) : upcomingWork.slice(0,5).map(function(a){
                  var d = daysUntilDateStr(a.dueDate);
                  return <Row key={a.id} icon="📋" label={a.title} sub={d<0?"Overdue":fmtUpcomingDate(a.dueDate)} right={<span style={{ color:d<0?C.red:d<=1?C.amber:C.muted,fontWeight:700,fontSize:12 }}>{d<0?"Overdue":d+"d"}</span>}/>;
                })}
              </div>
            </div>

            <div>
              <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:8 }}>Recent Materials</div>
              <div style={{ background:C.card,borderRadius:16,padding:"0 16px",border:"1px solid "+C.border }}>
                {myMaterials.length===0 ? (
                  <div style={{ padding:"16px 0",fontSize:13,color:C.muted }}>No materials saved for this course yet.</div>
                ) : myMaterials.slice(0,5).map(function(m){return(
                  <Row key={m.id} icon={MATERIAL_TYPE_ICON[m.type]||"📦"} label={m.title||"Untitled"} sub={MATERIAL_TYPE_LABEL[m.type]||"Material"} onPress={function(){setDetailMaterial(m);}}/>
                );})}
              </div>
            </div>
          </div>
        )}

        {tab==="materials" && (
          <div>
            <div style={{ marginBottom:12 }}>
              <input value={materialSearch} onChange={function(e){setMaterialSearch(e.target.value);}} placeholder={"Search materials in "+course+"..."} style={{ width:"100%",padding:"11px 14px",borderRadius:12,border:"1px solid "+C.border,fontSize:13,background:C.card,color:C.text,outline:"none",boxSizing:"border-box" }}/>
            </div>

            <div style={{ display:"flex",gap:6,overflowX:"auto",paddingBottom:16 }}>
              {["All"].concat(MATERIAL_TYPES).map(function(t){ var active=materialTypeFilter===t; return(
                <button key={t} onClick={function(){setMaterialTypeFilter(t);}} style={{ padding:"6px 14px",borderRadius:99,border:"none",background:active?C.cyan:C.card2,color:active?"#0A0F1E":C.muted,fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0 }}>{t==="All"?"All":(MATERIAL_TYPE_LABEL[t]||t)}</button>
              );})}
            </div>

            {showRecent && (
              <div style={{ marginBottom:20 }}>
                <div style={{ fontSize:11,fontWeight:800,color:C.muted,letterSpacing:1,marginBottom:10,textTransform:"uppercase" }}>Recent</div>
                <div style={{ display:"flex",gap:10,overflowX:"auto",paddingBottom:4 }}>
                  {recentMaterials.map(function(m){return(
                    <button key={m.id} onClick={function(){setDetailMaterial(m);}} style={{ background:C.card,border:"1px solid "+C.border,borderRadius:14,padding:"12px 16px",flexShrink:0,minWidth:110,maxWidth:130,cursor:"pointer",textAlign:"left",fontFamily:"inherit" }}>
                      <div style={{ fontSize:20,marginBottom:6 }}>{MATERIAL_TYPE_ICON[m.type]||"📦"}</div>
                      <div style={{ fontWeight:700,fontSize:12,color:C.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{m.title||"Untitled"}</div>
                      <div style={{ fontSize:10,color:C.muted,marginTop:3 }}>{MATERIAL_TYPE_LABEL[m.type]||"Material"}</div>
                    </button>
                  );})}
                </div>
              </div>
            )}

            <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:8 }}>{materialSearchQ||materialTypeFilter!=="All" ? "Results ("+filteredMaterials.length+")" : "All Materials ("+filteredMaterials.length+")"}</div>
            {myMaterials.length===0 ? (
              <div style={{ textAlign:"center",padding:"60px 20px" }}>
                <div style={{ fontSize:48,marginBottom:12 }}>📚</div>
                <div style={{ fontWeight:800,fontSize:16,color:C.text,marginBottom:6 }}>No materials yet</div>
                <div style={{ fontSize:13,color:C.muted }}>Materials saved for {course} will show up here.</div>
              </div>
            ) : filteredMaterials.length===0 ? (
              <div style={{ background:C.card,borderRadius:16,padding:16,border:"1px solid "+C.border,fontSize:13,color:C.muted }}>No materials match{materialSearchQ?" \""+materialSearch+"\"":""}{materialTypeFilter!=="All"?" in "+(MATERIAL_TYPE_LABEL[materialTypeFilter]||materialTypeFilter):""}.</div>
            ) : (
              <div style={{ background:C.card,borderRadius:16,padding:"0 16px",border:"1px solid "+C.border }}>
                {filteredMaterials.map(function(m){return(
                  <Row key={m.id} icon={MATERIAL_TYPE_ICON[m.type]||"📦"} label={m.title||"Untitled"} sub={(MATERIAL_TYPE_LABEL[m.type]||"Material")+" · "+formatRelativeDate(m.updatedAt||m.createdAt)} onPress={function(){setDetailMaterial(m);}}/>
                );})}
              </div>
            )}
          </div>
        )}

        {tab==="practice" && (
          <div>
            <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:12 }}>Practice {course}</div>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:24 }}>
              <button onClick={onAITutor} style={{ background:C.card,border:"1px solid "+C.cyan+"30",borderRadius:14,padding:"14px 8px",cursor:"pointer",textAlign:"center",fontFamily:"inherit" }}>
                <div style={{ width:38,height:38,borderRadius:10,background:C.cyan+"20",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 8px",fontSize:20 }}>🎓</div>
                <span style={{ fontSize:11,fontWeight:700,color:C.soft }}>AI Tutor</span>
              </button>
              <button onClick={onFlashcards} style={{ background:C.card,border:"1px solid "+C.purple+"30",borderRadius:14,padding:"14px 8px",cursor:"pointer",textAlign:"center",fontFamily:"inherit" }}>
                <div style={{ width:38,height:38,borderRadius:10,background:C.purple+"20",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 8px",fontSize:20 }}>🗂️</div>
                <span style={{ fontSize:11,fontWeight:700,color:C.soft }}>Flashcards</span>
              </button>
              <button onClick={onExamMode} style={{ background:C.card,border:"1px solid "+C.red+"30",borderRadius:14,padding:"14px 8px",cursor:"pointer",textAlign:"center",fontFamily:"inherit" }}>
                <div style={{ width:38,height:38,borderRadius:10,background:C.red+"20",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 8px",fontSize:20 }}>🎯</div>
                <span style={{ fontSize:11,fontWeight:700,color:C.soft }}>Exam Mode</span>
              </button>
            </div>
            <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:8 }}>Topics to Practice</div>
            <div style={{ background:C.card,borderRadius:16,padding:"0 16px",border:"1px solid "+C.border }}>
              {myMastery.length===0 ? (
                <div style={{ padding:"16px 0",fontSize:13,color:C.muted }}>No topics tracked yet — practice starts filling this in once quiz results are recorded.</div>
              ) : myMastery.slice().sort(function(a,b){return (a.masteryScore||0)-(b.masteryScore||0);}).map(function(m){return(
                <Row key={m.id} icon="🧠" label={m.topic} sub={m.masteryScore+"% mastery"} right={<button onClick={onAITutor} style={{ background:C.cyan+"20",border:"none",borderRadius:8,padding:"5px 12px",color:C.cyan,fontWeight:700,fontSize:11,cursor:"pointer" }}>Practice</button>}/>
              );})}
            </div>
          </div>
        )}

        {tab==="progress" && (
          <div>
            <div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.border,marginBottom:20 }}>
              <div style={{ fontSize:11,fontWeight:800,color:C.muted,letterSpacing:1,marginBottom:10,textTransform:"uppercase" }}>Average Mastery</div>
              {avgMastery==null ? <div style={{ fontSize:13,color:C.muted }}>No mastery data yet.</div> : <div style={{ fontSize:32,fontWeight:800,color:C.text }}>{avgMastery}%</div>}
            </div>
            <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:8 }}>All Topics</div>
            {myMastery.length===0 ? (
              <div style={{ background:C.card,borderRadius:16,padding:16,border:"1px solid "+C.border,fontSize:13,color:C.muted,marginBottom:20 }}>Nothing tracked yet for this course.</div>
            ) : myMastery.slice().sort(function(a,b){return (a.masteryScore||0)-(b.masteryScore||0);}).map(function(m){
              var trendIcon = m.trend==="up"?"📈":m.trend==="down"?"📉":m.trend==="new"?"🆕":"➡️";
              var scoreColor = m.masteryScore>=70?C.green:m.masteryScore>=50?C.amber:C.red;
              return(
                <div key={m.id} onClick={function(){onOpenTopic(m);}} style={{ background:C.card,border:"1px solid "+C.border,borderRadius:14,padding:14,marginBottom:10,cursor:"pointer" }}>
                  <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
                    <div style={{ fontWeight:700,fontSize:14,color:C.text }}>{trendIcon} {m.topic}</div>
                    <div style={{ fontWeight:800,fontSize:14,color:scoreColor }}>{m.masteryScore}%</div>
                  </div>
                  <div style={{ height:6,background:C.card2,borderRadius:99,overflow:"hidden",marginBottom:8 }}><div style={{ height:"100%",width:m.masteryScore+"%",background:scoreColor,borderRadius:99 }}/></div>
                  <div style={{ fontSize:11,color:C.muted }}>Confidence: {Math.round((m.confidence||0)*100)}%</div>
                </div>
              );
            })}
            <div style={{ fontWeight:800,fontSize:15,color:C.text,margin:"20px 0 8px" }}>Assignments</div>
            <div style={{ background:C.card,borderRadius:16,padding:"0 16px",border:"1px solid "+C.border }}>
              <Row icon="✅" label="Completed" sub={myAssignments.length+" total for this course"} right={<span style={{ fontWeight:800,color:C.text,fontSize:14 }}>{completedCount+"/"+myAssignments.length}</span>}/>
            </div>
          </div>
        )}

      </div>

      {detailMaterial && (
        <div style={{ position:"absolute",inset:0,background:"rgba(10,15,30,0.85)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:30 }} onClick={function(){setDetailMaterial(null);}}>
          <div style={{ background:C.card,borderRadius:"20px 20px 0 0",padding:20,width:"100%",maxHeight:"80vh",overflowY:"auto",boxSizing:"border-box" }} onClick={function(e){e.stopPropagation();}}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18 }}>
              <div style={{ display:"flex",gap:12,alignItems:"center",minWidth:0 }}>
                <div style={{ width:44,height:44,borderRadius:12,background:C.card2,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0 }}>{MATERIAL_TYPE_ICON[detailMaterial.type]||"📦"}</div>
                <div style={{ minWidth:0 }}>
                  <div style={{ fontWeight:800,fontSize:16,color:C.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{detailMaterial.title||"Untitled"}</div>
                  <div style={{ fontSize:12,color:C.muted,marginTop:2 }}>{MATERIAL_TYPE_LABEL[detailMaterial.type]||"Material"}</div>
                </div>
              </div>
              <button onClick={function(){setDetailMaterial(null);}} style={{ background:"none",border:"none",color:C.muted,fontSize:18,cursor:"pointer",flexShrink:0 }}>✕</button>
            </div>

            <div style={{ background:C.card2,borderRadius:14,padding:"0 14px",marginBottom:14 }}>
              <Row icon="📚" label="Course" sub={course}/>
              {detailMaterial.status && <Row icon="🏷️" label="Status" sub={detailMaterial.status}/>}
              <Row icon="🕐" label="Added" sub={formatRelativeDate(detailMaterial.createdAt)}/>
              {detailMaterial.updatedAt && detailMaterial.updatedAt!==detailMaterial.createdAt && <Row icon="✏️" label="Last Updated" sub={formatRelativeDate(detailMaterial.updatedAt)}/>}
            </div>

            {detailMaterial.tags && detailMaterial.tags.length>0 && (
              <div style={{ marginBottom:14 }}>
                <div style={{ fontSize:12,fontWeight:700,color:C.muted,marginBottom:8 }}>Tags</div>
                <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
                  {detailMaterial.tags.map(function(t){return<span key={t} style={{ background:C.card2,color:C.cyan,borderRadius:99,padding:"4px 12px",fontSize:12,fontWeight:700 }}>{t}</span>;})}
                </div>
              </div>
            )}

            <div style={{ padding:"12px 14px",background:C.card2,borderRadius:12,fontSize:12,color:C.muted,lineHeight:1.5 }}>📌 Materials store details like this, not a file — there's no attached document or preview to open yet.</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── STUDY VAULT ───────────────────────────────────────────────────────────────
// Semester → Course → Material browser. Reads notes, recordings, materials,
// quizzes, and flashcard decks — all data these repositories already store —
// nothing new is written or generated here. Not a second notes system: tapping
// a note opens the SAME NoteDetail screen Library already uses; tapping a
// recording opens the SAME RecordingsScreen. Quizzes/flashcard decks/materials
// have no viewer anywhere in Jotting to reuse (materials never even had a
// content field to view, and quizzes/flashcards' only existing UI is the
// generation flow, not a "reopen this saved one" flow) — those show as
// honest, non-interactive inventory rows, same treatment CourseOverviewScreen
// already gives materials, not a new quiz/flashcard experience.
//
// COURSE IDENTITY, same gap CourseOverviewScreen already documents: almost
// nothing in this app has a real courseId — every screen (Library, Command
// Center, Assignments, Exam Mode, ...) only ever works with the free-text
// `course` name, and that's what's actually populated on real content today.
// So the free-text name is the join key here too, same as everywhere else —
// real Course records (coursesRepository) are merged in for whenever those
// start getting created, but aren't required for the vault to show real data.
//
// SEMESTER, honestly: no screen anywhere in Jotting creates or names a
// Semester yet, so semesterId is empty on virtually all real data. This still
// groups by semesterId when a Course record happens to have one, falling back
// to a single "All Courses" bucket for the — currently universal — case where
// it doesn't. There's no semesters lookup available to resolve an id to a
// readable name; if one gets wired in elsewhere later, that's the one seam to
// swap in here.
function StudyVaultScreen({ notes, recordings, materials, quizzes, flashcardDecks, courses, semesters, onBack, onOpenCourse, onManageSemesters, onManageCourses }) {
  // Materials may be keyed by the OLD shim (courseId === course NAME) or the
  // NEW real Course id — this resolves either back to a display name, so a
  // material never shows up as a bare numeric id in the vault, and existing
  // materials keep grouping correctly alongside newly-created ones.
  function materialCourseDisplayName(m){
    var byId = (courses||[]).find(function(c){ return c.id===m.courseId; });
    return byId ? (byId.code||byId.title) : m.courseId;
  }
  var courseNames = Array.from(new Set(
    notes.map(function(n){return n.course;})
      .concat(recordings.map(function(r){return r.course;}))
      .concat(materials.map(materialCourseDisplayName))
      .concat(quizzes.map(function(q){return q.course;}))
      .concat(flashcardDecks.map(function(d){return d.course;}))
      .concat(courses.map(function(c){return c.code||c.title;}))
      .filter(Boolean)
  )).sort();

  var courseToSemester = {};
  courses.forEach(function(c){ var name=c.code||c.title; if (name && c.semesterId!=null) courseToSemester[name] = c.semesterId; });
  var groups = {};
  courseNames.forEach(function(name){
    var semId = courseToSemester[name] || "unsorted";
    if (!groups[semId]) groups[semId] = [];
    groups[semId].push(name);
  });
  var semesterKeys = Object.keys(groups).sort(function(a,b){ return a==="unsorted" ? 1 : b==="unsorted" ? -1 : String(a).localeCompare(String(b)); });

  function countsFor(name){
    return {
      notes: notes.filter(function(n){return n.course===name;}).length,
      recordings: recordings.filter(function(r){return r.course===name;}).length,
      materials: materials.filter(function(m){return materialCourseDisplayName(m)===name;}).length,
      quizzes: quizzes.filter(function(q){return q.course===name;}).length,
      flashcards: flashcardDecks.filter(function(d){return d.course===name;}).length,
    };
  }
  function summaryLine(c){
    var parts = [];
    if (c.notes) parts.push(c.notes+" note"+(c.notes===1?"":"s"));
    if (c.recordings) parts.push(c.recordings+" recording"+(c.recordings===1?"":"s"));
    if (c.materials) parts.push(c.materials+" material"+(c.materials===1?"":"s"));
    if (c.quizzes) parts.push(c.quizzes+" quiz"+(c.quizzes===1?"":"zes"));
    if (c.flashcards) parts.push(c.flashcards+" deck"+(c.flashcards===1?"":"s"));
    return parts.length ? parts.join(" · ") : "Nothing saved yet";
  }

  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text,flex:1 }}>🗄️ Study Vault</span>
        <button onClick={onManageCourses} title="Manage Courses" style={{ background:"rgba(255,255,255,0.08)",border:"none",borderRadius:10,width:36,height:36,cursor:"pointer",fontSize:15,marginRight:8 }}>📚</button>
        <button onClick={onManageSemesters} title="Manage Semesters" style={{ background:"rgba(255,255,255,0.08)",border:"none",borderRadius:10,width:36,height:36,cursor:"pointer",fontSize:15 }}>🗓️</button>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        {courseNames.length===0 ? (
          <div style={{ textAlign:"center",padding:"60px 20px" }}>
            <div style={{ fontSize:48,marginBottom:12 }}>🗄️</div>
            <div style={{ fontWeight:800,fontSize:16,color:C.text,marginBottom:6 }}>Your vault is empty</div>
            <div style={{ fontSize:13,color:C.muted,lineHeight:1.5 }}>Notes, recordings, materials, quizzes, and flashcards you save will show up here, organized by course.</div>
          </div>
        ) : semesterKeys.map(function(semId){
          var names = groups[semId];
          return (
            <div key={semId} style={{ marginBottom:24 }}>
              <div style={{ fontSize:11,fontWeight:800,color:C.muted,letterSpacing:1,marginBottom:10,textTransform:"uppercase" }}>{semId==="unsorted" ? "All Courses" : ((semesters||[]).find(function(s){return s.id===semId;})||{}).name || "Semester"}</div>
              <div style={{ background:C.card,borderRadius:16,padding:"0 16px",border:"1px solid "+C.border }}>
                {names.map(function(name){ return <Row key={name} icon="📚" label={name} sub={summaryLine(countsFor(name))} onPress={function(){onOpenCourse(name);}}/>; })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Per-course content page — the "Material" level of Semester → Course →
// Material. Every section below reads straight from the same arrays the rest
// of the app already loads (notes/recordings/materials/quizzes/flashcardDecks),
// filtered to this one course; nothing here fetches or computes anything new.
function StudyVaultCourseScreen({ course, courses, notes, recordings, materials, quizzes, flashcardDecks, onBack, onOpenNote, onOpenRecordings }) {
  // Same OLD-shim-or-NEW-real-id dual match as CourseOverviewScreen/
  // StudyVaultScreen — see those for why.
  var matchingCourseRecord = (courses||[]).find(function(c){ return (c.code||c.title)===course; });
  var myNotes = notes.filter(function(n){ return n.course===course; });
  var myRecordings = recordings.filter(function(r){ return r.course===course; });
  var myMaterials = materials.filter(function(m){ return m.courseId===course || (matchingCourseRecord && m.courseId===matchingCourseRecord.id); });
  var myQuizzes = quizzes.filter(function(q){ return q.course===course; });
  var myDecks = flashcardDecks.filter(function(d){ return d.course===course; });

  var pdfs = myMaterials.filter(function(m){ return m.type==="pdf"; });
  var handouts = myMaterials.filter(function(m){ return m.type==="handout"; });
  var pastQuestions = myMaterials.filter(function(m){ return m.type==="past_question"; });
  var otherMaterials = myMaterials.filter(function(m){ return m.type!=="pdf" && m.type!=="handout" && m.type!=="past_question"; });

  function VaultSection({ icon, title, items, emptyText, renderRow }){
    return (
      <div style={{ marginBottom:22 }}>
        <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:8,display:"flex",alignItems:"center",gap:8 }}>
          <span>{icon}</span><span>{title}</span><span style={{ fontSize:12,fontWeight:700,color:C.muted }}>({items.length})</span>
        </div>
        <div style={{ background:C.card,borderRadius:16,padding:items.length?"0 16px":16,border:"1px solid "+C.border }}>
          {items.length===0 ? <div style={{ fontSize:13,color:C.muted }}>{emptyText}</div> : items.slice(0,8).map(renderRow)}
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>{course}</span>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>

        <VaultSection icon="📝" title="Notes" items={myNotes} emptyText="No notes yet for this course." renderRow={function(n){return(
          <Row key={n.id} icon={n.type==="drawing"?"🎨":"📝"} label={n.title||"Untitled"} sub={formatRelativeDate(n.id)} onPress={function(){onOpenNote(n);}}/>
        );}}/>

        <VaultSection icon="🎙️" title="Recordings" items={myRecordings} emptyText="No lecture recordings yet for this course." renderRow={function(r){return(
          <Row key={r.id} icon="🎙️" label={r.title||"Untitled"} sub={formatRelativeDate(r.createdAt)} onPress={onOpenRecordings}/>
        );}}/>

        <VaultSection icon="📕" title="PDFs" items={pdfs} emptyText="No PDFs saved yet." renderRow={function(m){return(
          <Row key={m.id} icon="📕" label={m.title||"Untitled"} sub={formatRelativeDate(m.updatedAt||m.createdAt)}/>
        );}}/>

        <VaultSection icon="📄" title="Handouts" items={handouts} emptyText="No handouts saved yet." renderRow={function(m){return(
          <Row key={m.id} icon="📄" label={m.title||"Untitled"} sub={formatRelativeDate(m.updatedAt||m.createdAt)}/>
        );}}/>

        <VaultSection icon="❓" title="Past Questions" items={pastQuestions} emptyText="No past questions saved yet." renderRow={function(m){return(
          <Row key={m.id} icon="❓" label={m.title||"Untitled"} sub={formatRelativeDate(m.updatedAt||m.createdAt)}/>
        );}}/>

        <VaultSection icon="🧠" title="Quizzes" items={myQuizzes} emptyText="No saved quizzes yet — Quiz Me and Exam Mode results will show up here." renderRow={function(q){return(
          <Row key={q.id} icon="🧠" label={(q.questions&&q.questions.length||0)+" question"+((q.questions&&q.questions.length===1)?"":"s")} sub={(q.source==="exam"?"Exam Mode":"Quiz Me")+" · "+formatRelativeDate(q.createdAt)}/>
        );}}/>

        <VaultSection icon="🗂️" title="Flashcards" items={myDecks} emptyText="No saved flashcard decks yet." renderRow={function(d){return(
          <Row key={d.id} icon="🗂️" label={d.title||"Flashcards"} sub={(d.cards&&d.cards.length||0)+" cards · "+formatRelativeDate(d.createdAt)}/>
        );}}/>

        {otherMaterials.length>0 && (
          <VaultSection icon="📦" title="Other Materials" items={otherMaterials} emptyText="" renderRow={function(m){return(
            <Row key={m.id} icon={MATERIAL_TYPE_ICON[m.type]||"📦"} label={m.title||"Untitled"} sub={(MATERIAL_TYPE_LABEL[m.type]||"Material")+" · "+formatRelativeDate(m.updatedAt||m.createdAt)}/>
          );}}/>
        )}

      </div>
    </div>
  );
}

// ── MANAGE SEMESTERS ──────────────────────────────────────────────────────────
// Real Semester CRUD, reached from Study Vault's header — the same place the
// dormant "Semester {id}" grouping already lives. semestersRepository already
// had full create/get/list/update/delete (built earlier, never wired to any
// UI). This is that wiring, plus the one thing needed to make Study Vault's
// grouping mean anything: a way to actually put a course IN a semester.
//
// COURSE ASSIGNMENT lives here, not on the course-creation screens (Voice Note,
// Scan Doc, etc.) — those all use the shared CourseChipPicker's quick single-
// string "+ Add Course" flow, and bolting a semester picker onto that would
// change a fast inline flow used across seven screens into a multi-step form,
// which is a real redesign, not a fix. A course created via quick-add simply
// starts unassigned (semesterId stays unset) until placed into a semester here.
//
// Deleting a semester clears semesterId on any course pointed at it (see
// deleteSemesterRecord in App) rather than leaving a dangling reference —
// this screen doesn't need to know that happened, it just re-renders once
// `courses` updates.
function ManageSemestersScreen({ semesters, courses, onBack, onAdd, onUpdate, onDelete, onUpdateCourse }) {
  var [showForm, setShowForm] = useState(false);
  var [editingId, setEditingId] = useState(null);
  var [fName, setFName] = useState("");
  var [fYear, setFYear] = useState("");
  var [fStart, setFStart] = useState("");
  var [fEnd, setFEnd] = useState("");
  var [fStatus, setFStatus] = useState("active");
  var [error, setError] = useState("");
  var [detailId, setDetailId] = useState(null);

  function openAdd(){ setEditingId(null); setFName(""); setFYear(""); setFStart(""); setFEnd(""); setFStatus("active"); setError(""); setShowForm(true); }
  function openEdit(s){ setEditingId(s.id); setFName(s.name||""); setFYear(s.academicYear||""); setFStart(s.startDate||""); setFEnd(s.endDate||""); setFStatus(s.status||"active"); setError(""); setShowForm(true); }
  function submit(){
    if(!fName.trim()){ setError("Give this semester a name."); return; }
    var payload = { name:fName.trim(), academicYear:fYear.trim(), startDate:fStart, endDate:fEnd, status:fStatus };
    if(editingId){ onUpdate(editingId, payload); } else { onAdd(payload); }
    setShowForm(false);
  }
  function confirmDelete(s){ if(window.confirm("Delete \""+s.name+"\"? Courses in it will become unassigned — nothing about them is deleted.")){ onDelete(s.id); setDetailId(null); } }

  var STATUS_META = { upcoming:["Upcoming",C.amber], active:["Active",C.green], completed:["Completed",C.muted] };
  function fmtRange(s){ if(!s.startDate&&!s.endDate) return null; return (s.startDate||"?")+" → "+(s.endDate||"?"); }

  var detailSemester = detailId!=null ? semesters.find(function(s){return s.id===detailId;}) : null;
  var detailCourses = detailSemester ? courses.filter(function(c){return c.semesterId===detailSemester.id;}) : [];
  var unassignedForDetail = detailSemester ? courses.filter(function(c){return c.semesterId!==detailSemester.id;}) : [];

  return(
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column",position:"relative" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>🗓️ Manage Semesters</span>
        <button onClick={openAdd} style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:10,padding:"8px 14px",fontWeight:800,fontSize:13,cursor:"pointer" }}>+ Add</button>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        {semesters.length===0 ? (
          <div style={{ textAlign:"center",padding:"60px 20px" }}>
            <div style={{ fontSize:48,marginBottom:12 }}>🗓️</div>
            <div style={{ fontWeight:800,fontSize:16,color:C.text,marginBottom:6 }}>No semesters yet</div>
            <div style={{ fontSize:13,color:C.muted,marginBottom:20 }}>Add one, then assign your courses to it — Study Vault will group by it automatically.</div>
            <button onClick={openAdd} style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:14,padding:"12px 28px",fontWeight:800,fontSize:14,cursor:"pointer" }}>+ Add Semester</button>
          </div>
        ) : semesters.map(function(s){
          var meta = STATUS_META[s.status] || STATUS_META.active;
          var courseCount = courses.filter(function(c){return c.semesterId===s.id;}).length;
          var range = fmtRange(s);
          return(
            <button key={s.id} onClick={function(){setDetailId(s.id);}} style={{ width:"100%",textAlign:"left",background:C.card,borderRadius:16,padding:16,marginBottom:12,border:"1px solid "+C.border,cursor:"pointer",fontFamily:"inherit" }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10 }}>
                <div style={{ minWidth:0 }}>
                  <div style={{ fontWeight:800,fontSize:15,color:C.text }}>{s.name}</div>
                  {s.academicYear&&<div style={{ fontSize:12,color:C.muted,marginTop:2 }}>{s.academicYear}</div>}
                  {range&&<div style={{ fontSize:11,color:C.muted,marginTop:2 }}>{range}</div>}
                </div>
                <span style={{ fontSize:10,fontWeight:800,color:meta[1],background:meta[1]+"18",borderRadius:99,padding:"3px 10px",flexShrink:0 }}>{meta[0]}</span>
              </div>
              <div style={{ fontSize:12,color:C.cyan,fontWeight:700,marginTop:10 }}>{courseCount} course{courseCount===1?"":"s"}</div>
            </button>
          );
        })}
      </div>

      {showForm&&(
        <div style={{ position:"absolute",inset:0,background:"rgba(10,15,30,0.85)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:30 }} onClick={function(){setShowForm(false);}}>
          <div style={{ background:C.card,borderRadius:"20px 20px 0 0",padding:20,width:"100%",maxHeight:"85vh",overflowY:"auto",boxSizing:"border-box" }} onClick={function(e){e.stopPropagation();}}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
              <span style={{ fontWeight:800,fontSize:16,color:C.text }}>{editingId?"Edit Semester":"New Semester"}</span>
              <button onClick={function(){setShowForm(false);}} style={{ background:"none",border:"none",color:C.muted,fontSize:18,cursor:"pointer" }}>✕</button>
            </div>
            <input value={fName} onChange={function(e){setFName(e.target.value);}} placeholder="e.g. First Semester" style={{ width:"100%",padding:"13px 16px",borderRadius:12,border:"1px solid "+C.border,fontSize:15,fontWeight:700,background:C.bg,color:C.text,outline:"none",marginBottom:12,boxSizing:"border-box" }}/>
            <input value={fYear} onChange={function(e){setFYear(e.target.value);}} placeholder="Academic year (e.g. 2025/2026)" style={{ width:"100%",padding:"11px 14px",borderRadius:12,border:"1px solid "+C.border,fontSize:13,background:C.bg,color:C.text,outline:"none",marginBottom:12,boxSizing:"border-box" }}/>
            <div style={{ display:"flex",gap:10,marginBottom:12 }}>
              <div style={{ flex:1 }}>
                <label style={{ fontSize:12,fontWeight:700,color:C.soft,display:"block",marginBottom:6 }}>START DATE</label>
                <input type="date" value={fStart} onChange={function(e){setFStart(e.target.value);}} style={{ width:"100%",padding:"11px 14px",borderRadius:12,border:"1px solid "+C.border,fontSize:13,background:C.bg,color:C.text,outline:"none",boxSizing:"border-box" }}/>
              </div>
              <div style={{ flex:1 }}>
                <label style={{ fontSize:12,fontWeight:700,color:C.soft,display:"block",marginBottom:6 }}>END DATE</label>
                <input type="date" value={fEnd} onChange={function(e){setFEnd(e.target.value);}} style={{ width:"100%",padding:"11px 14px",borderRadius:12,border:"1px solid "+C.border,fontSize:13,background:C.bg,color:C.text,outline:"none",boxSizing:"border-box" }}/>
              </div>
            </div>
            <label style={{ fontSize:12,fontWeight:700,color:C.soft,display:"block",marginBottom:6 }}>STATUS</label>
            <div style={{ display:"flex",gap:8,marginBottom:16 }}>{["upcoming","active","completed"].map(function(st){return<button key={st} onClick={function(){setFStatus(st);}} style={{ flex:1,padding:"9px",borderRadius:10,border:"2px solid",borderColor:fStatus===st?C.cyan:C.border,background:fStatus===st?C.cyan:C.card2,color:fStatus===st?"#0A0F1E":C.muted,fontSize:12,fontWeight:700,cursor:"pointer",textTransform:"capitalize" }}>{st}</button>;})}</div>
            {error&&<div style={{ background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:13,color:C.red,fontWeight:600 }}>⚠️ {error}</div>}
            <div style={{ display:"flex",gap:10 }}>
              {editingId&&<button onClick={function(){var s=semesters.find(function(x){return x.id===editingId;});if(s)confirmDelete(s);setShowForm(false);}} style={{ background:"rgba(248,113,113,0.1)",border:"1px solid "+C.red+"40",borderRadius:14,padding:"13px 16px",color:C.red,fontWeight:700,fontSize:14,cursor:"pointer" }}>🗑</button>}
              <button onClick={submit} style={{ flex:1,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:14,padding:"13px",fontWeight:800,fontSize:15,cursor:"pointer" }}>{editingId?"Save Changes":"Add Semester"}</button>
            </div>
          </div>
        </div>
      )}

      {detailSemester&&(
        <div style={{ position:"absolute",inset:0,background:"rgba(10,15,30,0.85)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:30 }} onClick={function(){setDetailId(null);}}>
          <div style={{ background:C.card,borderRadius:"20px 20px 0 0",padding:20,width:"100%",maxHeight:"85vh",overflowY:"auto",boxSizing:"border-box" }} onClick={function(e){e.stopPropagation();}}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16 }}>
              <div>
                <div style={{ fontWeight:800,fontSize:17,color:C.text }}>{detailSemester.name}</div>
                {detailSemester.academicYear&&<div style={{ fontSize:12,color:C.muted,marginTop:2 }}>{detailSemester.academicYear}</div>}
              </div>
              <div style={{ display:"flex",gap:8 }}>
                <button onClick={function(){openEdit(detailSemester);setDetailId(null);}} style={{ background:C.card2,border:"1px solid "+C.border,borderRadius:8,padding:"6px 12px",color:C.cyan,fontSize:12,fontWeight:700,cursor:"pointer" }}>Edit</button>
                <button onClick={function(){confirmDelete(detailSemester);}} style={{ background:"rgba(248,113,113,0.12)",border:"none",borderRadius:8,width:32,height:32,cursor:"pointer",fontSize:13 }}>🗑</button>
              </div>
            </div>
            <div style={{ fontWeight:800,fontSize:14,color:C.text,marginBottom:10 }}>Courses in this semester ({detailCourses.length})</div>
            {detailCourses.length===0 ? (
              <div style={{ fontSize:13,color:C.muted,marginBottom:16 }}>No courses assigned yet — add one below.</div>
            ) : (
              <div style={{ marginBottom:16 }}>{detailCourses.map(function(c){return(
                <div key={c.id} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:"1px solid "+C.border }}>
                  <span style={{ fontSize:14,fontWeight:600,color:C.text }}>{c.code||c.title}</span>
                  <button onClick={function(){onUpdateCourse(c.id,{semesterId:null});}} style={{ background:"none",border:"1px solid "+C.border,borderRadius:8,padding:"5px 12px",color:C.muted,fontSize:11,fontWeight:700,cursor:"pointer" }}>Remove</button>
                </div>
              );})}</div>
            )}
            {unassignedForDetail.length>0 && (
              <div>
                <div style={{ fontWeight:800,fontSize:13,color:C.text,marginBottom:10 }}>Add a course</div>
                <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>{unassignedForDetail.map(function(c){return(
                  <button key={c.id} onClick={function(){onUpdateCourse(c.id,{semesterId:detailSemester.id});}} style={{ padding:"7px 14px",borderRadius:99,border:"2px solid "+C.border,background:C.card2,color:C.muted,fontSize:12,fontWeight:700,cursor:"pointer" }}>+ {c.code||c.title}</button>
                );})}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── MANAGE COURSES ────────────────────────────────────────────────────────────
// Real Course CRUD UI — updateCourseRecord/deleteCourseRecord have existed
// since Course IDs were introduced but never had a screen. Mirrors
// ManageSemestersScreen's exact list+form+detail shape directly above.
//
// Deleting a course here also cleans up what points at it — materials lose
// their courseId (set to null, becoming "uncategorized" rather than pointing
// at nothing), and any study plan's courseIds array has the deleted id
// removed — see deleteCourseRecord in App for the actual cleanup logic; this
// screen just triggers it and re-renders once state updates. Assignments,
// notes, recordings, quizzes, and flashcards are untouched — all still
// name-based, never migrated, so a deleted course's name simply stops
// existing as a real option going forward, exactly like any other legacy
// free-text name always has.
function ManageCoursesScreen({ courses, semesters, onBack, onAdd, onUpdate, onDelete }) {
  var [showForm, setShowForm] = useState(false);
  var [editingId, setEditingId] = useState(null);
  var [fCode, setFCode] = useState("");
  var [fTitle, setFTitle] = useState("");
  var [fDepartment, setFDepartment] = useState("");
  var [fLevel, setFLevel] = useState("");
  var [fUnits, setFUnits] = useState("");
  var [fSemesterId, setFSemesterId] = useState(null);
  var [fStatus, setFStatus] = useState("active");
  var [error, setError] = useState("");
  var [detailId, setDetailId] = useState(null);

  function openAdd(){ setEditingId(null); setFCode(""); setFTitle(""); setFDepartment(""); setFLevel(""); setFUnits(""); setFSemesterId(null); setFStatus("active"); setError(""); setShowForm(true); }
  function openEdit(c){ setEditingId(c.id); setFCode(c.code||""); setFTitle(c.title||""); setFDepartment(c.department||""); setFLevel(c.level||""); setFUnits(c.units!=null?String(c.units):""); setFSemesterId(c.semesterId!=null?c.semesterId:null); setFStatus(c.status||"active"); setError(""); setShowForm(true); }
  function submit(){
    if(!fCode.trim()){ setError("Give this course a code (e.g. PHY 101)."); return; }
    var payload = {
      code: fCode.trim().toUpperCase(),
      title: fTitle.trim(),
      department: fDepartment.trim(),
      level: fLevel.trim(),
      units: fUnits.trim() ? Number(fUnits.trim()) : null,
      semesterId: fSemesterId,
      status: fStatus,
    };
    if(editingId){ onUpdate(editingId, payload); } else { onAdd(payload); }
    setShowForm(false);
  }
  function confirmDelete(c){ if(window.confirm("Delete \""+(c.code||c.title)+"\"? Materials in it become uncategorized and it's removed from any study plans — nothing about those is deleted, just unlinked.")){ onDelete(c.id); setDetailId(null); } }

  var STATUS_META = { active:["Active",C.green], completed:["Completed",C.muted] };
  var detailCourse = detailId!=null ? courses.find(function(c){return c.id===detailId;}) : null;
  function semesterNameFor(semesterId){ var s=(semesters||[]).find(function(x){return x.id===semesterId;}); return s?s.name:null; }

  return(
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column",position:"relative" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>📚 Manage Courses</span>
        <button onClick={openAdd} style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:10,padding:"8px 14px",fontWeight:800,fontSize:13,cursor:"pointer" }}>+ Add</button>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        {courses.length===0 ? (
          <div style={{ textAlign:"center",padding:"60px 20px" }}>
            <div style={{ fontSize:48,marginBottom:12 }}>📚</div>
            <div style={{ fontWeight:800,fontSize:16,color:C.text,marginBottom:6 }}>No courses yet</div>
            <div style={{ fontSize:13,color:C.muted,marginBottom:20 }}>Add one here, or use "+ Add Course" the first time you save a note.</div>
            <button onClick={openAdd} style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:14,padding:"12px 28px",fontWeight:800,fontSize:14,cursor:"pointer" }}>+ Add Course</button>
          </div>
        ) : courses.map(function(c){
          var meta = STATUS_META[c.status] || STATUS_META.active;
          var semName = semesterNameFor(c.semesterId);
          return(
            <button key={c.id} onClick={function(){setDetailId(c.id);}} style={{ width:"100%",textAlign:"left",background:C.card,borderRadius:16,padding:16,marginBottom:12,border:"1px solid "+C.border,cursor:"pointer",fontFamily:"inherit" }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10 }}>
                <div style={{ minWidth:0 }}>
                  <div style={{ fontWeight:800,fontSize:15,color:C.text }}>{c.code}{c.title&&c.title!==c.code?" — "+c.title:""}</div>
                  <div style={{ fontSize:12,color:C.muted,marginTop:4,display:"flex",gap:8,flexWrap:"wrap" }}>
                    {c.department&&<span>{c.department}</span>}
                    {c.level&&<span>{c.level}</span>}
                    {c.units!=null&&<span>{c.units} unit{c.units===1?"":"s"}</span>}
                  </div>
                  {semName&&<div style={{ fontSize:11,color:C.cyan,fontWeight:700,marginTop:4 }}>{semName}</div>}
                </div>
                <span style={{ fontSize:10,fontWeight:800,color:meta[1],background:meta[1]+"18",borderRadius:99,padding:"3px 10px",flexShrink:0 }}>{meta[0]}</span>
              </div>
            </button>
          );
        })}
      </div>

      {showForm&&(
        <div style={{ position:"absolute",inset:0,background:"rgba(10,15,30,0.85)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:30 }} onClick={function(){setShowForm(false);}}>
          <div style={{ background:C.card,borderRadius:"20px 20px 0 0",padding:20,width:"100%",maxHeight:"85vh",overflowY:"auto",boxSizing:"border-box" }} onClick={function(e){e.stopPropagation();}}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
              <span style={{ fontWeight:800,fontSize:16,color:C.text }}>{editingId?"Edit Course":"New Course"}</span>
              <button onClick={function(){setShowForm(false);}} style={{ background:"none",border:"none",color:C.muted,fontSize:18,cursor:"pointer" }}>✕</button>
            </div>
            <input value={fCode} onChange={function(e){setFCode(e.target.value);}} placeholder="Course code (e.g. PHY 101)" style={{ width:"100%",padding:"13px 16px",borderRadius:12,border:"1px solid "+C.border,fontSize:15,fontWeight:700,background:C.bg,color:C.text,outline:"none",marginBottom:12,boxSizing:"border-box" }}/>
            <input value={fTitle} onChange={function(e){setFTitle(e.target.value);}} placeholder="Title (e.g. General Physics I) — optional" style={{ width:"100%",padding:"11px 14px",borderRadius:12,border:"1px solid "+C.border,fontSize:13,background:C.bg,color:C.text,outline:"none",marginBottom:12,boxSizing:"border-box" }}/>
            <div style={{ display:"flex",gap:10,marginBottom:12 }}>
              <input value={fDepartment} onChange={function(e){setFDepartment(e.target.value);}} placeholder="Department" style={{ flex:1,padding:"11px 14px",borderRadius:12,border:"1px solid "+C.border,fontSize:13,background:C.bg,color:C.text,outline:"none",boxSizing:"border-box" }}/>
              <input value={fLevel} onChange={function(e){setFLevel(e.target.value);}} placeholder="Level (e.g. 200L)" style={{ flex:1,padding:"11px 14px",borderRadius:12,border:"1px solid "+C.border,fontSize:13,background:C.bg,color:C.text,outline:"none",boxSizing:"border-box" }}/>
              <input value={fUnits} onChange={function(e){setFUnits(e.target.value.replace(/[^0-9]/g,""));}} placeholder="Units" style={{ width:80,padding:"11px 14px",borderRadius:12,border:"1px solid "+C.border,fontSize:13,background:C.bg,color:C.text,outline:"none",boxSizing:"border-box" }}/>
            </div>
            {(semesters||[]).length>0 && (
              <div style={{ marginBottom:12 }}>
                <label style={{ fontSize:12,fontWeight:700,color:C.soft,display:"block",marginBottom:6 }}>SEMESTER (optional)</label>
                <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
                  <button onClick={function(){setFSemesterId(null);}} style={{ padding:"7px 14px",borderRadius:99,border:"2px solid",borderColor:fSemesterId==null?C.cyan:C.border,background:fSemesterId==null?C.cyan:C.card2,color:fSemesterId==null?"#0A0F1E":C.muted,fontSize:12,fontWeight:700,cursor:"pointer" }}>None</button>
                  {semesters.map(function(s){return<button key={s.id} onClick={function(){setFSemesterId(s.id);}} style={{ padding:"7px 14px",borderRadius:99,border:"2px solid",borderColor:fSemesterId===s.id?C.cyan:C.border,background:fSemesterId===s.id?C.cyan:C.card2,color:fSemesterId===s.id?"#0A0F1E":C.muted,fontSize:12,fontWeight:700,cursor:"pointer" }}>{s.name}</button>;})}
                </div>
              </div>
            )}
            <label style={{ fontSize:12,fontWeight:700,color:C.soft,display:"block",marginBottom:6 }}>STATUS</label>
            <div style={{ display:"flex",gap:8,marginBottom:16 }}>{["active","completed"].map(function(st){return<button key={st} onClick={function(){setFStatus(st);}} style={{ flex:1,padding:"9px",borderRadius:10,border:"2px solid",borderColor:fStatus===st?C.cyan:C.border,background:fStatus===st?C.cyan:C.card2,color:fStatus===st?"#0A0F1E":C.muted,fontSize:12,fontWeight:700,cursor:"pointer",textTransform:"capitalize" }}>{st}</button>;})}</div>
            {error&&<div style={{ background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:13,color:C.red,fontWeight:600 }}>⚠️ {error}</div>}
            <div style={{ display:"flex",gap:10 }}>
              {editingId&&<button onClick={function(){var c=courses.find(function(x){return x.id===editingId;});if(c)confirmDelete(c);setShowForm(false);}} style={{ background:"rgba(248,113,113,0.1)",border:"1px solid "+C.red+"40",borderRadius:14,padding:"13px 16px",color:C.red,fontWeight:700,fontSize:14,cursor:"pointer" }}>🗑</button>}
              <button onClick={submit} style={{ flex:1,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:14,padding:"13px",fontWeight:800,fontSize:15,cursor:"pointer" }}>{editingId?"Save Changes":"Add Course"}</button>
            </div>
          </div>
        </div>
      )}

      {detailCourse&&(
        <div style={{ position:"absolute",inset:0,background:"rgba(10,15,30,0.85)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:30 }} onClick={function(){setDetailId(null);}}>
          <div style={{ background:C.card,borderRadius:"20px 20px 0 0",padding:20,width:"100%",maxHeight:"80vh",overflowY:"auto",boxSizing:"border-box" }} onClick={function(e){e.stopPropagation();}}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16 }}>
              <div>
                <div style={{ fontWeight:800,fontSize:17,color:C.text }}>{detailCourse.code}{detailCourse.title&&detailCourse.title!==detailCourse.code?" — "+detailCourse.title:""}</div>
                {semesterNameFor(detailCourse.semesterId)&&<div style={{ fontSize:12,color:C.cyan,fontWeight:700,marginTop:4 }}>{semesterNameFor(detailCourse.semesterId)}</div>}
              </div>
              <div style={{ display:"flex",gap:8 }}>
                <button onClick={function(){openEdit(detailCourse);setDetailId(null);}} style={{ background:C.card2,border:"1px solid "+C.border,borderRadius:8,padding:"6px 12px",color:C.cyan,fontSize:12,fontWeight:700,cursor:"pointer" }}>Edit</button>
                <button onClick={function(){confirmDelete(detailCourse);}} style={{ background:"rgba(248,113,113,0.12)",border:"none",borderRadius:8,width:32,height:32,cursor:"pointer",fontSize:13 }}>🗑</button>
              </div>
            </div>
            <div style={{ background:C.card2,borderRadius:14,padding:"0 14px" }}>
              {detailCourse.department&&<Row icon="🏛️" label="Department" sub={detailCourse.department}/>}
              {detailCourse.level&&<Row icon="🎓" label="Level" sub={detailCourse.level}/>}
              {detailCourse.units!=null&&<Row icon="📐" label="Units" sub={String(detailCourse.units)}/>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── TOPIC MASTERY DETAIL ─────────────────────────────────────────────────────
// Per-topic drill-down, reached from Course Overview's Progress tab and the
// Command Center's Weak Topics section. Everything shown is either a direct
// topicMastery field or a simple, deterministic rule over those fields — no
// AI, consistent with every other piece of the mastery/recommendation system
// built this session. Strengths/weaknesses/recommended-action thresholds are
// IMPORTED from recommendationService.js, not re-hardcoded, so this screen
// can't silently drift out of sync with the rules that generate Today's
// Mission and the weak-topic lists elsewhere.
//
// TWO HONEST GAPS, not papered over:
//   - Quiz Performance: quizAttempts has no `topic` field (same gap
//     topicMasteryService.js already documents), so there's no way to list
//     individual quiz attempts for THIS topic — only the running
//     masteryScore/confidence the mastery service already blends from quiz
//     evidence is available, and that's what's shown, labeled honestly.
//   - Flashcard Performance: FlashcardsScreen's "Got It"/"Still Learning"
//     self-grading is local React state only (saveFlashcardDeckLocally only
//     stores the deck, never study results) — there is currently zero
//     flashcard performance data anywhere in this app, for any topic. Shown
//     as an honest empty state, not invented.
function TopicMasteryScreen({ topicId, topicMastery, onBack, onAITutor, onFlashcards }) {
  var m = topicMastery.find(function(t){ return t.id===topicId; });

  if (!m) {
    return (
      <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
        <div style={{ background:C.card,padding:"16px 20px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid "+C.border }}>
          <button onClick={onBack} style={backBtn}>←</button>
          <span style={{ fontWeight:800,fontSize:16,color:C.text }}>Topic</span>
        </div>
        <div style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",padding:32,textAlign:"center" }}>
          <div style={{ color:C.muted,fontSize:13 }}>This topic's mastery record is gone — it may have been removed.</div>
        </div>
      </div>
    );
  }

  var score = typeof m.masteryScore==="number" ? m.masteryScore : null;
  var scoreColor = score==null ? C.muted : score>=EXAM_PREP_MASTERY_THRESHOLD ? C.green : score>=WEAK_TOPIC_MASTERY_THRESHOLD ? C.amber : C.red;
  var trendMeta = ({ up:["📈","Improving",C.green], down:["📉","Declining",C.red], steady:["➡️","Steady",C.muted], new:["🆕","New",C.cyan] })[m.trend] || ["➡️","Steady",C.muted];

  var strengths = [];
  var weaknesses = [];
  if (score!=null && score>=EXAM_PREP_MASTERY_THRESHOLD) strengths.push("Strong grasp — mastery is at or above "+EXAM_PREP_MASTERY_THRESHOLD+"%.");
  if (m.trend==="up") strengths.push("Trending upward — recent evidence is improving.");
  if (typeof m.confidence==="number" && m.confidence>=0.7) strengths.push("High confidence — well-established from repeated practice.");

  if (score!=null && score<WEAK_TOPIC_MASTERY_THRESHOLD) weaknesses.push("Below the weak-topic threshold ("+WEAK_TOPIC_MASTERY_THRESHOLD+"%).");
  if (m.trend==="down") weaknesses.push("Trending downward — recent evidence is worse than before.");
  if (typeof m.confidence==="number" && m.confidence<0.3) weaknesses.push("Low confidence — not enough practice evidence yet.");
  var daysSinceStudied = m.lastStudiedAt ? Math.floor((Date.now()-m.lastStudiedAt)/(24*60*60*1000)) : null;
  if (daysSinceStudied==null || daysSinceStudied>7) weaknesses.push(daysSinceStudied==null ? "Never practiced." : "Hasn't been practiced in "+daysSinceStudied+" days.");

  var recommendedAction, recommendedCta, recommendedHandler;
  if (score==null) {
    recommendedAction = "No mastery data yet — take a quiz on this topic to start tracking it.";
  } else if (score < WEAK_TOPIC_MASTERY_THRESHOLD) {
    recommendedAction = "This is a weak topic. Practice with AI Tutor to build it up.";
    recommendedCta = "Practice with AI Tutor"; recommendedHandler = onAITutor;
  } else if (score < EXAM_PREP_MASTERY_THRESHOLD) {
    recommendedAction = "Solid, but not fully mastered — a flashcard review would help.";
    recommendedCta = "Review Flashcards"; recommendedHandler = onFlashcards;
  } else {
    recommendedAction = "Strong grasp of this topic. Light review keeps it fresh.";
    recommendedCta = m.nextReviewAt ? "Next review: "+new Date(m.nextReviewAt).toLocaleDateString(undefined,{ month:"short", day:"numeric" }) : null;
  }

  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <div>
          <div style={{ fontWeight:800,fontSize:16,color:C.text }}>{m.topic}</div>
          {m.courseId && <div style={{ fontSize:11,color:C.muted }}>{m.courseId}</div>}
        </div>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>

        <div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.border,marginBottom:20,textAlign:"center" }}>
          <div style={{ fontSize:44,fontWeight:800,color:scoreColor,marginBottom:4 }}>{score==null?"—":score+"%"}</div>
          <div style={{ fontSize:12,color:C.muted,marginBottom:14 }}>Mastery</div>
          <div style={{ display:"inline-flex",alignItems:"center",gap:6,background:trendMeta[2]+"18",borderRadius:99,padding:"5px 14px" }}>
            <span>{trendMeta[0]}</span><span style={{ fontSize:12,fontWeight:700,color:trendMeta[2] }}>{trendMeta[1]}</span>
          </div>
        </div>

        <div style={{ marginBottom:20 }}>
          <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:8 }}>Strengths</div>
          <div style={{ background:C.card,borderRadius:16,padding:16,border:"1px solid "+C.border }}>
            {strengths.length===0 ? <div style={{ fontSize:13,color:C.muted }}>Nothing stands out yet.</div> : strengths.map(function(s,i){return<div key={i} style={{ display:"flex",gap:8,marginBottom:i<strengths.length-1?8:0 }}><span style={{color:C.green}}>✓</span><span style={{ fontSize:13,color:C.text }}>{s}</span></div>;})}
          </div>
        </div>

        <div style={{ marginBottom:20 }}>
          <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:8 }}>Weaknesses</div>
          <div style={{ background:C.card,borderRadius:16,padding:16,border:"1px solid "+C.border }}>
            {weaknesses.length===0 ? <div style={{ fontSize:13,color:C.muted }}>Nothing concerning right now.</div> : weaknesses.map(function(w,i){return<div key={i} style={{ display:"flex",gap:8,marginBottom:i<weaknesses.length-1?8:0 }}><span style={{color:C.red}}>!</span><span style={{ fontSize:13,color:C.text }}>{w}</span></div>;})}
          </div>
        </div>

        <div style={{ marginBottom:20 }}>
          <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:8 }}>Quiz Performance</div>
          <div style={{ background:C.card,borderRadius:16,padding:16,border:"1px solid "+C.border }}>
            <div style={{ fontSize:14,fontWeight:700,color:C.text,marginBottom:4 }}>Confidence: {typeof m.confidence==="number"?Math.round(m.confidence*100)+"%":"—"}</div>
            <div style={{ fontSize:12,color:C.muted,lineHeight:1.5 }}>Reflects how much quiz evidence has fed into this topic's mastery score. Individual quiz-attempt history per topic isn't tracked yet — only the running score is.</div>
          </div>
        </div>

        <div style={{ marginBottom:20 }}>
          <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:8 }}>Flashcard Performance</div>
          <div style={{ background:C.card,borderRadius:16,padding:16,border:"1px solid "+C.border }}>
            <div style={{ fontSize:13,color:C.muted,lineHeight:1.5 }}>Not tracked yet — flashcard results aren't saved once a study session ends.</div>
          </div>
        </div>

        <div style={{ marginBottom:20 }}>
          <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:8 }}>Last Studied</div>
          <div style={{ background:C.card,borderRadius:16,padding:16,border:"1px solid "+C.border,fontSize:14,color:C.text,fontWeight:700 }}>
            {m.lastStudiedAt ? formatRelativeDate(m.lastStudiedAt) : "Never"}
          </div>
        </div>

        <div>
          <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:8 }}>Recommended Action</div>
          <div style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)",borderRadius:16,padding:18 }}>
            <div style={{ fontSize:13,color:"#fff",lineHeight:1.6,marginBottom:(recommendedHandler||recommendedCta)?14:0 }}>{recommendedAction}</div>
            {recommendedHandler && <button onClick={recommendedHandler} style={{ background:"#fff",color:"#0A0F1E",border:"none",borderRadius:12,padding:"10px 18px",fontWeight:800,fontSize:13,cursor:"pointer" }}>{recommendedCta} →</button>}
            {!recommendedHandler && recommendedCta && <div style={{ fontSize:12,color:"rgba(255,255,255,0.85)",fontWeight:700 }}>{recommendedCta}</div>}
          </div>
        </div>

      </div>
    </div>
  );
}

// ── STUDY SESSION ─────────────────────────────────────────────────────────────
// A focused sequencer through FOUR EXISTING screens — NoteDetail (most recent
// note), FlashcardsScreen, ExamModeScreen, AITutorScreen — never a
// reimplementation of quiz-taking or flashcard-flipping. This screen never
// renders a question, a flashcard, or a chat bubble itself; it only tracks
// which step you're on and sends you to the real screen for it.
//
// HOW "PROGRESS" WORKS WITHOUT TOUCHING THOSE SCREENS' INTERNALS: each of the
// four destination screens already has its own onBack prop, supplied by App
// below — not hardcoded inside the screen components themselves. So a step
// counts as attempted the moment you navigate there and back, however that
// screen's OWN internal back button already worked (FlashcardsScreen's
// mid-study back calls its own startOver, not onBack, same for AITutorScreen
// mid-chat calling its own endSession — neither of those was touched; App
// only reroutes the OUTERMOST "actually leaving" case, exactly the case that
// already called onBack before this existed). Nothing here hooks into quiz
// scores or flashcard results — "attempted" just means "went there, came
// back", which is honest about what this screen can actually know without
// reaching into those screens' internals.
var STUDY_SESSION_STEPS = [
  { key:"notes",      icon:"📝", label:"Review Notes",  description:"Revisit your most recent note to refresh what you've learned." },
  { key:"flashcards", icon:"🗂️", label:"Flashcards",     description:"Practice with flashcards generated from your notes." },
  { key:"quizzes",    icon:"🎯", label:"Quiz Yourself",  description:"Take a quiz to test what you remember.", requiredPlan:"premium" },
  { key:"tutor",      icon:"🎓", label:"AI Tutor",       description:"Check your understanding with a Socratic tutoring session.", requiredPlan:"pro" },
];

// Mastery for the Quizzes step is handled by the REAL pipeline —
// topicMasteryService.updateTopicMasteryFromQuizAttempt() — see
// applyStudySessionMasteryNudge() in App below for how Study Session feeds it.

function StudySessionScreen({ session, plan, onStart, onSkip, onAdvance, onFinish, onEnd }) {
  var stepIndex = session.currentIndex;
  var step = STUDY_SESSION_STEPS[stepIndex];
  var isLast = stepIndex === STUDY_SESSION_STEPS.length-1;
  var attempted = !!session.results[step.key];
  var doneCount = Object.keys(session.results).length;
  var progressPct = Math.round((doneCount/STUDY_SESSION_STEPS.length)*100);
  var locked = step.requiredPlan && !planAtLeast(plan, step.requiredPlan);

  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <button onClick={onEnd} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>🎯 Study Session</span>
        <button onClick={onEnd} style={{ background:"none",border:"none",color:C.muted,fontSize:12,fontWeight:700,cursor:"pointer" }}>End</button>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>

        {/* Progress */}
        <div style={{ background:C.card,borderRadius:16,padding:18,border:"1px solid "+C.border,marginBottom:20 }}>
          <div style={{ display:"flex",justifyContent:"space-between",marginBottom:10 }}>
            <span style={{ fontSize:13,fontWeight:700,color:C.text }}>Step {stepIndex+1} of {STUDY_SESSION_STEPS.length}</span>
            <span style={{ fontSize:13,fontWeight:700,color:C.cyan }}>{doneCount}/{STUDY_SESSION_STEPS.length} complete</span>
          </div>
          <div style={{ height:8,background:C.card2,borderRadius:99,overflow:"hidden",marginBottom:12 }}><div style={{ height:"100%",width:progressPct+"%",background:"linear-gradient(90deg,#06B6D4,#A78BFA)",borderRadius:99,transition:"width 0.3s" }}/></div>
          <div style={{ display:"flex",gap:8 }}>
            {STUDY_SESSION_STEPS.map(function(s,i){ var r=session.results[s.key]; return(
              <div key={s.key} style={{ flex:1,textAlign:"center" }}>
                <div style={{ width:28,height:28,borderRadius:"50%",margin:"0 auto 4px",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:800,background:r==="done"?C.green:r==="skipped"?C.card2:i===stepIndex?C.cyan:C.card2,color:r==="done"?"#0A0F1E":i===stepIndex?"#0A0F1E":C.muted }}>{r==="done"?"✓":r==="skipped"?"–":i+1}</div>
                <span style={{ fontSize:9,color:C.muted,fontWeight:600 }}>{s.icon}</span>
              </div>
            );})}
          </div>
        </div>

        {/* Current activity (not yet attempted) OR feedback + next action (just returned) */}
        <div style={{ background:attempted?C.card:"linear-gradient(135deg,#06B6D4,#A78BFA)",borderRadius:20,padding:24,border:attempted?"1px solid "+C.border:"none" }}>
          {!attempted ? (
            <div>
              <div style={{ fontSize:11,fontWeight:800,color:"rgba(255,255,255,0.75)",letterSpacing:0.5,marginBottom:8,textTransform:"uppercase" }}>Current Activity</div>
              <div style={{ fontSize:40,marginBottom:10 }}>{step.icon}</div>
              <div style={{ fontWeight:800,fontSize:20,color:"#fff",marginBottom:8 }}>{step.label}</div>
              <div style={{ fontSize:14,color:"rgba(255,255,255,0.9)",lineHeight:1.6,marginBottom:locked?14:20 }}>{step.description}</div>
              {locked && <div style={{ background:"rgba(255,255,255,0.15)",borderRadius:10,padding:"8px 12px",fontSize:12,color:"#fff",fontWeight:700,marginBottom:14 }}>🔒 This step needs {step.requiredPlan==="premium"?"Premium":"Pro"} — you'll see the upgrade screen.</div>}
              <div style={{ display:"flex",gap:14,alignItems:"center" }}>
                <button onClick={function(){onStart(step);}} style={{ background:"#fff",color:"#0A0F1E",border:"none",borderRadius:14,padding:"13px 22px",fontWeight:800,fontSize:14,cursor:"pointer" }}>Start →</button>
                <button onClick={onSkip} style={{ background:"none",border:"none",color:"rgba(255,255,255,0.85)",fontWeight:700,fontSize:13,cursor:"pointer",textDecoration:"underline",padding:0 }}>Skip</button>
              </div>
            </div>
          ) : (
            <div>
              <div style={{ fontSize:11,fontWeight:800,color:C.muted,letterSpacing:0.5,marginBottom:8,textTransform:"uppercase" }}>Feedback</div>
              <div style={{ fontSize:36,marginBottom:10 }}>{session.results[step.key]==="skipped"?"⏭️":"✅"}</div>
              <div style={{ fontWeight:800,fontSize:18,color:C.text,marginBottom:8 }}>{session.results[step.key]==="skipped"?"Skipped "+step.label:"Nice — you worked on "+step.label+"."}</div>
              <div style={{ fontSize:13,color:C.muted,lineHeight:1.6,marginBottom:20 }}>{isLast?"That's the last step in this session.":"Ready for the next step?"}</div>
              {isLast ? (
                <button onClick={onFinish} style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:14,padding:"13px 22px",fontWeight:800,fontSize:14,cursor:"pointer" }}>Finish Session 🎉</button>
              ) : (
                <button onClick={onAdvance} style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:14,padding:"13px 22px",fontWeight:800,fontSize:14,cursor:"pointer" }}>Next: {STUDY_SESSION_STEPS[stepIndex+1].label} →</button>
              )}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

// ── STUDY SESSION COMPLETION ─────────────────────────────────────────────────
// Shown once every step has been attempted (the "Finish Session 🎉" button).
// Nothing here recomputes results itself — it only reads back what
// studyStepReturn()/applyStudySessionMasteryNudge() (in App, below) already
// stored on the session object the moment the student returned from the
// Quizzes step, and reuses buildRecommendations() — the SAME recommendation
// engine Command Center and Today's Mission already call — for "Recommended
// Next Step", instead of inventing a second one.
//
// HONESTY NOTE ON SCORE/MISTAKES/MASTERY CHANGE: these only ever reflect a
// quiz that was actually submitted during THIS session's Quizzes step. If that
// step was skipped, or visited but no exam was actually finished, or the
// course being quizzed has no tracked topics yet, each section says so
// plainly instead of showing a fabricated number — same "degrade honestly"
// approach as Weak Topics and Exam Prep elsewhere in this app.
function StudySessionCompleteScreen({ session, notes, recordings, assignments, topicMastery, onDone, onAssignments, onAITutor, onExamMode, onVoice, onStudyPlanner }) {
  var quizResult = session.quizResult;
  var masteryChange = session.masteryChange;
  var mistakes = quizResult ? Math.max(0, quizResult.totalQuestions-quizResult.score) : null;
  var doneCount = Object.keys(session.results).length;

  var lastStudyActivityAt = notes.concat(recordings).reduce(function(max,item){ var t=item.createdAt||item.id||0; return t>max?t:max; }, 0) || null;
  var recommendations = buildRecommendations({
    assignments: assignments,
    topicMastery: topicMastery,
    exams: [], // same unwired exam-date gap as everywhere else this engine is called
    lastStudyActivityAt: lastStudyActivityAt,
  });
  var nextRec = recommendations.length ? recommendations[0] : null;
  var nextHandler = nextRec ? handlerForTaskType(nextRec.type, { onAssignments:onAssignments, onAITutor:onAITutor, onExamMode:onExamMode, onVoice:onVoice, onStudyPlanner:onStudyPlanner }) : null;
  var nextLabel = nextRec ? missionCtaFor(nextRec.type).label : null;

  var masteryDelta = masteryChange ? masteryChange.avgAfter-masteryChange.avgBefore : null;
  var masteryColor = masteryDelta==null||masteryDelta===0 ? C.muted : masteryDelta>0 ? C.green : C.red;

  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid "+C.border }}>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>🎉 Session Complete</span>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>

        <div style={{ textAlign:"center",marginBottom:20 }}>
          <div style={{ fontSize:52,marginBottom:8 }}>🎉</div>
          <div style={{ fontWeight:800,fontSize:20,color:C.text,marginBottom:4 }}>Nice work!</div>
          <div style={{ fontSize:13,color:C.muted }}>{doneCount} of {STUDY_SESSION_STEPS.length} steps completed</div>
        </div>

        {/* Step recap */}
        <div style={{ display:"flex",gap:8,marginBottom:24 }}>
          {STUDY_SESSION_STEPS.map(function(s){ var r=session.results[s.key]; return(
            <div key={s.key} style={{ flex:1,textAlign:"center",background:C.card,borderRadius:12,padding:"10px 4px",border:"1px solid "+C.border }}>
              <div style={{ fontSize:18,marginBottom:4 }}>{s.icon}</div>
              <div style={{ fontSize:9,fontWeight:700,color:r==="done"?C.green:C.muted }}>{r==="done"?"Done":r==="skipped"?"Skipped":"—"}</div>
            </div>
          );})}
        </div>

        {/* Score */}
        <div style={{ background:C.card,borderRadius:16,padding:18,border:"1px solid "+C.border,marginBottom:14 }}>
          <div style={{ fontSize:11,fontWeight:800,color:C.muted,letterSpacing:1,marginBottom:8,textTransform:"uppercase" }}>Score</div>
          {quizResult ? (
            <div>
              <div style={{ fontSize:28,fontWeight:800,color:C.text }}>{quizResult.score}/{quizResult.totalQuestions}</div>
              <div style={{ fontSize:12,color:C.muted,marginTop:2 }}>{quizResult.percentage}% on {quizResult.course}</div>
            </div>
          ) : <div style={{ fontSize:13,color:C.muted }}>No quiz taken this session.</div>}
        </div>

        {/* Mistakes */}
        <div style={{ background:C.card,borderRadius:16,padding:18,border:"1px solid "+C.border,marginBottom:14 }}>
          <div style={{ fontSize:11,fontWeight:800,color:C.muted,letterSpacing:1,marginBottom:8,textTransform:"uppercase" }}>Mistakes</div>
          {quizResult ? <div style={{ fontSize:28,fontWeight:800,color:mistakes>0?C.red:C.green }}>{mistakes} missed</div> : <div style={{ fontSize:13,color:C.muted }}>—</div>}
        </div>

        {/* Mastery change */}
        <div style={{ background:C.card,borderRadius:16,padding:18,border:"1px solid "+C.border,marginBottom:20 }}>
          <div style={{ fontSize:11,fontWeight:800,color:C.muted,letterSpacing:1,marginBottom:8,textTransform:"uppercase" }}>Mastery Change</div>
          {masteryChange ? (
            <div>
              <div style={{ display:"flex",alignItems:"baseline",gap:8 }}>
                <span style={{ fontSize:28,fontWeight:800,color:C.text }}>{masteryChange.avgBefore}%</span>
                <span style={{ fontSize:16,color:C.muted }}>→</span>
                <span style={{ fontSize:28,fontWeight:800,color:masteryColor }}>{masteryChange.avgAfter}%</span>
                <span style={{ fontSize:13,fontWeight:700,color:masteryColor }}>({masteryDelta>0?"+":""}{masteryDelta})</span>
              </div>
              <div style={{ fontSize:12,color:C.muted,marginTop:6 }}>Across {masteryChange.topicsUpdated} tracked topic{masteryChange.topicsUpdated===1?"":"s"} in {masteryChange.course}</div>
            </div>
          ) : quizResult ? (
            <div style={{ fontSize:13,color:C.muted,lineHeight:1.5 }}>No tracked topics yet for {quizResult.course} — mastery has nothing to update against.</div>
          ) : <div style={{ fontSize:13,color:C.muted }}>Take a quiz to update topic mastery.</div>}
        </div>

        {/* Recommended next step */}
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:11,fontWeight:800,color:C.muted,letterSpacing:1,marginBottom:10,textTransform:"uppercase" }}>Recommended Next Step</div>
          {nextRec ? (
            <div style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)",borderRadius:18,padding:20 }}>
              <div style={{ fontWeight:800,fontSize:16,color:"#fff",marginBottom:6 }}>{nextRec.title}</div>
              <div style={{ fontSize:13,color:"rgba(255,255,255,0.9)",lineHeight:1.6,marginBottom:16 }}>{nextRec.message}</div>
              <button onClick={nextHandler} style={{ background:"#fff",color:"#0A0F1E",border:"none",borderRadius:14,padding:"12px 20px",fontWeight:800,fontSize:14,cursor:"pointer" }}>{nextLabel} →</button>
            </div>
          ) : (
            <div style={{ background:"rgba(52,211,153,0.1)",border:"1px solid rgba(52,211,153,0.3)",borderRadius:16,padding:18 }}>
              <div style={{ fontWeight:700,fontSize:14,color:C.green }}>You're all caught up — nothing urgent right now.</div>
            </div>
          )}
        </div>

        <button onClick={onDone} style={{ width:"100%",background:C.card2,color:C.text,border:"1px solid "+C.border,borderRadius:14,padding:"14px",fontWeight:800,fontSize:15,cursor:"pointer" }}>Done</button>

      </div>
    </div>
  );
}

// ── HOME ──────────────────────────────────────────────────────────────────────
function HomeScreen({ notes, onNote, onVoice, onDraw, onAIWrite, onScan, onChat, onRecordings, onStudyPlanner, onExamMode, onAssignments, onFlashcards, onAITutor, onSearch, plan, user, onNotifications, onProfile, unreadCount, profile }) {
  var [search,setSearch]=useState("");var [filter,setFilter]=useState("All");
  var filters=["All","Lecture","Study","Business","Personal"];
  var filtered=notes.filter(function(n){return(n.title.toLowerCase().includes(search.toLowerCase())||n.course.toLowerCase().includes(search.toLowerCase()))&&(filter==="All"||n.tag===filter);});
  var hour=new Date().getHours();
  var greeting=hour<12?"Good morning":hour<17?"Good afternoon":"Good evening";
  var firstName = user&&user.displayName ? user.displayName.split(" ")[0] : "Student";
  var todayCount = notes.filter(function(n){ var r=formatRelativeDate(n.id); return r==="Just now"||/m ago$/.test(r)||r==="Today"; }).length;
  var studyGoal = 3;
  var lastNote = notes.length ? notes.slice().sort(function(a,b){return (b.id||0)-(a.id||0);})[0] : null;
  var revisionNote = notes.length>1 ? notes.slice().sort(function(a,b){return (a.id||0)-(b.id||0);})[0] : null;
  return(
    <div style={{ flex:1,overflowY:"auto" }}>
      <div style={{ background:"linear-gradient(135deg,#0A0F1E 0%,#1E1B4B 60%,#0A0F1E 100%)",padding:"24px 20px 28px",position:"relative",overflow:"hidden" }}>
        <div style={{ position:"absolute",top:-40,right:-40,width:160,height:160,borderRadius:"50%",background:"rgba(6,182,212,0.07)" }}/>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,position:"relative" }}>
          <div style={{ display:"flex",alignItems:"center",gap:10 }}>
            <div style={{ width:40,height:40,borderRadius:12,overflow:"hidden" }}><img src="/jotting-logo.png" alt="Jotting AI" style={{ width:"100%",height:"100%",objectFit:"cover" }}/></div>
            <span style={{ fontWeight:800,fontSize:20,color:C.text }}>Jotting <span style={{ color:C.cyan }}>AI</span></span>
          </div>
          <div style={{ display:"flex",gap:8 }}>
            <button onClick={onSearch} title="Search everything" style={{ background:"rgba(255,255,255,0.08)",border:"none",borderRadius:10,width:38,height:38,cursor:"pointer",fontSize:17 }}>🔍</button>
            <button onClick={onNotifications} style={{ position:"relative",background:"rgba(255,255,255,0.08)",border:"none",borderRadius:10,width:38,height:38,cursor:"pointer",fontSize:17 }}>🔔{unreadCount>0&&<span style={{ position:"absolute",top:-2,right:-2,background:C.red,color:"#fff",borderRadius:99,minWidth:16,height:16,fontSize:9,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 3px" }}>{unreadCount>9?"9+":unreadCount}</span>}</button>
            <button onClick={onProfile} style={{ width:38,height:38,borderRadius:"50%",overflow:"hidden",background:"linear-gradient(135deg,#06B6D4,#A78BFA)",border:"none",display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,cursor:"pointer",padding:0 }}>
              {user&&user.photoURL?<img src={user.photoURL} alt="u" style={{ width:38,height:38,objectFit:"cover" }}/>:"👤"}
            </button>
          </div>
        </div>
        <p style={{ color:"rgba(255,255,255,0.45)",fontSize:13,margin:"0 0 4px" }}>{greeting} 👋</p>
        <h2 style={{ color:C.text,fontSize:24,fontWeight:800,margin:"0 0 20px",letterSpacing:-0.5 }}>Welcome, <span style={{ color:C.cyan }}>{firstName}</span></h2>
        <div style={{ position:"relative" }}><span style={{ position:"absolute",left:14,top:"50%",transform:"translateY(-50%)" }}>🔍</span><input value={search} onChange={function(e){setSearch(e.target.value);}} placeholder="Search notes, courses..." style={{ width:"100%",padding:"12px 14px 12px 42px",borderRadius:14,border:"1px solid rgba(255,255,255,0.1)",fontSize:14,background:"rgba(255,255,255,0.07)",color:C.text,outline:"none",boxSizing:"border-box" }}/></div>
      </div>
      <div style={{ padding:"20px 20px 100px" }}>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:22 }}>
          {[["📝",notes.length,"Notes"],["🤖","AI","Powered"],["🆓","Free","Speech"]].map(function(item){return<div key={item[2]} style={{ background:C.card,borderRadius:14,padding:"14px 10px",textAlign:"center",border:"1px solid "+C.border }}><div style={{ fontSize:20,marginBottom:4 }}>{item[0]}</div><div style={{ fontWeight:800,fontSize:18,color:C.text }}>{item[1]}</div><div style={{ fontSize:10,color:C.muted,fontWeight:600 }}>{item[2]}</div></div>;}) }
        </div>
        <div style={{ marginBottom:22 }}>
          <p style={{ fontWeight:800,fontSize:16,color:C.text,margin:"0 0 14px" }}>Quick Actions</p>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10 }}>
            {[["🎤","Record\nLecture",C.cyan,onVoice,false],["✨","AI\nWrite",C.purple,onAIWrite,false],["💬","AI\nChat",C.cyan,onChat,false],["📷","Scan\nDoc",C.amber,onScan,false],["🖊️","Draw",C.green,onDraw,false],["📁","My\nRecordings",C.purple,onRecordings,false],["🗓️","Study\nPlanner",C.amber,onStudyPlanner,true],["🎯","Exam\nMode",C.red,onExamMode,true],["📋","Assignments",C.green,onAssignments,false],["🗂️","Flashcards",C.purple,onFlashcards,false],["🎓","AI\nTutor",C.amber,onAITutor,true]].map(function(item){var locked=item[4]&&plan!=="premium";return<button key={item[1]} onClick={item[3]} style={{ position:"relative",background:C.card,border:"1px solid "+item[2]+"30",borderRadius:14,padding:"14px 8px",cursor:"pointer",textAlign:"center" }}>{locked&&<span style={{ position:"absolute",top:6,right:6,fontSize:9,fontWeight:800,color:C.amber,background:"rgba(245,158,11,0.15)",borderRadius:99,padding:"2px 6px" }}>PRO</span>}<div style={{ width:38,height:38,borderRadius:10,background:item[2]+"20",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 8px",fontSize:20 }}>{item[0]}</div><span style={{ fontSize:11,fontWeight:700,color:C.soft,whiteSpace:"pre-line",lineHeight:1.3 }}>{item[1]}</span></button>;}) }
          </div>
        </div>
        <div style={{ marginBottom:22 }}>
          <p style={{ fontWeight:800,fontSize:16,color:C.text,margin:"0 0 14px" }}>Your Day</p>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10 }}>
            <div style={{ background:C.card,borderRadius:16,padding:16,border:"1px solid "+C.border }}>
              <div style={{ fontSize:11,color:C.muted,fontWeight:700,marginBottom:8 }}>🎯 TODAY'S GOAL</div>
              <div style={{ fontWeight:800,fontSize:20,color:C.text,marginBottom:6 }}>{Math.min(todayCount,studyGoal)}/{studyGoal}</div>
              <div style={{ height:6,background:C.card2,borderRadius:99,overflow:"hidden" }}><div style={{ height:"100%",width:Math.min(100,(todayCount/studyGoal)*100)+"%",background:"linear-gradient(90deg,#06B6D4,#A78BFA)",borderRadius:99 }}/></div>
              <div style={{ fontSize:11,color:C.muted,marginTop:6 }}>notes today</div>
            </div>
            <div style={{ background:"linear-gradient(135deg,#F59E0B15,#F59E0B05)",borderRadius:16,padding:16,border:"1px solid #F59E0B30" }}>
              <div style={{ fontSize:11,color:C.muted,fontWeight:700,marginBottom:8 }}>🔥 STUDY STREAK</div>
              <div style={{ fontWeight:800,fontSize:20,color:C.amber,marginBottom:6 }}>{(profile&&profile.streak)||0} day{((profile&&profile.streak)||0)===1?"":"s"}</div>
              <div style={{ fontSize:11,color:C.muted }}>{(profile&&profile.streak)>=3?"Keep it up!":"Use the app daily to build a streak"}</div>
            </div>
            {lastNote && (
              <button onClick={function(){onNote(lastNote);}} style={{ background:C.card,borderRadius:16,padding:16,border:"1px solid "+C.border,textAlign:"left",cursor:"pointer" }}>
                <div style={{ fontSize:11,color:C.muted,fontWeight:700,marginBottom:8 }}>▶️ CONTINUE</div>
                <div style={{ fontWeight:700,fontSize:13,color:C.text,marginBottom:4,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{lastNote.title}</div>
                <div style={{ fontSize:11,color:C.muted }}>{formatRelativeDate(lastNote.id)}</div>
              </button>
            )}
            {revisionNote && (
              <button onClick={function(){onNote(revisionNote);}} style={{ background:C.card,borderRadius:16,padding:16,border:"1px solid "+C.border,textAlign:"left",cursor:"pointer" }}>
                <div style={{ fontSize:11,color:C.muted,fontWeight:700,marginBottom:8 }}>📖 REVISE THIS</div>
                <div style={{ fontWeight:700,fontSize:13,color:C.text,marginBottom:4,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{revisionNote.title}</div>
                <div style={{ fontSize:11,color:C.muted }}>Haven't reviewed in a while</div>
              </button>
            )}
          </div>
        </div>
        <div style={{ display:"flex",gap:8,marginBottom:16,overflowX:"auto",paddingBottom:4 }}>
          {filters.map(function(f){return<button key={f} onClick={function(){setFilter(f);}} style={{ padding:"7px 16px",borderRadius:99,border:"none",background:filter===f?C.cyan:C.card,color:filter===f?"#0A0F1E":C.muted,fontSize:13,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0 }}>{f}</button>;}) }
        </div>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
          <p style={{ fontWeight:800,fontSize:16,color:C.text,margin:0 }}>Recent Notes</p>
          <span style={{ fontSize:12,color:C.muted,fontWeight:600 }}>{filtered.length} notes</span>
        </div>
        {filtered.length===0?<div style={{ textAlign:"center",padding:"40px 20px" }}><div style={{ fontSize:48,marginBottom:12 }}>📝</div><p style={{ color:C.muted,fontSize:15 }}>No notes yet. Tap Voice Note to start!</p></div>
        :filtered.slice(0,5).map(function(note){return<button key={note.id} onClick={function(){onNote(note);}} style={{ width:"100%",background:C.card,border:"1px solid "+note.color+"22",borderRadius:18,padding:16,marginBottom:12,cursor:"pointer",textAlign:"left" }}><div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10 }}><div style={{ display:"flex",alignItems:"center",gap:10 }}><div style={{ width:42,height:42,borderRadius:12,background:note.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,border:"1px solid "+note.color+"30",flexShrink:0 }}>{note.type==="drawing"?"🎨":note.tag==="Lecture"?"📚":note.tag==="Study"?"💡":note.tag==="Business"?"💼":"📝"}</div><div><div style={{ fontWeight:800,fontSize:14,color:C.text,marginBottom:3 }}>{note.title}</div><span style={{ fontSize:11,fontWeight:700,color:note.color,background:note.bg,borderRadius:99,padding:"2px 8px" }}>{note.course}</span></div></div><div style={{ textAlign:"right" }}><div style={{ fontSize:11,color:C.muted,marginBottom:4 }}>{formatRelativeDate(note.id)}</div><span style={{ background:note.bg,borderRadius:99,padding:"2px 8px",fontSize:10,fontWeight:700,color:note.color }}>{note.tag}</span></div></div><p style={{ margin:"0 0 10px",fontSize:13,color:C.muted,lineHeight:1.6,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden" }}>{note.preview}</p><div style={{ display:"flex",alignItems:"center",paddingTop:10,borderTop:"1px solid "+C.border }}><span style={{ fontSize:11,color:C.muted }}>✨ AI features available</span><span style={{ fontSize:11,color:note.color,marginLeft:"auto",fontWeight:700 }}>Open →</span></div></button>;})}
      </div>
    </div>
  );
}

// ── AI CHAT ───────────────────────────────────────────────────────────────────
function AIScreen({ notes, onBack, chatSessions, onSaveSession, onDeleteSession, initialPrefill, initialSend, initialPicker }) {
  var greeting = {role:"ai", text:"Hi! 👋 I'm SAM-X, your AI study assistant. Ask me anything, attach a note to discuss it, or upload a file (image, PDF, TXT, or DOCX) and I'll read it with you."};
  var [activeId, setActiveId] = useState(null);
  var [messages, setMessages] = useState([greeting]);
  var [input, setInput] = useState("");
  var [streaming, setStreaming] = useState(false);
  var [streamingText, setStreamingText] = useState("");
  var [editingIndex, setEditingIndex] = useState(null);
  var [editText, setEditText] = useState("");
  var [errorRetry, setErrorRetry] = useState(null);
  var [copiedIndex, setCopiedIndex] = useState(null);
  var [showPicker, setShowPicker] = useState(false);
  var [pickerSearch, setPickerSearch] = useState("");
  var [pickerMode, setPickerMode] = useState("discuss");
  var [showAttachMenu, setShowAttachMenu] = useState(false);
  var [showHistory, setShowHistory] = useState(false);
  var [historySearch, setHistorySearch] = useState("");
  var [historyTab, setHistoryTab] = useState("chats");
  var [renamingId, setRenamingId] = useState(null);
  var [renameText, setRenameText] = useState("");

  var endRef = useRef(null);
  var abortRef = useRef(null);
  var fileInputRef = useRef(null);
  var inputRef = useRef(null);

  useEffect(function(){ endRef.current && endRef.current.scrollIntoView({behavior:"smooth"}); }, [messages, streamingText]);

  // Ask Jotting (Command Center's AI entry point) seeds a fresh chat with one
  // of three starting points — never a new way of talking to SAM-X, just a
  // programmatic trigger of what a tap already does:
  //   initialPicker: same openPicker(mode) the "📚 Explain a note"/"❓ Quiz me"/
  //     "🗓️ Study plan" suggestion chips below already call.
  //   initialSend: same messages.concat + askGemini() send() already does,
  //     just fired on mount instead of after typing + hitting the send button.
  //   initialPrefill: fills the input box and focuses it — the student still
  //     reviews, edits, and sends it themselves through the normal input bar.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(function(){
    if (initialPicker) { openPicker(initialPicker); return; }
    if (initialSend) { var updated = messages.concat([{role:"user", text:initialSend}]); setMessages(updated); askGemini(updated, false); return; }
    if (initialPrefill) { setInput(initialPrefill); inputRef.current && inputRef.current.focus(); }
  }, []);

  var courseList = Array.from(new Set(notes.map(function(n){return n.course;})));

  var iconBtnStyle = { background:C.card2, border:"none", borderRadius:10, width:36, height:36, color:C.muted, fontSize:16, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" };
  var suggestionChip = { background:C.card2, border:"1px solid "+C.border, borderRadius:99, padding:"9px 14px", color:C.text, fontSize:13, fontWeight:600, cursor:"pointer" };
  var msgActionBtn = { background:"none", border:"none", color:C.muted, fontSize:11, fontWeight:600, cursor:"pointer", padding:"2px 0" };
  var attachMenuItem = { display:"block", width:"100%", textAlign:"left", background:"none", border:"none", padding:"10px 14px", color:C.text, fontSize:14, fontWeight:600, cursor:"pointer", borderRadius:8 };

  function newChat(){ setActiveId(null); setMessages([greeting]); setInput(""); setShowHistory(false); setEditingIndex(null); setErrorRetry(null); }

  function openSession(session){ setActiveId(session.id); setMessages(session.messages); setShowHistory(false); setEditingIndex(null); setErrorRetry(null); }

  function persist(history){
    var sanitized = history.map(function(m){
      if(m.attachment){ var copy={...m}; delete copy.attachment; return copy; }
      return m;
    });
    var id = activeId || ("chat_"+Date.now());
    var existing = chatSessions.find(function(s){return s.id===id;});
    var firstUserMsg = sanitized.find(function(m){return m.role==="user";});
    var title = (existing&&existing.title) || (firstUserMsg ? (firstUserMsg.text.length>40?firstUserMsg.text.slice(0,40)+"…":firstUserMsg.text) : "New chat");
    onSaveSession({ id:id, title:title, messages:sanitized, updatedAt:Date.now(), pinned:existing?!!existing.pinned:false, archived:existing?!!existing.archived:false });
    if(!activeId) setActiveId(id);
  }

  function togglePin(e, session){ e.stopPropagation(); onSaveSession({...session, pinned:!session.pinned}); }
  function toggleArchive(e, session){ e.stopPropagation(); onSaveSession({...session, archived:!session.archived}); if(activeId===session.id) newChat(); }
  function startRename(e, session){ e.stopPropagation(); setRenamingId(session.id); setRenameText(session.title||""); }
  function saveRename(session){ onSaveSession({...session, title:renameText.trim()||"New chat"}); setRenamingId(null); }
  function removeSession(e, id){ e.stopPropagation(); if(!window.confirm("Delete this conversation?")) return; onDeleteSession(id); if(activeId===id) newChat(); }

  async function askGemini(history, isAutoOpener, action){
    setStreaming(true); setStreamingText(""); setErrorRetry(null);
    abortRef.current = new AbortController();
    var contents = history.map(function(m){
      var parts=[];
      if(m.attachment) parts.push({inline_data:{mime_type:m.attachment.mimeType, data:m.attachment.base64}});
      parts.push({text: m.apiText||m.text});
      return { role: m.role==="ai"?"model":"user", parts: parts };
    });
    if(isAutoOpener){
      contents.push({role:"user", parts:[{text:"Give a short, friendly opening — acknowledge what was shared and ask what they'd like help with."}]});
    }
    var sys = "You are SAM-X, a friendly, encouraging AI study assistant built into Jotting AI for a Nigerian university student"+(courseList.length?(" studying "+courseList.join(", ")):"")+". Give natural, structured answers — use headings and bullet points where helpful, explain concepts step-by-step, and ask a clarifying follow-up question when the request is ambiguous. Use Markdown formatting (headings, lists, tables, fenced code blocks, and $...$ or $$...$$ for math) where it helps clarity. Remember and use the whole conversation so far.";
    var currentStreamed = "";
    try{
      var reply = await callGeminiChatStream(contents, sys, function(partial){ currentStreamed=partial; setStreamingText(partial); }, abortRef.current.signal, 1500, action||"chat");
      var next = history.concat([{role:"ai", text:reply}]);
      setMessages(next);
      setStreamingText("");
      persist(next);
    }catch(e){
      if(e && e.name==="AbortError"){
        var next2 = currentStreamed ? history.concat([{role:"ai", text:currentStreamed}]) : history;
        setMessages(next2);
        setStreamingText("");
        if(currentStreamed) persist(next2);
      } else if(e && e.code==="OUT_OF_CREDITS"){
        setStreamingText("");
        triggerUpgradeScreen();
      } else {
        setErrorRetry({ history: history });
      }
    }
    setStreaming(false);
    abortRef.current = null;
  }

  function stopGenerating(){ abortRef.current && abortRef.current.abort(); }
  function retry(){ if(errorRetry){ var h = errorRetry.history; setErrorRetry(null); askGemini(h, false); } }

  async function send(){
    var q = input.trim();
    if(!q || streaming) return;
    setInput("");
    if(inputRef.current) inputRef.current.style.height = "auto";
    var updated = messages.concat([{role:"user", text:q}]);
    setMessages(updated);
    askGemini(updated, false);
  }

  function autoResizeInput(e){
    setInput(e.target.value);
    var el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }

  function startEdit(i){ setEditingIndex(i); setEditText(messages[i].text); }
  function saveEdit(){
    if(!editText.trim()) return;
    var truncated = messages.slice(0, editingIndex);
    var updated = truncated.concat([{role:"user", text:editText.trim()}]);
    setMessages(updated);
    setEditingIndex(null);
    askGemini(updated, false);
  }

  function regenerate(){
    if(streaming || messages.length===0 || messages[messages.length-1].role!=="ai") return;
    var truncated = messages.slice(0,-1);
    setMessages(truncated);
    askGemini(truncated, false);
  }

  function copyMessage(i, text){ navigator.clipboard && navigator.clipboard.writeText(text); setCopiedIndex(i); setTimeout(function(){setCopiedIndex(null);}, 1500); }

  function blobToBase64(blob){
    return new Promise(function(resolve,reject){
      var reader = new FileReader();
      reader.onloadend = function(){ resolve(reader.result.split(",")[1]); };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function handleFileAttach(e){
    var file = e.target.files && e.target.files[0];
    e.target.value = "";
    if(!file) return;
    setShowAttachMenu(false);
    try{
      var msg;
      if(file.type.startsWith("image/") || file.type==="application/pdf"){
        var base64 = await blobToBase64(file);
        msg = { role:"user", text:"📎 Attached: "+file.name, attachment:{mimeType:file.type, base64:base64}, apiText:"I've attached a file named \""+file.name+"\". Please read it and help me with it." };
      } else if(file.name.toLowerCase().endsWith(".docx")){
        var arrayBuffer = await file.arrayBuffer();
        var result = await mammoth.extractRawText({arrayBuffer:arrayBuffer});
        msg = { role:"user", text:"📎 Attached: "+file.name, apiText:"Here is the content of a Word document named \""+file.name+"\":\n\n"+result.value+"\n\nPlease help me with it." };
      } else if(file.type==="text/plain" || file.name.toLowerCase().endsWith(".txt")){
        var text = await file.text();
        msg = { role:"user", text:"📎 Attached: "+file.name, apiText:"Here is the content of a file named \""+file.name+"\":\n\n"+text+"\n\nPlease help me with it." };
      } else {
        alert("That file type isn't supported yet. Try an image, PDF, TXT, or DOCX file.");
        return;
      }
      var updated = messages.concat([msg]);
      setMessages(updated);
      askGemini(updated, true, msg.attachment ? "pdf_analysis" : "chat");
    }catch(err){
      alert("Couldn't read that file — try a different one.");
    }
  }

  function openPicker(mode){ setPickerMode(mode); setShowPicker(true); setShowAttachMenu(false); }

  function attachNote(note, mode){
    setShowPicker(false);
    var prompts = {
      discuss: "Please help me understand it — I'll ask questions about it.",
      flashcards: "Please turn this into a set of flashcards (question on one line, answer on the next) covering the key concepts.",
      studyplan: "Please suggest a study plan for reviewing this material, broken into manageable sessions.",
      quiz: "Please quiz me on this — ask me one question at a time and check my answers as I respond."
    };
    var actionByMode = { discuss:"chat", flashcards:"flashcards", studyplan:"summary", quiz:"quiz" };
    var attachMsg = {
      role:"user",
      text:"📎 Attached note: \""+note.title+"\" ("+(mode==="flashcards"?"flashcards":mode==="studyplan"?"study plan":mode==="quiz"?"quiz me":"discuss")+")",
      apiText:"Here is my lecture note titled \""+note.title+"\" (course: "+note.course+"):\n\n"+note.content+"\n\n"+(prompts[mode]||prompts.discuss)
    };
    var updated = messages.concat([attachMsg]);
    setMessages(updated);
    askGemini(updated, true, actionByMode[mode]||"chat");
  }

  var filteredNotes = notes.filter(function(n){ return n.title.toLowerCase().includes(pickerSearch.toLowerCase())||n.course.toLowerCase().includes(pickerSearch.toLowerCase()); });

  function groupSessions(list){
    var now = new Date();
    var startToday = new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
    var groups = { pinned:[], today:[], yesterday:[], last7:[], last30:[], older:[] };
    list.forEach(function(s){
      if(s.pinned){ groups.pinned.push(s); return; }
      var d = new Date(s.updatedAt||0);
      var startOfThat = new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();
      var diffDays = Math.round((startToday-startOfThat)/86400000);
      if(diffDays<=0) groups.today.push(s);
      else if(diffDays===1) groups.yesterday.push(s);
      else if(diffDays<=7) groups.last7.push(s);
      else if(diffDays<=30) groups.last30.push(s);
      else groups.older.push(s);
    });
    return groups;
  }

  var visibleSessions = chatSessions.filter(function(s){
    if (s.type==="tutor") return false; // keep Tutor sessions out of regular chat history — same collection, own screen
    var matchesSearch = !historySearch || (s.title||"").toLowerCase().includes(historySearch.toLowerCase());
    var matchesTab = historyTab==="archived" ? s.archived : !s.archived;
    return matchesSearch && matchesTab;
  });
  var grouped = groupSessions(visibleSessions);
  var GROUP_LABELS = [["pinned","📌 Pinned"],["today","Today"],["yesterday","Yesterday"],["last7","Previous 7 Days"],["last30","Previous 30 Days"],["older","Older"]];

  return(
    <div style={{ flex:1, display:"flex", flexDirection:"column", background:C.bg, position:"relative" }}>
      <div style={{ background:C.card, padding:"16px 20px", borderBottom:"1px solid "+C.border, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <button onClick={onBack} style={backBtn}>←</button>
          <div style={{ width:40,height:40,borderRadius:12,overflow:"hidden" }}><img src="/samx-logo.png" alt="SAM-X AI" style={{ width:"100%",height:"100%",objectFit:"cover" }}/></div>
          <div><div style={{ fontWeight:800,fontSize:16,color:C.text }}>SAM-X AI</div><div style={{ fontSize:11,color:C.green,fontWeight:600 }}>AI Study Assistant</div></div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={function(){setShowHistory(true);}} title="Chat history" style={iconBtnStyle}>🕐</button>
          <button onClick={newChat} title="New chat" style={iconBtnStyle}>✏️</button>
        </div>
      </div>

      <div style={{ flex:1, overflowY:"auto", padding:"16px 16px 8px" }}>
        {messages.length===1 && !streaming && (
          <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginBottom:16 }}>
            <button onClick={function(){openPicker("discuss");}} style={suggestionChip}>📚 Explain a note</button>
            <button onClick={function(){openPicker("quiz");}} style={suggestionChip}>❓ Quiz me</button>
            <button onClick={function(){openPicker("flashcards");}} style={suggestionChip}>🗂️ Make flashcards</button>
            <button onClick={function(){openPicker("studyplan");}} style={suggestionChip}>🗓️ Study plan</button>
          </div>
        )}
        {messages.map(function(m,i){
          var isEditing = editingIndex===i;
          return (
            <div key={i} style={{ display:"flex", flexDirection:"column", alignItems:m.role==="user"?"flex-end":"flex-start", marginBottom:16, animation:"fadeIn 0.25s ease" }}>
              <div style={{ display:"flex", justifyContent:m.role==="user"?"flex-end":"flex-start", width:"100%" }}>
                {m.role==="ai" && <div style={{ width:32,height:32,borderRadius:10,overflow:"hidden",marginRight:8,flexShrink:0,marginTop:2 }}><img src="/samx-logo.png" alt="SAM-X AI" style={{ width:"100%",height:"100%",objectFit:"cover" }}/></div>}
                <div style={{ maxWidth:"82%" }}>
                  {isEditing ? (
                    <div style={{ background:C.card2, borderRadius:14, padding:10, border:"1px solid "+C.cyan }}>
                      <textarea value={editText} onChange={function(e){setEditText(e.target.value);}} style={{ width:"100%", minHeight:60, background:"transparent", border:"none", color:C.text, fontSize:14, outline:"none", resize:"none", fontFamily:"inherit" }}/>
                      <div style={{ display:"flex", gap:8, justifyContent:"flex-end", marginTop:6 }}>
                        <button onClick={function(){setEditingIndex(null);}} style={{ background:"none", border:"1px solid "+C.border, borderRadius:8, padding:"6px 12px", color:C.muted, fontSize:12, cursor:"pointer" }}>Cancel</button>
                        <button onClick={saveEdit} style={{ background:C.cyan, border:"none", borderRadius:8, padding:"6px 12px", color:"#0A0F1E", fontWeight:700, fontSize:12, cursor:"pointer" }}>Save & Resend</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ background:m.role==="user"?"linear-gradient(135deg,#06B6D4,#A78BFA)":C.card2, borderRadius:m.role==="user"?"18px 18px 4px 18px":"18px 18px 18px 4px", padding:"12px 16px", border:m.role==="ai"?"1px solid "+C.border:"none" }}>
                      {m.role==="ai"
                        ? <div className="samx-md" style={{ fontSize:14, color:C.text, lineHeight:1.7 }}><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{m.text}</ReactMarkdown></div>
                        : <p style={{ margin:0, fontSize:14, color:"#fff", lineHeight:1.7, whiteSpace:"pre-wrap" }}>{m.text}</p>}
                    </div>
                  )}
                </div>
              </div>
              {!isEditing && (
                <div style={{ display:"flex", gap:12, marginTop:4, marginLeft:m.role==="ai"?40:0 }}>
                  {m.role==="ai" && <button onClick={function(){copyMessage(i, m.text);}} style={msgActionBtn}>{copiedIndex===i?"✓ Copied":"📋 Copy"}</button>}
                  {m.role==="user" && <button onClick={function(){startEdit(i);}} style={msgActionBtn}>✏️ Edit</button>}
                  {m.role==="ai" && i===messages.length-1 && !streaming && <button onClick={regenerate} style={msgActionBtn}>🔄 Regenerate</button>}
                </div>
              )}
            </div>
          );
        })}
        {streaming && (
          <div style={{ display:"flex", marginBottom:16 }}>
            <div style={{ width:32,height:32,borderRadius:10,overflow:"hidden",marginRight:8,flexShrink:0,marginTop:2 }}><img src="/samx-logo.png" alt="SAM-X AI" style={{ width:"100%",height:"100%",objectFit:"cover" }}/></div>
            <div style={{ maxWidth:"82%", background:C.card2, borderRadius:"18px 18px 18px 4px", padding:"12px 16px", border:"1px solid "+C.border }}>
              {streamingText
                ? <div className="samx-md" style={{ fontSize:14, color:C.text, lineHeight:1.7 }}><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{streamingText}</ReactMarkdown></div>
                : <div style={{ display:"flex", gap:4 }}>{[0,1,2].map(function(i){return <div key={i} style={{ width:8,height:8,borderRadius:"50%",background:C.cyan,animation:"dot "+(0.5+i*0.15)+"s ease-in-out infinite alternate" }}/>;})}</div>}
            </div>
          </div>
        )}
        {errorRetry && (
          <div style={{ background:"rgba(248,113,113,0.1)", border:"1px solid rgba(248,113,113,0.3)", borderRadius:12, padding:14, marginBottom:16, display:"flex", justifyContent:"space-between", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:13, color:C.red }}>⚠️ Couldn't reach SAM-X. Check your connection.</span>
            <button onClick={retry} style={{ background:C.red, border:"none", borderRadius:8, padding:"6px 14px", color:"#fff", fontWeight:700, fontSize:12, cursor:"pointer", flexShrink:0 }}>Retry</button>
          </div>
        )}
        <div ref={endRef}/>
      </div>

      <div style={{ padding:"12px 16px 16px", background:C.card2, borderTop:"1px solid "+C.border, position:"relative" }}>
        {streaming ? (
          <button onClick={stopGenerating} style={{ width:"100%", background:"rgba(248,113,113,0.15)", color:C.red, border:"2px solid "+C.red+"40", borderRadius:14, padding:"13px", fontWeight:800, fontSize:14, cursor:"pointer" }}>⏹ Stop Generating</button>
        ) : (
          <div style={{ display:"flex", gap:8, alignItems:"flex-end" }}>
            <button onClick={function(){setShowAttachMenu(function(s){return !s;});}} title="Attach" style={{ width:48,height:48,borderRadius:14,background:C.card,border:"1px solid "+C.border,cursor:"pointer",fontSize:20,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,color:C.text }}>+</button>
            <textarea ref={inputRef} value={input} onChange={autoResizeInput} onKeyDown={function(e){if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); send(); }}} placeholder="Ask anything..." rows={1} style={{ flex:1,padding:"12px 16px",borderRadius:18,border:"1px solid "+C.border,fontSize:14,background:C.bg,color:C.text,outline:"none",minWidth:0,resize:"none",overflowY:"auto",maxHeight:120,lineHeight:1.5,fontFamily:"inherit" }}/>
            <button onClick={send} style={{ width:48,height:48,borderRadius:14,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",border:"none",cursor:"pointer",fontSize:20,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>↑</button>
          </div>
        )}
        {showAttachMenu && (
          <div style={{ position:"absolute", bottom:76, left:16, background:C.card, border:"1px solid "+C.border, borderRadius:14, padding:8, boxShadow:"0 8px 24px rgba(0,0,0,0.4)", zIndex:25 }}>
            <button onClick={function(){setShowAttachMenu(false); openPicker("discuss");}} style={attachMenuItem}>📝 Attach a note</button>
            <button onClick={function(){fileInputRef.current&&fileInputRef.current.click();}} style={attachMenuItem}>📎 Attach a file</button>
          </div>
        )}
        <input ref={fileInputRef} type="file" accept="image/*,.pdf,.txt,.docx" onChange={handleFileAttach} style={{display:"none"}}/>
      </div>

      {showPicker && (
        <div style={{ position:"absolute", inset:0, background:"rgba(10,15,30,0.85)", display:"flex", flexDirection:"column", justifyContent:"flex-end", zIndex:20 }} onClick={function(){setShowPicker(false);}}>
          <div style={{ background:C.card, borderRadius:"20px 20px 0 0", padding:20, maxHeight:"70vh", display:"flex", flexDirection:"column" }} onClick={function(e){e.stopPropagation();}}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
              <span style={{ fontWeight:800, fontSize:16, color:C.text }}>{pickerMode==="flashcards"?"Make flashcards from...":pickerMode==="studyplan"?"Study plan from...":pickerMode==="quiz"?"Quiz me on...":"Attach a note"}</span>
              <button onClick={function(){setShowPicker(false);}} style={{ background:"none", border:"none", color:C.muted, fontSize:18, cursor:"pointer" }}>✕</button>
            </div>
            <input value={pickerSearch} onChange={function(e){setPickerSearch(e.target.value);}} placeholder="Search notes, courses..." style={{ width:"100%", padding:"11px 14px", borderRadius:12, border:"1px solid "+C.border, fontSize:13, background:C.bg, color:C.text, outline:"none", marginBottom:14, boxSizing:"border-box" }}/>
            <div style={{ overflowY:"auto" }}>
              {filteredNotes.length===0 && <div style={{ textAlign:"center", color:C.muted, fontSize:13, padding:"20px 0" }}>No notes match.</div>}
              {filteredNotes.map(function(n){return(
                <button key={n.id} onClick={function(){attachNote(n, pickerMode);}} style={{ width:"100%", textAlign:"left", background:C.card2, border:"1px solid "+C.border, borderRadius:12, padding:"12px 14px", marginBottom:8, cursor:"pointer" }}>
                  <div style={{ fontWeight:700, fontSize:14, color:C.text, marginBottom:3 }}>{n.title}</div>
                  <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                    <span style={{ fontSize:10, color:n.color, fontWeight:700, background:n.bg, borderRadius:99, padding:"2px 8px" }}>{n.course}</span>
                    <span style={{ fontSize:11, color:C.muted }}>{formatRelativeDate(n.id)}</span>
                  </div>
                </button>
              );})}
            </div>
          </div>
        </div>
      )}

      {showHistory && (
        <div style={{ position:"absolute", inset:0, background:"rgba(10,15,30,0.85)", display:"flex", flexDirection:"column", justifyContent:"flex-end", zIndex:20 }} onClick={function(){setShowHistory(false);}}>
          <div style={{ background:C.card, borderRadius:"20px 20px 0 0", padding:20, maxHeight:"80vh", display:"flex", flexDirection:"column" }} onClick={function(e){e.stopPropagation();}}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
              <span style={{ fontWeight:800, fontSize:16, color:C.text }}>Chat History</span>
              <button onClick={function(){setShowHistory(false);}} style={{ background:"none", border:"none", color:C.muted, fontSize:18, cursor:"pointer" }}>✕</button>
            </div>
            <button onClick={newChat} style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8, background:"linear-gradient(135deg,#06B6D4,#A78BFA)", border:"none", borderRadius:12, padding:"12px 16px", color:"#fff", fontWeight:700, fontSize:14, cursor:"pointer", marginBottom:12 }}>✏️ New Chat</button>
            <input value={historySearch} onChange={function(e){setHistorySearch(e.target.value);}} placeholder="Search conversations..." style={{ width:"100%", padding:"10px 14px", borderRadius:12, border:"1px solid "+C.border, fontSize:13, background:C.bg, color:C.text, outline:"none", marginBottom:10, boxSizing:"border-box" }}/>
            <div style={{ display:"flex", gap:8, marginBottom:14 }}>
              <button onClick={function(){setHistoryTab("chats");}} style={{ flex:1, padding:"8px", borderRadius:10, border:"none", background:historyTab==="chats"?C.cyan:C.card2, color:historyTab==="chats"?"#0A0F1E":C.muted, fontWeight:700, fontSize:12, cursor:"pointer" }}>Chats</button>
              <button onClick={function(){setHistoryTab("archived");}} style={{ flex:1, padding:"8px", borderRadius:10, border:"none", background:historyTab==="archived"?C.cyan:C.card2, color:historyTab==="archived"?"#0A0F1E":C.muted, fontWeight:700, fontSize:12, cursor:"pointer" }}>Archived</button>
            </div>
            <div style={{ overflowY:"auto" }}>
              {visibleSessions.length===0 && <div style={{ textAlign:"center", color:C.muted, fontSize:13, padding:"20px 0" }}>{historyTab==="archived"?"No archived chats.":"No conversations yet."}</div>}
              {GROUP_LABELS.map(function(g){
                var list = grouped[g[0]];
                if(!list || list.length===0) return null;
                return (
                  <div key={g[0]} style={{ marginBottom:14 }}>
                    <div style={{ fontSize:11, fontWeight:700, color:C.muted, marginBottom:8, textTransform:"uppercase", letterSpacing:0.5 }}>{g[1]}</div>
                    {list.map(function(s){
                      var lastMsg = s.messages && s.messages.length ? s.messages[s.messages.length-1] : null;
                      var isRenaming = renamingId===s.id;
                      return (
                        <div key={s.id} onClick={function(){if(!isRenaming) openSession(s);}} style={{ background:activeId===s.id?C.cyan+"15":C.card2, border:"1px solid "+(activeId===s.id?C.cyan+"50":C.border), borderRadius:12, padding:"12px 14px", marginBottom:8, cursor:isRenaming?"default":"pointer" }}>
                          {isRenaming ? (
                            <div style={{ display:"flex", gap:8 }}>
                              <input autoFocus value={renameText} onChange={function(e){setRenameText(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")saveRename(s);}} onClick={function(e){e.stopPropagation();}} style={{ flex:1, background:C.bg, border:"1px solid "+C.cyan, borderRadius:8, padding:"6px 10px", color:C.text, fontSize:13, outline:"none" }}/>
                              <button onClick={function(e){e.stopPropagation();saveRename(s);}} style={{ background:C.cyan, border:"none", borderRadius:8, padding:"6px 12px", color:"#0A0F1E", fontWeight:700, fontSize:12, cursor:"pointer" }}>Save</button>
                            </div>
                          ) : (
                            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:10 }}>
                              <div style={{ minWidth:0, flex:1 }}>
                                <div style={{ fontWeight:700, fontSize:14, color:C.text, marginBottom:3, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{s.title||"New chat"}</div>
                                {lastMsg && <div style={{ fontSize:12, color:C.muted, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{lastMsg.text}</div>}
                                <div style={{ fontSize:10, color:C.muted, marginTop:4 }}>{formatRelativeDate(s.updatedAt)}</div>
                              </div>
                              <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                                <span onClick={function(e){togglePin(e,s);}} style={{ fontSize:15, cursor:"pointer", opacity:s.pinned?1:0.4 }}>📌</span>
                                <span onClick={function(e){startRename(e,s);}} style={{ fontSize:15, cursor:"pointer", opacity:0.6 }}>✏️</span>
                                <span onClick={function(e){toggleArchive(e,s);}} style={{ fontSize:15, cursor:"pointer", opacity:0.6 }}>{s.archived?"📤":"🗄️"}</span>
                                <span onClick={function(e){removeSession(e,s.id);}} style={{ fontSize:15, cursor:"pointer", color:C.red }}>🗑️</span>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── STUDY PLANNER (Premium) ───────────────────────────────────────────────────
// Turns a student's own notes + an exam date into a day-by-day revision schedule.
// Billed at the cheap "summary" text rate — only short note excerpts go into the
// prompt, never full transcripts, to keep this affordable even for a big library.
function StudyPlannerScreen({ notes, onBack, plan, onUpgrade, onSaveNote, onSavePlan, courses, onCreateCourse }) {
  // Widened to include real Course records; selectedCourses still holds plain
  // display NAMES (unchanged — the notes filter and the AI prompt text below
  // both key off note.course, which isn't migrated), so nothing about the
  // existing generation logic changes. courseIds (below, computed only at
  // save time) is the new, additive part: whichever selected names happen to
  // match a real Course get their real id captured too, so studyPlans records
  // going forward carry a real courseId for CourseOverviewScreen/StudyVaultScreen
  // to join on, instead of the free-text-name-only shape they had before.
  var courseList = Array.from(new Set((courses||[]).map(function(c){return c.code||c.title;}).filter(Boolean).concat(notes.map(function(n){return n.course;}))));
  var [selectedCourses, setSelectedCourses] = useState([]);
  var [examDate, setExamDate] = useState("");
  var [hoursPerDay, setHoursPerDay] = useState(2);
  var [loading, setLoading] = useState(false);
  var [planText, setPlanText] = useState("");
  var [error, setError] = useState("");
  var [saved, setSaved] = useState(false);
  var [showAddCourse, setShowAddCourse] = useState(false);
  var [newCourseDraft, setNewCourseDraft] = useState("");

  function toggleCourse(c){ setSelectedCourses(function(s){ return s.includes(c) ? s.filter(function(x){return x!==c;}) : [...s,c]; }); }
  async function submitNewCourse(){
    var code = newCourseDraft.trim().toUpperCase();
    if (!code) return;
    if (!courseList.includes(code)) await onCreateCourse(code);
    toggleCourse(code);
    setNewCourseDraft(""); setShowAddCourse(false);
  }
  function courseIdsFor(names){
    return names.map(function(name){
      var match = (courses||[]).find(function(c){ return (c.code||c.title)===name; });
      return match ? match.id : null;
    }).filter(function(id){ return id!=null; });
  }

  async function generatePlan(){
    if(!examDate){ setError("Pick your exam date first."); return; }
    if(selectedCourses.length===0){ setError("Select at least one course."); return; }
    setError(""); setLoading(true); setPlanText(""); setSaved(false);
    try{
      var today = new Date(); today.setHours(0,0,0,0);
      var exam = new Date(examDate+"T00:00:00");
      var daysLeft = Math.max(1, Math.round((exam.getTime()-today.getTime())/86400000));
      var relevantNotes = notes.filter(function(n){ return selectedCourses.includes(n.course); });
      var outline = relevantNotes.map(function(n){ return "- ["+n.course+"] "+n.title+": "+n.content.slice(0,200).replace(/\s+/g," "); }).join("\n");
      var prompt = "You are building a revision timetable for a Nigerian university student.\n"+
        "Exam date: "+examDate+" ("+daysLeft+" day"+(daysLeft===1?"":"s")+" from today).\n"+
        "Courses to cover: "+selectedCourses.join(", ")+".\n"+
        "Study time available: about "+hoursPerDay+" hour"+(hoursPerDay===1?"":"s")+" per day.\n\n"+
        "Here are short excerpts from the student's own notes to base the plan on:\n"+(outline||"(no note excerpts available — plan generally around the course names)")+"\n\n"+
        "Create a day-by-day study plan from today until the exam date. For each day, give a short heading with the date and a bullet list of specific topics/notes to review with rough time allocations adding up to about the daily time available. Group revision by course, prioritize weaker/earlier topics first, and build in one light review day right before the exam. Return only the plan in Markdown, no preamble.";
      var res = await callGeminiText(prompt, 2200, "summary");
      setPlanText(res);
      if (onSavePlan) onSavePlan(res, {courses:selectedCourses, courseIds:courseIdsFor(selectedCourses), examDate:examDate, hoursPerDay:hoursPerDay});
    }catch(e){
      if(e.code==="OUT_OF_CREDITS"){ onUpgrade(); } else { setError("Couldn't reach SAM-X — check your connection and try again."); }
    }
    setLoading(false);
  }

  function saveToLibrary(){
    if(!planText.trim()) return;
    onSaveNote({ id:Date.now(), title:"Study Plan - "+examDate, course:selectedCourses[0]||"General", color:C.amber, bg:"rgba(245,158,11,0.12)", tag:"Study", words:planText.split(" ").length, preview:planText.replace(/[#*_>-]/g,"").slice(0,100), content:planText });
    setSaved(true);
  }

  if(!planAtLeast(plan, "pro")){
    return (
      <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
        <div style={{ background:C.card,padding:"16px 20px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid "+C.border }}>
          <button onClick={onBack} style={backBtn}>←</button>
          <span style={{ fontWeight:800,fontSize:16,color:C.text }}>🗓️ Study Planner</span>
        </div>
        <div style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,textAlign:"center" }}>
          <div style={{ fontSize:56,marginBottom:16 }}>🗓️</div>
          <div style={{ fontWeight:800,fontSize:18,color:C.text,marginBottom:8 }}>Study Planner is a Pro feature</div>
          <p style={{ color:C.muted,fontSize:13,lineHeight:1.6,marginBottom:24,maxWidth:280 }}>Turn your notes and exam date into a day-by-day revision timetable, built by SAM-X.</p>
          <button onClick={onUpgrade} style={{ background:"linear-gradient(135deg,#F59E0B,#EF4444)",color:"#fff",border:"none",borderRadius:14,padding:"14px 32px",fontWeight:800,fontSize:15,cursor:"pointer" }}>🚀 Upgrade to Pro</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>🗓️ Study Planner</span>
        {planText?<button onClick={saveToLibrary} disabled={saved} style={{ background:saved?C.card2:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:saved?C.muted:"#fff",border:"none",borderRadius:10,padding:"8px 16px",fontWeight:800,fontSize:13,cursor:saved?"default":"pointer" }}>{saved?"✓ Saved":"Save"}</button>:<div style={{width:64}}/>}
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        {!planText && (
          <div>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
              <span style={{ fontWeight:800,fontSize:14,color:C.text }}>Which courses are you preparing for?</span>
              <button onClick={function(){setShowAddCourse(function(s){return !s;});}} style={{ background:C.amber+"20",border:"1px solid "+C.amber+"40",borderRadius:8,padding:"5px 12px",color:C.amber,fontSize:12,fontWeight:700,cursor:"pointer" }}>+ Add Course</button>
            </div>
            {showAddCourse&&(<div style={{ background:C.card2,borderRadius:14,padding:14,marginBottom:14,border:"1px solid "+C.amber+"30" }}><div style={{ display:"flex",gap:8 }}><input value={newCourseDraft} onChange={function(e){setNewCourseDraft(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")submitNewCourse();}} placeholder="e.g. BIO 201" style={{ flex:1,padding:"10px 14px",borderRadius:10,border:"1px solid "+C.border,background:C.bg,color:C.text,outline:"none",fontSize:14 }}/><button onClick={submitNewCourse} style={{ background:C.amber,border:"none",borderRadius:10,padding:"10px 16px",color:"#0A0F1E",fontWeight:800,cursor:"pointer" }}>Add</button><button onClick={function(){setShowAddCourse(false);}} style={{ background:C.card,border:"1px solid "+C.border,borderRadius:10,padding:"10px 12px",color:C.muted,cursor:"pointer" }}>X</button></div></div>)}
            {courseList.length===0 ? <p style={{ color:C.muted,fontSize:13 }}>Add a course above, or save a few notes so SAM-X has something to plan from.</p> : (
              <div style={{ display:"flex",gap:8,flexWrap:"wrap",marginBottom:20 }}>
                {courseList.map(function(c){return<button key={c} onClick={function(){toggleCourse(c);}} style={{ padding:"7px 14px",borderRadius:99,border:"2px solid",borderColor:selectedCourses.includes(c)?C.amber:C.border,background:selectedCourses.includes(c)?C.amber:C.card,color:selectedCourses.includes(c)?"#0A0F1E":C.muted,fontSize:12,fontWeight:700,cursor:"pointer" }}>{c}</button>;})}
              </div>
            )}
            <div style={{ marginBottom:16 }}>
              <label style={{ fontSize:12,fontWeight:700,color:C.soft,display:"block",marginBottom:6 }}>EXAM DATE</label>
              <input type="date" value={examDate} onChange={function(e){setExamDate(e.target.value);}} style={{ width:"100%",padding:"13px 16px",borderRadius:12,border:"1px solid "+C.border,fontSize:14,background:C.card,color:C.text,outline:"none",boxSizing:"border-box" }}/>
            </div>
            <div style={{ marginBottom:20 }}>
              <label style={{ fontSize:12,fontWeight:700,color:C.soft,display:"block",marginBottom:6 }}>HOURS AVAILABLE PER DAY</label>
              <div style={{ display:"flex",gap:8 }}>{[1,2,3,4,5].map(function(h){return<button key={h} onClick={function(){setHoursPerDay(h);}} style={{ flex:1,padding:"10px",borderRadius:10,border:"2px solid",borderColor:hoursPerDay===h?C.amber:C.border,background:hoursPerDay===h?C.amber:C.card,color:hoursPerDay===h?"#0A0F1E":C.muted,fontSize:13,fontWeight:700,cursor:"pointer" }}>{h}h</button>;})}</div>
            </div>
            {error && <div style={{ background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:13,color:C.red,fontWeight:600 }}>⚠️ {error}</div>}
            <button onClick={generatePlan} disabled={loading||courseList.length===0} style={{ width:"100%",background:loading?"#374151":"linear-gradient(135deg,#F59E0B,#EF4444)",color:"#fff",border:"none",borderRadius:14,padding:"15px",fontWeight:800,fontSize:15,cursor:loading?"not-allowed":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10 }}>{loading?(<><div style={{ width:18,height:18,borderRadius:"50%",border:"2px solid rgba(255,255,255,0.3)",borderTop:"2px solid #fff",animation:"spin 1s linear infinite" }}/>Building your plan...</>):"🗓️ Generate Study Plan"}</button>
          </div>
        )}
        {planText && (
          <div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.amber+"40" }}>
            <div className="samx-md" style={{ fontSize:14,color:"#CBD5E1",lineHeight:1.9 }}><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{planText}</ReactMarkdown></div>
            <button onClick={function(){setPlanText("");setError("");setSaved(false);}} style={{ marginTop:14,background:"none",border:"1px solid "+C.border,borderRadius:10,padding:"8px 16px",color:C.cyan,fontWeight:700,fontSize:13,cursor:"pointer" }}>↺ Start over</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── EXAM MODE (Premium) ──────────────────────────────────────────────────────
// A stricter, timed practice-test experience: unlike "Quiz Me" (instant per-question
// feedback), Exam Mode withholds all feedback until the end and enforces a countdown,
// closer to real exam conditions. Reuses the same MCQ-JSON contract as NoteDetail's
// Quiz Me so both features share one prompt shape and are billed the same "quiz" rate.
function ExamModeScreen({ notes, onBack, plan, onUpgrade, onRecordResult, onSaveQuiz }) {
  var courseList = Array.from(new Set(notes.map(function(n){return n.course;})));
  var [phase, setPhase] = useState("setup"); // setup | loading | exam | results
  var [course, setCourse] = useState(courseList[0]||"");
  var [numQuestions, setNumQuestions] = useState(10);
  var [minutes, setMinutes] = useState(15);
  var [questions, setQuestions] = useState([]);
  var [answers, setAnswers] = useState([]); // index-aligned with questions, null until answered
  var [qIdx, setQIdx] = useState(0);
  var [secondsLeft, setSecondsLeft] = useState(0);
  var [error, setError] = useState("");
  var timerRef = useRef(null);

  function fmtClock(s){ s=Math.max(0,s); return String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0"); }

  useEffect(function(){ return function(){ clearInterval(timerRef.current); }; }, []);

  function submitExam(){
    clearInterval(timerRef.current);
    var finalScore = questions.reduce(function(sum,q,i){ return sum + (answers[i]===q.answer?1:0); }, 0);
    if (onRecordResult && questions.length) {
      onRecordResult({ course:course, score:finalScore, totalQuestions:questions.length, percentage:Math.round((finalScore/questions.length)*100) });
    }
    setPhase("results");
  }

  async function startExam(){
    if(!course){ setError("Select a course first."); return; }
    var relevantNotes = notes.filter(function(n){ return n.course===course; });
    if(relevantNotes.length===0){ setError("No notes found for this course yet."); return; }
    setError(""); setPhase("loading");
    try{
      var combined = relevantNotes.map(function(n){return n.title+":\n"+n.content;}).join("\n\n").slice(0,9000);
      var raw = await callGeminiText("Create "+numQuestions+" multiple choice exam questions covering these lecture notes for the course \""+course+"\". Mix easy, medium and hard questions. Return ONLY a JSON array: [{\"question\":\"...\",\"options\":[\"A\",\"B\",\"C\",\"D\"],\"answer\":0}] NOTES:\n\n"+combined, 2400, "quiz");
      var parsed = parseQuizQuestions(raw);
      setQuestions(parsed);
      if (onSaveQuiz) onSaveQuiz(parsed, {course:course, source:"exam"});
      setAnswers(new Array(parsed.length).fill(null));
      setQIdx(0);
      setSecondsLeft(minutes*60);
      setPhase("exam");
      timerRef.current = setInterval(function(){
        setSecondsLeft(function(s){
          if(s<=1){ clearInterval(timerRef.current); submitExam(); return 0; }
          return s-1;
        });
      }, 1000);
    }catch(e){
      setPhase("setup");
      if(e.code==="OUT_OF_CREDITS"){ onUpgrade(); } else { setError(e.message||"Couldn't build the exam — check your connection and try again."); }
    }
  }

  function selectAnswer(i){ setAnswers(function(a){ var next=a.slice(); next[qIdx]=i; return next; }); }
  function next(){ if(qIdx<questions.length-1) setQIdx(qIdx+1); }
  function prev(){ if(qIdx>0) setQIdx(qIdx-1); }
  function restart(){ setPhase("setup"); setQuestions([]); setAnswers([]); setQIdx(0); }

  var score = questions.reduce(function(sum,q,i){ return sum + (answers[i]===q.answer?1:0); }, 0);

  if(plan!=="premium"){
    return (
      <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
        <div style={{ background:C.card,padding:"16px 20px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid "+C.border }}>
          <button onClick={onBack} style={backBtn}>←</button>
          <span style={{ fontWeight:800,fontSize:16,color:C.text }}>🎯 Exam Mode</span>
        </div>
        <div style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,textAlign:"center" }}>
          <div style={{ fontSize:56,marginBottom:16 }}>🎯</div>
          <div style={{ fontWeight:800,fontSize:18,color:C.text,marginBottom:8 }}>Exam Mode is a Premium feature</div>
          <p style={{ color:C.muted,fontSize:13,lineHeight:1.6,marginBottom:24,maxWidth:280 }}>Timed, exam-style practice tests generated from your own notes — results only revealed at the end.</p>
          <button onClick={onUpgrade} style={{ background:"linear-gradient(135deg,#F59E0B,#EF4444)",color:"#fff",border:"none",borderRadius:14,padding:"14px 32px",fontWeight:800,fontSize:15,cursor:"pointer" }}>🚀 Upgrade to Premium</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <button onClick={phase==="exam"?function(){if(window.confirm("Leave the exam? Your progress will be lost.")) onBack();}:onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>🎯 Exam Mode</span>
        {phase==="exam" ? <span style={{ fontFamily:"monospace",fontWeight:800,fontSize:16,color:secondsLeft<60?C.red:C.text }}>⏱ {fmtClock(secondsLeft)}</span> : <div style={{width:36}}/>}
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        {phase==="setup" && (
          <div>
            <div style={{ fontWeight:800,fontSize:14,color:C.text,marginBottom:8 }}>Which course is this exam on?</div>
            {courseList.length===0 ? <p style={{ color:C.muted,fontSize:13 }}>Save a few notes first so SAM-X has something to test you on.</p> : (
              <div style={{ display:"flex",gap:8,flexWrap:"wrap",marginBottom:20 }}>
                {courseList.map(function(c){return<button key={c} onClick={function(){setCourse(c);}} style={{ padding:"7px 14px",borderRadius:99,border:"2px solid",borderColor:course===c?C.red:C.border,background:course===c?C.red:C.card,color:course===c?"#fff":C.muted,fontSize:12,fontWeight:700,cursor:"pointer" }}>{c}</button>;})}
              </div>
            )}
            <div style={{ marginBottom:16 }}>
              <label style={{ fontSize:12,fontWeight:700,color:C.soft,display:"block",marginBottom:6 }}>NUMBER OF QUESTIONS</label>
              <div style={{ display:"flex",gap:8 }}>{[10,15,20].map(function(n){return<button key={n} onClick={function(){setNumQuestions(n);}} style={{ flex:1,padding:"10px",borderRadius:10,border:"2px solid",borderColor:numQuestions===n?C.red:C.border,background:numQuestions===n?C.red:C.card,color:numQuestions===n?"#fff":C.muted,fontSize:13,fontWeight:700,cursor:"pointer" }}>{n}</button>;})}</div>
            </div>
            <div style={{ marginBottom:20 }}>
              <label style={{ fontSize:12,fontWeight:700,color:C.soft,display:"block",marginBottom:6 }}>TIME LIMIT</label>
              <div style={{ display:"flex",gap:8 }}>{[10,15,20,30].map(function(m){return<button key={m} onClick={function(){setMinutes(m);}} style={{ flex:1,padding:"10px",borderRadius:10,border:"2px solid",borderColor:minutes===m?C.red:C.border,background:minutes===m?C.red:C.card,color:minutes===m?"#fff":C.muted,fontSize:13,fontWeight:700,cursor:"pointer" }}>{m}m</button>;})}</div>
            </div>
            {error && <div style={{ background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:13,color:C.red,fontWeight:600 }}>⚠️ {error}</div>}
            <div style={{ background:"rgba(248,113,113,0.06)",border:"1px solid "+C.red+"30",borderRadius:12,padding:"12px 14px",marginBottom:16,fontSize:12,color:C.muted,lineHeight:1.6 }}>⚠️ Once you start, answers and scores are only revealed at the end — just like the real thing.</div>
            <button onClick={startExam} disabled={courseList.length===0} style={{ width:"100%",background:"linear-gradient(135deg,#F59E0B,#EF4444)",color:"#fff",border:"none",borderRadius:14,padding:"15px",fontWeight:800,fontSize:15,cursor:"pointer" }}>🎯 Start Exam</button>
          </div>
        )}
        {phase==="loading" && (
          <div style={{ textAlign:"center",padding:"60px 20px" }}><div style={{ fontSize:48,animation:"spin 2s linear infinite" }}>🎯</div><p style={{ color:C.muted,marginTop:16 }}>Building your exam...</p></div>
        )}
        {phase==="exam" && questions.length>0 && (
          <div>
            <div style={{ display:"flex",justifyContent:"space-between",marginBottom:8 }}><span style={{ fontSize:13,color:C.muted }}>Question {qIdx+1}/{questions.length}</span><span style={{ fontSize:13,color:C.muted }}>{answers.filter(function(a){return a!==null;}).length} answered</span></div>
            <div style={{ height:4,background:C.border,borderRadius:2,marginBottom:20 }}><div style={{ height:4,background:C.red,borderRadius:2,width:((qIdx+1)/questions.length*100)+"%",transition:"width 0.3s" }}/></div>
            <div style={{ background:C.card,borderRadius:16,padding:20,marginBottom:16,border:"1px solid "+C.border }}><p style={{ margin:0,fontSize:16,fontWeight:600,color:C.text,lineHeight:1.6 }}>{questions[qIdx].question}</p></div>
            {questions[qIdx].options.map(function(opt,i){ var isSel=answers[qIdx]===i; return<button key={i} onClick={function(){selectAnswer(i);}} style={{ width:"100%",textAlign:"left",background:isSel?C.red+"20":C.card,border:"2px solid "+(isSel?C.red:C.border),borderRadius:12,padding:"13px 16px",marginBottom:10,fontSize:14,color:isSel?C.red:C.text,cursor:"pointer",fontWeight:isSel?700:500,display:"flex",gap:10,fontFamily:"inherit" }}><span style={{opacity:0.5}}>{String.fromCharCode(65+i)}.</span>{opt}</button>;})}
            <div style={{ display:"flex",gap:10,marginTop:16 }}>
              <button onClick={prev} disabled={qIdx===0} style={{ flex:1,background:C.card2,color:qIdx===0?C.muted:C.text,border:"1px solid "+C.border,borderRadius:12,padding:"13px",fontWeight:700,cursor:qIdx===0?"default":"pointer" }}>← Back</button>
              {qIdx<questions.length-1
                ? <button onClick={next} style={{ flex:1,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:12,padding:"13px",fontWeight:800,cursor:"pointer" }}>Next →</button>
                : <button onClick={function(){if(window.confirm("Submit your exam now?")) submitExam();}} style={{ flex:1,background:"linear-gradient(135deg,#F59E0B,#EF4444)",color:"#fff",border:"none",borderRadius:12,padding:"13px",fontWeight:800,cursor:"pointer" }}>Submit Exam</button>}
            </div>
          </div>
        )}
        {phase==="results" && (
          <div>
            <div style={{ textAlign:"center",padding:"20px 20px 30px" }}>
              <div style={{ fontSize:56,marginBottom:12 }}>{score/questions.length>=0.8?"🏆":score/questions.length>=0.5?"📖":"💪"}</div>
              <div style={{ fontSize:40,fontWeight:800,color:C.text }}>{score}/{questions.length}</div>
              <p style={{ color:C.muted,marginTop:6 }}>{Math.round((score/questions.length)*100)}% correct{score/questions.length>=0.8?" — excellent!":score/questions.length>=0.5?" — solid effort!":" — keep revising!"}</p>
              <button onClick={restart} style={{ marginTop:16,background:"linear-gradient(135deg,#F59E0B,#EF4444)",color:"#fff",border:"none",borderRadius:14,padding:"12px 28px",fontWeight:800,fontSize:14,cursor:"pointer" }}>Try Another Exam</button>
            </div>
            <div style={{ fontWeight:800,fontSize:14,color:C.text,marginBottom:12 }}>Review your answers</div>
            {questions.map(function(q,i){
              var yourAns = answers[i];
              var correct = yourAns===q.answer;
              return (
                <div key={i} style={{ background:C.card,borderRadius:14,padding:16,marginBottom:10,border:"1px solid "+(correct?"#34D39940":"#F8717140") }}>
                  <div style={{ fontSize:13,fontWeight:700,color:C.text,marginBottom:8 }}>{i+1}. {q.question}</div>
                  {q.options.map(function(opt,oi){
                    var isCorrectOpt = oi===q.answer;
                    var isYourOpt = oi===yourAns;
                    var bg = isCorrectOpt?"rgba(52,211,153,0.12)":isYourOpt?"rgba(248,113,113,0.12)":"transparent";
                    var col = isCorrectOpt?C.green:isYourOpt?C.red:C.muted;
                    return <div key={oi} style={{ padding:"7px 10px",borderRadius:8,background:bg,color:col,fontSize:12,fontWeight:isCorrectOpt||isYourOpt?700:500,marginBottom:4 }}>{String.fromCharCode(65+oi)}. {opt}{isCorrectOpt?" ✓":isYourOpt?" ✗":""}</div>;
                  })}
                  {yourAns===null && <div style={{ fontSize:11,color:C.amber,marginTop:4 }}>Not answered</div>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── ASSIGNMENTS ───────────────────────────────────────────────────────────────
// Free-tier feature (no AI cost) — a simple due-date tracker so "Assignment Reminder"
// in Settings has something real to check against instead of sitting as Coming Soon.
function AssignmentsScreen({ assignments, notes, onBack, onAdd, onUpdate, onToggle, onDelete, openAssignmentId, openInAddMode, courses }) {
  // Widened to include real Course records alongside the existing note/
  // assignment-derived names — nothing that already worked disappears, real
  // courses just become pickable here too. Assignments themselves still store
  // a plain course name (not a migration target this pass), so this is a
  // consistency improvement only, not a data-model change.
  var courseList = Array.from(new Set((courses||[]).map(function(c){return c.code||c.title;}).filter(Boolean).concat(notes.map(function(n){return n.course;})).concat(assignments.map(function(a){return a.course;})).filter(Boolean)));
  var [showForm,setShowForm]=useState(false);
  var [editingId,setEditingId]=useState(null);
  var [fTitle,setFTitle]=useState("");
  var [fCourse,setFCourse]=useState("General");
  var [fDueDate,setFDueDate]=useState("");
  var [fNotes,setFNotes]=useState("");
  var [error,setError]=useState("");

  function openAdd(){ setEditingId(null); setFTitle(""); setFCourse("General"); setFDueDate(""); setFNotes(""); setError(""); setShowForm(true); }
  function openEdit(a){ setEditingId(a.id); setFTitle(a.title); setFCourse(a.course||"General"); setFDueDate(a.dueDate||""); setFNotes(a.notes||""); setError(""); setShowForm(true); }
  // Jumped here from a unified-search result — open straight to editing that assignment
  // instead of the plain list. Runs once per incoming id (deliberately no `assignments`
  // in the deps — re-running on every list change would re-open the form after the
  // student closes it).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(function(){
    if (!openAssignmentId) return;
    var match = assignments.find(function(a){ return a.id===openAssignmentId; });
    if (match) openEdit(match);
  }, [openAssignmentId]);
  // Jumped here from the Command Center + menu's "Add Assignment" — open
  // straight to the add form instead of the plain list. Same shape as the
  // openAssignmentId effect above; App resets the flag on the way out (see
  // AssignmentsScreen's onBack) so it doesn't re-trigger on a later, normal visit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(function(){
    if (openInAddMode) openAdd();
  }, [openInAddMode]);
  function submit(){
    if(!fTitle.trim()){ setError("Give the assignment a title."); return; }
    if(!fDueDate){ setError("Pick a due date."); return; }
    var payload = { title:fTitle.trim(), course:fCourse.trim()||"General", dueDate:fDueDate, notes:fNotes.trim() };
    if(editingId){ onUpdate(editingId, payload); } else { onAdd(payload); }
    setShowForm(false);
  }
  function fmtDue(dateStr){ var d=new Date(dateStr+"T00:00:00"); return d.toLocaleDateString(undefined,{ weekday:"short", month:"short", day:"numeric" }); }
  function daysUntil(dateStr){ var today=new Date(); today.setHours(0,0,0,0); var d=new Date(dateStr+"T00:00:00"); return Math.round((d.getTime()-today.getTime())/86400000); }

  var active = assignments.filter(function(a){return !a.completed;}).slice().sort(function(a,b){return (a.dueDate||"").localeCompare(b.dueDate||"");});
  var completed = assignments.filter(function(a){return a.completed;}).slice().sort(function(a,b){return (b.dueDate||"").localeCompare(a.dueDate||"");});
  var overdue = active.filter(function(a){return daysUntil(a.dueDate)<0;});
  var dueSoon = active.filter(function(a){var d=daysUntil(a.dueDate); return d>=0&&d<=3;});
  var upcoming = active.filter(function(a){return daysUntil(a.dueDate)>3;});

  function Group({ title, color, items }){
    if(items.length===0) return null;
    return(
      <div style={{ marginBottom:20 }}>
        <div style={{ fontSize:12,fontWeight:800,color:color,marginBottom:10,textTransform:"uppercase",letterSpacing:0.5 }}>{title} ({items.length})</div>
        {items.map(function(a){
          var d = daysUntil(a.dueDate);
          var dueColor = d<0?C.red:d<=1?C.amber:C.muted;
          return(
            <div key={a.id} style={{ background:C.card,borderRadius:14,padding:14,marginBottom:10,border:"1px solid "+C.border,display:"flex",gap:12,alignItems:"flex-start" }}>
              <button onClick={function(){onToggle(a.id,!a.completed);}} style={{ width:24,height:24,borderRadius:"50%",border:"2px solid "+(a.completed?C.green:C.border),background:a.completed?C.green:"transparent",flexShrink:0,marginTop:2,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:"#0A0F1E",fontSize:12,fontWeight:800 }}>{a.completed?"✓":""}</button>
              <div style={{ flex:1,minWidth:0,cursor:"pointer" }} onClick={function(){openEdit(a);}}>
                <div style={{ fontWeight:700,fontSize:14,color:a.completed?C.muted:C.text,textDecoration:a.completed?"line-through":"none" }}>{a.title}</div>
                <div style={{ display:"flex",gap:8,alignItems:"center",marginTop:5,flexWrap:"wrap" }}>
                  <span style={{ fontSize:10,color:C.purple,fontWeight:700,background:"rgba(167,139,250,0.12)",borderRadius:99,padding:"2px 8px" }}>{a.course}</span>
                  <span style={{ fontSize:11,color:dueColor,fontWeight:700 }}>{d<0?"Overdue — ":""}{fmtDue(a.dueDate)}</span>
                </div>
                {a.notes&&<div style={{ fontSize:12,color:C.muted,marginTop:6,lineHeight:1.5 }}>{a.notes}</div>}
              </div>
              <button onClick={function(){if(window.confirm("Delete \""+a.title+"\"?"))onDelete(a.id);}} style={{ background:"rgba(248,113,113,0.12)",border:"none",borderRadius:8,width:28,height:28,cursor:"pointer",fontSize:12,flexShrink:0 }}>🗑</button>
            </div>
          );
        })}
      </div>
    );
  }

  return(
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column",position:"relative" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>📋 Assignments</span>
        <button onClick={openAdd} style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:10,padding:"8px 14px",fontWeight:800,fontSize:13,cursor:"pointer" }}>+ Add</button>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        {assignments.length===0 ? (
          <div style={{ textAlign:"center",padding:"60px 20px" }}>
            <div style={{ fontSize:48,marginBottom:12 }}>📋</div>
            <div style={{ fontWeight:800,fontSize:16,color:C.text,marginBottom:6 }}>No assignments yet</div>
            <div style={{ fontSize:13,color:C.muted,marginBottom:20 }}>Add one so Jotting AI can remind you before it's due.</div>
            <button onClick={openAdd} style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:14,padding:"12px 28px",fontWeight:800,fontSize:14,cursor:"pointer" }}>+ Add Assignment</button>
          </div>
        ) : (
          <div>
            <Group title="Overdue" color={C.red} items={overdue}/>
            <Group title="Due Soon" color={C.amber} items={dueSoon}/>
            <Group title="Upcoming" color={C.cyan} items={upcoming}/>
            <Group title="Completed" color={C.green} items={completed}/>
          </div>
        )}
      </div>
      {showForm&&(
        <div style={{ position:"absolute",inset:0,background:"rgba(10,15,30,0.85)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:30 }} onClick={function(){setShowForm(false);}}>
          <div style={{ background:C.card,borderRadius:"20px 20px 0 0",padding:20,width:"100%",maxHeight:"85vh",overflowY:"auto",boxSizing:"border-box" }} onClick={function(e){e.stopPropagation();}}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
              <span style={{ fontWeight:800,fontSize:16,color:C.text }}>{editingId?"Edit Assignment":"New Assignment"}</span>
              <button onClick={function(){setShowForm(false);}} style={{ background:"none",border:"none",color:C.muted,fontSize:18,cursor:"pointer" }}>✕</button>
            </div>
            <input value={fTitle} onChange={function(e){setFTitle(e.target.value);}} placeholder="Assignment title..." style={{ width:"100%",padding:"13px 16px",borderRadius:12,border:"1px solid "+C.border,fontSize:15,fontWeight:700,background:C.bg,color:C.text,outline:"none",marginBottom:12,boxSizing:"border-box" }}/>
            {courseList.length>0&&<div style={{ display:"flex",gap:8,flexWrap:"wrap",marginBottom:10 }}>{courseList.map(function(c){return<button key={c} onClick={function(){setFCourse(c);}} style={{ padding:"6px 12px",borderRadius:99,border:"2px solid",borderColor:fCourse===c?C.purple:C.border,background:fCourse===c?C.purple:C.card2,color:fCourse===c?"#0A0F1E":C.muted,fontSize:11,fontWeight:700,cursor:"pointer" }}>{c}</button>;})}</div>}
            <input value={fCourse} onChange={function(e){setFCourse(e.target.value);}} placeholder="Course (e.g. MTH 101)" style={{ width:"100%",padding:"11px 14px",borderRadius:12,border:"1px solid "+C.border,fontSize:13,background:C.bg,color:C.text,outline:"none",marginBottom:12,boxSizing:"border-box" }}/>
            <label style={{ fontSize:12,fontWeight:700,color:C.soft,display:"block",marginBottom:6 }}>DUE DATE</label>
            <input type="date" value={fDueDate} onChange={function(e){setFDueDate(e.target.value);}} style={{ width:"100%",padding:"11px 14px",borderRadius:12,border:"1px solid "+C.border,fontSize:14,background:C.bg,color:C.text,outline:"none",marginBottom:12,boxSizing:"border-box" }}/>
            <textarea value={fNotes} onChange={function(e){setFNotes(e.target.value);}} placeholder="Notes (optional)..." style={{ width:"100%",minHeight:70,padding:"11px 14px",borderRadius:12,border:"1px solid "+C.border,fontSize:13,background:C.bg,color:C.text,outline:"none",marginBottom:12,resize:"none",fontFamily:"inherit",boxSizing:"border-box" }}/>
            {error&&<div style={{ background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:13,color:C.red,fontWeight:600 }}>⚠️ {error}</div>}
            <div style={{ display:"flex",gap:10 }}>
              {editingId&&<button onClick={function(){if(window.confirm("Delete this assignment?")){onDelete(editingId);setShowForm(false);}}} style={{ background:"rgba(248,113,113,0.1)",border:"1px solid "+C.red+"40",borderRadius:14,padding:"13px 16px",color:C.red,fontWeight:700,fontSize:14,cursor:"pointer" }}>🗑</button>}
              <button onClick={submit} style={{ flex:1,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:14,padding:"13px",fontWeight:800,fontSize:15,cursor:"pointer" }}>{editingId?"Save Changes":"Add Assignment"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── FLASHCARDS ────────────────────────────────────────────────────────────────
// Free feature (uses AI credits like AI Chat/Scan Doc/Quiz Me already do, no Premium
// gate) — generates a real flip-card deck from one note, with a self-graded pass and
// a "review just what I missed" loop, instead of flashcards only existing buried
// inside an AI Chat attachment.
function FlashcardsScreen({ notes, onBack, onSaveNote, onSaveDeck }) {
  var [phase, setPhase] = useState("setup"); // setup | loading | study | done
  var [search, setSearch] = useState("");
  var [selectedNote, setSelectedNote] = useState(null);
  var [numCards, setNumCards] = useState(12);
  var [deck, setDeck] = useState([]);     // original full generated set — untouched, lets "Study Again" fully restart
  var [queue, setQueue] = useState([]);   // the cards currently being studied (a subset during a review pass)
  var [results, setResults] = useState([]); // aligned with queue: true=got it, false=still learning, null=unanswered
  var [idx, setIdx] = useState(0);
  var [flipped, setFlipped] = useState(false);
  var [error, setError] = useState("");
  var [saved, setSaved] = useState(false);
  // Set only when a generated deck came back smaller than numCards (still a
  // valid deck, just short of the request) — separate from `error` because
  // `error` is only rendered on the setup screen, and this needs to be visible
  // once the student is already in the study view.
  var [deckNotice, setDeckNotice] = useState("");

  var filteredNotes = notes.filter(function(n){ return n.title.toLowerCase().includes(search.toLowerCase())||n.course.toLowerCase().includes(search.toLowerCase()); });

  async function generate(){
    if (!selectedNote) { setError("Pick a note first."); return; }
    setError(""); setDeckNotice(""); setPhase("loading"); setSaved(false);
    try{
      var raw = await callGeminiText(
        "Create EXACTLY "+numCards+" flashcards from the following lecture note titled \""+selectedNote.title+"\" (course: "+selectedNote.course+"). Each card should test one distinct concept, term, or fact — a short question or term on the front, a concise clear answer or definition on the back (1-2 sentences max). You must generate all "+numCards+" cards — do not stop early or summarize instead of completing the full set. Return ONLY a JSON array of exactly "+numCards+" objects, no preamble: [{\"front\":\"...\",\"back\":\"...\"}]\n\nNOTE:\n"+selectedNote.content,
        flashcardMaxTokens(numCards), "flashcards"
      );
      var parsed = parseFlashcards(raw);
      setDeck(parsed); setQueue(parsed); setResults(new Array(parsed.length).fill(null));
      setIdx(0); setFlipped(false);
      setPhase("study");
      if (onSaveDeck) onSaveDeck(parsed, selectedNote);
      if (parsed.length < numCards) {
        // Not a hard error — a smaller-but-fully-valid deck is still usable, so
        // it's shown rather than discarded. This is now a rare "the model came
        // up short" case, not the routine outcome the flat 1800-token cap caused.
        setDeckNotice("Got "+parsed.length+" of the "+numCards+" cards you asked for — you can study this deck or try generating again.");
      }
    }catch(e){
      setPhase("setup");
      if (e.code==="OUT_OF_CREDITS") { triggerUpgradeScreen(); } else { setError(e.message || "Couldn't build the deck — check your connection and try again."); }
    }
  }

  function markAndNext(knewIt){
    var nextResults = results.slice(); nextResults[idx] = knewIt;
    setResults(nextResults);
    if (idx+1 < queue.length) { setIdx(idx+1); setFlipped(false); }
    else { setPhase("done"); }
  }
  function reviewMissed(){
    var missed = queue.filter(function(c,i){ return results[i]===false; });
    setQueue(missed); setResults(new Array(missed.length).fill(null));
    setIdx(0); setFlipped(false); setPhase("study");
  }
  function studyAgain(){
    setQueue(deck); setResults(new Array(deck.length).fill(null));
    setIdx(0); setFlipped(false); setPhase("study");
  }
  function startOver(){ setPhase("setup"); setSelectedNote(null); setDeck([]); setQueue([]); setResults([]); setError(""); setDeckNotice(""); setSaved(false); }
  function saveDeckAsNote(){
    var content = deck.map(function(c,i){ return "**Q"+(i+1)+":** "+c.front+"\n\n**A:** "+c.back; }).join("\n\n---\n\n");
    onSaveNote({ id:Date.now(), title:"Flashcards - "+selectedNote.title, course:selectedNote.course, color:C.purple, bg:"rgba(167,139,250,0.12)", tag:"Study", words:content.split(" ").length, preview:"🗂️ "+deck.length+" flashcards", content:content });
    setSaved(true);
  }

  var known = results.filter(function(r){return r===true;}).length;
  var missedCount = results.filter(function(r){return r===false;}).length;

  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <button onClick={phase==="study"?startOver:onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>🗂️ Flashcards</span>
        {(phase==="study"||phase==="done")
          ? <button onClick={saveDeckAsNote} disabled={saved} style={{ background:saved?C.card2:"linear-gradient(135deg,#A78BFA,#06B6D4)",color:saved?C.muted:"#fff",border:"none",borderRadius:10,padding:"8px 14px",fontWeight:800,fontSize:13,cursor:saved?"default":"pointer" }}>{saved?"✓ Saved":"Save"}</button>
          : <div style={{width:52}}/>}
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20,display:"flex",flexDirection:"column" }}>

        {phase==="setup" && (
          <div>
            <div style={{ fontWeight:800,fontSize:14,color:C.text,marginBottom:8 }}>Which note should SAM-X build flashcards from?</div>
            <input value={search} onChange={function(e){setSearch(e.target.value);}} placeholder="Search notes, courses..." style={{ width:"100%",padding:"11px 14px",borderRadius:12,border:"1px solid "+C.border,fontSize:13,background:C.card,color:C.text,outline:"none",marginBottom:14,boxSizing:"border-box" }}/>
            {filteredNotes.length===0 ? (
              <p style={{ color:C.muted,fontSize:13,textAlign:"center",padding:"20px 0" }}>{notes.length===0?"Save a few notes first so SAM-X has something to work from.":"No notes match."}</p>
            ) : (
              <div style={{ marginBottom:20,maxHeight:280,overflowY:"auto" }}>
                {filteredNotes.map(function(n){ var isSel=selectedNote&&selectedNote.id===n.id; return(
                  <button key={n.id} onClick={function(){setSelectedNote(n);setError("");}} style={{ width:"100%",textAlign:"left",background:isSel?C.purple+"15":C.card,border:"2px solid "+(isSel?C.purple:C.border),borderRadius:12,padding:"12px 14px",marginBottom:8,cursor:"pointer" }}>
                    <div style={{ fontWeight:700,fontSize:14,color:C.text,marginBottom:3 }}>{n.title}</div>
                    <div style={{ display:"flex",gap:8,alignItems:"center" }}>
                      <span style={{ fontSize:10,color:n.color||C.purple,fontWeight:700,background:n.bg||"rgba(167,139,250,0.12)",borderRadius:99,padding:"2px 8px" }}>{n.course}</span>
                      <span style={{ fontSize:11,color:C.muted }}>{formatRelativeDate(n.id)}</span>
                    </div>
                  </button>
                );})}
              </div>
            )}
            <div style={{ marginBottom:20 }}>
              <label style={{ fontSize:12,fontWeight:700,color:C.soft,display:"block",marginBottom:6 }}>NUMBER OF CARDS</label>
              <div style={{ display:"flex",gap:8 }}>{[8,12,15,20,30].map(function(n){return<button key={n} onClick={function(){setNumCards(n);}} style={{ flex:1,padding:"10px",borderRadius:10,border:"2px solid",borderColor:numCards===n?C.purple:C.border,background:numCards===n?C.purple:C.card,color:numCards===n?"#fff":C.muted,fontSize:13,fontWeight:700,cursor:"pointer" }}>{n}</button>;})}</div>
            </div>
            {error && <div style={{ background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:13,color:C.red,fontWeight:600 }}>⚠️ {error}</div>}
            <button onClick={generate} disabled={!selectedNote} style={{ width:"100%",background:selectedNote?"linear-gradient(135deg,#A78BFA,#06B6D4)":"#374151",color:"#fff",border:"none",borderRadius:14,padding:"15px",fontWeight:800,fontSize:15,cursor:selectedNote?"pointer":"default" }}>🗂️ Generate Flashcards</button>
          </div>
        )}

        {phase==="loading" && (
          <div style={{ textAlign:"center",padding:"60px 20px" }}><div style={{ fontSize:48,animation:"spin 2s linear infinite" }}>🗂️</div><p style={{ color:C.muted,marginTop:16 }}>Building your deck...</p></div>
        )}

        {phase==="study" && queue.length>0 && (
          <div style={{ flex:1,display:"flex",flexDirection:"column" }}>
            <div style={{ display:"flex",justifyContent:"space-between",marginBottom:14 }}>
              <span style={{ fontSize:13,color:C.muted }}>Card {idx+1}/{queue.length}</span>
              <span style={{ fontSize:13,color:C.muted }}>{results.filter(function(r){return r!==null;}).length} answered</span>
            </div>
            <div style={{ height:4,background:C.border,borderRadius:2,marginBottom:24 }}><div style={{ height:4,background:C.purple,borderRadius:2,width:((idx+1)/queue.length*100)+"%",transition:"width 0.3s" }}/></div>
            {deckNotice && idx===0 && !flipped && <div style={{ background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:12,color:C.amber,fontWeight:600 }}>⚠️ {deckNotice}</div>}
            <div style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",perspective:1000 }} onClick={function(){setFlipped(!flipped);}}>
              <div style={{ width:"100%",maxWidth:340,height:220,position:"relative",cursor:"pointer" }}>
                <div style={{ position:"relative",width:"100%",height:"100%",transition:"transform 0.5s",transformStyle:"preserve-3d",transform:flipped?"rotateY(180deg)":"rotateY(0deg)" }}>
                  <div style={{ position:"absolute",inset:0,backfaceVisibility:"hidden",background:"linear-gradient(135deg,#A78BFA25,#06B6D425)",border:"2px solid "+C.purple+"50",borderRadius:20,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,textAlign:"center" }}>
                    <span style={{ fontSize:10,fontWeight:800,color:C.purple,letterSpacing:1,marginBottom:12 }}>QUESTION</span>
                    <span style={{ fontSize:17,fontWeight:700,color:C.text,lineHeight:1.5 }}>{queue[idx].front}</span>
                    <span style={{ fontSize:11,color:C.muted,marginTop:16 }}>Tap to reveal</span>
                  </div>
                  <div style={{ position:"absolute",inset:0,backfaceVisibility:"hidden",background:C.card,border:"2px solid "+C.cyan+"50",borderRadius:20,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,textAlign:"center",transform:"rotateY(180deg)" }}>
                    <span style={{ fontSize:10,fontWeight:800,color:C.cyan,letterSpacing:1,marginBottom:12 }}>ANSWER</span>
                    <span style={{ fontSize:15,color:C.text,lineHeight:1.6 }}>{queue[idx].back}</span>
                  </div>
                </div>
              </div>
            </div>
            <div style={{ display:"flex",gap:10,marginTop:24 }}>
              <button onClick={function(){markAndNext(false);}} disabled={!flipped} style={{ flex:1,background:flipped?"rgba(248,113,113,0.15)":C.card2,color:flipped?C.red:C.muted,border:"2px solid "+(flipped?C.red+"40":C.border),borderRadius:14,padding:"14px",fontWeight:800,fontSize:14,cursor:flipped?"pointer":"default" }}>😅 Still Learning</button>
              <button onClick={function(){markAndNext(true);}} disabled={!flipped} style={{ flex:1,background:flipped?"rgba(52,211,153,0.15)":C.card2,color:flipped?C.green:C.muted,border:"2px solid "+(flipped?C.green+"40":C.border),borderRadius:14,padding:"14px",fontWeight:800,fontSize:14,cursor:flipped?"pointer":"default" }}>✅ Got It</button>
            </div>
          </div>
        )}

        {phase==="done" && (
          <div style={{ textAlign:"center",padding:"20px 0" }}>
            <div style={{ fontSize:56,marginBottom:12 }}>{known===queue.length?"🏆":known/queue.length>=0.5?"📖":"💪"}</div>
            <div style={{ fontSize:40,fontWeight:800,color:C.text }}>{known}/{queue.length}</div>
            <p style={{ color:C.muted,marginTop:6,marginBottom:24 }}>marked "Got It"{missedCount>0?" — "+missedCount+" to review":""}</p>
            <div style={{ display:"flex",flexDirection:"column",gap:10,maxWidth:300,margin:"0 auto" }}>
              {missedCount>0 && <button onClick={reviewMissed} style={{ background:"linear-gradient(135deg,#A78BFA,#06B6D4)",color:"#fff",border:"none",borderRadius:14,padding:"13px",fontWeight:800,fontSize:14,cursor:"pointer" }}>🔁 Review Missed ({missedCount})</button>}
              <button onClick={studyAgain} style={{ background:C.card2,color:C.text,border:"1px solid "+C.border,borderRadius:14,padding:"13px",fontWeight:700,fontSize:14,cursor:"pointer" }}>🔄 Study Full Deck Again</button>
              <button onClick={startOver} style={{ background:"none",color:C.muted,border:"none",padding:"10px",fontWeight:700,fontSize:13,cursor:"pointer" }}>Pick a different note</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── ADVANCED AI TUTOR (Premium) ─────────────────────────────────────────────────
// Genuinely different from regular AI Chat, not a reskin: three Socratic-style
// tutoring modes that guide rather than just answer — teaching a concept step by
// step, walking through a problem with hints instead of the final answer up front,
// or probing understanding with follow-up questions. Session-only (like Study
// Planner/Exam Mode) rather than persisted — starting fresh each visit keeps this
// screen self-contained instead of needing new chat-history schema/UI.
function AITutorScreen({ notes, onBack, plan, onUpgrade, sessions, onSaveSession, onDeleteSession }) {
  var MODES = {
    explain: { label:"🧑‍🏫 Explain This", desc:"Teaches a concept step by step, checking your understanding before moving on.", color:C.cyan },
    problem: { label:"🧩 Work a Problem", desc:"Guides you through solving it with hints — won't just hand you the final answer.", color:C.purple },
    check:   { label:"🎯 Check Understanding", desc:"Quizzes you with probing follow-ups to see if you can really reason about it.", color:C.amber },
  };
  var [phase, setPhase] = useState("setup"); // setup | chat
  var [mode, setMode] = useState("explain");
  var [source, setSource] = useState("note"); // note | custom
  var [search, setSearch] = useState("");
  var [topicNote, setTopicNote] = useState(null);
  var [customTopic, setCustomTopic] = useState("");
  var [messages, setMessages] = useState([]);
  var [input, setInput] = useState("");
  var [streaming, setStreaming] = useState(false);
  var [streamingText, setStreamingText] = useState("");
  var [errorRetry, setErrorRetry] = useState(null);
  var [activeId, setActiveId] = useState(null); // Firestore doc id once this session has been saved at least once
  var [showHistory, setShowHistory] = useState(false);
  var endRef = useRef(null);
  var abortRef = useRef(null);

  useEffect(function(){ endRef.current && endRef.current.scrollIntoView({behavior:"smooth"}); }, [messages, streamingText]);

  var tutorSessions = sessions.filter(function(s){ return s.type==="tutor"; }).sort(function(a,b){ return (b.updatedAt||0)-(a.updatedAt||0); });
  var filteredNotes = notes.filter(function(n){ return n.title.toLowerCase().includes(search.toLowerCase())||n.course.toLowerCase().includes(search.toLowerCase()); });
  var topicLabel = source==="note" ? (topicNote?topicNote.title:"") : customTopic.trim();
  var canStart = topicLabel.length>0;

  function systemPromptFor(){
    var base = "You are SAM-X operating in Tutor Mode for a Nigerian university student, teaching \""+topicLabel+"\". ";
    var byMode = {
      explain: "Explain this concept step by step using the Socratic method: teach one piece at a time, ask a short check-in question before moving to the next part, and adapt your pace to how the student responds. Never dump the whole explanation in one message — keep each turn short and interactive.",
      problem: "Guide the student through solving a problem on this topic. Don't give the final answer up front — ask leading questions, offer hints, and let them attempt each step themselves. Confirm their reasoning before advancing. Only reveal the full solution if they explicitly ask for it or get stuck after a couple of hints.",
      check: "Quiz the student's understanding of this topic with probing follow-up questions that test real reasoning, not just recall. Give constructive feedback after each answer and gently correct misunderstandings instead of just marking them wrong.",
    };
    var contextNote = source==="note" && topicNote ? "\n\nHere is the student's own note on this topic (course: "+topicNote.course+") to ground your teaching in what they've actually been taught:\n"+topicNote.content.slice(0,4000) : "";
    return base + byMode[mode] + " Use Markdown formatting where it helps clarity." + contextNote;
  }

  // Upserts this session to Firestore (via the same chats collection AI Chat uses,
  // tagged type:"tutor" so the two histories never mix) — called after every AI reply,
  // same "save as you go" pattern AIScreen already uses for regular chat sessions.
  function persist(history){
    var id = activeId || ("tutor_"+Date.now());
    var title = MODES[mode].label.replace(/^\S+\s/,"")+": "+topicLabel; // strip the leading emoji for a cleaner title
    onSaveSession({
      id: id, type:"tutor", mode:mode, topicLabel:topicLabel,
      topicNoteId: (source==="note" && topicNote) ? topicNote.id : null,
      title: title, messages: history, updatedAt: Date.now(),
    });
    if (!activeId) setActiveId(id);
  }

  async function runTurn(history, isOpener){
    setStreaming(true); setStreamingText(""); setErrorRetry(null);
    abortRef.current = new AbortController();
    var contents = history.map(function(m){ return { role: m.role==="ai"?"model":"user", parts:[{text:m.text}] }; });
    if (isOpener) contents.push({ role:"user", parts:[{text:"Begin the session — greet me briefly and kick off the first step."}] });
    var acc = "";
    try{
      var reply = await callGeminiChatStream(contents, systemPromptFor(), function(partial){ acc=partial; setStreamingText(partial); }, abortRef.current.signal, 1000, "chat");
      var next = history.concat([{role:"ai", text:reply}]);
      setMessages(next); setStreamingText("");
      persist(next);
    }catch(e){
      if (e && e.name==="AbortError") {
        var next2 = acc ? history.concat([{role:"ai", text:acc}]) : history;
        setMessages(next2); setStreamingText("");
        if (acc) persist(next2);
      } else if (e && e.code==="OUT_OF_CREDITS") {
        setStreamingText(""); onUpgrade();
      } else {
        setErrorRetry({ history:history, isOpener:isOpener });
      }
    }
    setStreaming(false); abortRef.current=null;
  }

  function startSession(){ setActiveId(null); setMessages([]); setPhase("chat"); runTurn([], true); }
  function endSession(){ if (streaming) abortRef.current && abortRef.current.abort(); setPhase("setup"); setMessages([]); setActiveId(null); setTopicNote(null); setCustomTopic(""); }
  function resumeSession(s){
    setActiveId(s.id); setMode(s.mode||"explain"); setSource(s.topicNoteId?"note":"custom");
    setTopicNote(s.topicNoteId ? (notes.find(function(n){return n.id===s.topicNoteId;})||null) : null);
    setCustomTopic(s.topicNoteId ? "" : (s.topicLabel||""));
    setMessages(s.messages||[]); setShowHistory(false); setErrorRetry(null); setPhase("chat");
  }
  function removeSession(e, id){ e.stopPropagation(); if(!window.confirm("Delete this tutoring session?")) return; onDeleteSession(id); if (activeId===id) endSession(); }
  function send(){
    var q = input.trim();
    if (!q || streaming) return;
    setInput("");
    var updated = messages.concat([{role:"user", text:q}]);
    setMessages(updated);
    runTurn(updated, false);
  }
  function stopGenerating(){ abortRef.current && abortRef.current.abort(); }
  function retry(){ if (errorRetry){ var r=errorRetry; setErrorRetry(null); runTurn(r.history, r.isOpener); } }

  function renderHistorySheet(){
    return (
      <div style={{ position:"absolute",inset:0,background:"rgba(10,15,30,0.85)",display:"flex",flexDirection:"column",justifyContent:"flex-end",zIndex:20 }} onClick={function(){setShowHistory(false);}}>
        <div style={{ background:C.card,borderRadius:"20px 20px 0 0",padding:20,maxHeight:"75vh",display:"flex",flexDirection:"column" }} onClick={function(e){e.stopPropagation();}}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
            <span style={{ fontWeight:800,fontSize:16,color:C.text }}>Past Tutoring Sessions</span>
            <button onClick={function(){setShowHistory(false);}} style={{ background:"none",border:"none",color:C.muted,fontSize:18,cursor:"pointer" }}>✕</button>
          </div>
          <div style={{ overflowY:"auto" }}>
            {tutorSessions.length===0 && <div style={{ textAlign:"center",color:C.muted,fontSize:13,padding:"20px 0" }}>No past sessions yet.</div>}
            {tutorSessions.map(function(s){
              var m = MODES[s.mode] || MODES.explain;
              var lastMsg = s.messages && s.messages.length ? s.messages[s.messages.length-1] : null;
              return(
                <div key={s.id} onClick={function(){resumeSession(s);}} style={{ background:C.card2,border:"1px solid "+C.border,borderRadius:12,padding:"12px 14px",marginBottom:8,cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10 }}>
                  <div style={{ minWidth:0,flex:1 }}>
                    <div style={{ display:"flex",alignItems:"center",gap:6,marginBottom:3 }}>
                      <span style={{ fontSize:10,fontWeight:700,color:m.color,background:m.color+"20",borderRadius:99,padding:"2px 8px" }}>{m.label}</span>
                    </div>
                    <div style={{ fontWeight:700,fontSize:14,color:C.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{s.topicLabel}</div>
                    {lastMsg && <div style={{ fontSize:12,color:C.muted,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",marginTop:2 }}>{lastMsg.text}</div>}
                    <div style={{ fontSize:10,color:C.muted,marginTop:4 }}>{formatRelativeDate(s.updatedAt)}</div>
                  </div>
                  <span onClick={function(e){removeSession(e,s.id);}} style={{ fontSize:15,cursor:"pointer",color:C.red,flexShrink:0 }}>🗑️</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  if (!planAtLeast(plan, "pro")) {
    return (
      <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
        <div style={{ background:C.card,padding:"16px 20px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid "+C.border }}>
          <button onClick={onBack} style={backBtn}>←</button>
          <span style={{ fontWeight:800,fontSize:16,color:C.text }}>🎓 AI Tutor</span>
        </div>
        <div style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,textAlign:"center" }}>
          <div style={{ fontSize:56,marginBottom:16 }}>🎓</div>
          <div style={{ fontWeight:800,fontSize:18,color:C.text,marginBottom:8 }}>Advanced AI Tutor is a Pro feature</div>
          <p style={{ color:C.muted,fontSize:13,lineHeight:1.6,marginBottom:24,maxWidth:280 }}>A Socratic tutor that teaches step by step, walks through problems with hints, or quizzes your real understanding — not just a chatbot that answers.</p>
          <button onClick={onUpgrade} style={{ background:"linear-gradient(135deg,#F59E0B,#EF4444)",color:"#fff",border:"none",borderRadius:14,padding:"14px 32px",fontWeight:800,fontSize:15,cursor:"pointer" }}>🚀 Upgrade to Pro</button>
        </div>
      </div>
    );
  }

  if (phase==="setup") {
    return (
      <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column",position:"relative" }}>
        <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
          <div style={{ display:"flex",alignItems:"center",gap:12 }}>
            <button onClick={onBack} style={backBtn}>←</button>
            <span style={{ fontWeight:800,fontSize:16,color:C.text }}>🎓 AI Tutor</span>
          </div>
          {tutorSessions.length>0 && <button onClick={function(){setShowHistory(true);}} title="Past sessions" style={{ background:"rgba(255,255,255,0.08)",border:"none",borderRadius:10,width:36,height:36,cursor:"pointer",fontSize:15 }}>🕐</button>}
        </div>
        <div style={{ flex:1,overflowY:"auto",padding:20 }}>
          <div style={{ fontWeight:800,fontSize:14,color:C.text,marginBottom:10 }}>How should SAM-X tutor you?</div>
          <div style={{ marginBottom:20 }}>
            {Object.keys(MODES).map(function(k){ var m=MODES[k]; var isSel=mode===k; return(
              <button key={k} onClick={function(){setMode(k);}} style={{ width:"100%",textAlign:"left",background:isSel?m.color+"15":C.card,border:"2px solid "+(isSel?m.color:C.border),borderRadius:14,padding:"14px 16px",marginBottom:10,cursor:"pointer" }}>
                <div style={{ fontWeight:700,fontSize:14,color:isSel?m.color:C.text,marginBottom:4 }}>{m.label}</div>
                <div style={{ fontSize:12,color:C.muted,lineHeight:1.5 }}>{m.desc}</div>
              </button>
            );})}
          </div>

          <div style={{ fontWeight:800,fontSize:14,color:C.text,marginBottom:10 }}>What's the topic?</div>
          <div style={{ display:"flex",gap:8,marginBottom:14 }}>
            <button onClick={function(){setSource("note");}} style={{ flex:1,padding:"9px",borderRadius:10,border:"2px solid",borderColor:source==="note"?C.cyan:C.border,background:source==="note"?C.cyan:C.card,color:source==="note"?"#0A0F1E":C.muted,fontSize:13,fontWeight:700,cursor:"pointer" }}>📝 From my notes</button>
            <button onClick={function(){setSource("custom");}} style={{ flex:1,padding:"9px",borderRadius:10,border:"2px solid",borderColor:source==="custom"?C.cyan:C.border,background:source==="custom"?C.cyan:C.card,color:source==="custom"?"#0A0F1E":C.muted,fontSize:13,fontWeight:700,cursor:"pointer" }}>✏️ Type a topic</button>
          </div>

          {source==="note" ? (
            <div style={{ marginBottom:20 }}>
              <input value={search} onChange={function(e){setSearch(e.target.value);}} placeholder="Search notes, courses..." style={{ width:"100%",padding:"11px 14px",borderRadius:12,border:"1px solid "+C.border,fontSize:13,background:C.card,color:C.text,outline:"none",marginBottom:12,boxSizing:"border-box" }}/>
              {filteredNotes.length===0 ? (
                <p style={{ color:C.muted,fontSize:13,textAlign:"center",padding:"16px 0" }}>{notes.length===0?"Save a few notes first so SAM-X has something to teach from.":"No notes match."}</p>
              ) : (
                <div style={{ maxHeight:220,overflowY:"auto" }}>
                  {filteredNotes.map(function(n){ var isSel=topicNote&&topicNote.id===n.id; return(
                    <button key={n.id} onClick={function(){setTopicNote(n);}} style={{ width:"100%",textAlign:"left",background:isSel?C.cyan+"15":C.card,border:"2px solid "+(isSel?C.cyan:C.border),borderRadius:12,padding:"11px 14px",marginBottom:8,cursor:"pointer" }}>
                      <div style={{ fontWeight:700,fontSize:13,color:C.text,marginBottom:3 }}>{n.title}</div>
                      <span style={{ fontSize:10,color:n.color||C.cyan,fontWeight:700,background:n.bg||"rgba(6,182,212,0.12)",borderRadius:99,padding:"2px 8px" }}>{n.course}</span>
                    </button>
                  );})}
                </div>
              )}
            </div>
          ) : (
            <input value={customTopic} onChange={function(e){setCustomTopic(e.target.value);}} placeholder="e.g. Newton's laws of motion" style={{ width:"100%",padding:"13px 16px",borderRadius:12,border:"1px solid "+C.border,fontSize:14,background:C.card,color:C.text,outline:"none",marginBottom:20,boxSizing:"border-box" }}/>
          )}

          <button onClick={startSession} disabled={!canStart} style={{ width:"100%",background:canStart?"linear-gradient(135deg,#F59E0B,#EF4444)":"#374151",color:"#fff",border:"none",borderRadius:14,padding:"15px",fontWeight:800,fontSize:15,cursor:canStart?"pointer":"default" }}>🎓 Start Tutoring Session</button>
        </div>
        {showHistory && renderHistorySheet()}
      </div>
    );
  }

  return (
    <div style={{ flex:1,display:"flex",flexDirection:"column",background:C.bg,position:"relative" }}>
      <div style={{ background:C.card,padding:"16px 20px",borderBottom:"1px solid "+C.border,display:"flex",justifyContent:"space-between",alignItems:"center" }}>
        <div style={{ display:"flex",alignItems:"center",gap:10,minWidth:0 }}>
          <button onClick={endSession} style={backBtn}>←</button>
          <div style={{ minWidth:0 }}>
            <div style={{ fontWeight:800,fontSize:14,color:C.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{MODES[mode].label}</div>
            <div style={{ fontSize:11,color:C.muted,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{topicLabel}</div>
          </div>
        </div>
        <div style={{ display:"flex",gap:6,flexShrink:0 }}>
          <button onClick={function(){setShowHistory(true);}} title="Past sessions" style={{ background:"rgba(255,255,255,0.08)",border:"none",borderRadius:10,width:36,height:36,cursor:"pointer",fontSize:14 }}>🕐</button>
          <button onClick={endSession} title="End session" style={{ background:"rgba(255,255,255,0.08)",border:"none",borderRadius:10,width:36,height:36,cursor:"pointer",fontSize:14 }}>🏁</button>
        </div>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:"16px 16px 8px" }}>
        {messages.map(function(m,i){ return(
          <div key={i} style={{ display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",marginBottom:16 }}>
            {m.role==="ai" && <div style={{ width:32,height:32,borderRadius:10,background:"linear-gradient(135deg,#F59E0B,#EF4444)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,marginRight:8,flexShrink:0,marginTop:2 }}>🎓</div>}
            <div style={{ maxWidth:"82%",background:m.role==="user"?"linear-gradient(135deg,#06B6D4,#A78BFA)":C.card2,borderRadius:m.role==="user"?"18px 18px 4px 18px":"18px 18px 18px 4px",padding:"12px 16px",border:m.role==="ai"?"1px solid "+C.border:"none" }}>
              {m.role==="ai"
                ? <div className="samx-md" style={{ fontSize:14,color:C.text,lineHeight:1.7 }}><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{m.text}</ReactMarkdown></div>
                : <p style={{ margin:0,fontSize:14,color:"#fff",lineHeight:1.7,whiteSpace:"pre-wrap" }}>{m.text}</p>}
            </div>
          </div>
        );})}
        {streaming && (
          <div style={{ display:"flex",marginBottom:16 }}>
            <div style={{ width:32,height:32,borderRadius:10,background:"linear-gradient(135deg,#F59E0B,#EF4444)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,marginRight:8,flexShrink:0,marginTop:2 }}>🎓</div>
            <div style={{ maxWidth:"82%",background:C.card2,borderRadius:"18px 18px 18px 4px",padding:"12px 16px",border:"1px solid "+C.border }}>
              {streamingText
                ? <div className="samx-md" style={{ fontSize:14,color:C.text,lineHeight:1.7 }}><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{streamingText}</ReactMarkdown></div>
                : <div style={{ display:"flex",gap:4 }}>{[0,1,2].map(function(i){return <div key={i} style={{ width:8,height:8,borderRadius:"50%",background:C.amber,animation:"dot "+(0.5+i*0.15)+"s ease-in-out infinite alternate" }}/>;})}</div>}
            </div>
          </div>
        )}
        {errorRetry && (
          <div style={{ background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",borderRadius:12,padding:14,marginBottom:16,display:"flex",justifyContent:"space-between",alignItems:"center",gap:10 }}>
            <span style={{ fontSize:13,color:C.red }}>⚠️ Couldn't reach SAM-X. Check your connection.</span>
            <button onClick={retry} style={{ background:C.red,border:"none",borderRadius:8,padding:"6px 14px",color:"#fff",fontWeight:700,fontSize:12,cursor:"pointer",flexShrink:0 }}>Retry</button>
          </div>
        )}
        <div ref={endRef}/>
      </div>
      <div style={{ padding:"12px 16px 16px",background:C.card2,borderTop:"1px solid "+C.border }}>
        {streaming ? (
          <button onClick={stopGenerating} style={{ width:"100%",background:"rgba(248,113,113,0.15)",color:C.red,border:"2px solid "+C.red+"40",borderRadius:14,padding:"13px",fontWeight:800,fontSize:14,cursor:"pointer" }}>⏹ Stop Generating</button>
        ) : (
          <div style={{ display:"flex",gap:8,alignItems:"flex-end" }}>
            <textarea value={input} onChange={function(e){setInput(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); send(); }}} placeholder="Your answer or question..." rows={1} style={{ flex:1,padding:"12px 16px",borderRadius:18,border:"1px solid "+C.border,fontSize:14,background:C.bg,color:C.text,outline:"none",minWidth:0,resize:"none",overflowY:"auto",maxHeight:100,lineHeight:1.5,fontFamily:"inherit" }}/>
            <button onClick={send} style={{ width:48,height:48,borderRadius:14,background:"linear-gradient(135deg,#F59E0B,#EF4444)",border:"none",cursor:"pointer",fontSize:20,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>↑</button>
          </div>
        )}
      </div>
      {showHistory && renderHistorySheet()}
    </div>
  );
}

// ── UNIFIED SEARCH ────────────────────────────────────────────────────────────
// Notes, Assignments, and Recordings each have their own local search already —
// this is the first place a query actually spans all three at once.
function UnifiedSearchScreen({ notes, assignments, recordings, onBack, onOpenNote, onOpenAssignment, onOpenRecordings }) {
  var [query, setQuery] = useState("");
  var q = query.trim().toLowerCase();

  var noteResults = q ? notes.filter(function(n){
    return n.title.toLowerCase().includes(q) || n.course.toLowerCase().includes(q) || (n.content||"").toLowerCase().includes(q);
  }) : [];
  var assignmentResults = q ? assignments.filter(function(a){
    return a.title.toLowerCase().includes(q) || (a.course||"").toLowerCase().includes(q) || (a.notes||"").toLowerCase().includes(q);
  }) : [];
  var recordingResults = q ? recordings.filter(function(r){
    return (r.title||"").toLowerCase().includes(q) || (r.course||"").toLowerCase().includes(q);
  }) : [];
  var totalResults = noteResults.length + assignmentResults.length + recordingResults.length;

  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <div style={{ position:"relative",flex:1 }}>
          <span style={{ position:"absolute",left:14,top:"50%",transform:"translateY(-50%)" }}>🔍</span>
          <input autoFocus value={query} onChange={function(e){setQuery(e.target.value);}} placeholder="Search notes, assignments, recordings..." style={{ width:"100%",padding:"11px 14px 11px 42px",borderRadius:12,border:"1px solid "+C.border,fontSize:14,background:C.card2,color:C.text,outline:"none",boxSizing:"border-box" }}/>
        </div>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        {!q && (
          <div style={{ textAlign:"center",padding:"60px 20px" }}>
            <div style={{ fontSize:48,marginBottom:12 }}>🔍</div>
            <div style={{ fontWeight:800,fontSize:16,color:C.text,marginBottom:6 }}>Search everything</div>
            <div style={{ fontSize:13,color:C.muted }}>Find a note, assignment, or lecture recording in one place.</div>
          </div>
        )}
        {q && totalResults===0 && (
          <div style={{ textAlign:"center",padding:"60px 20px" }}>
            <div style={{ fontSize:48,marginBottom:12 }}>🤷</div>
            <div style={{ fontWeight:800,fontSize:16,color:C.text,marginBottom:6 }}>No matches</div>
            <div style={{ fontSize:13,color:C.muted }}>Try a different search term.</div>
          </div>
        )}
        {noteResults.length>0 && (
          <div style={{ marginBottom:20 }}>
            <div style={{ fontSize:12,fontWeight:800,color:C.cyan,marginBottom:10,textTransform:"uppercase",letterSpacing:0.5 }}>📝 Notes ({noteResults.length})</div>
            {noteResults.map(function(n){return(
              <button key={n.id} onClick={function(){onOpenNote(n);}} style={{ width:"100%",textAlign:"left",background:C.card,border:"1px solid "+C.border,borderRadius:12,padding:"12px 14px",marginBottom:8,cursor:"pointer" }}>
                <div style={{ fontWeight:700,fontSize:14,color:C.text,marginBottom:3 }}>{n.title}</div>
                <div style={{ display:"flex",gap:8,alignItems:"center",marginBottom:4 }}>
                  <span style={{ fontSize:10,color:n.color||C.cyan,fontWeight:700,background:n.bg||"rgba(6,182,212,0.12)",borderRadius:99,padding:"2px 8px" }}>{n.course}</span>
                  <span style={{ fontSize:11,color:C.muted }}>{formatRelativeDate(n.id)}</span>
                </div>
                <div style={{ fontSize:12,color:C.muted,lineHeight:1.5,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden" }}>{n.preview||(n.content||"").slice(0,120)}</div>
              </button>
            );})}
          </div>
        )}
        {assignmentResults.length>0 && (
          <div style={{ marginBottom:20 }}>
            <div style={{ fontSize:12,fontWeight:800,color:C.purple,marginBottom:10,textTransform:"uppercase",letterSpacing:0.5 }}>📋 Assignments ({assignmentResults.length})</div>
            {assignmentResults.map(function(a){return(
              <button key={a.id} onClick={function(){onOpenAssignment(a.id);}} style={{ width:"100%",textAlign:"left",background:C.card,border:"1px solid "+C.border,borderRadius:12,padding:"12px 14px",marginBottom:8,cursor:"pointer" }}>
                <div style={{ fontWeight:700,fontSize:14,color:a.completed?C.muted:C.text,textDecoration:a.completed?"line-through":"none",marginBottom:3 }}>{a.title}</div>
                <div style={{ display:"flex",gap:8,alignItems:"center" }}>
                  <span style={{ fontSize:10,color:C.purple,fontWeight:700,background:"rgba(167,139,250,0.12)",borderRadius:99,padding:"2px 8px" }}>{a.course}</span>
                  {a.dueDate && <span style={{ fontSize:11,color:C.muted }}>Due {a.dueDate}</span>}
                </div>
              </button>
            );})}
          </div>
        )}
        {recordingResults.length>0 && (
          <div style={{ marginBottom:20 }}>
            <div style={{ fontSize:12,fontWeight:800,color:C.amber,marginBottom:10,textTransform:"uppercase",letterSpacing:0.5 }}>🎙️ Recordings ({recordingResults.length})</div>
            {recordingResults.map(function(r){return(
              <button key={r.id} onClick={onOpenRecordings} style={{ width:"100%",textAlign:"left",background:C.card,border:"1px solid "+C.border,borderRadius:12,padding:"12px 14px",marginBottom:8,cursor:"pointer" }}>
                <div style={{ fontWeight:700,fontSize:14,color:C.text,marginBottom:3 }}>{r.title}</div>
                <div style={{ display:"flex",gap:8,alignItems:"center" }}>
                  <span style={{ fontSize:10,color:C.amber,fontWeight:700,background:"rgba(245,158,11,0.12)",borderRadius:99,padding:"2px 8px" }}>{r.course}</span>
                  <span style={{ fontSize:11,color:C.muted }}>{formatRelativeDate(r.createdAt)}</span>
                </div>
              </button>
            );})}
          </div>
        )}
      </div>
    </div>
  );
}

// ── PROFILE & ACCOUNT ──────────────────────────────────────────────────────────
function ProfileScreen({ onBack, user, plan, credits, profile, onSaveProfile, onLogout }) {
  var [school, setSchool] = useState(profile.school||"");
  var [faculty, setFaculty] = useState(profile.faculty||"");
  var [department, setDepartment] = useState(profile.department||"");
  var [level, setLevel] = useState(profile.level||"");
  var [saving, setSaving] = useState(false);
  var [saved, setSaved] = useState(false);
  var [resetSent, setResetSent] = useState(false);

  var dirty = school!==(profile.school||"") || faculty!==(profile.faculty||"") || department!==(profile.department||"") || level!==(profile.level||"");

  async function save(){
    setSaving(true);
    await onSaveProfile({ school:school.trim(), faculty:faculty.trim(), department:department.trim(), level:level });
    setSaving(false);
    setSaved(true);
    setTimeout(function(){setSaved(false);}, 2000);
  }

  async function changePassword(){
    if(!user||!user.email) return;
    try{ await sendPasswordResetEmail(auth, user.email); setResetSent(true); }
    catch(e){ alert("Couldn't send reset email — try again in a moment."); }
  }

  return (
    <div style={{ flex:1, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.card, padding:"16px 20px", display:"flex", alignItems:"center", gap:12, borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800, fontSize:16, color:C.text }}>Profile & Account</span>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:20 }}>
        <div style={{ textAlign:"center", marginBottom:24 }}>
          <div style={{ width:84,height:84,borderRadius:"50%",overflow:"hidden",background:"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:36,margin:"0 auto 14px" }}>
            {user&&user.photoURL ? <img src={user.photoURL} alt="profile" style={{ width:84,height:84,objectFit:"cover" }}/> : "👤"}
          </div>
          <div style={{ fontWeight:800, fontSize:18, color:C.text }}>{(user&&user.displayName)||"Student"}</div>
          <div style={{ fontSize:13, color:C.muted }}>{user&&user.email}</div>
          <span style={{ display:"inline-block", marginTop:8, background:(PLANS[plan]||PLANS.free).color+"25", color:(PLANS[plan]||PLANS.free).color, borderRadius:99, padding:"4px 14px", fontSize:12, fontWeight:700 }}>{(PLANS[plan]||PLANS.free).name} Plan · {credits} credits</span>
        </div>

        <div style={{ background:C.card, borderRadius:16, padding:18, marginBottom:16, border:"1px solid "+C.border }}>
          <div style={{ fontWeight:800, fontSize:14, color:C.text, marginBottom:14 }}>Academic Info</div>
          <label style={{ fontSize:12, color:C.muted, fontWeight:600 }}>School</label>
          <input value={school} onChange={function(e){setSchool(e.target.value);}} placeholder="e.g. University of Lagos" style={{ width:"100%", padding:"11px 14px", borderRadius:12, border:"1px solid "+C.border, background:C.bg, color:C.text, fontSize:14, outline:"none", margin:"6px 0 14px", boxSizing:"border-box" }}/>
          <label style={{ fontSize:12, color:C.muted, fontWeight:600 }}>Faculty</label>
          <input value={faculty} onChange={function(e){setFaculty(e.target.value);}} placeholder="e.g. Faculty of Science" style={{ width:"100%", padding:"11px 14px", borderRadius:12, border:"1px solid "+C.border, background:C.bg, color:C.text, fontSize:14, outline:"none", margin:"6px 0 14px", boxSizing:"border-box" }}/>
          <label style={{ fontSize:12, color:C.muted, fontWeight:600 }}>Department</label>
          <input value={department} onChange={function(e){setDepartment(e.target.value);}} placeholder="e.g. Computer Science" style={{ width:"100%", padding:"11px 14px", borderRadius:12, border:"1px solid "+C.border, background:C.bg, color:C.text, fontSize:14, outline:"none", margin:"6px 0 14px", boxSizing:"border-box" }}/>
          <label style={{ fontSize:12, color:C.muted, fontWeight:600 }}>Level</label>
          <div style={{ display:"flex", gap:8, marginTop:6, flexWrap:"wrap" }}>
            {["100L","200L","300L","400L","500L","Postgrad"].map(function(lv){return<button key={lv} onClick={function(){setLevel(lv);}} style={{ padding:"7px 14px", borderRadius:99, border:"2px solid", borderColor:level===lv?C.cyan:C.border, background:level===lv?C.cyan:C.card2, color:level===lv?"#0A0F1E":C.muted, fontSize:12, fontWeight:700, cursor:"pointer" }}>{lv}</button>;})}
          </div>
          {dirty && <button onClick={save} disabled={saving} style={{ width:"100%", marginTop:16, background:saving?C.card2:"linear-gradient(135deg,#06B6D4,#A78BFA)", color:saving?C.muted:"#fff", border:"none", borderRadius:12, padding:"12px", fontWeight:800, fontSize:14, cursor:saving?"default":"pointer" }}>{saving?"Saving...":"Save Changes"}</button>}
          {saved && <div style={{ textAlign:"center", color:C.green, fontSize:12, fontWeight:700, marginTop:10 }}>✓ Saved</div>}
        </div>

        <div style={{ background:C.card, borderRadius:16, border:"1px solid "+C.border, overflow:"hidden", marginBottom:16 }}>
          <Row icon="⭐" label="Subscription" sub={(PLANS[plan]||PLANS.free).name+" plan"}/>
          <Row icon="🔥" label="Study Streak" sub={(profile.streak||0)+" day"+(profile.streak===1?"":"s")+" in a row"}/>
          <Row icon="🔑" label="Change Password" sub={resetSent?"Reset email sent — check your inbox":"Sends a reset link to your email"} onPress={changePassword}/>
        </div>

        <button onClick={onLogout} style={{ width:"100%", background:"rgba(248,113,113,0.1)", border:"1px solid rgba(248,113,113,0.3)", borderRadius:14, padding:"14px", color:C.red, fontWeight:800, fontSize:14, cursor:"pointer" }}>Log Out</button>
      </div>
    </div>
  );
}

// ── NOTIFICATION CENTER ────────────────────────────────────────────────────────
function NotificationScreen({ onBack, notifications, onMarkRead, onMarkAllRead, onNavigate, notifEnabled, setNotifEnabled, user }) {
  var TYPE_ICON = { study:"📚", ai_complete:"✨", streak:"🔥", app_update:"🚀", assignment:"📋", daily:"🎯", recording:"🎙️", account:"📧" };
  var unreadCount = notifications.filter(function(n){return !n.read;}).length;
  function handleTogglePush(v){
    if (v) {
      subscribeToPush(user.uid).then(function(){ setNotifEnabled(true); }).catch(function(e){
        alert(e.message || "Couldn't enable push notifications on this device.");
      });
    } else {
      setNotifEnabled(false);
      unsubscribeFromPush(user.uid).catch(function(){});
    }
  }
  return (
    <div style={{ flex:1, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.card, padding:"16px 20px", display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom:"1px solid "+C.border }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <button onClick={onBack} style={backBtn}>←</button>
          <span style={{ fontWeight:800, fontSize:16, color:C.text }}>Notifications</span>
        </div>
        {unreadCount>0 && <button onClick={onMarkAllRead} style={{ background:"none", border:"none", color:C.cyan, fontSize:12, fontWeight:700, cursor:"pointer" }}>Mark all read</button>}
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:20 }}>
        <div style={{ background:C.card, borderRadius:14, padding:"14px 16px", marginBottom:18, display:"flex", justifyContent:"space-between", alignItems:"center", border:"1px solid "+C.border }}>
          <div><div style={{ fontWeight:700, fontSize:14, color:C.text }}>Push Notifications</div><div style={{ fontSize:12, color:C.muted }}>Reminders reach this device even when Jotting AI is closed</div></div>
          <Toggle value={notifEnabled} onChange={handleTogglePush} color={C.purple}/>
        </div>
        {notifications.length===0 ? (
          <div style={{ textAlign:"center", padding:"60px 20px" }}>
            <div style={{ fontSize:48, marginBottom:12 }}>🔔</div>
            <div style={{ fontWeight:700, fontSize:16, color:C.text, marginBottom:6 }}>All caught up</div>
            <div style={{ fontSize:13, color:C.muted }}>Study reminders, AI completions, and streak milestones will show up here.</div>
          </div>
        ) : notifications.map(function(n){return(
          <button key={n.id} onClick={function(){ if(!n.read) onMarkRead(n.id); if(n.route) onNavigate(n.route); }} style={{ width:"100%", textAlign:"left", display:"flex", gap:12, background:n.read?C.card:C.card2, border:"1px solid "+(n.read?C.border:C.cyan+"40"), borderRadius:14, padding:14, marginBottom:10, cursor:"pointer" }}>
            <div style={{ width:38,height:38,borderRadius:10,background:C.card2,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0 }}>{TYPE_ICON[n.type]||"🔔"}</div>
            <div style={{ minWidth:0, flex:1 }}>
              <div style={{ display:"flex", justifyContent:"space-between", gap:8 }}>
                <span style={{ fontWeight:700, fontSize:14, color:C.text }}>{n.title}</span>
                {!n.read && <span style={{ width:8,height:8,borderRadius:"50%",background:C.cyan,flexShrink:0,marginTop:5 }}/>}
              </div>
              <div style={{ fontSize:13, color:C.muted, marginTop:2, lineHeight:1.5 }}>{n.message}</div>
              <div style={{ fontSize:11, color:C.muted, marginTop:6 }}>{formatRelativeDate(n.ts)}</div>
            </div>
          </button>
        );})}
      </div>
    </div>
  );
}

// ── PRICING / UPGRADE ─────────────────────────────────────────────────────────
function PricingScreen({ onBack, plan, credits, user, onPlanUpdated }) {
  var [cycle, setCycle] = useState("monthly");
  var [processingPlan, setProcessingPlan] = useState(null); // plan key currently mid-checkout/downgrade
  var [payError, setPayError] = useState("");
  var [paySuccess, setPaySuccess] = useState("");
  var planOrder = ["free","pro","premium"];

  function priceFor(p){ return cycle==="monthly" ? p.priceMonthly : p.priceYearly; }
  function periodLabel(){ return cycle==="monthly" ? "/month" : "/year"; }

  async function verifyAndApply(reference, planKey, billCycle){
    try{
      var result = await callSubscriptionApi({ action:"verify_payment", reference:reference, planId:planKey, cycle:billCycle });
      // Written ONLY here, directly after the server has genuinely verified
      // this payment with Paystack (using the secret key server-side) — this
      // is what makes the unlock survive a refresh/re-login even if the
      // separate Firestore accounts/{uid} write is ever delayed or fails.
      // Never written from Paystack's own client-side popup callback alone,
      // and never from a plain button tap.
      if (user) persistLocalEntitlement(user.uid, {
        plan: result.plan,
        monthlyCredits: (PLANS[result.plan]||PLANS.free).monthlyCredits,
        verifiedAt: Date.now(),
        reference: reference,
      });
      onPlanUpdated(result.plan, result.credits);
      setPayError("");
      setPaySuccess("✅ Payment verified — you're now on the "+((PLANS[result.plan]||PLANS.free).name)+" plan.");
      setTimeout(function(){ setPaySuccess(""); }, 6000);
    }catch(e){
      // Deliberately does NOT call onPlanUpdated or write a local
      // entitlement here — an unverified payment must never unlock
      // anything, even temporarily.
      setPaySuccess("");
      setPayError("Payment went through, but we couldn't confirm it yet. If your plan doesn't update in a minute, contact support with this reference: "+reference);
    }
    setProcessingPlan(null);
  }

  async function startUpgrade(planKey){
    if(!user || !user.email){ setPayError("You need to be signed in with an email to upgrade."); return; }
    setPayError("");
    setPaySuccess("");
    setProcessingPlan(planKey);
    try{
      await loadPaystackScript();
      var reference = "jotting_"+Date.now()+"_"+Math.random().toString(36).slice(2,10);
      var amountNaira = cycle==="monthly" ? PLANS[planKey].priceMonthly : PLANS[planKey].priceYearly;
      window.PaystackPop.setup({
        key: PAYSTACK_PUBLIC_KEY,
        email: user.email,
        amount: amountNaira*100, // Paystack takes kobo
        currency: "NGN",
        ref: reference,
        metadata: { uid:user.uid, planId:planKey, cycle:cycle },
        callback: function(response){ verifyAndApply(response.reference, planKey, cycle); },
        onClose: function(){ setProcessingPlan(null); },
      }).openIframe();
    }catch(e){
      setProcessingPlan(null);
      setPayError(e.message||"Couldn't open the payment window — check your connection and try again.");
    }
  }

  async function startDowngrade(){
    if(!window.confirm("Downgrade to the Free plan? You'll lose Pro/Premium features immediately.")) return;
    setPayError("");
    setPaySuccess("");
    setProcessingPlan("free");
    try{
      var result = await callSubscriptionApi({ action:"downgrade" });
      // Symmetric cleanup — without this, a legitimate downgrade would keep
      // getting silently re-overridden back to the old paid plan on the next
      // login by the local entitlement resolver above.
      if (user) clearLocalEntitlement(user.uid);
      onPlanUpdated(result.plan, result.credits);
    }catch(e){
      setPayError("Couldn't downgrade — check your connection and try again.");
    }
    setProcessingPlan(null);
  }

  return (
    <div style={{ flex:1, background:C.bg, display:"flex", flexDirection:"column" }}>
      <style>{"@keyframes floatUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}"}</style>
      <div style={{ background:C.card, padding:"16px 20px", display:"flex", alignItems:"center", gap:12, borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800, fontSize:16, color:C.text }}>Plans & Pricing</span>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:20 }}>
        {credits <= LOW_CREDIT_WARNING_THRESHOLD && (
          <div style={{ background:"rgba(245,158,11,0.1)", border:"1px solid rgba(245,158,11,0.3)", borderRadius:14, padding:16, marginBottom:20, textAlign:"center" }}>
            <div style={{ fontSize:28, marginBottom:6 }}>⚡</div>
            <div style={{ fontWeight:800, fontSize:15, color:C.amber, marginBottom:4 }}>{credits<=0 ? "You're out of AI credits" : "Running low on AI credits"}</div>
            <div style={{ fontSize:12, color:C.muted }}>You have {credits} credit{credits===1?"":"s"} left on the {(PLANS[plan]||PLANS.free).name} plan. Upgrade below for a lot more room.</div>
          </div>
        )}
        {payError && (
          <div style={{ background:"rgba(248,113,113,0.1)", border:"1px solid rgba(248,113,113,0.3)", borderRadius:12, padding:"12px 14px", marginBottom:16, fontSize:12, color:C.red, fontWeight:600, lineHeight:1.5 }}>⚠️ {payError}</div>
        )}
        {paySuccess && (
          <div style={{ background:"rgba(52,211,153,0.1)", border:"1px solid rgba(52,211,153,0.3)", borderRadius:12, padding:"12px 14px", marginBottom:16, fontSize:12, color:C.green, fontWeight:600, lineHeight:1.5 }}>{paySuccess}</div>
        )}
        <div style={{ textAlign:"center", marginBottom:20 }}>
          <div style={{ fontWeight:800, fontSize:22, color:C.text, marginBottom:6 }}>Choose your plan</div>
          <div style={{ fontSize:13, color:C.muted }}>Cancel anytime. Prices in Naira.</div>
        </div>
        <div style={{ display:"flex", justifyContent:"center", marginBottom:24 }}>
          <div style={{ display:"flex", background:C.card2, borderRadius:99, padding:4, gap:4 }}>
            <button onClick={function(){setCycle("monthly");}} style={{ padding:"8px 18px", borderRadius:99, border:"none", background:cycle==="monthly"?C.cyan:"transparent", color:cycle==="monthly"?"#0A0F1E":C.muted, fontWeight:700, fontSize:13, cursor:"pointer" }}>Monthly</button>
            <button onClick={function(){setCycle("yearly");}} style={{ padding:"8px 18px", borderRadius:99, border:"none", background:cycle==="yearly"?C.cyan:"transparent", color:cycle==="yearly"?"#0A0F1E":C.muted, fontWeight:700, fontSize:13, cursor:"pointer", display:"flex", alignItems:"center", gap:6 }}>Yearly <span style={{ fontSize:10, background:C.green, color:"#0A0F1E", borderRadius:99, padding:"2px 6px", fontWeight:800 }}>save 17%</span></button>
          </div>
        </div>

        {planOrder.map(function(key, idx){
          var p = PLANS[key];
          var isCurrent = plan===key;
          var isProcessing = processingPlan===key;
          return (
            <div key={key} style={{ animation:"floatUp 0.35s ease "+(idx*0.08)+"s both", background:C.card, border:"2px solid "+(isCurrent?p.color:C.border), borderRadius:20, padding:20, marginBottom:16, position:"relative", overflow:"hidden" }}>
              {key==="pro" && <div style={{ position:"absolute", top:0, right:0, background:p.color, color:"#0A0F1E", fontSize:10, fontWeight:800, padding:"4px 14px", borderBottomLeftRadius:10 }}>MOST POPULAR</div>}
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
                <div>
                  <div style={{ fontWeight:800, fontSize:18, color:p.color }}>{p.name}</div>
                  <div style={{ fontSize:12, color:C.muted }}>{p.tagline}</div>
                </div>
                {isCurrent && <span style={{ fontSize:10, fontWeight:800, color:C.green, background:"rgba(52,211,153,0.15)", borderRadius:99, padding:"4px 10px" }}>CURRENT PLAN</span>}
              </div>
              <div style={{ display:"flex", alignItems:"baseline", gap:6, marginBottom:16 }}>
                <span style={{ fontSize:30, fontWeight:800, color:C.text }}>{priceFor(p)===0?"Free":"₦"+priceFor(p).toLocaleString()}</span>
                {priceFor(p)>0 && <span style={{ fontSize:13, color:C.muted }}>{periodLabel()}</span>}
              </div>
              <div style={{ marginBottom:18 }}>
                {p.features.map(function(f,i){return <div key={i} style={{ display:"flex", gap:8, alignItems:"flex-start", marginBottom:8 }}><span style={{ color:p.color, fontSize:14 }}>✓</span><span style={{ fontSize:13, color:C.soft, lineHeight:1.5 }}>{f}</span></div>;})}
              </div>
              <button disabled={isCurrent||isProcessing} onClick={function(){ key==="free" ? startDowngrade() : startUpgrade(key); }} style={{ width:"100%", padding:"13px", borderRadius:14, border:"none", background:isCurrent?C.card2:("linear-gradient(135deg,"+p.color+",#A78BFA)"), color:isCurrent?C.muted:"#0A0F1E", fontWeight:800, fontSize:14, cursor:(isCurrent||isProcessing)?"default":"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
                {isProcessing
                  ? (<><div style={{ width:16,height:16,borderRadius:"50%",border:"2px solid rgba(10,15,30,0.3)",borderTop:"2px solid #0A0F1E",animation:"spin 1s linear infinite" }}/>Processing...</>)
                  : (isCurrent?"Your Current Plan":(key==="free"?"Downgrade to Free":"Upgrade to "+p.name))}
              </button>
            </div>
          );
        })}

        <div style={{ marginTop:8, marginBottom:20 }}>
          <div style={{ fontWeight:800, fontSize:15, color:C.text, marginBottom:12, textAlign:"center" }}>Compare features</div>
          <div style={{ background:C.card, borderRadius:16, border:"1px solid "+C.border, overflow:"hidden" }}>
            <div style={{ display:"grid", gridTemplateColumns:"1.4fr 1fr 1fr 1fr", padding:"10px 12px", background:C.card2, fontSize:11, fontWeight:800, color:C.muted }}>
              <span>Feature</span><span style={{textAlign:"center"}}>Free</span><span style={{textAlign:"center"}}>Pro</span><span style={{textAlign:"center"}}>Premium</span>
            </div>
            {[
              ["AI credits / month","60","400","1,500"],
              ["Voice recording & transcribe","✓","✓","✓"],
              ["AI Chat, Scan Doc, Quizzes","✓","✓","✓"],
              ["Priority AI responses","—","✓","✓"],
              ["Cloud storage","Standard","More","Maximum"],
              ["AI Study Planner","—","✓","✓"],
              ["Advanced AI Tutor","—","✓","✓"],
              ["Advanced Analytics","—","✓","✓"],
              ["Exam Mode","—","—","✓"],
              ["Priority support","—","✓","✓"],
            ].map(function(row,i){return(
              <div key={i} style={{ display:"grid", gridTemplateColumns:"1.4fr 1fr 1fr 1fr", padding:"10px 12px", fontSize:12, color:C.soft, borderTop:"1px solid "+C.border }}>
                <span style={{ color:C.text, fontWeight:600 }}>{row[0]}</span>
                <span style={{textAlign:"center"}}>{row[1]}</span>
                <span style={{textAlign:"center"}}>{row[2]}</span>
                <span style={{textAlign:"center"}}>{row[3]}</span>
              </div>
            );})}
          </div>
        </div>
        <div style={{ textAlign:"center", fontSize:11, color:C.muted, marginBottom:20 }}>🔒 Payments are securely processed by Paystack. Jotting AI never sees or stores your card details.</div>
      </div>
    </div>
  );
}

// Small, self-contained addition to Settings → Account: resend uses
// sendEmailVerification directly (a plain module-level import — it doesn't
// touch React state, so no App-level wiring is needed for it). Rechecking
// status goes through the onRefresh prop (App's refreshEmailVerification)
// so the real `user` state gets updated — not just a local copy here — and
// every other place that happens to read user.emailVerified stays correct
// too. Never gates anything: this only ever changes what this one row
// displays, matching the app's "don't block on verification" requirement.
function EmailVerificationRow({ user, onRefresh }) {
  var [sending, setSending] = useState(false);
  var [checking, setChecking] = useState(false);
  var [message, setMessage] = useState("");
  var verified = !!(user && user.emailVerified);

  async function resend(){
    if (!auth.currentUser || sending) return;
    setSending(true); setMessage("");
    try{
      await sendEmailVerification(auth.currentUser);
      setMessage("Verification email sent — check your inbox.");
    }catch(e){
      setMessage(e.code==="auth/too-many-requests" ? "Please wait a bit before requesting another email." : "Couldn't send the email — try again in a moment.");
    }
    setSending(false);
  }

  async function recheck(){
    if (checking || !onRefresh) return;
    setChecking(true); setMessage("");
    try{
      var nowVerified = await onRefresh();
      setMessage(nowVerified ? "Your email is verified! 🎉" : "Still not verified — check your inbox for the link.");
    }catch(e){
      setMessage("Couldn't check right now — try again in a moment.");
    }
    setChecking(false);
  }

  return (
    <div>
      <Row icon="✅" label="Email Verified" sub={verified?"Your email is verified":"Email not verified yet"} right={<span style={{ fontSize:13,fontWeight:800,color:verified?C.green:C.amber }}>{verified?"Verified ✓":"Pending"}</span>}/>
      {!verified && (
        <div style={{ display:"flex",gap:8,padding:"4px 0 8px" }}>
          <button onClick={resend} disabled={sending} style={{ ...actionBtn(C.cyan), flex:1, opacity:sending?0.6:1 }}>{sending?"Sending...":"Resend email"}</button>
          <button onClick={recheck} disabled={checking} style={{ ...actionBtn(C.green), flex:1, opacity:checking?0.6:1 }}>{checking?"Checking...":"I've verified"}</button>
        </div>
      )}
      {message && <div style={{ fontSize:12,color:C.muted,padding:"0 0 8px",lineHeight:1.5 }}>{message}</div>}
    </div>
  );
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────
function SettingsScreen({ user, onLogout, recQuality, setRecQuality, recSettings, setRecSettings, plan, credits, onViewPlans, themeName, onSelectTheme, notifPrefs, setNotifPrefs, privacy, onSetPin, onDisablePin, onSetAutoLock, onSetHiddenFolder, aiStyle, setAiStyle, aiLength, setAiLength, aiLanguage, setAiLanguage, isIOS, isStandalone, installPromptEvent, promptInstall, onRefreshVerification }) {
  var [openSection,setOpenSection]=useState(null);
  var [pinSetupMode,setPinSetupMode]=useState(false);
  var [pinDraft1,setPinDraft1]=useState("");
  var [pinDraft2,setPinDraft2]=useState("");
  var [pinError,setPinError]=useState("");
  // About section detail sheets — App Version/What's New/Privacy/Terms/Contact
  // Support previously had no onPress at all (Row renders inert without one).
  // Content here is assembled only from facts already stated elsewhere in this
  // app's own UI (recording audio staying device-local, Paystack handling
  // payment with no card storage, the existing plan/credit system, the exact
  // "What's New" text the app already shows as a one-time notification, and
  // the same support email Report a Bug already uses) — not invented copy,
  // and explicitly labeled as a plain-language summary rather than a real
  // legal document, since no actual Privacy Policy/Terms text exists in this
  // app to link to.
  var [infoSheet,setInfoSheet]=useState(null);
  var ABOUT_INFO = {
    version: {
      icon: "📱", title: "App Version",
      body: [
        "Jotting AI v4.0.0 — Login Edition",
        "Built with love by Samuel.",
      ],
    },
    whatsnew: {
      icon: "🆕", title: "What's New",
      body: [
        "Free, Pro, and Premium plans with AI credits — check Settings → Subscription to see your usage.",
        "Login, Firebase, and Cloud sync.",
      ],
    },
    privacy: {
      icon: "🔏", title: "Privacy & Data",
      body: [
        "A plain-language summary of how Jotting AI handles your data today — not a substitute for a full legal Privacy Policy.",
        "Your notes, assignments, and other study data sync to the cloud so they follow you across your devices.",
        "Lecture recording audio stays on this device only — it's never uploaded, so it won't follow you to a different device or survive clearing browser data.",
        "Payments are processed securely by Paystack — Jotting AI never sees or stores your card details.",
        "Questions about your data? Use Contact Support below.",
      ],
    },
    terms: {
      icon: "📜", title: "Terms of Service",
      body: [
        "A plain-language summary of Jotting AI's current terms — not a substitute for a full legal agreement.",
        "Free, Pro, and Premium plans are available, each with a monthly AI credit allowance.",
        "Subscriptions can be cancelled anytime from Settings → Subscription.",
        "Payments are processed securely by Paystack.",
        "Questions about these terms? Use Contact Support below.",
      ],
    },
    contact: {
      icon: "💬", title: "Contact Support",
      body: [
        "Get help from the Jotting AI team:",
        "samuel@gmail.com",
      ],
    },
  };

  function startPinSetup(){ setPinDraft1("");setPinDraft2("");setPinError("");setPinSetupMode(true); }
  function confirmPinSetup(){
    if(pinDraft1.length!==4||!/^\d{4}$/.test(pinDraft1)){ setPinError("PIN must be exactly 4 digits."); return; }
    if(pinDraft1!==pinDraft2){ setPinError("PINs don't match — try again."); return; }
    onSetPin(pinDraft1);
    setPinSetupMode(false);
  }

  function Section({ id, icon, title, color, children }) {
    var isOpen=openSection===id;
    return<div style={{ background:C.card,borderRadius:16,marginBottom:12,border:"1px solid "+C.border,overflow:"hidden" }}><button onClick={function(){setOpenSection(isOpen?null:id);}} style={{ width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"16px",background:"none",border:"none",cursor:"pointer" }}><div style={{ display:"flex",alignItems:"center",gap:12 }}><div style={{ width:36,height:36,borderRadius:10,background:color+"20",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18 }}>{icon}</div><span style={{ fontWeight:700,fontSize:15,color:C.text }}>{title}</span></div><span style={{ color:C.muted,fontSize:20 }}>{isOpen?"v":">"}</span></button>{isOpen&&<div style={{ padding:"0 16px 16px",borderTop:"1px solid "+C.border }}>{children}</div>}</div>;
  }

  return(
    <div style={{ flex:1,overflowY:"auto",background:C.bg,position:"relative" }}>
      <div style={{ background:C.card,padding:"16px 20px",borderBottom:"1px solid "+C.border }}><span style={{ fontWeight:800,fontSize:18,color:C.text }}>Settings</span></div>
      <div style={{ padding:"16px 16px 100px" }}>
        {/* User Profile Card */}
        <div style={{ background:"linear-gradient(135deg,#1E293B,#0F172A)",borderRadius:20,padding:20,marginBottom:16,border:"1px solid rgba(6,182,212,0.2)" }}>
          <div style={{ display:"flex",alignItems:"center",gap:16 }}>
            <div style={{ width:60,height:60,borderRadius:18,overflow:"hidden",background:"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,flexShrink:0 }}>
              {user&&user.photoURL?<img src={user.photoURL} alt="profile" style={{ width:60,height:60,objectFit:"cover" }}/>:"👤"}
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:800,fontSize:18,color:C.text }}>{(user&&user.displayName)||"Student"}</div>
              <div style={{ fontSize:13,color:C.muted }}>{user&&user.email}</div>
              <div style={{ fontSize:11,color:C.green,marginTop:2 }}>✅ Verified Account</div>
            </div>
          </div>
        </div>

        {!isStandalone && (
          <div style={{ background:"linear-gradient(135deg,rgba(6,182,212,0.12),rgba(167,139,250,0.12))",borderRadius:16,padding:18,marginBottom:16,border:"1px solid rgba(6,182,212,0.25)" }}>
            <div style={{ display:"flex",alignItems:"center",gap:12,marginBottom:12 }}>
              <div style={{ width:42,height:42,borderRadius:12,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0 }}>📲</div>
              <div>
                <div style={{ fontWeight:800,fontSize:14,color:C.text }}>Install Jotting AI</div>
                <div style={{ fontSize:12,color:C.muted }}>{isIOS?"Add it to your Home Screen":"Get it on your Home Screen — opens like a real app, no browser bar"}</div>
              </div>
            </div>
            {isIOS ? (
              <div style={{ fontSize:12,color:C.soft,lineHeight:1.7,background:C.card,borderRadius:10,padding:"10px 14px" }}>
                Tap the <b>Share</b> icon <span style={{fontSize:14}}>⬆️</span> in Safari's toolbar, then choose <b>"Add to Home Screen."</b>
              </div>
            ) : installPromptEvent ? (
              <button onClick={promptInstall} style={{ width:"100%",background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:12,padding:"12px",fontWeight:800,fontSize:14,cursor:"pointer" }}>📲 Install App</button>
            ) : (
              <div style={{ fontSize:12,color:C.muted,lineHeight:1.6 }}>Look for an install icon in your browser's address bar, or check its menu for "Install app" / "Add to Home screen."</div>
            )}
          </div>
        )}
        {isStandalone && (
          <div style={{ background:"rgba(52,211,153,0.1)",border:"1px solid rgba(52,211,153,0.3)",borderRadius:14,padding:"12px 16px",marginBottom:16,display:"flex",alignItems:"center",gap:10 }}>
            <span style={{ fontSize:18 }}>✅</span>
            <span style={{ fontSize:13,color:C.green,fontWeight:700 }}>Installed — you're running Jotting AI as an app</span>
          </div>
        )}

        <Section id="sub" icon="⭐" title="Subscription" color="#F59E0B">
          <div style={{ marginTop:12 }}>
            <div style={{ background:C.card2,borderRadius:12,padding:"12px 16px",marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center" }}>
              <div>
                <div style={{ fontWeight:700,fontSize:14,color:C.text }}>Current Plan</div>
                <div style={{ fontSize:12,color:C.muted }}>{credits} AI credit{credits===1?"":"s"} remaining this month</div>
              </div>
              <span style={{ background:(PLANS[plan]||PLANS.free).color+"25",color:(PLANS[plan]||PLANS.free).color,borderRadius:99,padding:"4px 14px",fontSize:12,fontWeight:700 }}>{(PLANS[plan]||PLANS.free).name}</span>
            </div>
            {credits<=LOW_CREDIT_WARNING_THRESHOLD && <div style={{ background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:12,padding:"10px 14px",marginBottom:10,fontSize:12,color:C.amber,fontWeight:600 }}>⚡ {credits<=0?"You're out of credits — upgrade to keep using AI features.":"Running low on credits."}</div>}
            {plan!=="premium" && (
              <div style={{ background:"linear-gradient(135deg,#4F46E5,#7C3AED,#06B6D4)",borderRadius:16,padding:20,marginBottom:10 }}>
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12 }}><div><div style={{ fontWeight:800,fontSize:18,color:"#fff" }}>{plan==="free"?"Upgrade to Pro":"Upgrade to Premium"}</div><div style={{ fontSize:12,color:"rgba(255,255,255,0.75)",marginTop:4,lineHeight:1.8 }}>More AI credits{"\n"}Faster SAM-X responses{"\n"}Priority support</div></div><span style={{ fontSize:32 }}>🚀</span></div>
                <div style={{ display:"flex",alignItems:"baseline",gap:4,marginBottom:14 }}><span style={{ fontSize:32,fontWeight:800,color:"#fff" }}>₦{(plan==="free"?PLANS.pro.priceMonthly:PLANS.premium.priceMonthly).toLocaleString()}</span><span style={{ fontSize:13,color:"rgba(255,255,255,0.6)" }}>/month</span></div>
                <button onClick={onViewPlans} style={{ width:"100%",background:"#fff",color:"#4F46E5",border:"none",borderRadius:12,padding:"13px",fontWeight:800,fontSize:15,cursor:"pointer" }}>See Plans →</button>
              </div>
            )}
            <Row icon="📊" label="View All Plans" sub="Compare Free, Pro, and Premium" onPress={onViewPlans}/>
          </div>
        </Section>

        <Section id="notif" icon="🔔" title="Notifications" color="#A78BFA">
          <div style={{ marginTop:12 }}>
            {[["📚","study","Study Reminders","Nudge if you haven't made a note in 2+ days"],["🎯","daily","Daily Goal Reminder","Evening nudge if today's goal isn't met"],["📋","assignment","Assignment Reminder","Nudge when something's due within 2 days"],["🎙️","recording","Recording Reminder","Nudge if you haven't recorded in a week"]].map(function(item){return<Row key={item[1]} icon={item[0]} label={item[2]} sub={item[3]} right={<Toggle value={notifPrefs[item[1]]} onChange={function(v){setNotifPrefs(function(p){return{...p,[item[1]]:v};});}} color={C.purple}/>}/>;})}
            <div style={{ fontSize:11,color:C.muted,marginTop:8 }}>These check once while the app is open — turn on Push Notifications (bell icon on Home) so they can actually alert you.</div>
          </div>
        </Section>

        <Section id="lang" icon="🌍" title="AI Response Language" color="#34D399">
          <div style={{ marginTop:12 }}>{[["English","🇬🇧"],["Yoruba","🇳🇬"],["Hausa","🇳🇬"],["Igbo","🇳🇬"],["French","🇫🇷"]].map(function(item){return<div key={item[0]} onClick={function(){setAiLanguage(item[0]);}} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 0",borderBottom:"1px solid "+C.border,cursor:"pointer" }}><div style={{ display:"flex",alignItems:"center",gap:10 }}><span style={{ fontSize:20 }}>{item[1]}</span><span style={{ fontSize:14,fontWeight:600,color:aiLanguage===item[0]?C.green:C.text }}>{item[0]}</span></div>{aiLanguage===item[0]&&<span style={{ color:C.green,fontSize:18,fontWeight:700 }}>✓</span>}</div>;})}
            <div style={{ fontSize:11,color:C.muted,marginTop:8 }}>Changes what language SAM-X replies in across AI Write, AI Chat, Study Planner, Quizzes, and more. The app's own interface stays in English for now.</div>
          </div>
        </Section>

        <Section id="appearance" icon="🎨" title="Appearance" color="#F59E0B">
          <div style={{ marginTop:12 }}>
            <div style={{ fontSize:12,color:C.muted,marginBottom:8,fontWeight:600 }}>THEME</div>
            <div style={{ display:"flex",gap:8 }}>
              {[["dark","🌙","Dark"],["light","☀️","Light"]].map(function(t){return(
                <button key={t[0]} onClick={function(){onSelectTheme(t[0]);}} style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:6,padding:"14px 8px",borderRadius:12,border:"2px solid",borderColor:themeName===t[0]?C.cyan:C.border,background:themeName===t[0]?C.cyan+"15":C.card,cursor:"pointer" }}>
                  <span style={{ fontSize:22 }}>{t[1]}</span>
                  <span style={{ fontSize:13,fontWeight:700,color:themeName===t[0]?C.cyan:C.muted }}>{t[2]}</span>
                </button>
              );})}
            </div>
            <div style={{ fontSize:11,color:C.muted,marginTop:8 }}>Switches the whole app's colors — your choice is remembered on this device.</div>
          </div>
        </Section>

        <Section id="rec" icon="🎤" title="Recording Settings" color="#06B6D4">
          <div style={{ marginTop:12 }}>
            <div style={{ marginBottom:12 }}><div style={{ fontSize:12,color:C.muted,marginBottom:8,fontWeight:600 }}>RECORDING QUALITY</div><div style={{ display:"flex",gap:8 }}>{["Low","Medium","High"].map(function(q){return<button key={q} onClick={function(){setRecQuality(q);}} style={{ flex:1,padding:"8px",borderRadius:10,border:"2px solid",borderColor:recQuality===q?C.cyan:C.border,background:recQuality===q?C.cyan:C.card,color:recQuality===q?"#0A0F1E":C.muted,fontSize:13,fontWeight:700,cursor:"pointer" }}>{q}</button>;})}</div><div style={{ fontSize:11,color:C.muted,marginTop:6 }}>Higher quality sounds better but makes a bigger audio file — matters if a lecture runs long.</div></div>
            <Row icon="🔇" label="Noise Reduction" sub="Requests a noise-suppressed mic when you record" right={<Toggle value={recSettings.noise} onChange={function(v){setRecSettings(function(p){return{...p,noise:v};});}} color={C.cyan}/>}/>
            <Row icon="✨" label="Auto-Transcribe" sub="Start transcribing automatically the moment you stop recording" right={<Toggle value={recSettings.autoTranscribe} onChange={function(v){setRecSettings(function(p){return{...p,autoTranscribe:v};});}} color={C.cyan}/>}/>
            <Row icon="💾" label="Auto Save" sub="Save the note automatically once transcription finishes" right={<Toggle value={recSettings.autoSave} onChange={function(v){setRecSettings(function(p){return{...p,autoSave:v};});}} color={C.cyan}/>}/>
            <div style={{ opacity:0.5 }}>
              <Row icon="👥" label="Speaker Identification" sub="Needs a paid diarization service — not available yet" right={<span style={{ fontSize:9,fontWeight:700,color:C.amber,background:"rgba(245,158,11,0.15)",borderRadius:99,padding:"3px 8px" }}>COMING SOON</span>}/>
            </div>
          </div>
        </Section>

        <Section id="ai" icon="🤖" title="AI Settings" color="#A78BFA">
          <div style={{ marginTop:12 }}>
            <div style={{ marginBottom:14 }}><div style={{ fontSize:12,color:C.muted,marginBottom:8,fontWeight:600 }}>AI ENGINE</div><div style={{ background:C.card2,borderRadius:12,padding:"12px 14px",display:"flex",alignItems:"center",gap:10 }}><span style={{ fontSize:20 }}>🤖</span><div><div style={{ fontWeight:700,fontSize:14,color:C.text }}>SAM-X AI</div><div style={{ fontSize:11,color:C.muted }}>Powers your Summary, Quiz, AI Write, Scan Doc, and Chat</div></div></div></div>
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:12,color:C.muted,marginBottom:8,fontWeight:600 }}>WRITING STYLE</div>
              <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>{["Academic","Simple","Detailed"].map(function(s){return<button key={s} onClick={function(){setAiStyle(s);}} style={{ padding:"8px 16px",borderRadius:10,border:"2px solid",borderColor:aiStyle===s?C.purple:C.border,background:aiStyle===s?C.purple:C.card,color:aiStyle===s?"#0A0F1E":C.muted,fontSize:13,fontWeight:700,cursor:"pointer" }}>{s}</button>;})}</div>
            </div>
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:12,color:C.muted,marginBottom:8,fontWeight:600 }}>AI SUMMARY LENGTH</div>
              <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>{["Short","Medium","Long"].map(function(s){return<button key={s} onClick={function(){setAiLength(s);}} style={{ padding:"8px 16px",borderRadius:10,border:"2px solid",borderColor:aiLength===s?C.purple:C.border,background:aiLength===s?C.purple:C.card,color:aiLength===s?"#0A0F1E":C.muted,fontSize:13,fontWeight:700,cursor:"pointer" }}>{s}</button>;})}</div>
            </div>
            <Row icon="🌐" label="AI Response Language" sub={aiLanguage+" — change in the AI Response Language section above"}/>
            <Row icon="📵" label="Offline AI Mode" sub="Available on Pro" right={<span style={{ background:"rgba(245,158,11,0.15)",color:C.amber,borderRadius:99,padding:"3px 10px",fontSize:11,fontWeight:700 }}>PRO</span>}/>
          </div>
        </Section>

        <Section id="privacy" icon="🔒" title="Privacy and Security" color="#F87171">
          <div style={{ marginTop:12 }}>
            <Row icon="🔢" label="PIN Lock" sub={privacy.pinEnabled?"On — locks the app after you switch away":"Set a 4-digit PIN to lock the app"} right={<Toggle value={privacy.pinEnabled} onChange={function(v){ if(v){ startPinSetup(); } else if(window.confirm("Turn off PIN lock?")){ onDisablePin(); } }} color={C.red}/>}/>
            {pinSetupMode&&(
              <div style={{ background:C.card2,borderRadius:14,padding:14,margin:"6px 0 12px",border:"1px solid "+C.red+"30" }}>
                <div style={{ fontSize:12,fontWeight:700,color:C.soft,marginBottom:8 }}>Choose a 4-digit PIN</div>
                <input value={pinDraft1} onChange={function(e){setPinDraft1(e.target.value.replace(/\D/g,"").slice(0,4));}} type="password" inputMode="numeric" placeholder="New PIN" style={{ width:"100%",padding:"10px 14px",borderRadius:10,border:"1px solid "+C.border,background:C.bg,color:C.text,fontSize:16,letterSpacing:4,outline:"none",marginBottom:8,boxSizing:"border-box" }}/>
                <input value={pinDraft2} onChange={function(e){setPinDraft2(e.target.value.replace(/\D/g,"").slice(0,4));}} type="password" inputMode="numeric" placeholder="Confirm PIN" style={{ width:"100%",padding:"10px 14px",borderRadius:10,border:"1px solid "+C.border,background:C.bg,color:C.text,fontSize:16,letterSpacing:4,outline:"none",marginBottom:8,boxSizing:"border-box" }}/>
                {pinError&&<div style={{ color:C.red,fontSize:12,fontWeight:600,marginBottom:8 }}>{pinError}</div>}
                <div style={{ display:"flex",gap:8 }}>
                  <button onClick={function(){setPinSetupMode(false);}} style={{ flex:1,background:"none",border:"1px solid "+C.border,borderRadius:10,padding:"9px",color:C.muted,fontWeight:700,fontSize:13,cursor:"pointer" }}>Cancel</button>
                  <button onClick={confirmPinSetup} style={{ flex:1,background:C.red,border:"none",borderRadius:10,padding:"9px",color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer" }}>Set PIN</button>
                </div>
              </div>
            )}
            <div style={{ opacity:privacy.pinEnabled?1:0.5,pointerEvents:privacy.pinEnabled?"auto":"none" }}>
              <Row icon="⏱" label="Auto Lock" sub={privacy.pinEnabled?"Lock if you're away from the app for a minute":"Turn on PIN Lock first"} right={<Toggle value={privacy.autoLock} onChange={onSetAutoLock} color={C.red}/>}/>
            </div>
            <Row icon="📁" label="Hidden Notes Folder" sub={privacy.hiddenFolder?"On — mark a note hidden from its own page to keep it out of Home & Library":"Keep private notes out of your main list"} right={<Toggle value={privacy.hiddenFolder} onChange={onSetHiddenFolder} color={C.red}/>}/>
            <div style={{ opacity:0.5 }}>
              <Row icon="👆" label="Fingerprint Unlock" sub="Needs native device support — not available in-browser yet" right={<span style={{ fontSize:9,fontWeight:700,color:C.amber,background:"rgba(245,158,11,0.15)",borderRadius:99,padding:"3px 8px" }}>COMING SOON</span>}/>
              <Row icon="👤" label="Face Unlock" sub="Needs native device support — not available in-browser yet" right={<span style={{ fontSize:9,fontWeight:700,color:C.amber,background:"rgba(245,158,11,0.15)",borderRadius:99,padding:"3px 8px" }}>COMING SOON</span>}/>
              <Row icon="🔐" label="Encrypt Notes" sub="Real end-to-end encryption needs more backend work first" right={<span style={{ fontSize:9,fontWeight:700,color:C.amber,background:"rgba(245,158,11,0.15)",borderRadius:99,padding:"3px 8px" }}>COMING SOON</span>}/>
            </div>
          </div>
        </Section>

        <Section id="about" icon="ℹ️" title="About" color="#06B6D4">
          <div style={{ marginTop:12 }}>
            <Row icon="📱" label="App Version" sub="v4.0.0 - Login Edition" right={<span style={{ fontSize:13,color:C.muted }}>v4.0</span>} onPress={function(){setInfoSheet("version");}}/>
            <Row icon="🆕" label="What's New" sub="Login, Firebase, Cloud sync!" onPress={function(){setInfoSheet("whatsnew");}}/>
            <Row icon="🔏" label="Privacy Policy" sub="How we handle your data" onPress={function(){setInfoSheet("privacy");}}/>
            <Row icon="📜" label="Terms of Service" sub="Rules and conditions" onPress={function(){setInfoSheet("terms");}}/>
            <Row icon="💬" label="Contact Support" sub="Get help from our team" onPress={function(){setInfoSheet("contact");}}/>
            <Row icon="⭐" label="Rate the App" onPress={function(){alert("Thank you! Rating coming soon!");}}/>
            <Row icon="📤" label="Share the App" onPress={function(){if(navigator.share){navigator.share({title:"Jotting AI",text:"Check out this AI note-taking app!",url:"https://notewave12.netlify.app"});}else{alert("Link: notewave12.netlify.app");}}}/>
            <Row icon="🐛" label="Report a Bug" onPress={function(){alert("Report bugs to: samuel@gmail.com");}}/>
            <div style={{ textAlign:"center",marginTop:16,color:C.muted,fontSize:12 }}>Jotting AI v4.0 - Built with love by Samuel</div>
          </div>
        </Section>

        <Section id="account" icon="👤" title="Account" color="#34D399">
          <div style={{ marginTop:12 }}>
            <Row icon="✉️" label="Email" sub={(user&&user.email)||"Not logged in"}/>
            <Row icon="👤" label="Display Name" sub={(user&&user.displayName)||"Not set"}/>
            <EmailVerificationRow user={user} onRefresh={onRefreshVerification}/>
            <div onClick={onLogout} style={{ display:"flex",alignItems:"center",justifyContent:"center",padding:"14px",marginTop:12,background:"rgba(248,113,113,0.1)",borderRadius:12,cursor:"pointer",border:"1px solid "+C.red+"30" }}>
              <span style={{ fontSize:14,fontWeight:700,color:C.red }}>🚪 Logout</span>
            </div>
          </div>
        </Section>
      </div>
      {infoSheet&&(
        <div style={{ position:"absolute",inset:0,background:"rgba(10,15,30,0.85)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:30 }} onClick={function(){setInfoSheet(null);}}>
          <div style={{ background:C.card,borderRadius:"20px 20px 0 0",padding:20,width:"100%",maxHeight:"85vh",overflowY:"auto",boxSizing:"border-box" }} onClick={function(e){e.stopPropagation();}}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
              <span style={{ fontWeight:800,fontSize:16,color:C.text }}>{ABOUT_INFO[infoSheet].icon} {ABOUT_INFO[infoSheet].title}</span>
              <button onClick={function(){setInfoSheet(null);}} style={{ background:"none",border:"none",color:C.muted,fontSize:18,cursor:"pointer" }}>✕</button>
            </div>
            {ABOUT_INFO[infoSheet].body.map(function(line,i){return<p key={i} style={{ fontSize:13,color:C.soft,lineHeight:1.6,margin:i===0?"0 0 12px":"0 0 10px" }}>{line}</p>;})}
            <button onClick={function(){setInfoSheet(null);}} style={{ width:"100%",marginTop:8,background:C.card2,color:C.text,border:"1px solid "+C.border,borderRadius:14,padding:"13px",fontWeight:700,fontSize:14,cursor:"pointer" }}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────────────────────
export default function App() {
  var [user, setUser] = useState(null);
  var [authLoading, setAuthLoading] = useState(true);
  var [showOnboarding, setShowOnboarding] = useState(false);
  var [notes, setNotes] = useState([]);
  var [chatSessions, setChatSessions] = useState([]);
  var [recordings, setRecordings] = useState([]);
  var [resumeRecording, setResumeRecording] = useState(null);
  var [cloudLoading, setCloudLoading] = useState(false);
  // ── Offline / sync status ────────────────────────────────────────────────
  // isOnline is the standard browser signal (imperfect — reports network
  // interface status, not real Firestore reachability — but it's the honest,
  // standard tool for this, not something to build a health-check service
  // around). pendingSyncCount/lastSyncFailed are updated by beginSync()/
  // endSync() below, called from the app's EXISTING cloud-write paths
  // (saveNote/updateNote, addAssignment/updateAssignment, saveChatSession) —
  // this only observes what those calls already do; it doesn't add retries,
  // a queue, or change when/whether a sync happens. Local IndexedDB writes
  // (via each repository) already happen synchronously before any of this,
  // regardless of online state — that's what actually keeps work from being
  // lost; this state is purely the visible status on top of that.
  var [isOnline, setIsOnline] = useState(function(){ return typeof navigator!=="undefined" ? navigator.onLine : true; });
  var [pendingSyncCount, setPendingSyncCount] = useState(0);
  var [lastSyncFailed, setLastSyncFailed] = useState(false);
  useEffect(function(){
    function onOnline(){ setIsOnline(true); }
    function onOffline(){ setIsOnline(false); }
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return function(){ window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); };
  }, []);
  function beginSync(){ setPendingSyncCount(function(n){ return n+1; }); }
  function endSync(success){ setPendingSyncCount(function(n){ return Math.max(0, n-1); }); setLastSyncFailed(!success); }
  var syncState = !isOnline ? "offline" : pendingSyncCount>0 ? "syncing" : lastSyncFailed ? "failed" : "synced";
  var SYNC_STATE_META = {
    offline: { bg:"rgba(248,113,113,0.12)", color:C.red,    icon:"📴", label:"Offline — your work is saved on this device" },
    syncing: { bg:"rgba(6,182,212,0.10)",   color:C.cyan,   icon:"🔄", label:"Syncing..." },
    failed:  { bg:"rgba(245,158,11,0.12)",  color:C.amber,  icon:"⚠️", label:"Sync failed — saved on this device" },
    synced:  { bg:"rgba(52,211,153,0.08)",  color:C.green,  icon:"✓",  label:"Synced" },
  };
  var syncBarMeta = SYNC_STATE_META[syncState];
  var [screen, setScreen] = useState("home");
  var [activeNote, setActiveNote] = useState(null);
  var [activeCourse, setActiveCourse] = useState(null);
  var [activeVaultCourse, setActiveVaultCourse] = useState(null);
  var [activeTopicId, setActiveTopicId] = useState(null);
  var [studySession, setStudySession] = useState(null); // null | { currentIndex, results:{stepKey:"done"|"skipped"} }
  var [pendingAssignmentId, setPendingAssignmentId] = useState(null); // set by unified search when jumping to a specific assignment
  var [assignmentAddMode, setAssignmentAddMode] = useState(false); // set by the Command Center + menu's "Add Assignment"
  var [aiChatSeed, setAiChatSeed] = useState(null); // {initialPrefill|initialSend|initialPicker} set by Ask Jotting
  var [tab, setTab] = useState("home");
  var [recQuality, setRecQuality] = useState(function(){ try{ return localStorage.getItem("jotting_recQuality")||"Medium"; }catch(e){ return "Medium"; } });
  var [recSettings, setRecSettings] = useState(function(){
    try{ var raw=localStorage.getItem("jotting_recSettings"); return raw?JSON.parse(raw):{noise:true,autoTranscribe:false,speakerID:false,autoSave:false}; }
    catch(e){ return {noise:true,autoTranscribe:false,speakerID:false,autoSave:false}; }
  });
  // Device-level (like recQuality/recSettings above, not synced cross-device) — mirrored
  // into the module-level `aiPreferences` object so callGeminiText/callGeminiChatStream/
  // callGeminiVision automatically apply them without any screen needing new props.
  var [aiStyle, setAiStyle] = useState(function(){ try{ return localStorage.getItem("jotting_aiStyle")||"Academic"; }catch(e){ return "Academic"; } });
  var [aiLength, setAiLength] = useState(function(){ try{ return localStorage.getItem("jotting_aiLength")||"Medium"; }catch(e){ return "Medium"; } });
  var [aiLanguage, setAiLanguage] = useState(function(){ try{ return localStorage.getItem("jotting_aiLanguage")||"English"; }catch(e){ return "English"; } });
  useEffect(function(){ try{ localStorage.setItem("jotting_aiStyle", aiStyle); }catch(e){} aiPreferences.style = aiStyle; }, [aiStyle]);
  useEffect(function(){ try{ localStorage.setItem("jotting_aiLength", aiLength); }catch(e){} aiPreferences.length = aiLength; }, [aiLength]);
  useEffect(function(){ try{ localStorage.setItem("jotting_aiLanguage", aiLanguage); }catch(e){} aiPreferences.language = aiLanguage; }, [aiLanguage]);
  // ── PWA installability ────────────────────────────────────────────────────────
  // Chrome/Edge/Android fire beforeinstallprompt and let us trigger it programmatically
  // later (from a Settings row, not immediately — showing our own UI at a moment of our
  // choosing is friendlier than an unsolicited browser popup). iOS Safari never fires
  // this event at all; there's no programmatic install API there, only manual
  // Share → Add to Home Screen, so that path gets static instructions instead.
  var [installPromptEvent, setInstallPromptEvent] = useState(null);
  var [isStandalone, setIsStandalone] = useState(false);
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  useEffect(function(){
    function checkStandalone(){
      setIsStandalone(window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone===true);
    }
    checkStandalone();
    function onBeforeInstallPrompt(e){ e.preventDefault(); setInstallPromptEvent(e); }
    function onInstalled(){ setInstallPromptEvent(null); checkStandalone(); }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return function(){
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  async function promptInstall(){
    if (!installPromptEvent) return;
    installPromptEvent.prompt();
    await installPromptEvent.userChoice.catch(function(){});
    setInstallPromptEvent(null); // a captured prompt can only be used once
  }

  var [themeName, setThemeName] = useState(function(){ return loadSavedThemeName(); });
  function selectTheme(name){
    if (name===themeName) return;
    applyTheme(name); // mutate C synchronously so the very next render already has the new colors
    setThemeName(name);
    try{ localStorage.setItem("jotting_theme", name); }catch(e){}
  }
  var [plan, setPlan] = useState("free");
  var [credits, setCredits] = useState(PLANS.free.monthlyCredits);
  var [profile, setProfile] = useState({ school:"", faculty:"", department:"", level:"", streak:0 });
  var [notifEnabled, setNotifEnabled] = useState(function(){ try{ return localStorage.getItem("jotting_notifEnabled")==="1"; }catch(e){ return false; } });
  useEffect(function(){ try{ localStorage.setItem("jotting_notifEnabled", notifEnabled?"1":"0"); }catch(e){} }, [notifEnabled]);
  var [notifCenter, setNotifCenter] = useState([]);
  useEffect(function(){ try{ localStorage.setItem("jotting_recQuality", recQuality); }catch(e){} }, [recQuality]);
  useEffect(function(){ try{ localStorage.setItem("jotting_recSettings", JSON.stringify(recSettings)); }catch(e){} }, [recSettings]);
  var [assignments, setAssignments] = useState([]);
  var [examResults, setExamResults] = useState([]);
  var [topicMastery, setTopicMastery] = useState([]);
  var [studyPlans, setStudyPlans] = useState([]);
  var [materials, setMaterials] = useState([]);
  var [courses, setCourses] = useState([]);
  var [semesters, setSemesters] = useState([]);
  var [quizzes, setQuizzes] = useState([]);
  var [flashcardDecks, setFlashcardDecks] = useState([]);
  var [studySessions, setStudySessions] = useState([]);

  // ── Notification preferences (Settings → Notifications) ─────────────────────
  var [notifPrefs, setNotifPrefs] = useState(function(){
    var defaults = {study:true,daily:true,recording:false,assignment:true};
    try{ var raw=localStorage.getItem("jotting_notifPrefs"); return raw?{...defaults, ...JSON.parse(raw)}:defaults; }
    catch(e){ return defaults; }
  });
  useEffect(function(){ try{ localStorage.setItem("jotting_notifPrefs", JSON.stringify(notifPrefs)); }catch(e){} }, [notifPrefs]);
  // profiles/{uid} is already client-writable (see saveProfileFields), so this rides
  // along with school/faculty/department/level/streak — it's what send-reminders.js reads
  // server-side, since it obviously can't see this device's localStorage.
  useEffect(function(){ if (user) saveProfileFields(user.uid, { notifPrefs:notifPrefs }); }, [notifPrefs, user]);
  // Register the service worker once on load (cheap, doesn't request any permission by
  // itself) — subscribeToPush() later just needs it ready when the student opts in.
  var [swUpdateAvailable, setSwUpdateAvailable] = useState(false);
  var swRegRef = useRef(null);
  var justSignedUpRef = useRef(false); // set by LoginScreen's onLogin(user,{justSignedUp:true}) — consumed once inside onAuthStateChanged below to queue the "check your email" notification
  useEffect(function(){
    registerServiceWorker(function(reg){ swRegRef.current = reg; setSwUpdateAvailable(true); });
  }, []);
  function applyAppUpdate(){
    var reg = swRegRef.current;
    if (!reg || !reg.waiting) { window.location.reload(); return; }
    var reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", function(){
      if (reloaded) return; reloaded = true;
      window.location.reload();
    });
    reg.waiting.postMessage({ type:"SKIP_WAITING" });
    setSwUpdateAvailable(false);
  }
  // Migration: the old "Push Notifications" toggle only granted browser permission, it
  // never actually created a push subscription. If a returning student already has it
  // on, quietly (re)subscribe so background reminders start working without them having
  // to notice and retoggle it themselves.
  useEffect(function(){
    if (!user || !notifEnabled || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready.then(function(reg){ return reg.pushManager.getSubscription(); })
      .then(function(sub){ if (!sub) subscribeToPush(user.uid).catch(function(){}); })
      .catch(function(){});
  }, [user, notifEnabled]);

  // ── Privacy: PIN lock + hidden notes (Settings → Privacy and Security) ──────
  var [privacy, setPrivacyState] = useState({ pinEnabled:false, pinHash:"", autoLock:true, hiddenFolder:false });
  var [locked, setLocked] = useState(false);
  var hiddenSinceRef = useRef(null);
  useEffect(function(){ if (user) persistPrivacySettings(user.uid, privacy); }, [privacy, user]);
  function setPinCode(pin){ setPrivacyState(function(p){ return {...p, pinEnabled:true, pinHash:simpleHash(pin)}; }); }
  function disablePin(){ setPrivacyState(function(p){ return {...p, pinEnabled:false, pinHash:"", autoLock:false}; }); setLocked(false); }
  function setAutoLock(v){ setPrivacyState(function(p){ return {...p, autoLock:v}; }); }
  function setHiddenFolder(v){ setPrivacyState(function(p){ return {...p, hiddenFolder:v}; }); }
  function verifyPin(pin){ return simpleHash(pin)===privacy.pinHash; }
  // Auto-lock: if PIN Lock + Auto Lock are both on, coming back to the tab after being
  // away for a minute or more re-locks the app — the "1 minute" behavior Settings promises.
  useEffect(function(){
    function onVisibility(){
      if (document.hidden) { hiddenSinceRef.current = Date.now(); }
      else {
        if (privacy.pinEnabled && privacy.autoLock && hiddenSinceRef.current && (Date.now()-hiddenSinceRef.current)>=60000) setLocked(true);
        hiddenSinceRef.current = null;
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return function(){ document.removeEventListener("visibilitychange", onVisibility); };
  }, [privacy.pinEnabled, privacy.autoLock]);

  // Notes hidden from Home & Library (but still reachable directly) once "Hidden Notes
  // Folder" is on and the student has marked at least one note hidden from its own page.
  var visibleNotes = privacy.hiddenFolder ? notes.filter(function(n){ return !n.hidden; }) : notes;
  var hiddenNotesList = notes.filter(function(n){ return n.hidden; });

  // ── Local reminder checks (Study / Daily Goal / Assignment / Recording nudges) ──
  // Runs while the app is open — not a real background push scheduler (that would need
  // a server-side job), so it checks conditions periodically and fires through the same
  // in-app notification + browser push pipeline already used for streaks/app updates.
  // Study/Daily/Recording fire at most once per calendar day; Assignment fires at most
  // once per calendar day PER assignment, tracked via localStorage flags.
  var reminderStateRef = useRef({});
  useEffect(function(){ reminderStateRef.current = { user:user, notifPrefs:notifPrefs, notes:notes, recordings:recordings, assignments:assignments }; });
  useEffect(function(){
    function checkReminders(){
      var s = reminderStateRef.current;
      if (!s.user) return;
      var uid = s.user.uid;
      var today = dayKey();
      var hour = new Date().getHours();

      if (s.notifPrefs.daily && hour>=19) {
        var k1 = "jotting_reminded_daily_"+uid+"_"+today;
        var todayCount = s.notes.filter(function(n){ var r=formatRelativeDate(n.id); return r==="Just now"||/m ago$/.test(r)||r==="Today"; }).length;
        if (!localStorage.getItem(k1) && todayCount<3) {
          localStorage.setItem(k1,"1");
          addNotificationRef.current("daily","🎯 Daily goal reminder","You're at "+todayCount+"/3 notes today — a quick session before bed keeps your streak alive.", {screen:"home"});
        }
      }
      if (s.notifPrefs.study && hour>=9) {
        var k2 = "jotting_reminded_study_"+uid+"_"+today;
        var lastNoteTs = s.notes.length ? Math.max.apply(null, s.notes.map(function(n){return n.id||0;})) : 0;
        var daysSince = lastNoteTs ? Math.floor((Date.now()-lastNoteTs)/86400000) : 999;
        if (!localStorage.getItem(k2) && daysSince>=2) {
          localStorage.setItem(k2,"1");
          addNotificationRef.current("study","📚 Haven't studied in a while","It's been "+daysSince+" days since your last note. Jump back in!", {screen:"home"});
        }
      }
      if (s.notifPrefs.recording && hour>=9) {
        var k3 = "jotting_reminded_recording_"+uid+"_"+today;
        var lastRecTs = s.recordings.length ? Math.max.apply(null, s.recordings.map(function(r){return r.createdAt||0;})) : 0;
        var daysSinceRec = lastRecTs ? Math.floor((Date.now()-lastRecTs)/86400000) : 999;
        if (!localStorage.getItem(k3) && daysSinceRec>=7) {
          localStorage.setItem(k3,"1");
          addNotificationRef.current("recording","🎙️ Record your next lecture","It's been a while since you recorded a lecture — don't fall behind on notes.", {screen:"voice"});
        }
      }
      if (s.notifPrefs.assignment && hour>=9) {
        var today0 = new Date(); today0.setHours(0,0,0,0);
        s.assignments.filter(function(a){ return !a.completed && a.dueDate; }).forEach(function(a){
          var due = new Date(a.dueDate+"T00:00:00");
          var daysLeft = Math.round((due.getTime()-today0.getTime())/86400000);
          if (daysLeft>=0 && daysLeft<=2) {
            var k4 = "jotting_reminded_assignment_"+uid+"_"+a.id+"_"+today;
            if (!localStorage.getItem(k4)) {
              localStorage.setItem(k4,"1");
              addNotificationRef.current("assignment","📋 Assignment due soon","\""+a.title+"\" ("+a.course+") is due "+(daysLeft===0?"today":daysLeft===1?"tomorrow":"in "+daysLeft+" days")+".", {screen:"assignment", assignmentId:a.id});
            }
          }
        });
      }
    }
    checkReminders();
    var iv = setInterval(checkReminders, 5*60*1000);
    return function(){ clearInterval(iv); };
  }, []);

  // `route` is optional and additive — existing/legacy notifications (already
  // persisted in localStorage before this) simply have no `route` field, and
  // are handled gracefully as "no specific destination" (see
  // navigateFromNotification below). No migration needed, no data reshaped.
  function addNotification(type, title, message, route){
    setNotifCenter(function(list){
      var updated = [makeNotif(type,title,message,route), ...list].slice(0,50);
      if (user) persistNotifsLocal(user.uid, updated);
      return updated;
    });
    if (notifEnabled) sendNotification(title, message);
  }
  var addNotificationRef = useRef(addNotification);
  useEffect(function(){ addNotificationRef.current = addNotification; }); // no dep array: refreshes every render, always current
  function markNotifRead(id){
    setNotifCenter(function(list){
      var updated = list.map(function(n){ return n.id===id ? {...n, read:true} : n; });
      if (user) persistNotifsLocal(user.uid, updated);
      return updated;
    });
  }
  function markAllNotifsRead(){
    setNotifCenter(function(list){
      var updated = list.map(function(n){ return {...n, read:true}; });
      if (user) persistNotifsLocal(user.uid, updated);
      return updated;
    });
  }
  // Routes a tapped notification to its relevant destination, reusing the
  // exact same navigation primitives every other "jump to X" entry point in
  // this app already uses (go(), setActiveNote, setPendingAssignmentId,
  // setActiveCourse, setResumeRecording) — no new navigation mechanism.
  // `route` is optional; a notification without one (including every
  // notification that existed before this change) just does nothing here —
  // NotificationScreen still marks it read on tap, same as always.
  function navigateFromNotification(route){
    if (!route) return;
    if (route.screen==="note" && route.noteId!=null) {
      var n = notes.find(function(x){ return x.id===route.noteId; });
      // The note may have since been deleted — fall back to Library rather
      // than silently doing nothing or opening a stale/missing note.
      if (n) { setActiveNote(n); go("detail", tab); } else { go("library","library"); }
      return;
    }
    if (route.screen==="assignment" && route.assignmentId!=null) {
      setPendingAssignmentId(route.assignmentId);
      go("assignments", tab);
      return;
    }
    if (route.screen==="course" && route.courseName) {
      setActiveCourse(route.courseName);
      go("course", tab);
      return;
    }
    if (route.screen==="voice") { setResumeRecording(null); go("voice","new"); return; }
    if (route.screen==="profile") { go("profile", tab); return; }
    if (route.screen==="pricing") { go("pricing", tab); return; }
    if (route.screen==="dashboard") { go("dashboard","dashboard"); return; }
    if (route.screen==="home") { go("home","home"); return; }
  }
  async function saveProfile(fields){
    setProfile(function(p){ return {...p, ...fields}; });
    if (user) await saveProfileFields(user.uid, fields);
  }

  // Re-fetches the current user's record from Firebase (the only way to pick
  // up a verification click that happened outside this session) and forces a
  // re-render with the fresh emailVerified value — Firebase mutates the same
  // User instance in place on reload(), so just passing it back through
  // setUser() wouldn't trigger anything, since React sees the same reference.
  // Returns the up-to-date verified boolean so the caller can show its own
  // "still not verified" / "verified!" feedback without duplicating this logic.
  async function refreshEmailVerification(){
    if (!auth.currentUser) return false;
    await auth.currentUser.reload();
    var fresh = auth.currentUser;
    setUser(function(prev){ return fresh ? {...fresh} : prev; });
    return !!(fresh && fresh.emailVerified);
  }

  // Let any AI helper function (defined outside this component) update the credit
  // balance shown here, and let any screen jump to the upgrade page, without props
  // needing to be threaded down through every single screen.
  useEffect(function(){
    updateGlobalCredits = function(remaining){ setCredits(remaining); };
    triggerUpgradeScreen = function(){ setScreen("pricing"); };
    return function(){ updateGlobalCredits = function(){}; triggerUpgradeScreen = function(){}; };
  }, [user]);

  // Listen for auth state
  useEffect(function() {
    var unsub = onAuthStateChanged(auth, function(firebaseUser) {
      if (firebaseUser) {
        setUser(firebaseUser);
        setAuthLoading(false); // don't make the user wait for notes to load too
        // IndexedDB is async (localStorage wasn't), so the old "read cache
        // synchronously, then kick off the cloud fetch" ordering is now expressed as
        // a promise chain instead of two lines in a row — migration and the local
        // repository read both resolve before the cloud fetch starts, same
        // guaranteed local-then-cloud order as before, just a few ms later.
        migrateNotesFromLocalStorage(firebaseUser.uid)
          .catch(function(e){ console.error("Note migration to local database failed:", e); })
          .then(function(){ return notesRepository.list(firebaseUser.uid); })
          .catch(function(e){ console.error("Loading notes from local database failed:", e); return []; })
          .then(function(cached){
            if (cached && cached.length > 0) setNotes(cached);
            setCloudLoading(true);
            loadNotesFromCloud(firebaseUser.uid).then(function(cloudNotes){
              setNotes(function(prev){
                // Keep any note that hasn't made it to the cloud yet (no firestoreId),
                // and merge with what the cloud has, so nothing already on-screen is lost.
                var unsynced = prev.filter(function(n){ return !n.firestoreId; });
                var byId = {};
                unsynced.concat(cloudNotes).forEach(function(n){ byId[n.id] = n; });
                var merged = Object.values(byId);
                merged.sort(function(a,b){ return (b.createdAt||0) - (a.createdAt||0); });
                syncNotesToRepository(firebaseUser.uid, merged).catch(function(e){ console.error("Note repository sync failed:", e); });
                return merged;
              });
              setCloudLoading(false);
            });
          });
        var cachedChats = loadChatsLocal(firebaseUser.uid);
        if (cachedChats.length > 0) setChatSessions(cachedChats);
        loadChatsFromCloud(firebaseUser.uid).then(function(cloudChats){
          setChatSessions(function(prev){
            var byId = {};
            prev.concat(cloudChats).forEach(function(s){ byId[s.id] = s; });
            var merged = Object.values(byId);
            merged.sort(function(a,b){ return (b.updatedAt||0) - (a.updatedAt||0); });
            persistChatsLocal(firebaseUser.uid, merged);
            return merged;
          });
        });
        // Same async ordering fix as notes above: migration + the local repository
        // read both resolve before the cloud fetch starts, so local-then-cloud order
        // is guaranteed even though IndexedDB (unlike localStorage) is async.
        migrateAssignmentsFromLocalStorage(firebaseUser.uid)
          .catch(function(e){ console.error("Assignment migration to local database failed:", e); })
          .then(function(){ return assignmentsRepository.list(firebaseUser.uid); })
          .catch(function(e){ console.error("Loading assignments from local database failed:", e); return []; })
          .then(function(cachedAssignments){
            if (cachedAssignments && cachedAssignments.length > 0) setAssignments(cachedAssignments);
            // Snapshot of what was ALREADY locally cached before the Firestore
            // fetch below runs — see syncAssignmentsToRepository's own comment
            // for why this matters: only ids present here can ever be purged.
            var baselineIds = {};
            (cachedAssignments||[]).forEach(function(a){ baselineIds[a.id] = true; });
            loadAssignmentsFromCloud(firebaseUser.uid).then(function(cloudAssignments){
              setAssignments(function(prev){
                var unsynced = prev.filter(function(a){ return !a.firestoreId; });
                var byId = {};
                unsynced.concat(cloudAssignments).forEach(function(a){ byId[a.id] = a; });
                var merged = Object.values(byId);
                merged.sort(function(a,b){ return (a.dueDate||"").localeCompare(b.dueDate||""); });
                syncAssignmentsToRepository(firebaseUser.uid, merged, baselineIds).catch(function(e){ console.error("Assignment repository sync failed:", e); });
                return merged;
              });
            }).catch(function(e){
              // The cloud fetch itself failed (offline, network error, etc.) —
              // there's no reliable picture of what's currently in Firestore,
              // so the local reconcile is skipped entirely rather than purging
              // anything based on an incomplete result. The student keeps
              // seeing what was already cached above; this simply runs again
              // next time the app opens or connectivity returns.
              console.error("Loading assignments from cloud failed — local cache left untouched:", e);
            });
          });
        var cachedExamResults = loadExamResultsLocal(firebaseUser.uid);
        if (cachedExamResults.length > 0) setExamResults(cachedExamResults);
        loadExamResultsFromCloud(firebaseUser.uid).then(function(cloudResults){
          setExamResults(function(prev){
            var unsynced = prev.filter(function(r){ return !r.firestoreId; });
            var byId = {};
            unsynced.concat(cloudResults).forEach(function(r){ byId[r.id] = r; });
            var merged = Object.values(byId);
            merged.sort(function(a,b){ return (b.createdAt||0)-(a.createdAt||0); });
            persistExamResultsLocal(firebaseUser.uid, merged);
            return merged;
          });
        });
        // Same async ordering fix as notes/assignments above: migration + the local
        // repository read both resolve before the cloud fetch starts.
        migrateRecordingsFromLocalStorage(firebaseUser.uid)
          .catch(function(e){ console.error("Recording metadata migration to local database failed:", e); })
          .then(function(){ return recordingsRepository.list(firebaseUser.uid); })
          .catch(function(e){ console.error("Loading recording metadata from local database failed:", e); return []; })
          .then(function(cachedRecordings){
            if (cachedRecordings && cachedRecordings.length > 0) setRecordings(cachedRecordings);
            // Snapshot of what was ALREADY locally cached before the Firestore
            // fetch below runs — see syncRecordingsToRepository's own comment
            // for why this matters: only ids present here can ever be purged.
            var recordingBaselineIds = {};
            (cachedRecordings||[]).forEach(function(r){ recordingBaselineIds[r.id] = true; });
            loadRecordingsFromCloud(firebaseUser.uid).then(function(cloudRecordings){
              setRecordings(function(prev){
                var byId = {};
                prev.concat(cloudRecordings).forEach(function(r){ byId[r.id] = r; });
                var merged = Object.values(byId);
                merged.sort(function(a,b){ return (b.createdAt||0) - (a.createdAt||0); });
                syncRecordingsToRepository(firebaseUser.uid, merged, recordingBaselineIds).catch(function(e){ console.error("Recording metadata repository sync failed:", e); });
                return merged;
              });
            }).catch(function(e){
              // Cloud fetch failed (offline, network error, etc.) — skip the
              // local reconcile entirely rather than purge anything based on
              // an incomplete result. The student keeps seeing what was
              // already cached above; this simply runs again next time the
              // app opens or connectivity returns.
              console.error("Loading recordings from cloud failed — local cache left untouched:", e);
            });
          });
        topicMasteryRepository.list(firebaseUser.uid).then(function(records){ setTopicMastery(records); }).catch(function(e){ console.error("Loading topic mastery failed:", e); });
        studyPlansRepository.list(firebaseUser.uid).then(function(plans){ setStudyPlans(plans); }).catch(function(e){ console.error("Loading study plans failed:", e); });
        materialsRepository.list(firebaseUser.uid).then(function(records){ setMaterials(records); }).catch(function(e){ console.error("Loading materials failed:", e); });
        coursesRepository.listCourses(firebaseUser.uid).then(function(records){ setCourses(records); }).catch(function(e){ console.error("Loading courses failed:", e); });
        semestersRepository.list(firebaseUser.uid).then(function(records){ setSemesters(records); }).catch(function(e){ console.error("Loading semesters failed:", e); });
        quizzesRepository.list(firebaseUser.uid).then(function(records){ setQuizzes(records); }).catch(function(e){ console.error("Loading quizzes failed:", e); });
        flashcardsRepository.list(firebaseUser.uid).then(function(records){ setFlashcardDecks(records); }).catch(function(e){ console.error("Loading flashcard decks failed:", e); });
        studySessionsRepository.list(firebaseUser.uid).then(function(records){ setStudySessions(records); }).catch(function(e){ console.error("Loading study sessions failed:", e); });
        loadOrInitAccount(firebaseUser.uid).then(function(account){
          // resolveAccountWithLocalEntitlement handles the "display-only
          // estimate" comment's caveat exactly as before (the real refill
          // still only ever happens server-side), and additionally trusts a
          // locally-verified paid entitlement over a Firestore result that
          // would otherwise incorrectly show this account as Free — see that
          // function's own comment for why.
          var resolved = resolveAccountWithLocalEntitlement(firebaseUser.uid, account);
          setPlan(resolved.plan);
          setCredits(resolved.credits);
        });
        var cachedNotifs = loadNotifsLocal(firebaseUser.uid);
        if (cachedNotifs.length > 0) setNotifCenter(cachedNotifs);
        // Fires once, right after a brand-new email/password signup (never
        // for login or Google sign-in, and never again on later sessions —
        // the ref is one-shot, reset the moment it's consumed). Deliberately
        // a notification, not a blocking screen: the student is already past
        // onLogin and into the app by this point, exactly as before — this
        // is purely informational, matching "don't block normal app testing."
        if (justSignedUpRef.current) {
          justSignedUpRef.current = false;
          addNotificationRef.current("account", "📧 Verify your email", "We sent a link to "+(firebaseUser.email||"your email address")+". Check your inbox (and spam folder) to confirm your account.", {screen:"profile"});
        }
        // App update announcements: bump this version string whenever you ship something
        // worth telling students about, and each user sees the update notice once.
        var APP_UPDATE_VERSION = "2026-07-subscriptions";
        if (localStorage.getItem("jotting_lastUpdateSeen_"+firebaseUser.uid) !== APP_UPDATE_VERSION) {
          addNotificationRef.current("app_update", "🚀 New: Plans & AI Credits", "Jotting AI now has Free, Pro, and Premium plans — check Settings to see your usage.", {screen:"pricing"});
          localStorage.setItem("jotting_lastUpdateSeen_"+firebaseUser.uid, APP_UPDATE_VERSION);
        }
        loadOrInitProfile(firebaseUser.uid).then(function(prof){
          setProfile(prof);
          var milestones = [3,7,14,30,60,100];
          if (milestones.indexOf(prof.streak)!==-1) {
            addNotificationRef.current("streak", "🔥 "+prof.streak+"-day streak!", "You've used Jotting AI "+prof.streak+" days in a row. Keep it going!", {screen:"dashboard"});
          }
        });
        var isNew = !localStorage.getItem("jotting_seen_"+firebaseUser.uid);
        if (isNew) { setShowOnboarding(true); localStorage.setItem("jotting_seen_"+firebaseUser.uid,"1"); }
        setPrivacyState(loadPrivacySettings(firebaseUser.uid));
        setLocked(false);
      } else {
        setUser(null);
        setNotes([]);
        setChatSessions([]);
        setRecordings([]);
        setAssignments([]);
        setExamResults([]);
        setTopicMastery([]);
        setStudyPlans([]);
        setMaterials([]);
        setCourses([]);
        setSemesters([]);
        setQuizzes([]);
        setFlashcardDecks([]);
        setStudySessions([]);
        setStudySession(null);
        setResumeRecording(null);
        setAssignmentAddMode(false);
        setAiChatSeed(null);
        setPendingSyncCount(0);
        setLastSyncFailed(false);
        setPlan("free");
        setCredits(PLANS.free.monthlyCredits);
        setProfile({ school:"", faculty:"", department:"", level:"", streak:0 });
        setNotifCenter([]);
        setPrivacyState({ pinEnabled:false, pinHash:"", autoLock:true, hiddenFolder:false });
        setLocked(false);
        setAuthLoading(false);
      }
    });
    return unsub;
  }, []);

  function go(s,t){ setScreen(s); if(t)setTab(t); }

  // ── Study Session control ─────────────────────────────────────────────────
  // Pure navigation/state-tracking — never touches quiz/flashcard/chat
  // internals. See the StudySessionScreen comment above for the full design.
  function startStudySession(){ setStudySession({ currentIndex:0, results:{}, startedAt:Date.now(), quizResult:null, masteryChange:null }); go("studysession","home"); }
  function endStudySession(){ setStudySession(null); go(tab,tab); }

  // Study Session's mastery hook — thin orchestration only. All the real
  // scoring (EMA blend, confidence, trend, spaced-repetition review date)
  // comes straight from topicMasteryService.updateTopicMasteryFromQuizAttempt(),
  // not reimplemented here. The one thing Study Session still has to decide,
  // because nothing else in the app does yet: which topic(s) a course-wide
  // Exam Mode quiz is evidence for. There's no quiz-to-topic mapping anywhere
  // in Jotting (topicMasteryService.js's own header comment documents this
  // same gap), so — matching that file's own suggested pattern, "recorded
  // against each one by calling updateTopicMasteryFromQuizAttempt once per
  // topic" — this applies the quiz as evidence to every topic ALREADY tracked
  // under the quizzed course. Returns null (no invented data, no invented
  // topic) if the course has no tracked topics at all.
  //
  // `freshResult` is an examResults entry — {course, score, totalQuestions,
  // percentage, id}. It isn't a real quizAttempts record (that store, if one
  // exists in the live app, isn't something Study Session writes to here —
  // only quizzesRepository/examResults are touched, both already wired
  // elsewhere) — just enough of that shape (userId/courseId/correctCount/
  // totalQuestions/completedAt) for updateTopicMasteryFromQuizAttempt to run.
  async function applyStudySessionMasteryNudge(freshResult){
    var affected = topicMastery.filter(function(m){ return m.courseId===freshResult.course; });
    if (!affected.length || !user) return null;
    var avgBefore = Math.round(affected.reduce(function(sum,m){return sum+(m.masteryScore||0);},0)/affected.length);

    var quizAttempt = {
      userId: user.uid,
      courseId: freshResult.course,
      correctCount: freshResult.score,
      totalQuestions: freshResult.totalQuestions,
      completedAt: freshResult.id, // examResults entries use id as their creation timestamp, same convention notes/assignments already use
    };

    var updatedRecords = [];
    for (var i=0; i<affected.length; i++){
      try{
        var record = await updateTopicMasteryFromQuizAttempt(quizAttempt, affected[i].topic);
        if (record) updatedRecords.push(record);
      }catch(e){ console.error("Topic mastery update failed for \""+affected[i].topic+"\":", e); }
    }
    if (!updatedRecords.length) return null;

    setTopicMastery(function(list){
      var byId = {}; updatedRecords.forEach(function(m){ byId[m.id]=m; });
      return list.map(function(m){ return byId[m.id]||m; });
    });

    var avgAfter = Math.round(updatedRecords.reduce(function(sum,m){return sum+(m.masteryScore||0);},0)/updatedRecords.length);
    return { course:freshResult.course, topicsUpdated:updatedRecords.length, avgBefore:avgBefore, avgAfter:avgAfter };
  }

  async function studyStepReturn(){
    var s = studySession;
    if (!s) { go("studysession","home"); return; }
    var key = STUDY_SESSION_STEPS[s.currentIndex].key;
    if (s.results[key]) { go("studysession","home"); return; } // already marked (e.g. bounced back and forth) — don't overwrite "skipped" with "done", and don't re-run the mastery nudge a second time

    var patch = {};
    if (key==="quizzes") {
      // Only count a quiz as "taken this session" if a fresh exam result was
      // actually recorded after this session started — visiting Exam Mode and
      // backing out of setup without submitting is still an honest "no quiz
      // taken", not a fabricated score.
      var freshResult = examResults.length && examResults[0].id>=s.startedAt ? examResults[0] : null;
      if (freshResult) {
        patch.quizResult = { course:freshResult.course, score:freshResult.score, totalQuestions:freshResult.totalQuestions, percentage:freshResult.percentage };
        patch.masteryChange = await applyStudySessionMasteryNudge(freshResult);
      }
    }

    setStudySession(function(prev){
      if (!prev) return prev;
      var results = {...prev.results, [key]:"done"};
      return {...prev, results:results, ...patch};
    });
    go("studysession","home");
  }
  // Persists the completed session via studySessionsRepository (built earlier,
  // never wired to any UI until now) and hands off to the completion screen —
  // which only reads back session.quizResult/masteryChange computed above, it
  // doesn't compute anything itself.
  function finishStudySession(){
    if (studySession && user) {
      var s = studySession;
      var record = {
        userId: user.uid,
        startedAt: s.startedAt,
        completedAt: Date.now(),
        steps: STUDY_SESSION_STEPS.map(function(step){ return { key:step.key, label:step.label, status: s.results[step.key]||"skipped" }; }),
        quizResult: s.quizResult||null,
        masteryChange: s.masteryChange||null,
      };
      studySessionsRepository.create(record).catch(function(e){ console.error("Study session save failed:", e); });
    }
    go("studysessioncomplete","home");
  }
  function studySessionAdvance(){
    setStudySession(function(s){
      if (!s) return s;
      return {...s, currentIndex: Math.min(s.currentIndex+1, STUDY_SESSION_STEPS.length-1)};
    });
  }
  function studySessionSkip(){
    setStudySession(function(s){
      if (!s) return s;
      var key = STUDY_SESSION_STEPS[s.currentIndex].key;
      var results = {...s.results, [key]:"skipped"};
      return {...s, results:results, currentIndex: Math.min(s.currentIndex+1, STUDY_SESSION_STEPS.length-1)};
    });
  }
  // Routes "Start" on the current step to the real, existing screen for it.
  // Notes has no natural preset target (Library isn't a back-button screen),
  // so this picks the single most recent note and opens NoteDetail for it —
  // the exact same setActiveNote+go("detail") pattern used everywhere else
  // notes are opened, not a new mechanism.
  function startStudyStep(step){
    if (step.key==="notes") {
      var mostRecent = notes.length ? notes.slice().sort(function(a,b){return (b.id||0)-(a.id||0);})[0] : null;
      if (!mostRecent) { alert("No notes yet to review — try Skip."); return; }
      setActiveNote(mostRecent);
      go("detail");
    } else if (step.key==="flashcards") {
      go("flashcards","home");
    } else if (step.key==="quizzes") {
      go("exammode","home");
    } else if (step.key==="tutor") {
      go("aitutor","home");
    }
  }

  function saveNote(note) {
    var newNote = {...note, userId: user&&user.uid, createdAt: note.createdAt || Date.now()};
    setNotes(function(n){
      var updated = [newNote, ...n];
      if (user) notesRepository.create(newNote).catch(function(e){ console.error("Local note save failed:", e); });
      return updated;
    });
    addNotification("ai_complete", "✨ Note ready", "\""+newNote.title+"\" has been generated and saved to your Library.", {screen:"note", noteId:newNote.id});
    // Land straight on the new note (instead of Home) so the student can rename
    // or tweak it right away while it's fresh, instead of hunting for it in the Library.
    setActiveNote(newNote);
    go("detail", tab);
    // Sync to Firestore in the background — a slow/broken connection should
    // never block the user from saving and moving on.
    if (user) {
      beginSync();
      saveNoteToCloud(user.uid, newNote).then(function(firestoreId){
        endSync(!!firestoreId);
        if (firestoreId) {
          setNotes(function(n){
            var updated = n.map(function(x){ return x.id===newNote.id ? {...x, firestoreId:firestoreId} : x; });
            notesRepository.update(newNote.id, {firestoreId:firestoreId}).catch(function(e){ console.error("Local note update failed:", e); });
            return updated;
          });
        }
      }).catch(function(e){ endSync(false); console.error("Background cloud save failed:", e); });
    }
  }

  // Renaming a note or editing its content after it's already been saved (from NoteDetail).
  function updateNote(id, fields) {
    setNotes(function(n){
      var updated = n.map(function(x){ return x.id===id ? {...x, ...fields} : x; });
      if (user) notesRepository.update(id, fields).catch(function(e){ console.error("Local note update failed:", e); });
      return updated;
    });
    var existing = notes.find(function(n){ return n.id===id; });
    if (user && existing && existing.firestoreId) {
      beginSync();
      updateNoteInCloud(existing.firestoreId, fields).then(function(){ endSync(true); }).catch(function(e){ endSync(false); console.error("Note update error:", e); });
    }
  }

  async function deleteNote(id) {
    var note = notes.find(function(n){ return n.id===id; });
    if (note&&note.firestoreId) await deleteNoteFromCloud(note.firestoreId);
    setNotes(function(n){
      var updated = n.filter(function(x){ return x.id!==id; });
      if (user) notesRepository.delete(id).catch(function(e){ console.error("Local note delete failed:", e); });
      return updated;
    });
    if (screen==="detail") go(tab==="library"?"library":"home",tab);
  }

  function saveChatSession(session) {
    setChatSessions(function(prev){
      var exists = prev.some(function(s){ return s.id===session.id; });
      var updated = exists ? prev.map(function(s){ return s.id===session.id ? session : s; }) : [session, ...prev];
      updated.sort(function(a,b){ return (b.updatedAt||0) - (a.updatedAt||0); });
      if (user) persistChatsLocal(user.uid, updated);
      return updated;
    });
    if (user) {
      beginSync();
      saveChatToCloud(user.uid, session).then(function(){ endSync(true); }).catch(function(e){ endSync(false); console.error("Background chat save failed:", e); });
    }
  }

  async function deleteChatSession(id) {
    await deleteChatFromCloud(id);
    setChatSessions(function(s){
      var updated = s.filter(function(x){ return x.id!==id; });
      if (user) persistChatsLocal(user.uid, updated);
      return updated;
    });
  }

  // ── Assignments ────────────────────────────────────────────────────────────────
  function addAssignment(payload) {
    // userId is required here — assignmentsRepository.list(uid) (called on every
    // login/reload) queries IndexedDB's "by_userId" index, so a record missing
    // this field is invisible to that query no matter how correctly it was
    // otherwise saved. Same root cause and same fix as saveRecordingFromSession's
    // recording-metadata bug — see that function's comment for the full trace.
    var newA = { id:Date.now(), userId:user&&user.uid, completed:false, ...payload };
    setAssignments(function(a){
      var updated = [newA, ...a];
      if (user) assignmentsRepository.create(newA).catch(function(e){ console.error("Local assignment save failed:", e); });
      return updated;
    });
    if (user) {
      beginSync();
      saveAssignmentToCloud(user.uid, newA).then(function(firestoreId){
        endSync(!!firestoreId);
        if (firestoreId) {
          setAssignments(function(a){
            var updated = a.map(function(x){ return x.id===newA.id ? {...x, firestoreId:firestoreId} : x; });
            assignmentsRepository.update(newA.id, {firestoreId:firestoreId}).catch(function(e){ console.error("Local assignment update failed:", e); });
            return updated;
          });
        }
      }).catch(function(e){ endSync(false); console.error("Background assignment save failed:", e); });
    }
  }

  // ── Materials (Command Center + menu → Upload Material) ─────────────────────
  // materialsRepository has existed since earlier this session but never had a
  // writer anywhere — this completes that wiring. Same local-optimistic-update
  // shape addAssignment() above already uses, minus the Firestore sync step
  // (materialsRepository, like quizzesRepository/flashcardsRepository/
  // studyPlansRepository, is IndexedDB-only — nothing new about that here).
  function addMaterial(payload) {
    var createdAt = Date.now();
    var newM = { id:createdAt, createdAt:createdAt, updatedAt:createdAt, userId:user&&user.uid, ...payload };
    setMaterials(function(list){
      var updated = [newM, ...list];
      if (user) materialsRepository.create(newM).catch(function(e){ console.error("Local material save failed:", e); });
      return updated;
    });
    // newM.courseId is now the real Course id (see Course CRUD below), not a
    // display string, so the notification uses courseName (the course's actual
    // code/title, passed alongside courseId by whatever screen called this) —
    // never the raw id, which would show as a meaningless number to the student.
    addNotification("study", "📚 Material saved", "\""+newM.title+"\" added to "+(newM.courseName||"your course")+".", newM.courseName ? {screen:"course", courseName:newM.courseName} : null);
    go("home","home");
  }
  // Added alongside Manage Courses — needed so deleting a real Course can clear
  // courseId on any material that pointed to it (see deleteCourseRecord below)
  // instead of leaving a dangling reference. materialsRepository.update already
  // existed (confirmed generic, no field-specific logic) — this is its first
  // caller.
  function updateMaterialRecord(id, fields) {
    setMaterials(function(list){
      var updated = list.map(function(m){ return m.id===id ? {...m, ...fields} : m; });
      if (user) materialsRepository.update(id, fields).catch(function(e){ console.error("Local material update failed:", e); });
      return updated;
    });
  }

  // ── Courses (real Course CRUD — Course IDs) ──────────────────────────────────
  // coursesRepository already had full create/get/list/update/delete (built
  // earlier this session, never wired to any UI). This is that wiring — same
  // local-optimistic-update shape every other repository-backed handler in this
  // file already uses. IndexedDB-only, like materials/studyPlans — no Firestore
  // sync step, same reasoning as those.
  //
  // SCOPE, stated plainly: this pass gives materials and study plans a REAL
  // courseId to join on (see UploadMaterialScreen/StudyPlannerScreen and their
  // consumers in CourseOverviewScreen/StudyVaultScreen/CommandCenterScreen).
  // topicMastery is NOT touched here — updateTopicMasteryFromQuizAttempt and its
  // matching logic (topicMasteryService.js/topicMasteryRepository.js) haven't
  // been inspected, and existing topic mastery records are keyed by course NAME
  // today. Flipping that join blind risks silently orphaning every existing
  // mastery record (old ones under the name, new ones under a real id that
  // never matches). ExamModeScreen's course picker below is still widened to
  // show real courses for consistency, but the value it sends to
  // recordExamResult (and from there into topic mastery) is untouched — still
  // the course display name, exactly as it worked before this change.
  function addCourse(payload) {
    var createdAt = Date.now();
    // Every "+ Add Course" call site (CourseChipPicker, DrawScreen's course
    // select, StudyPlannerScreen, UploadMaterialScreen) calls this with a
    // plain typed string, not an object — normalize that shorthand here so
    // {...payload} never spreads a string's characters into numeric keys
    // (which would silently create a course with no real code/title field,
    // breaking every c.code||c.title lookup everywhere else in the app).
    var fields = typeof payload==="string" ? { code:payload, title:payload } : payload;
    var newC = { id:createdAt, createdAt:createdAt, userId:user&&user.uid, ...fields };
    return new Promise(function(resolve){
      setCourses(function(list){
        var updated = [newC, ...list];
        if (user) coursesRepository.createCourse(newC).catch(function(e){ console.error("Local course save failed:", e); });
        return updated;
      });
      resolve(newC);
    });
  }
  function updateCourseRecord(id, fields) {
    setCourses(function(list){
      var updated = list.map(function(c){ return c.id===id ? {...c, ...fields} : c; });
      if (user) coursesRepository.updateCourse(id, fields).catch(function(e){ console.error("Local course update failed:", e); });
      return updated;
    });
  }
  function deleteCourseRecord(id) {
    // Same "no orphaned references" reasoning as deleteSemesterRecord: a real
    // Course id can now live in two other places (materials.courseId,
    // studyPlans.courseIds), and both get cleaned up here rather than left
    // dangling. Assignments/notes/recordings/quizzes/flashcards are all still
    // name-based (never migrated), so they're completely unaffected — a
    // deleted course's name simply stops appearing as a real Course option,
    // exactly like any other legacy free-text name.
    materials.filter(function(m){ return m.courseId===id; }).forEach(function(m){ updateMaterialRecord(m.id, {courseId:null, courseName:m.courseName}); });
    studyPlans.filter(function(p){ return (p.courseIds||[]).includes(id); }).forEach(function(p){ updateStudyPlanRecord(p.id, {courseIds:(p.courseIds||[]).filter(function(cid){return cid!==id;})}); });
    setCourses(function(list){
      var updated = list.filter(function(c){ return c.id!==id; });
      if (user) coursesRepository.deleteCourse(id).catch(function(e){ console.error("Local course delete failed:", e); });
      return updated;
    });
  }

  // ── Semesters (real Semester CRUD) ───────────────────────────────────────────
  // semestersRepository already had full create/get/list/update/delete (built
  // earlier, never wired to any UI or referenced by App_login.js at all until
  // now). Same shape as the Course handlers directly above. IndexedDB-only,
  // same reasoning as courses/materials/studyPlans — no Firestore sync step.
  function addSemester(payload) {
    var createdAt = Date.now();
    var fields = typeof payload==="string" ? { name:payload } : payload;
    var newS = { id:createdAt, createdAt:createdAt, userId:user&&user.uid, ...fields };
    return new Promise(function(resolve){
      setSemesters(function(list){
        var updated = [newS, ...list];
        if (user) semestersRepository.create(newS).catch(function(e){ console.error("Local semester save failed:", e); });
        return updated;
      });
      resolve(newS);
    });
  }
  function updateSemesterRecord(id, fields) {
    setSemesters(function(list){
      var updated = list.map(function(s){ return s.id===id ? {...s, ...fields} : s; });
      if (user) semestersRepository.update(id, fields).catch(function(e){ console.error("Local semester update failed:", e); });
      return updated;
    });
  }
  // Deleting a semester must not leave courses pointing at a semesterId that no
  // longer exists — every course currently assigned to this semester gets its
  // semesterId cleared (via the existing updateCourseRecord, not a new code
  // path) rather than silently left dangling. Same "no orphaned references"
  // reasoning as everywhere else in this codebase that cleans up on delete.
  function deleteSemesterRecord(id) {
    courses.filter(function(c){ return c.semesterId===id; }).forEach(function(c){ updateCourseRecord(c.id, {semesterId:null}); });
    setSemesters(function(list){
      var updated = list.filter(function(s){ return s.id!==id; });
      if (user) semestersRepository.delete(id).catch(function(e){ console.error("Local semester delete failed:", e); });
      return updated;
    });
  }
  function updateAssignment(id, fields) {
    setAssignments(function(a){
      var updated = a.map(function(x){ return x.id===id ? {...x, ...fields} : x; });
      if (user) assignmentsRepository.update(id, fields).catch(function(e){ console.error("Local assignment update failed:", e); });
      return updated;
    });
    var existing = assignments.find(function(x){ return x.id===id; });
    if (user && existing && existing.firestoreId) {
      beginSync();
      updateAssignmentInCloud(existing.firestoreId, fields).then(function(){ endSync(true); }).catch(function(e){ endSync(false); console.error("Assignment update error:", e); });
    }
  }
  function toggleAssignment(id, completed) { updateAssignment(id, {completed:completed, completedAt: completed?Date.now():null}); }
  async function deleteAssignment(id) {
    var a = assignments.find(function(x){ return x.id===id; });
    if (a && a.firestoreId) await deleteAssignmentFromCloud(a.firestoreId);
    setAssignments(function(list){
      var updated = list.filter(function(x){ return x.id!==id; });
      if (user) assignmentsRepository.delete(id).catch(function(e){ console.error("Local assignment delete failed:", e); });
      return updated;
    });
  }

  // ── Exam results (Advanced Analytics score history) ─────────────────────────
  function recordExamResult(payload) {
    var newResult = { id:Date.now(), ...payload };
    setExamResults(function(r){
      var updated = [newResult, ...r];
      if (user) persistExamResultsLocal(user.uid, updated);
      return updated;
    });
    if (user) {
      saveExamResultToCloud(user.uid, newResult).then(function(firestoreId){
        if (firestoreId) {
          setExamResults(function(r){
            var updated = r.map(function(x){ return x.id===newResult.id ? {...x, firestoreId:firestoreId} : x; });
            persistExamResultsLocal(user.uid, updated);
            return updated;
          });
        }
      }).catch(function(e){ console.error("Background exam result save failed:", e); });
    }
  }

  // ── Flashcards & Quizzes: local structured persistence (IndexedDB) ─────────────
  // Flashcard decks and quiz question-sets used to be fully ephemeral — generated
  // into a screen's own React state and gone the moment the student navigated away.
  // (Flashcards had one escape hatch already — manually flattening a deck into a
  // Note's Markdown via the existing Save button — that path is completely
  // untouched and still works exactly as before.) These two helpers give both a
  // real, structured local home via flashcardsRepository/quizzesRepository
  // (IndexedDB) the moment they're generated — silently, in the background, same
  // fire-and-forget-with-logging pattern every other local write in this file
  // already uses. Nothing in the UI changes because of this: no new buttons, no
  // new screens — this just means the data no longer has to vanish.
  function saveFlashcardDeckLocally(deck, note){
    if (!user || !deck || !deck.length) return;
    flashcardsRepository.create({
      userId: user.uid,
      noteId: note ? note.id : null,
      course: note ? note.course : null,
      title: note ? note.title : "Flashcards",
      cards: deck,
    }).catch(function(e){ console.error("Local flashcard deck save failed:", e); });
  }
  function saveQuizLocally(questions, meta){
    if (!user || !questions || !questions.length) return;
    quizzesRepository.create({
      userId: user.uid,
      noteId: (meta && meta.noteId!=null) ? meta.noteId : null,
      course: (meta && meta.course) ? meta.course : null,
      source: (meta && meta.source) ? meta.source : "quizme",
      questions: questions,
    }).catch(function(e){ console.error("Local quiz save failed:", e); });
  }
  // Same pattern as the two helpers above: StudyPlannerScreen's existing "Save"
  // button (flattening a plan into a Note) is untouched — this adds a silent,
  // structured local copy of the generated plan the moment it's produced.
  function saveStudyPlanLocally(planText, meta){
    if (!user || !planText || !planText.trim()) return;
    // Previously fire-and-forget into studyPlansRepository only — the in-memory
    // `studyPlans` state never got the new plan, so it went stale the instant a
    // plan was created (only fixed by a full reload). That staleness would have
    // let a study plan silently escape the courseId-cleanup below whenever a
    // course was deleted right after a plan referencing it was generated —
    // fixing it here since Manage Courses' delete now depends on this state
    // actually being accurate, not just eventually-correct-after-reload.
    var createdAt = Date.now();
    var newPlan = {
      id: createdAt,
      userId: user.uid,
      courses: (meta && meta.courses) || [],
      courseIds: (meta && meta.courseIds) || [],
      examDate: (meta && meta.examDate) || null,
      hoursPerDay: (meta && meta.hoursPerDay) || null,
      planText: planText,
      createdAt: createdAt,
    };
    setStudyPlans(function(list){
      var updated = [newPlan, ...list];
      studyPlansRepository.create(newPlan).catch(function(e){ console.error("Local study plan save failed:", e); });
      return updated;
    });
  }
  // Added alongside Manage Courses — lets deleteCourseRecord (below) remove a
  // deleted course's id from any study plan's courseIds array, instead of
  // leaving a dangling reference. studyPlansRepository.update already existed
  // (confirmed generic) — this is its first caller.
  function updateStudyPlanRecord(id, fields) {
    setStudyPlans(function(list){
      var updated = list.map(function(p){ return p.id===id ? {...p, ...fields} : p; });
      if (user) studyPlansRepository.update(id, fields).catch(function(e){ console.error("Local study plan update failed:", e); });
      return updated;
    });
  }

  // ── Lecture Recordings library ────────────────────────────────────────────────
  // Called right after a live recording stops — saves the raw audio into IndexedDB
  // (device-local, no Firebase Storage/Blaze plan needed) and tracks metadata in
  // Firestore so the recording is there even if the app is closed before the student
  // decides whether/when to turn it into notes.
  // Returns a Promise that resolves only once BOTH the metadata write
  // (recordingsRepository.create) and the audio blob write (saveAudioBlobLocal)
  // have genuinely completed — not just been started. Previously this function
  // returned nothing, so VoiceNoteScreen's stopRecording() had no way to know
  // when (or whether) either write actually finished, and moved straight to
  // the "✅ Your recording has been saved" modal — which also offers immediate
  // navigation away — the instant this function was merely CALLED. If the
  // student tapped away while these async IndexedDB writes were still in
  // flight, closing the tab could abort them before they committed, silently
  // losing the recording despite the confirmation the student had just seen.
  // See stopRecording() for the other half of this fix — it now awaits this
  // promise before ever showing that modal.
  function saveRecordingFromSession(id, blob, mimeType, meta) {
    if (!user) return Promise.reject(new Error("Not signed in."));
    // userId is required here — recordingsRepository.list(uid) (called on every
    // login/reload) queries IndexedDB's "by_userId" index, so a record missing
    // this field is invisible to that query no matter how correctly it was
    // otherwise saved. It would "self-heal" on a later reload ONLY once the
    // Firestore fetch below succeeds and syncRecordingsToRepository re-creates
    // the local copy from the cloud version (saveRecordingMeta does stamp
    // userId on that one) — meaning any reload while offline or slow, which is
    // exactly the condition this app is built around, left the recording
    // invisible with no recovery for that whole session, even though the audio
    // blob itself was always intact in the separate jotting_audio_db.
    var placeholder = { id:id, userId:user.uid, title:meta.title, course:meta.course, createdAt:Date.now(), durationSeconds:meta.durationSeconds||0, sizeBytes:blob.size, mimeType:mimeType, transcribed:false, noteId:null, audioReady:false };
    setRecordings(function(r){ return [placeholder, ...r]; });
    var metaSave = recordingsRepository.create(placeholder);
    var audioSave = saveAudioBlobLocal(id, blob, mimeType);
    return Promise.all([metaSave, audioSave]).then(function(){
      var final = {...placeholder, audioReady:true};
      setRecordings(function(r){
        var updated = r.map(function(x){ return x.id===id ? final : x; });
        recordingsRepository.update(id, {audioReady:true}).catch(function(e){ console.error("Local recording metadata update failed:", e); });
        return updated;
      });
      saveRecordingMeta(user.uid, final);
      return final;
    }).catch(function(e){
      console.error("Recording save failed (metadata and/or audio):", e);
      setRecordings(function(r){
        var updated = r.map(function(x){ return x.id===id ? {...x, uploadFailed:true} : x; });
        if (user) recordingsRepository.update(id, {uploadFailed:true}).catch(function(e2){ console.error("Local recording metadata update failed:", e2); });
        return updated;
      });
      throw e;
    });
  }

  function renameRecording(id, newTitle) {
    setRecordings(function(r){
      var updated = r.map(function(x){ return x.id===id ? {...x, title:newTitle} : x; });
      if (user) recordingsRepository.update(id, {title:newTitle}).catch(function(e){ console.error("Local recording metadata update failed:", e); });
      return updated;
    });
    updateRecordingMeta(id, {title:newTitle});
  }

  async function deleteRecording(id) {
    setRecordings(function(r){
      var updated = r.filter(function(x){ return x.id!==id; });
      if (user) recordingsRepository.delete(id).catch(function(e){ console.error("Local recording metadata delete failed:", e); });
      return updated;
    });
    await deleteAudioBlobLocal(id);
    await deleteRecordingMeta(id);
  }

  function markRecordingTranscribed(recordingId, noteId) {
    setRecordings(function(r){
      var updated = r.map(function(x){ return x.id===recordingId ? {...x, transcribed:true, noteId:noteId} : x; });
      if (user) recordingsRepository.update(recordingId, {transcribed:true, noteId:noteId}).catch(function(e){ console.error("Local recording metadata update failed:", e); });
      return updated;
    });
    updateRecordingMeta(recordingId, {transcribed:true, noteId:noteId});
  }

  // "Transcribe" from the Recordings library — pulls the audio back out of IndexedDB and
  // hands it to the Record Lecture screen's normal review → convert → save flow.
  async function openRecordingForTranscription(rec) {
    try {
      var blob = await getAudioBlobLocal(rec.id);
      if (!blob) { alert("This recording's audio isn't saved on this device — recordings are stored locally, not in the cloud. Try opening it from the device you originally recorded it on."); return; }
      setResumeRecording({ blob:blob, mimeType:rec.mimeType, title:rec.title, course:rec.course, recordingId:rec.id });
      go("voice", tab);
    } catch(e) {
      alert("Couldn't load this recording — try again.");
    }
  }

  async function handleLogout() {
    if (!window.confirm("Are you sure you want to logout?")) return;
    await signOut(auth);
    setScreen("home"); setTab("home");
  }

  var NAV = [
    {id:"home",icon:"🏠",label:"Home",s:"home"},
    {id:"library",icon:"📚",label:"Library",s:"library"},
    {id:"new",icon:"+",label:"New",s:"voice",special:true},
    {id:"dashboard",icon:"📊",label:"Stats",s:"dashboard"},
    {id:"settings",icon:"⚙️",label:"Settings",s:"settings"},
  ];

  // Loading spinner
  if (authLoading) {
    return (
      <div style={{ minHeight:"100vh",background:"#06081A",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16 }}>
        <div style={{ width:70,height:70,borderRadius:20,overflow:"hidden" }}><img src="/jotting-logo.png" alt="Jotting AI" style={{ width:"100%",height:"100%",objectFit:"cover" }}/></div>
        <div style={{ width:36,height:36,borderRadius:"50%",border:"3px solid rgba(6,182,212,0.3)",borderTop:"3px solid #06B6D4",animation:"spin 1s linear infinite" }}/>
        <p style={{ color:C.muted,fontSize:14,fontFamily:"sans-serif" }}>Loading Jotting AI...</p>
        <style>{"@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}"}</style>
      </div>
    );
  }

  // Onboarding
  if (showOnboarding) {
    return (
      <div style={{ height:"100dvh",background:"#06081A",display:"flex",justifyContent:"center",alignItems:"center",overflow:"hidden" }}>
        <style>{"@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;font-family:'DM Sans',sans-serif;}body{margin:0;background:#06081A;}button,textarea,input{font-family:'DM Sans',sans-serif;}::-webkit-scrollbar{width:0;}@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}"}</style>
        <div style={{ width:"100%",maxWidth:400,height:"100dvh",background:C.bg,overflow:"hidden",display:"flex",flexDirection:"column",boxShadow:"0 24px 80px rgba(6,182,212,0.12)" }}>
          <OnboardingScreen onDone={function(){setShowOnboarding(false);}}/>
        </div>
      </div>
    );
  }

  // Login screen
  if (!user) {
    return (
      <div style={{ height:"100dvh",background:"#06081A",display:"flex",justifyContent:"center",alignItems:"center",overflow:"hidden" }}>
        <style>{"@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;font-family:'DM Sans',sans-serif;}body{margin:0;background:#06081A;}button,textarea,input{font-family:'DM Sans',sans-serif;}::-webkit-scrollbar{width:0;}input::placeholder{color:#4B5563;}@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}"}</style>
        <div style={{ width:"100%",maxWidth:400,height:"100dvh",background:C.bg,overflow:"hidden",display:"flex",flexDirection:"column",boxShadow:"0 24px 80px rgba(6,182,212,0.12)" }}>
          <LoginScreen onLogin={function(u, meta){ if (meta && meta.justSignedUp) justSignedUpRef.current = true; setUser(u); }}/>
        </div>
      </div>
    );
  }

  // PIN Lock screen — shown after returning to the app if PIN + Auto Lock are both on
  if (locked) {
    return <LockScreen verifyPin={verifyPin} onUnlock={function(){setLocked(false);}} onForgot={handleLogout}/>;
  }

  // Main app
  return (
    <div style={{ height:"100dvh",background:"#06081A",display:"flex",justifyContent:"center",alignItems:"center",overflow:"hidden" }}>
      <style>{"\n@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');\n*{box-sizing:border-box;font-family:'DM Sans',sans-serif;}\nhtml,body{height:100%;overflow:hidden;position:fixed;width:100%;margin:0;background:#06081A;}\nbutton,textarea,input{font-family:'DM Sans',sans-serif;}\n::-webkit-scrollbar{width:0;}\ninput::placeholder,textarea::placeholder{color:#4B5563;}\n@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}\n@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,0.4)}50%{box-shadow:0 0 0 20px rgba(239,68,68,0)}}\n@keyframes wv{from{transform:scaleY(0.3)}to{transform:scaleY(1.2)}}\n@keyframes dot{from{opacity:0.3;transform:scale(0.7)}to{opacity:1;transform:scale(1)}}\n.samx-md p{margin:6px 0;}\n.samx-md ul,.samx-md ol{padding-left:20px;margin:8px 0;}\n.samx-md li{margin:4px 0;}\n.samx-md h1{margin:4px 0 14px;font-size:22px;font-weight:800;color:#F1F5F9;border-bottom:2px solid rgba(6,182,212,0.3);padding-bottom:8px;}\n.samx-md h2{margin:20px 0 8px;font-size:16px;font-weight:800;color:#06B6D4;}\n.samx-md h3{margin:12px 0 6px;font-size:14px;font-weight:700;color:#A78BFA;}\n.samx-md strong{color:#F1F5F9;}\n.samx-md code{background:rgba(6,182,212,0.15);color:#06B6D4;padding:2px 6px;border-radius:5px;font-size:13px;font-family:monospace;}\n.samx-md pre{background:#0A0F1E;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px;overflow-x:auto;margin:8px 0;}\n.samx-md pre code{background:transparent;color:#E2E8F0;padding:0;}\n.samx-md table{border-collapse:collapse;width:100%;font-size:13px;margin:10px 0;}\n.samx-md th,.samx-md td{border:1px solid rgba(255,255,255,0.08);padding:6px 10px;text-align:left;}\n.samx-md th{background:rgba(255,255,255,0.05);}\n.samx-md blockquote{border-left:3px solid #06B6D4;padding-left:10px;margin:8px 0;color:#94A3B8;}\n"}</style>
      <div style={{ width:"100%",maxWidth:400,height:"100dvh",background:C.bg,overflow:"hidden",display:"flex",flexDirection:"column",boxShadow:"0 24px 80px rgba(6,182,212,0.12), 0 0 0 1px rgba(255,255,255,0.06)" }}>
        <div style={{ background:syncBarMeta.bg,padding:"6px 16px",textAlign:"center",fontSize:11,fontWeight:700,color:syncBarMeta.color,flexShrink:0 }}>{syncBarMeta.icon} {syncBarMeta.label}</div>
        {swUpdateAvailable&&<div style={{ background:"rgba(167,139,250,0.15)",padding:"10px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10 }}><span style={{ fontSize:12,color:C.purple,fontWeight:600 }}>🔄 A new version of Jotting AI is ready</span><button onClick={applyAppUpdate} style={{ background:C.purple,border:"none",borderRadius:8,padding:"5px 12px",color:"#fff",fontSize:11,fontWeight:800,cursor:"pointer",flexShrink:0 }}>Refresh</button></div>}
        {cloudLoading&&<div style={{ background:"rgba(6,182,212,0.1)",padding:"10px",textAlign:"center",fontSize:12,color:C.cyan,fontWeight:600 }}>☁️ Syncing your notes...</div>}
        <div style={{ flex:1,display:"flex",flexDirection:"column",overflowY:"auto",minHeight:0 }}>
          {screen==="home"&&<CommandCenterScreen notes={visibleNotes} recordings={recordings} assignments={assignments} topicMastery={topicMastery} courses={courses} user={user} plan={plan} onVoice={function(){setResumeRecording(null);go("voice","new");}} onDraw={function(){go("draw");}} onAIWrite={function(){go("aiwrite");}} onScan={function(){go("scan");}} onChat={function(seed){setAiChatSeed(seed||null);go("ai");}} onRecordings={function(){setScreen("recordings");}} onStudyPlanner={function(){go("studyplanner","home");}} onExamMode={function(){go("exammode","home");}} onAssignments={function(){go("assignments","home");}} onFlashcards={function(){go("flashcards","home");}} onAITutor={function(){go("aitutor","home");}} onSearch={function(){setPendingAssignmentId(null);setScreen("search");}} onNotifications={function(){setScreen("notifications");}} onProfile={function(){setScreen("profile");}} unreadCount={notifCenter.filter(function(n){return !n.read;}).length} onOpenMission={function(){go("mission","home");}} onOpenCourse={function(c){setActiveCourse(c);go("course");}} onOpenTopic={function(m){setActiveTopicId(m.id);go("topic");}} onStartStudySession={startStudySession} onOpenVault={function(){go("vault","home");}} onOpenUpcoming={function(){go("upcoming","home");}} onOpenProgress={function(){go("progress","dashboard");}} onCreateNote={function(){go("createnote","home");}} onUploadMaterial={function(){go("uploadmaterial","home");}} onAddAssignmentDirect={function(){setAssignmentAddMode(true);go("assignments","home");}}/>}
          {screen==="course"&&activeCourse&&<CourseOverviewScreen course={activeCourse} courses={courses} assignments={assignments} topicMastery={topicMastery} materials={materials} onBack={function(){go(tab,tab);}} onAITutor={function(){go("aitutor","home");}} onFlashcards={function(){go("flashcards","home");}} onExamMode={function(){go("exammode","home");}} onOpenTopic={function(m){setActiveTopicId(m.id);go("topic");}}/>}
          {screen==="vault"&&<StudyVaultScreen notes={visibleNotes} recordings={recordings} materials={materials} quizzes={quizzes} flashcardDecks={flashcardDecks} courses={courses} semesters={semesters} onBack={function(){go(tab,tab);}} onOpenCourse={function(c){setActiveVaultCourse(c);go("vaultcourse");}} onManageSemesters={function(){go("managesemesters",tab);}} onManageCourses={function(){go("managecourses",tab);}}/>}
          {screen==="managesemesters"&&<ManageSemestersScreen semesters={semesters} courses={courses} onBack={function(){go("vault",tab);}} onAdd={addSemester} onUpdate={updateSemesterRecord} onDelete={deleteSemesterRecord} onUpdateCourse={updateCourseRecord}/>}
          {screen==="managecourses"&&<ManageCoursesScreen courses={courses} semesters={semesters} onBack={function(){go("vault",tab);}} onAdd={addCourse} onUpdate={updateCourseRecord} onDelete={deleteCourseRecord}/>}
          {screen==="vaultcourse"&&activeVaultCourse&&<StudyVaultCourseScreen course={activeVaultCourse} courses={courses} notes={visibleNotes} recordings={recordings} materials={materials} quizzes={quizzes} flashcardDecks={flashcardDecks} onBack={function(){go("vault",tab);}} onOpenNote={function(n){setActiveNote(n);go("detail");}} onOpenRecordings={function(){go("recordings",tab);}}/>}
          {screen==="topic"&&activeTopicId!=null&&<TopicMasteryScreen topicId={activeTopicId} topicMastery={topicMastery} onBack={function(){go(tab,tab);}} onAITutor={function(){go("aitutor","home");}} onFlashcards={function(){go("flashcards","home");}}/>}
          {screen==="mission"&&<TodaysMissionScreen onBack={function(){go(tab,tab);}} notes={visibleNotes} recordings={recordings} assignments={assignments} topicMastery={topicMastery} studyPlans={studyPlans} onAssignments={function(){go("assignments","home");}} onAITutor={function(){go("aitutor","home");}} onExamMode={function(){go("exammode","home");}} onVoice={function(){setResumeRecording(null);go("voice","new");}} onStudyPlanner={function(){go("studyplanner","home");}}/>}
          {screen==="upcoming"&&<UpcomingScreen assignments={assignments} studyPlans={studyPlans} onBack={function(){go(tab,tab);}} onOpenAssignment={function(id){setPendingAssignmentId(id);go("assignments",tab);}}/>}
          {screen==="library"&&<LibraryScreen notes={visibleNotes} hiddenNotes={hiddenNotesList} hiddenFolderEnabled={privacy.hiddenFolder} pinEnabled={privacy.pinEnabled} verifyPin={verifyPin} onNote={function(n){setActiveNote(n);go("detail");}} onDelete={deleteNote}/>}
          {screen==="dashboard"&&<DashboardScreen notes={notes} user={user} credits={credits} plan={plan} profile={profile} onOpenAnalytics={function(){go("analytics","dashboard");}} onOpenProgress={function(){go("progress","dashboard");}}/>}
          {screen==="analytics"&&<AdvancedAnalyticsScreen notes={notes} assignments={assignments} examResults={examResults} plan={plan} onBack={function(){go(tab,tab);}} onUpgrade={function(){setScreen("pricing");}}/>}
          {screen==="progress"&&<ProgressInsightsScreen studySessions={studySessions} examResults={examResults} topicMastery={topicMastery} onBack={function(){go(tab,tab);}} onOpenTopic={function(m){setActiveTopicId(m.id);go("topic");}}/>}
          {screen==="detail"&&activeNote&&<NoteDetail note={activeNote} onBack={function(){ if(studySession){studyStepReturn();}else{go(tab==="library"?"library":"home",tab);} }} onDelete={deleteNote} onUpdate={updateNote} onSaveQuiz={saveQuizLocally}/>}
          {screen==="voice"&&<VoiceNoteScreen onBack={function(){setResumeRecording(null);go("home","home");}} onSave={saveNote} recQuality={recQuality} recSettings={recSettings} onSaveRecording={saveRecordingFromSession} onDeleteRecording={deleteRecording} onMarkTranscribed={markRecordingTranscribed} onOpenRecordings={function(){setScreen("recordings");}} resumeAudio={resumeRecording} courses={courses} onCreateCourse={addCourse}/>}
          {screen==="draw"&&<DrawScreen onBack={function(){go("home","home");}} onSave={saveNote} courses={courses} onCreateCourse={addCourse}/>}
          {screen==="aiwrite"&&<AIWriteScreen onBack={function(){go("home","home");}} onSave={saveNote} courses={courses} onCreateCourse={addCourse}/>}
          {screen==="scan"&&<ScanDocScreen onBack={function(){go("home","home");}} onSave={saveNote} courses={courses} onCreateCourse={addCourse}/>}
          {screen==="ai"&&<AIScreen notes={notes} onBack={function(){setAiChatSeed(null);go("home","home");}} chatSessions={chatSessions} onSaveSession={saveChatSession} onDeleteSession={deleteChatSession} initialPrefill={aiChatSeed&&aiChatSeed.initialPrefill} initialSend={aiChatSeed&&aiChatSeed.initialSend} initialPicker={aiChatSeed&&aiChatSeed.initialPicker}/>}
          {screen==="recordings"&&<RecordingsScreen recordings={recordings} onBack={function(){go(tab,tab);}} onRename={renameRecording} onDelete={deleteRecording} onTranscribe={openRecordingForTranscription}/>}
          {screen==="studyplanner"&&<StudyPlannerScreen notes={notes} onBack={function(){go(tab,tab);}} plan={plan} onUpgrade={function(){setScreen("pricing");}} onSaveNote={saveNote} onSavePlan={saveStudyPlanLocally} courses={courses} onCreateCourse={addCourse}/>}
          {screen==="exammode"&&<ExamModeScreen notes={notes} onBack={function(){ if(studySession){studyStepReturn();}else{go(tab,tab);} }} plan={plan} onUpgrade={function(){setScreen("pricing");}} onRecordResult={recordExamResult} onSaveQuiz={saveQuizLocally}/>}
          {screen==="assignments"&&<AssignmentsScreen assignments={assignments} notes={notes} courses={courses} onBack={function(){ setAssignmentAddMode(false); go(tab,tab); }} onAdd={addAssignment} onUpdate={updateAssignment} onToggle={toggleAssignment} onDelete={deleteAssignment} openAssignmentId={pendingAssignmentId} openInAddMode={assignmentAddMode}/>}
          {screen==="search"&&<UnifiedSearchScreen notes={notes} assignments={assignments} recordings={recordings} onBack={function(){go(tab,tab);}} onOpenNote={function(n){setActiveNote(n);go("detail");}} onOpenAssignment={function(id){setPendingAssignmentId(id);go("assignments",tab);}} onOpenRecordings={function(){go("recordings",tab);}}/>}
          {screen==="flashcards"&&<FlashcardsScreen notes={notes} onBack={function(){ if(studySession){studyStepReturn();}else{go(tab,tab);} }} onSaveNote={saveNote} onSaveDeck={saveFlashcardDeckLocally}/>}
          {screen==="createnote"&&<CreateNoteScreen onBack={function(){go("home","home");}} onSave={saveNote} courses={courses} onCreateCourse={addCourse}/>}
          {screen==="uploadmaterial"&&<UploadMaterialScreen onBack={function(){go("home","home");}} onSave={addMaterial} courses={courses} onCreateCourse={addCourse}/>}
          {screen==="studysession"&&studySession&&<StudySessionScreen session={studySession} plan={plan} onStart={startStudyStep} onSkip={studySessionSkip} onAdvance={studySessionAdvance} onFinish={finishStudySession} onEnd={endStudySession}/>}
          {screen==="studysessioncomplete"&&studySession&&<StudySessionCompleteScreen session={studySession} notes={visibleNotes} recordings={recordings} assignments={assignments} topicMastery={topicMastery} onDone={endStudySession} onAssignments={function(){go("assignments","home");}} onAITutor={function(){go("aitutor","home");}} onExamMode={function(){go("exammode","home");}} onVoice={function(){setResumeRecording(null);go("voice","new");}} onStudyPlanner={function(){go("studyplanner","home");}}/>}
          {screen==="aitutor"&&<AITutorScreen notes={notes} onBack={function(){ if(studySession){studyStepReturn();}else{go(tab,tab);} }} plan={plan} onUpgrade={function(){setScreen("pricing");}} sessions={chatSessions} onSaveSession={saveChatSession} onDeleteSession={deleteChatSession}/>}
          {screen==="settings"&&<SettingsScreen user={user} onLogout={handleLogout} recQuality={recQuality} setRecQuality={setRecQuality} recSettings={recSettings} setRecSettings={setRecSettings} plan={plan} credits={credits} onViewPlans={function(){setScreen("pricing");}} themeName={themeName} onSelectTheme={selectTheme} notifPrefs={notifPrefs} setNotifPrefs={setNotifPrefs} privacy={privacy} onSetPin={setPinCode} onDisablePin={disablePin} onSetAutoLock={setAutoLock} onSetHiddenFolder={setHiddenFolder} aiStyle={aiStyle} setAiStyle={setAiStyle} aiLength={aiLength} setAiLength={setAiLength} aiLanguage={aiLanguage} setAiLanguage={setAiLanguage} isIOS={isIOS} isStandalone={isStandalone} installPromptEvent={installPromptEvent} promptInstall={promptInstall} onRefreshVerification={refreshEmailVerification}/>}
          {screen==="pricing"&&<PricingScreen onBack={function(){go("settings","settings");}} plan={plan} credits={credits} user={user} onPlanUpdated={function(newPlan,newCredits){ setPlan(newPlan); setCredits(newCredits); addNotificationRef.current("app_update","🎉 Plan updated","You're now on the "+((PLANS[newPlan]||PLANS.free).name)+" plan.", {screen:"pricing"}); }}/>}
          {screen==="notifications"&&<NotificationScreen onBack={function(){go(tab,tab);}} notifications={notifCenter} onMarkRead={markNotifRead} onMarkAllRead={markAllNotifsRead} onNavigate={navigateFromNotification} notifEnabled={notifEnabled} setNotifEnabled={setNotifEnabled} user={user}/>}
          {screen==="profile"&&<ProfileScreen onBack={function(){go(tab,tab);}} user={user} plan={plan} credits={credits} profile={profile} onSaveProfile={saveProfile} onLogout={handleLogout}/>}
        </div>
        <div style={{ background:C.card2,borderTop:"1px solid "+C.border,padding:"10px 10px 16px",display:"flex",justifyContent:"space-around",alignItems:"center",flexShrink:0 }}>
          {NAV.map(function(item){return(
            <button key={item.id} onClick={function(){ if(item.s==="voice") setResumeRecording(null); go(item.s,item.id); }} style={{ background:item.special?"linear-gradient(135deg,#06B6D4,#A78BFA)":"none",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:item.special?"0":"4px 8px",width:item.special?52:"auto",height:item.special?52:"auto",borderRadius:item.special?"50%":0,boxShadow:item.special?"0 4px 20px rgba(6,182,212,0.4)":"none",justifyContent:"center",flexShrink:0 }}>
              <span style={{ fontSize:item.special?24:20,color:item.special?"#fff":tab===item.id?C.cyan:"#4B5563" }}>{item.icon}</span>
              {!item.special&&<span style={{ fontSize:10,fontWeight:700,color:tab===item.id?C.cyan:"#4B5563" }}>{item.label}</span>}
              {!item.special&&tab===item.id&&<div style={{ width:4,height:4,borderRadius:"50%",background:C.cyan }}/>}
            </button>
          );})}
        </div>
      </div>
    </div>
  );
}