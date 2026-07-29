 import { useState, useEffect, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, updateProfile, sendPasswordResetEmail, GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import { getFirestore, collection, addDoc, getDocs, getDoc, deleteDoc, doc, setDoc, query, where } from "firebase/firestore";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import mammoth from "mammoth";

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
const googleProvider = new GoogleAuthProvider();

const C = {
  bg: "#0A0F1E", card: "#111827", card2: "#1E293B",
  border: "rgba(255,255,255,0.06)", cyan: "#06B6D4",
  purple: "#A78BFA", amber: "#F59E0B", green: "#34D399",
  red: "#F87171", text: "#F1F5F9", muted: "#64748B", soft: "#94A3B8",
};

// ── Subscription plans & AI credit costs ───────────────────────────────────────
// Adding a new plan later is just adding a new key here — nothing else needs to change.
// IMPORTANT: netlify/functions/generate.js keeps its own matching copy of the credit
// allocations (server-side enforcement can't trust anything sent from the browser),
// so if you change numbers here, update that file too.
const PLANS = {
  free:    { id:"free",    name:"Free",    priceMonthly:0,   priceYearly:0,     monthlyCredits:60,   color:C.muted,  tagline:"Get started",          features:["Unlimited notes & Library","60 AI credits / month","Voice recording & transcription","AI Chat, Scan Doc & quizzes"] },
  pro:     { id:"pro",     name:"Pro",     priceMonthly:550, priceYearly:5500,  monthlyCredits:400,  color:C.cyan,   tagline:"For regular studying",   features:["Everything in Free","400 AI credits / month","Faster, priority AI responses","More cloud storage","Priority support"] },
  premium: { id:"premium", name:"Premium", priceMonthly:1500,priceYearly:15000, monthlyCredits:1500, color:C.purple, tagline:"For serious exam prep",  features:["Everything in Pro","1,500 AI credits / month","AI Study Planner","Exam Mode","Advanced AI Tutor","Advanced analytics & maximum storage"] },
};
const LOW_CREDIT_WARNING_THRESHOLD = 10;

async function getIdToken(){
  try{ return auth.currentUser ? await auth.currentUser.getIdToken() : null; }catch(e){ return null; }
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

async function callGeminiText(promptText, maxTokens, action) {
  return await callProxy(action||"chat", { contents:[{role:"user",parts:[{text:promptText}]}], maxTokens:maxTokens||800 }, updateGlobalCredits);
}

// Full multi-turn chat: `contents` is the whole conversation so far (each turn
// {role:"user"|"model", parts:[{text}]}), so SAM-X actually remembers context
// across messages instead of treating every question in isolation.
// The real Gemini key can't be relayed as a raw token-stream through a standard
// serverless function, so the proxy returns the complete answer in one shot and
// this reveals it word-by-word client-side — same smooth feel, secure underneath.
async function callGeminiChatStream(contents, systemInstruction, onChunk, signal, maxTokens, action) {
  var text = await callProxy(action||"chat", { contents:contents, systemInstruction:systemInstruction, maxTokens:maxTokens||1200 }, updateGlobalCredits);
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
  return await callProxy(action||"pdf_analysis", { contents:[{role:"user",parts:[{inline_data:{mime_type:mediaType,data:base64}},{text:promptText}]}], maxTokens:maxTokens||1200 }, updateGlobalCredits);
}

// SAM-X can listen to real recorded audio directly and produce text from it —
// this powers the record-then-transcribe flow (full transcript / smart notes / summary).
async function callGeminiAudio(base64, mediaType, promptText, maxTokens, action) {
  return await callProxy(action||"transcribe", { contents:[{role:"user",parts:[{inline_data:{mime_type:mediaType,data:base64}},{text:promptText}]}], maxTokens:maxTokens||2000 }, updateGlobalCredits);
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

// Local durable cache: notes always land here immediately, independent of Firestore's
// success/speed, so a refresh never loses what you just saved.
function loadNotesLocal(userId) {
  try {
    var raw = localStorage.getItem("jotting_notes_"+userId);
    return raw ? JSON.parse(raw) : [];
  } catch(e) { return []; }
}
function persistNotesLocal(userId, notesList) {
  try { localStorage.setItem("jotting_notes_"+userId, JSON.stringify(notesList)); } catch(e){}
}

// ── Chat session persistence (SAM-X AI chat history) ───────────────────────────
// Each session keeps its own stable id (client-generated), so saving is just an
// upsert to that same Firestore doc — no separate firestoreId bookkeeping needed.
async function saveChatToCloud(userId, session) {
  try { await setDoc(doc(db, "chats", session.id), { ...session, userId }); }
  catch(e) { console.error("Chat save error:", e); }
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

// ── Profile (school/department/level) + daily study streak ────────────────────
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
      var fresh = { school:"", department:"", level:"", streak:1, lastActiveDay:today };
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
  } catch(e) { console.error("Profile load error:", e); return { school:"", department:"", level:"", streak:1, lastActiveDay:dayKey() }; }
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
function makeNotif(type, title, message){
  return { id:"n_"+Date.now()+"_"+Math.floor(Math.random()*1000), type:type, title:title, message:message, ts:Date.now(), read:false };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// ── Browser push notifications (for study reminders) ───────────────────────────
function requestNotificationPermission(){
  if ("Notification" in window && Notification.permission==="default") {
    Notification.requestPermission().catch(function(){});
  }
}
function sendNotification(title, body){
  if ("Notification" in window && Notification.permission==="granted") {
    try{ new Notification(title, { body:body, icon:"/favicon.ico" }); }catch(e){}
  }
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

// ── ONBOARDING SCREEN ─────────────────────────────────────────────────────────
function OnboardingScreen({ onDone }) {
  var [page, setPage] = useState(0);
  var pages = [
    { icon:"🎵", title:"Welcome to Jotting AI", desc:"The smartest note-taking app for Nigerian university students", color:"#06B6D4", bg:"linear-gradient(135deg,#0A0F1E,#1E1B4B)" },
    { icon:"🎙️", title:"Record Your Lectures", desc:"Record your lecturer's voice and our AI converts it to perfect notes automatically", color:"#A78BFA", bg:"linear-gradient(135deg,#0A0F1E,#1E0B4B)" },
    { icon:"🤖", title:"AI-Powered Learning", desc:"Get instant summaries, quizzes, and flashcards from your notes using SAM-X AI", color:"#34D399", bg:"linear-gradient(135deg,#0A0F1E,#0B1E1B)" },
    { icon:"📚", title:"Study Smarter", desc:"Library, Dashboard, Push Notifications — everything you need to ace your exams", color:"#F59E0B", bg:"linear-gradient(135deg,#0A0F1E,#1E1A0A)" },
  ];
  var p = pages[page];
  return (
    <div style={{ flex:1,background:p.bg,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,textAlign:"center" }}>
      <div style={{ fontSize:80,marginBottom:24 }}>{p.icon}</div>
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
        setSuccess("Account created successfully!");
        onLogin(cred.user);
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
    setLoading(true); setError("");
    try {
      var result = await signInWithPopup(auth, googleProvider);
      onLogin(result.user);
    } catch(e) {
      setError(getErrorMsg(e.code));
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
        <div style={{ width:70,height:70,borderRadius:20,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:34,margin:"0 auto 16px" }}>🎵</div>
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
function VoiceNoteScreen({ onBack, onSave, recQuality, recSettings }) {
  recQuality = recQuality || "Medium";
  recSettings = recSettings || { noise:true, autoTranscribe:false, speakerID:false, autoSave:false };
  var QUALITY_BITRATE = { Low:16000, Medium:32000, High:64000 };
  var MAX_AUDIO_BYTES = 18 * 1024 * 1024; // safety margin under Gemini's 20MB inline request cap

  var [phase,setPhase]=useState("idle"); // idle | recording | paused | stopped | transcribing | reviewing
  var [elapsed,setElapsed]=useState(0);
  var [title,setTitle]=useState("");var [courses,setCourses]=useState(["General"]);var [course,setCourse]=useState("General");
  var [showAddCourse,setShowAddCourse]=useState(false);var [newCourse,setNewCourse]=useState("");
  var [status,setStatus]=useState("Tap Start Recording to begin");
  var [wantFull,setWantFull]=useState(true);var [wantSmart,setWantSmart]=useState(true);var [wantSummary,setWantSummary]=useState(true);
  var [outputs,setOutputs]=useState({full:"",smart:"",summary:""});
  var [activeTab,setActiveTab]=useState(null);
  var [audioSizeWarning,setAudioSizeWarning]=useState("");
  var [saving,setSaving]=useState(false);

  var timerRef=useRef(null);
  var mediaRecorderRef=useRef(null);
  var streamRef=useRef(null);
  var chunksRef=useRef([]);
  var audioBlobRef=useRef(null);
  var mimeTypeRef=useRef("audio/webm");

  var fmt=function(s){return String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");};
  function addCourse(){var c=newCourse.trim().toUpperCase();if(!c||courses.includes(c))return;setCourses(function(p){return[...p,c];});setNewCourse("");setShowAddCourse(false);}
  function removeCourse(c){if(c==="General")return;setCourses(function(p){return p.filter(function(x){return x!==c;});});if(course===c)setCourse("General");}

  useEffect(function(){
    return function(){
      clearInterval(timerRef.current);
      try{ mediaRecorderRef.current && mediaRecorderRef.current.state!=="inactive" && mediaRecorderRef.current.stop(); }catch(e){}
      try{ streamRef.current && streamRef.current.getTracks().forEach(function(t){t.stop();}); }catch(e){}
    };
  }, []);

  async function startRecording(){
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){ setStatus("Your browser doesn't support audio recording."); return; }
    try{
      var stream = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: !!recSettings.noise, echoCancellation:true } });
      streamRef.current = stream;
      var mimeType = "audio/webm";
      if (window.MediaRecorder && MediaRecorder.isTypeSupported){
        if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) mimeType = "audio/webm;codecs=opus";
        else if (MediaRecorder.isTypeSupported("audio/mp4")) mimeType = "audio/mp4";
      }
      mimeTypeRef.current = mimeType;
      chunksRef.current = [];
      var recorder = new MediaRecorder(stream, { mimeType: mimeType, audioBitsPerSecond: QUALITY_BITRATE[recQuality]||32000 });
      recorder.ondataavailable = function(e){ if(e.data && e.data.size>0) chunksRef.current.push(e.data); };
      recorder.onstop = function(){
        audioBlobRef.current = new Blob(chunksRef.current, { type: mimeTypeRef.current });
        if (audioBlobRef.current.size > MAX_AUDIO_BYTES) {
          setAudioSizeWarning("This recording is quite long (~"+Math.round(audioBlobRef.current.size/1024/1024)+"MB). Transcription may fail — consider recording shorter sessions if this happens.");
        } else {
          setAudioSizeWarning("");
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setPhase("recording");
      setElapsed(0);
      setStatus("Recording...");
      timerRef.current = setInterval(function(){ setElapsed(function(e){return e+1;}); }, 1000);
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
    timerRef.current = setInterval(function(){ setElapsed(function(e){return e+1;}); }, 1000);
    setPhase("recording");
    setStatus("Recording...");
  }
  function stopRecording(){
    clearInterval(timerRef.current);
    try{ mediaRecorderRef.current && mediaRecorderRef.current.stop(); }catch(e){}
    try{ streamRef.current && streamRef.current.getTracks().forEach(function(t){t.stop();}); }catch(e){}
    setPhase("stopped");
    setStatus("Recording saved — choose what you'd like from it.");
    if (recSettings.autoTranscribe) {
      // small delay so onstop finishes building the blob first
      setTimeout(function(){ transcribe(); }, 300);
    }
  }

  function blobToBase64(blob){
    return new Promise(function(resolve,reject){
      var reader = new FileReader();
      reader.onloadend = function(){ resolve(reader.result.split(",")[1]); };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function transcribe(){
    if(!audioBlobRef.current){ setStatus("Record something first!"); return; }
    if(!wantFull && !wantSmart && !wantSummary){ setStatus("Pick at least one output type."); return; }
    setPhase("transcribing");
    setStatus("✨ Transcribing your recording with AI...");
    try{
      var base64 = await blobToBase64(audioBlobRef.current);
      var mediaType = mimeTypeRef.current.split(";")[0];
      var jobs=[];
      if(wantFull) jobs.push(["full", callGeminiAudio(base64, mediaType, "Transcribe this lecture recording verbatim, word for word, as accurately as you can. Add natural paragraph breaks where the speaker's train of thought shifts. Return only the transcript, no preamble.", 3000, "transcribe")]);
      if(wantSmart) jobs.push(["smart", callGeminiAudio(base64, mediaType, "Listen to this lecture recording and turn it into clean, well-organized study notes — headers and bullet points, only the important points, skip filler and repetition. Return only the notes, no preamble.", 2000, "transcribe")]);
      if(wantSummary) jobs.push(["summary", callGeminiAudio(base64, mediaType, "Listen to this lecture recording and write a concise one-page revision summary covering only the core ideas and key takeaways a student needs to remember. Return only the summary, no preamble.", 900, "transcribe")]);
      var results = await Promise.allSettled(jobs.map(function(j){return j[1];}));
      var outOfCredits = results.some(function(r){ return r.status==="rejected" && r.reason && r.reason.code==="OUT_OF_CREDITS"; });
      if (outOfCredits) { triggerUpgradeScreen(); setPhase("stopped"); return; }
      var next = {full:"",smart:"",summary:""};
      var firstKey=null;
      results.forEach(function(r,i){
        var key=jobs[i][0];
        if(r.status==="fulfilled"){ next[key]=r.value; if(!firstKey)firstKey=key; }
        else { next[key]="⚠️ Couldn't generate this — "+(r.reason&&r.reason.message?r.reason.message:"try again."); }
      });
      setOutputs(next);
      setActiveTab(firstKey||"full");
      setPhase("reviewing");
      setStatus("Review below, edit anything, then save.");
      if (recSettings.autoSave && firstKey) {
        setTimeout(function(){ saveNote(next[firstKey]); }, 300);
      }
    }catch(e){
      setStatus("Couldn't reach Gemini to transcribe — check your API key or connection.");
      setPhase("stopped");
    }
  }

  function saveNote(overrideContent){
    var content = overrideContent!=null ? overrideContent : (activeTab?outputs[activeTab]:"");
    if(!content || !content.trim()){ alert("Nothing to save yet!"); return; }
    setSaving(true);
    try{
      onSave({id:Date.now(),title:title||("Voice Note - "+new Date().toLocaleDateString()),course,color:"#06B6D4",bg:"rgba(6,182,212,0.12)",tag:"Lecture",words:content.split(" ").length,preview:content.slice(0,100),content:content});
    }catch(e){ alert("Couldn't save the note — check your connection and try again."); }
    setSaving(false);
  }

  var TAB_LABELS = { full:"📝 Full Transcript", smart:"📚 Smart Notes", summary:"📄 Summary" };
  var checkedTabs = ["full","smart","summary"].filter(function(k){ return (k==="full"&&wantFull)||(k==="smart"&&wantSmart)||(k==="summary"&&wantSummary); });

  return(
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>Voice Recording</span>
        {phase==="reviewing"
          ? <button onClick={function(){saveNote();}} disabled={saving} style={{ background:saving?C.card2:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:saving?C.muted:"#fff",border:"none",borderRadius:10,padding:"8px 18px",fontWeight:800,fontSize:14,cursor:saving?"default":"pointer" }}>{saving?"Saving...":"Save"}</button>
          : <div style={{ width:64 }}/>}
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        <input value={title} onChange={function(e){setTitle(e.target.value);}} placeholder="Note title (optional)..." style={{ width:"100%",padding:"13px 16px",borderRadius:12,border:"1px solid "+C.border,fontSize:15,fontWeight:700,background:C.card,color:C.text,outline:"none",marginBottom:14,boxSizing:"border-box" }}/>
        <div style={{ marginBottom:16 }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}><span style={{ fontSize:13,fontWeight:700,color:C.soft }}>Select Course</span><button onClick={function(){setShowAddCourse(function(s){return !s;});}} style={{ background:C.cyan+"20",border:"1px solid "+C.cyan+"40",borderRadius:8,padding:"5px 12px",color:C.cyan,fontSize:12,fontWeight:700,cursor:"pointer" }}>+ Add Course</button></div>
          {showAddCourse&&(<div style={{ background:C.card2,borderRadius:14,padding:14,marginBottom:12,border:"1px solid "+C.cyan+"30" }}><div style={{ display:"flex",gap:8 }}><input value={newCourse} onChange={function(e){setNewCourse(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")addCourse();}} placeholder="e.g. BIO 201" style={{ flex:1,padding:"10px 14px",borderRadius:10,border:"1px solid "+C.border,background:C.bg,color:C.text,outline:"none",fontSize:14 }}/><button onClick={addCourse} style={{ background:C.cyan,border:"none",borderRadius:10,padding:"10px 16px",color:"#0A0F1E",fontWeight:800,cursor:"pointer" }}>Add</button><button onClick={function(){setShowAddCourse(false);}} style={{ background:C.card,border:"1px solid "+C.border,borderRadius:10,padding:"10px 12px",color:C.muted,cursor:"pointer" }}>X</button></div></div>)}
          <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>{courses.map(function(c){return(<div key={c} style={{ display:"flex" }}><button onClick={function(){setCourse(c);}} style={{ padding:"7px 14px",borderRadius:c==="General"?99:"99px 0 0 99px",border:"2px solid",borderColor:course===c?C.cyan:C.border,borderRight:c!=="General"?"none":undefined,background:course===c?C.cyan:C.card,color:course===c?"#0A0F1E":C.muted,fontSize:12,fontWeight:700,cursor:"pointer" }}>{c}</button>{c!=="General"&&<button onClick={function(){removeCourse(c);}} style={{ padding:"7px 8px",borderRadius:"0 99px 99px 0",border:"2px solid",borderColor:course===c?C.cyan:C.border,borderLeft:"none",background:course===c?C.cyan:C.card,color:C.red,fontSize:11,cursor:"pointer" }}>X</button>}</div>);})}</div>
        </div>

        <div style={{ background:C.card,borderRadius:24,padding:"28px 20px",border:"2px solid "+(phase==="recording"?C.red:phase==="paused"?C.amber:C.border),marginBottom:16,textAlign:"center" }}>
          <div onClick={phase==="idle"?startRecording:undefined} style={{ width:110,height:110,borderRadius:"50%",background:phase==="recording"?"linear-gradient(135deg,#EF4444,#F87171)":phase==="paused"?"linear-gradient(135deg,#F59E0B,#FCD34D)":"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 20px",cursor:phase==="idle"?"pointer":"default",fontSize:46,boxShadow:phase==="recording"?"0 0 0 14px rgba(239,68,68,0.12)":"0 8px 32px rgba(6,182,212,0.35)",animation:phase==="recording"?"pulse 1.5s ease-in-out infinite":"none" }}>{phase==="paused"?"⏸":"🎙️"}</div>
          {(phase==="recording"||phase==="paused")&&<div style={{ fontSize:40,fontWeight:800,color:phase==="paused"?C.amber:C.red,marginBottom:12,fontFamily:"monospace",letterSpacing:3 }}>⏱ {fmt(elapsed)}</div>}
          <div style={{ display:"flex",justifyContent:"center",marginBottom:14 }}><Wave active={phase==="recording"} color={phase==="recording"?"#EF4444":C.cyan} size={1.6}/></div>
          <p style={{ color:phase==="recording"?C.red:phase==="paused"?C.amber:C.muted,fontSize:14,fontWeight:600,margin:"0 0 20px" }}>{status}</p>
          <div style={{ display:"flex",gap:10,justifyContent:"center" }}>
            {phase==="idle"&&<button onClick={startRecording} style={{ background:"linear-gradient(135deg,#EF4444,#F87171)",color:"#fff",border:"none",borderRadius:14,padding:"14px 36px",fontWeight:800,fontSize:15,cursor:"pointer",boxShadow:"0 4px 20px rgba(239,68,68,0.4)" }}>🎤 Start Recording</button>}
            {(phase==="recording"||phase==="paused")&&<div style={{ display:"flex",gap:10 }}>
              {phase==="recording"?<button onClick={pauseRecording} style={{ background:C.amber,color:"#0A0F1E",border:"none",borderRadius:14,padding:"13px 24px",fontWeight:800,fontSize:14,cursor:"pointer" }}>⏸ Pause</button>:<button onClick={resumeRecording} style={{ background:C.green,color:"#0A0F1E",border:"none",borderRadius:14,padding:"13px 24px",fontWeight:800,fontSize:14,cursor:"pointer" }}>▶ Resume</button>}
              <button onClick={stopRecording} style={{ background:"rgba(248,113,113,0.15)",color:C.red,border:"2px solid "+C.red+"40",borderRadius:14,padding:"13px 24px",fontWeight:800,fontSize:14,cursor:"pointer" }}>⏹ Stop Recording</button>
            </div>}
          </div>
        </div>

        {(phase==="stopped"||phase==="transcribing"||phase==="reviewing")&&(
          <div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.border,marginBottom:16 }}>
            {audioSizeWarning&&<div style={{ background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:10,padding:10,fontSize:12,color:C.amber,marginBottom:14 }}>⚠️ {audioSizeWarning}</div>}
            <div style={{ fontWeight:800,fontSize:14,color:C.text,marginBottom:12 }}>Choose Output</div>
            {[["full",wantFull,setWantFull,"📝 Full Transcript","Everything the lecturer said"],["smart",wantSmart,setWantSmart,"📚 Smart Notes","Only the important points"],["summary",wantSummary,setWantSummary,"📄 Summary","One-page revision notes"]].map(function(item){return(
              <label key={item[0]} style={{ display:"flex",alignItems:"center",gap:12,padding:"10px 0",cursor:phase==="transcribing"?"default":"pointer",opacity:phase==="transcribing"?0.6:1 }}>
                <input type="checkbox" checked={item[1]} disabled={phase==="transcribing"} onChange={function(e){item[2](e.target.checked);}} style={{ width:20,height:20,accentColor:C.cyan }}/>
                <div><div style={{ fontWeight:700,fontSize:14,color:C.text }}>{item[3]}</div><div style={{ fontSize:12,color:C.muted }}>{item[4]}</div></div>
              </label>
            );})}
            {phase!=="reviewing"&&<button onClick={transcribe} disabled={phase==="transcribing"} style={{ width:"100%",marginTop:14,background:phase==="transcribing"?C.card2:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:phase==="transcribing"?C.muted:"#fff",border:"none",borderRadius:14,padding:"14px",fontWeight:800,fontSize:15,cursor:phase==="transcribing"?"default":"pointer" }}>{phase==="transcribing"?"✨ Transcribing...":"✨ Transcribe"}</button>}
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
    </div>
  );
}

// ── SCAN DOC ──────────────────────────────────────────────────────────────────
function ScanDocScreen({ onBack, onSave }) {
  var [image,setImage]=useState(null); // final (possibly cropped) image data URL, or null while a PDF is loaded
  var [pdfFile,setPdfFile]=useState(null); // {dataUrl, name} when a PDF was chosen instead of an image
  var [cropping,setCropping]=useState(false);
  var [rawImage,setRawImage]=useState(null); // uncropped source, kept so "Re-crop" can start over
  var [box,setBox]=useState({x:20,y:20,w:200,h:200}); // crop rectangle, in on-screen px relative to the preview
  var [extracting,setExtracting]=useState(false);var [extracted,setExtracted]=useState("");var [title,setTitle]=useState("");var [course,setCourse]=useState("General");var [status,setStatus]=useState("Take a photo or upload an image or PDF");
  var fileRef=useRef(null); var imgRef=useRef(null); var dragRef=useRef(null);
  var courses=["General","PHY 101","MTH 101","COS 102","ENG 201","CHM 102"];

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
        <div style={{ display:"flex",gap:8,marginBottom:16,flexWrap:"wrap" }}>{courses.map(function(c){return<button key={c} onClick={function(){setCourse(c);}} style={{ padding:"6px 14px",borderRadius:99,border:"2px solid",borderColor:course===c?C.cyan:C.border,background:course===c?C.cyan:C.card,color:course===c?"#0A0F1E":C.muted,fontSize:12,fontWeight:700,cursor:"pointer" }}>{c}</button>;})}</div>

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
function DrawScreen({ onBack, onSave }) {
  var canvasRef=useRef(null);var [drawing,setDrawing]=useState(false);var [color,setColor]=useState("#06B6D4");var [size,setSize]=useState(4);var [tool,setTool]=useState("pen");
  var [title,setTitle]=useState("");var [course,setCourse]=useState("General");var [hasContent,setHasContent]=useState(false);
  var colors=["#06B6D4","#A78BFA","#F59E0B","#34D399","#F87171","#fff"];
  var courses=["General","PHY 101","MTH 101","COS 102","ENG 201","CHM 102"];
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
        <select value={course} onChange={function(e){setCourse(e.target.value);}} style={{ padding:"9px 10px",borderRadius:10,border:"1px solid "+C.border,fontSize:12,background:C.bg,color:C.text,outline:"none" }}>{courses.map(function(c){return<option key={c} value={c}>{c}</option>;})}</select>
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

// ── AI WRITE ──────────────────────────────────────────────────────────────────
function AIWriteScreen({ onBack, onSave }) {
  var [prompt,setPrompt]=useState("");var [result,setResult]=useState("");var [loading,setLoading]=useState(false);var [course,setCourse]=useState("General");
  var courses=["General","PHY 101","MTH 101","COS 102","ENG 201","CHM 102"];
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
        <div style={{ display:"flex",gap:8,marginBottom:14,flexWrap:"wrap" }}>{courses.map(function(c){return<button key={c} onClick={function(){setCourse(c);}} style={{ padding:"6px 14px",borderRadius:99,border:"2px solid",borderColor:course===c?C.purple:C.border,background:course===c?C.purple:C.card,color:course===c?"#0A0F1E":C.muted,fontSize:12,fontWeight:700,cursor:"pointer" }}>{c}</button>;})}</div>
        <div style={{ display:"flex",gap:10,marginBottom:16 }}><input value={prompt} onChange={function(e){setPrompt(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")generate();}} placeholder="What should I write notes about?" style={{ flex:1,padding:"13px 16px",borderRadius:14,border:"1px solid "+C.border,fontSize:14,background:C.card,color:C.text,outline:"none" }}/><button onClick={function(){generate();}} disabled={loading} style={{ width:48,height:48,borderRadius:14,background:"linear-gradient(135deg,#A78BFA,#06B6D4)",border:"none",cursor:"pointer",fontSize:20,flexShrink:0 }}>✨</button></div>
        {!result&&!loading&&suggestions.map(function(s){return<button key={s} onClick={function(){setPrompt(s);generate(s);}} style={{ width:"100%",textAlign:"left",background:C.card,border:"1px solid "+C.border,borderRadius:12,padding:"12px 16px",color:C.soft,fontSize:13,cursor:"pointer",marginBottom:8,fontFamily:"inherit" }}>{s}</button>;})}
        {loading&&<div style={{ textAlign:"center",padding:"40px 20px" }}><div style={{ fontSize:48,animation:"spin 2s linear infinite" }}>✨</div><p style={{ color:C.muted }}>Writing your notes...</p></div>}
        {result&&<div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.border }}><textarea value={result} onChange={function(e){setResult(e.target.value);}} style={{ width:"100%",minHeight:280,background:"transparent",border:"none",color:C.text,fontSize:14,lineHeight:1.9,outline:"none",resize:"none",fontFamily:"inherit",boxSizing:"border-box" }}/></div>}
      </div>
    </div>
  );
}

// ── NOTE DETAIL ───────────────────────────────────────────────────────────────
function NoteDetail({ note, onBack, onDelete }) {
  var [view,setView]=useState("note");var [summary,setSummary]=useState(null);var [quiz,setQuiz]=useState([]);var [quizIdx,setQuizIdx]=useState(0);var [selected,setSelected]=useState(null);var [score,setScore]=useState(0);var [quizDone,setQuizDone]=useState(false);var [loading,setLoading]=useState(false);
  async function generateSummary(){setLoading(true);setView("summary");try{var raw=await callGeminiText("Summarize these notes. Return ONLY JSON: {\"summary\":\"...\",\"keyPoints\":[\"...\"],\"tags\":[\"...\"]} NOTES: "+note.content,800,"summary");setSummary(JSON.parse(raw.split("```json").join("").split("```").join("").trim()));}catch(e){if(e.code==="OUT_OF_CREDITS"){triggerUpgradeScreen();}else{setSummary({summary:"This covers "+note.title+".",keyPoints:["Review definitions","Practice problems"],tags:[note.course,note.tag]});}}setLoading(false);}
  async function generateQuiz(){setLoading(true);setView("quiz");try{var raw=await callGeminiText("Create 5 MCQ from these notes. Return ONLY JSON array: [{\"question\":\"...\",\"options\":[\"A\",\"B\",\"C\",\"D\"],\"answer\":0}] NOTES: "+note.content,800,"quiz");var q=JSON.parse(raw.split("```json").join("").split("```").join("").trim());setQuiz(q);setQuizIdx(0);setSelected(null);setScore(0);setQuizDone(false);}catch(e){if(e.code==="OUT_OF_CREDITS"){triggerUpgradeScreen();}else{setQuiz([{question:"What is the main topic?",options:[note.course,"History","Math","Art"],answer:0}]);}}setLoading(false);}
  function pick(i){if(selected!==null)return;setSelected(i);if(i===quiz[quizIdx].answer)setScore(function(s){return s+1;});setTimeout(function(){if(quizIdx+1<quiz.length){setQuizIdx(function(q){return q+1;});setSelected(null);}else setQuizDone(true);},900);}
  return(
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border,position:"sticky",top:0,zIndex:10 }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:15,color:C.text,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{note.title}</span>
        <div style={{ display:"flex",gap:6 }}><button onClick={function(){if(navigator.share)navigator.share({title:note.title,text:note.content});else{navigator.clipboard&&navigator.clipboard.writeText(note.content);alert("Copied!");}}} style={{ background:C.card2,border:"none",borderRadius:8,width:32,height:32,cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center" }}>📤</button><button onClick={function(){onDelete(note.id);}} style={{ background:"rgba(248,113,113,0.12)",border:"none",borderRadius:8,width:32,height:32,cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center" }}>🗑</button></div>
      </div>
      <div style={{ background:C.card,padding:"0 20px 12px",display:"flex",gap:6,borderBottom:"1px solid "+C.border }}>
        {[["📝","note","Note"],["📋","summary","Summary"],["🧠","quiz","Quiz"]].map(function(item){return<button key={item[1]} onClick={function(){setView(item[1]);if(item[1]==="summary"&&!summary)generateSummary();if(item[1]==="quiz"&&quiz.length===0)generateQuiz();}} style={{ padding:"7px 16px",borderRadius:99,border:"none",background:view===item[1]?note.color:C.card2,color:view===item[1]?"#0A0F1E":C.muted,fontSize:13,fontWeight:700,cursor:"pointer",marginTop:12 }}>{item[0]+" "+item[2]}</button>;})}
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        {view==="note"&&(<div><div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:16 }}><span style={{ fontSize:11,fontWeight:700,color:note.color,background:note.bg,borderRadius:99,padding:"3px 12px" }}>{note.course}</span><span style={{ fontSize:11,color:C.muted }}>{formatRelativeDate(note.id)}</span></div><div style={{ background:C.card,borderRadius:18,padding:note.type==="drawing"?12:20,border:"1px solid "+C.border,marginBottom:16 }}>{note.type==="drawing"?<img src={note.content} alt={note.title} style={{ width:"100%",borderRadius:12,display:"block" }}/>:<div className="samx-md" style={{ fontSize:14,color:"#CBD5E1",lineHeight:1.9 }}><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{note.content}</ReactMarkdown></div>}</div>{note.type!=="drawing"&&<div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10 }}><button onClick={function(){setView("summary");if(!summary)generateSummary();}} style={actionBtn(note.color)}>📋 AI Summary</button><button onClick={function(){setView("quiz");if(quiz.length===0)generateQuiz();}} style={actionBtn(C.purple)}>🧠 Quiz Me</button></div>}</div>)}
        {view==="summary"&&(loading?<div style={{ textAlign:"center",padding:"60px 20px" }}><div style={{ fontSize:48,animation:"spin 2s linear infinite" }}>✨</div><p style={{ color:C.muted,marginTop:16 }}>Generating...</p></div>:summary?(<div><div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.border,marginBottom:14 }}><div style={{ fontSize:11,fontWeight:700,color:C.green,letterSpacing:1,marginBottom:10 }}>OVERVIEW</div><p style={{ margin:0,fontSize:14,color:"#CBD5E1",lineHeight:1.8 }}>{summary.summary}</p></div><div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.border,marginBottom:14 }}><div style={{ fontSize:11,fontWeight:700,color:C.amber,letterSpacing:1,marginBottom:12 }}>KEY POINTS</div>{summary.keyPoints&&summary.keyPoints.map(function(p,i){return<div key={i} style={{ display:"flex",gap:10,marginBottom:10 }}><div style={{ width:6,height:6,borderRadius:3,background:C.amber,marginTop:7,flexShrink:0 }}/><p style={{ margin:0,fontSize:14,color:"#CBD5E1",lineHeight:1.7 }}>{p}</p></div>;})}</div><div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>{summary.tags&&summary.tags.map(function(t){return<span key={t} style={{ background:C.card2,color:C.cyan,borderRadius:99,padding:"4px 14px",fontSize:12,fontWeight:700 }}>{t}</span>;})}</div></div>):null)}
        {view==="quiz"&&(loading?<div style={{ textAlign:"center",padding:"60px 20px" }}><div style={{ fontSize:48,animation:"spin 2s linear infinite" }}>🧠</div><p style={{ color:C.muted,marginTop:16 }}>Generating quiz...</p></div>:quizDone?(<div style={{ textAlign:"center",padding:"40px 20px" }}><div style={{ fontSize:64,marginBottom:16 }}>{score===quiz.length?"🏆":"📖"}</div><div style={{ fontSize:40,fontWeight:800,color:C.text }}>{score}/{quiz.length}</div><p style={{ color:C.muted,marginTop:8 }}>{score===quiz.length?"Perfect! 🔥":"Keep studying! 💪"}</p><button onClick={function(){setQuizIdx(0);setSelected(null);setScore(0);setQuizDone(false);}} style={{ marginTop:20,background:"linear-gradient(135deg,"+note.color+",#A78BFA)",color:"#fff",border:"none",borderRadius:14,padding:"13px 32px",fontWeight:800,fontSize:15,cursor:"pointer" }}>Try Again</button></div>):quiz.length>0?(<div><div style={{ display:"flex",justifyContent:"space-between",marginBottom:8 }}><span style={{ fontSize:13,color:C.muted }}>Question {quizIdx+1}/{quiz.length}</span><span style={{ fontSize:13,fontWeight:700,color:C.text }}>Score: {score}</span></div><div style={{ height:4,background:C.border,borderRadius:2,marginBottom:20 }}><div style={{ height:4,background:note.color,borderRadius:2,width:(quizIdx/quiz.length*100)+"%",transition:"width 0.3s" }}/></div><div style={{ background:C.card,borderRadius:16,padding:20,marginBottom:16,border:"1px solid "+C.border }}><p style={{ margin:0,fontSize:16,fontWeight:600,color:C.text,lineHeight:1.6 }}>{quiz[quizIdx].question}</p></div>{quiz[quizIdx].options.map(function(opt,i){var bg=C.card,border=C.border,color=C.text;if(selected!==null){if(i===quiz[quizIdx].answer){bg="rgba(52,211,153,0.15)";border="#34D399";color="#34D399";}else if(i===selected){bg="rgba(248,113,113,0.15)";border="#F87171";color="#F87171";}}return<button key={i} onClick={function(){pick(i);}} disabled={selected!==null} style={{ width:"100%",textAlign:"left",background:bg,border:"2px solid "+border,borderRadius:12,padding:"13px 16px",marginBottom:10,fontSize:14,color:color,cursor:selected!==null?"default":"pointer",fontWeight:500,display:"flex",gap:10,fontFamily:"inherit" }}><span style={{opacity:0.5}}>{String.fromCharCode(65+i)}.</span>{opt}</button>;})}</div>):null)}
      </div>
    </div>
  );
}

// ── LIBRARY ───────────────────────────────────────────────────────────────────
function LibraryScreen({ notes, onNote, onDelete }) {
  var [search,setSearch]=useState("");var [sort,setSort]=useState("date");var [filter,setFilter]=useState("All");var [courseFilter,setCourseFilter]=useState("All Courses");var [view,setView]=useState("list");var [selected,setSelected]=useState([]);
  var filters=["All","Lecture","Study","Business","Personal"];
  var sorts=[["date","📅 Date"],["title","🔤 Title"],["course","📚 Course"],["words","💬 Words"]];
  var courseOptions=["All Courses"].concat(Array.from(new Set(notes.map(function(n){return n.course;}))).sort());
  var filtered=notes.filter(function(n){var ms=n.title.toLowerCase().includes(search.toLowerCase())||n.course.toLowerCase().includes(search.toLowerCase())||n.content.toLowerCase().includes(search.toLowerCase());var mf=filter==="All"||n.tag===filter;var mc=courseFilter==="All Courses"||n.course===courseFilter;return ms&&mf&&mc;});
  filtered=filtered.slice().sort(function(a,b){if(sort==="title")return a.title.localeCompare(b.title);if(sort==="course")return a.course.localeCompare(b.course);if(sort==="words")return(b.words||0)-(a.words||0);return (b.id||0)-(a.id||0);});
  function toggleSelect(id){setSelected(function(s){return s.includes(id)?s.filter(function(x){return x!==id;}):[...s,id];});}
  function deleteSelected(){selected.forEach(function(id){onDelete(id);});setSelected([]);}
  return(
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:"linear-gradient(135deg,#0A0F1E,#1E1B4B)",padding:"20px 20px 0" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
          <div><h2 style={{ color:C.text,fontSize:22,fontWeight:800,margin:0 }}>Library 📚</h2><p style={{ color:C.muted,fontSize:12,margin:"4px 0 0" }}>{notes.length} notes saved</p></div>
          <button onClick={function(){setView(view==="list"?"grid":"list");}} style={{ background:"rgba(255,255,255,0.08)",border:"none",borderRadius:10,width:36,height:36,cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center" }}>{view==="list"?"⊞":"☰"}</button>
        </div>
        <div style={{ position:"relative",marginBottom:14 }}><span style={{ position:"absolute",left:14,top:"50%",transform:"translateY(-50%)" }}>🔍</span><input value={search} onChange={function(e){setSearch(e.target.value);}} placeholder="Search notes, courses, content..." style={{ width:"100%",padding:"11px 14px 11px 42px",borderRadius:12,border:"1px solid rgba(255,255,255,0.1)",fontSize:13,background:"rgba(255,255,255,0.07)",color:C.text,outline:"none",boxSizing:"border-box" }}/></div>
        <div style={{ display:"flex",gap:6,overflowX:"auto",paddingBottom:10 }}>{filters.map(function(f){return<button key={f} onClick={function(){setFilter(f);}} style={{ padding:"6px 14px",borderRadius:99,border:"none",background:filter===f?C.cyan:"rgba(255,255,255,0.07)",color:filter===f?"#0A0F1E":C.muted,fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0 }}>{f}</button>;})}</div>
        {courseOptions.length>1&&<div style={{ display:"flex",gap:6,overflowX:"auto",paddingBottom:14 }}>{courseOptions.map(function(c){return<button key={c} onClick={function(){setCourseFilter(c);}} style={{ padding:"5px 12px",borderRadius:99,border:"1px solid "+(courseFilter===c?C.purple:"rgba(255,255,255,0.12)"),background:courseFilter===c?C.purple+"25":"transparent",color:courseFilter===c?C.purple:C.muted,fontSize:11,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0 }}>{c}</button>;})}</div>}
      </div>
      <div style={{ background:C.card,padding:"10px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <div style={{ display:"flex",gap:6,overflowX:"auto" }}>{sorts.map(function(s){return<button key={s[0]} onClick={function(){setSort(s[0]);}} style={{ padding:"5px 12px",borderRadius:99,border:"none",background:sort===s[0]?C.purple+"30":"transparent",color:sort===s[0]?C.purple:C.muted,fontSize:11,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap" }}>{s[1]}</button>;})}</div>
        {selected.length>0&&<button onClick={deleteSelected} style={{ background:"rgba(248,113,113,0.15)",border:"1px solid "+C.red+"40",borderRadius:8,padding:"5px 12px",color:C.red,fontSize:11,fontWeight:700,cursor:"pointer",flexShrink:0 }}>🗑 Delete {selected.length}</button>}
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
function DashboardScreen({ notes, user, credits, plan }) {
  var totalWords=notes.reduce(function(sum,n){return sum+(n.words||n.content.split(" ").length);},0);
  var totalNotes=notes.length;
  var todayNotes=notes.filter(function(n){return formatRelativeDate(n.id)==="Just now"||/m ago$/.test(formatRelativeDate(n.id))||formatRelativeDate(n.id)==="Today";}).length;
  var courseCounts={};notes.forEach(function(n){courseCounts[n.course]=(courseCounts[n.course]||0)+1;});
  var tagCounts={Lecture:0,Study:0,Business:0,Personal:0};notes.forEach(function(n){if(tagCounts[n.tag]!==undefined)tagCounts[n.tag]++;});
  var weekDays=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];var weekActivity=[3,1,4,2,5,0,2];var maxActivity=Math.max.apply(null,weekActivity);
  var tagColors={Lecture:C.cyan,Study:C.purple,Business:C.amber,Personal:C.green};
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
          <div><div style={{ fontSize:13,color:"rgba(255,255,255,0.8)",fontWeight:600,marginBottom:4 }}>Study Streak 🔥</div><div style={{ fontSize:40,fontWeight:800,color:"#fff" }}>7 Days</div><div style={{ fontSize:12,color:"rgba(255,255,255,0.7)",marginTop:4 }}>Keep it up! You are on fire!</div></div>
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
        <div style={{ background:C.card,borderRadius:18,padding:"20px",border:"1px solid "+C.border }}>
          <div style={{ fontWeight:800,fontSize:15,color:C.text,marginBottom:16 }}>Notes by Type 🏷️</div>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10 }}>{Object.keys(tagCounts).map(function(tag){var count=tagCounts[tag];var color=tagColors[tag]||C.cyan;var icons={Lecture:"📚",Study:"💡",Business:"💼",Personal:"📝"};return<div key={tag} style={{ background:color+"15",borderRadius:14,padding:"14px",border:"1px solid "+color+"30" }}><div style={{ fontSize:24,marginBottom:6 }}>{icons[tag]}</div><div style={{ fontSize:22,fontWeight:800,color:color }}>{count}</div><div style={{ fontSize:11,color:C.muted,fontWeight:600 }}>{tag}</div></div>;})}</div>
        </div>
      </div>
    </div>
  );
}

// ── HOME ──────────────────────────────────────────────────────────────────────
function HomeScreen({ notes, onNote, onVoice, onDraw, onAIWrite, onScan, onChat, user, onNotifications, onProfile, unreadCount, profile }) {
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
            <div style={{ width:40,height:40,borderRadius:12,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20 }}>🎵</div>
            <span style={{ fontWeight:800,fontSize:20,color:C.text }}>Jotting <span style={{ color:C.cyan }}>AI</span></span>
          </div>
          <div style={{ display:"flex",gap:8 }}>
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
            {[["🎙️","Voice\nNote",C.cyan,onVoice],["✨","AI\nWrite",C.purple,onAIWrite],["💬","AI\nChat",C.cyan,onChat],["📷","Scan\nDoc",C.amber,onScan],["🖊️","Draw",C.green,onDraw]].map(function(item){return<button key={item[1]} onClick={item[3]} style={{ background:C.card,border:"1px solid "+item[2]+"30",borderRadius:14,padding:"14px 8px",cursor:"pointer",textAlign:"center" }}><div style={{ width:38,height:38,borderRadius:10,background:item[2]+"20",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 8px",fontSize:20 }}>{item[0]}</div><span style={{ fontSize:11,fontWeight:700,color:C.soft,whiteSpace:"pre-line",lineHeight:1.3 }}>{item[1]}</span></button>;}) }
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
function AIScreen({ notes, onBack, chatSessions, onSaveSession, onDeleteSession }) {
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
          <div style={{ width:40,height:40,borderRadius:12,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20 }}>🤖</div>
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
                {m.role==="ai" && <div style={{ width:32,height:32,borderRadius:10,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,marginRight:8,flexShrink:0,marginTop:2 }}>🤖</div>}
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
            <div style={{ width:32,height:32,borderRadius:10,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,marginRight:8,flexShrink:0,marginTop:2 }}>🤖</div>
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

// ── PROFILE & ACCOUNT ──────────────────────────────────────────────────────────
function ProfileScreen({ onBack, user, plan, credits, profile, onSaveProfile, onLogout }) {
  var [school, setSchool] = useState(profile.school||"");
  var [department, setDepartment] = useState(profile.department||"");
  var [level, setLevel] = useState(profile.level||"");
  var [saving, setSaving] = useState(false);
  var [saved, setSaved] = useState(false);
  var [resetSent, setResetSent] = useState(false);

  var dirty = school!==(profile.school||"") || department!==(profile.department||"") || level!==(profile.level||"");

  async function save(){
    setSaving(true);
    await onSaveProfile({ school:school.trim(), department:department.trim(), level:level });
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
function NotificationScreen({ onBack, notifications, onMarkRead, onMarkAllRead, notifEnabled, setNotifEnabled }) {
  var TYPE_ICON = { study:"📚", ai_complete:"✨", streak:"🔥", app_update:"🚀", assignment:"📋", daily:"🎯", recording:"🎙️" };
  var unreadCount = notifications.filter(function(n){return !n.read;}).length;
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
          <div><div style={{ fontWeight:700, fontSize:14, color:C.text }}>Push Notifications</div><div style={{ fontSize:12, color:C.muted }}>Study reminders and alerts on your device</div></div>
          <Toggle value={notifEnabled} onChange={function(v){ setNotifEnabled(v); if(v) requestNotificationPermission(); }} color={C.purple}/>
        </div>
        {notifications.length===0 ? (
          <div style={{ textAlign:"center", padding:"60px 20px" }}>
            <div style={{ fontSize:48, marginBottom:12 }}>🔔</div>
            <div style={{ fontWeight:700, fontSize:16, color:C.text, marginBottom:6 }}>All caught up</div>
            <div style={{ fontSize:13, color:C.muted }}>Study reminders, AI completions, and streak milestones will show up here.</div>
          </div>
        ) : notifications.map(function(n){return(
          <button key={n.id} onClick={function(){ if(!n.read) onMarkRead(n.id); }} style={{ width:"100%", textAlign:"left", display:"flex", gap:12, background:n.read?C.card:C.card2, border:"1px solid "+(n.read?C.border:C.cyan+"40"), borderRadius:14, padding:14, marginBottom:10, cursor:"pointer" }}>
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
function PricingScreen({ onBack, plan, credits }) {
  var [cycle, setCycle] = useState("monthly");
  var planOrder = ["free","pro","premium"];

  function priceFor(p){ return cycle==="monthly" ? p.priceMonthly : p.priceYearly; }
  function periodLabel(){ return cycle==="monthly" ? "/month" : "/year"; }

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
              <button disabled={isCurrent} onClick={function(){alert("Real payment isn't wired up yet — this is where Paystack checkout will go next.");}} style={{ width:"100%", padding:"13px", borderRadius:14, border:"none", background:isCurrent?C.card2:("linear-gradient(135deg,"+p.color+",#A78BFA)"), color:isCurrent?C.muted:"#0A0F1E", fontWeight:800, fontSize:14, cursor:isCurrent?"default":"pointer" }}>{isCurrent?"Your Current Plan":(key==="free"?"Downgrade to Free":"Upgrade to "+p.name)}</button>
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
              ["AI Study Planner","—","—","✓"],
              ["Exam Mode","—","—","✓"],
              ["Advanced AI Tutor","—","—","✓"],
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
        <div style={{ textAlign:"center", fontSize:11, color:C.muted, marginBottom:20 }}>Payments aren't live yet — upgrading here is a preview. Real checkout is coming soon.</div>
      </div>
    </div>
  );
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────
function SettingsScreen({ user, onLogout, recQuality, setRecQuality, recSettings, setRecSettings, plan, credits, onViewPlans }) {
  var [openSection,setOpenSection]=useState(null);
  var [lang,setLang]=useState("English");
  var [aiStyle,setAiStyle]=useState("Academic");
  var [notifs,setNotifs]=useState({study:true,assignment:false,daily:true,recording:false});
  var [privacy,setPrivacy]=useState({fingerprint:false,face:false,pin:false,autoLock:true,hiddenFolder:false,encrypt:false});

  function Section({ id, icon, title, color, children }) {
    var isOpen=openSection===id;
    return<div style={{ background:C.card,borderRadius:16,marginBottom:12,border:"1px solid "+C.border,overflow:"hidden" }}><button onClick={function(){setOpenSection(isOpen?null:id);}} style={{ width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"16px",background:"none",border:"none",cursor:"pointer" }}><div style={{ display:"flex",alignItems:"center",gap:12 }}><div style={{ width:36,height:36,borderRadius:10,background:color+"20",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18 }}>{icon}</div><span style={{ fontWeight:700,fontSize:15,color:C.text }}>{title}</span></div><span style={{ color:C.muted,fontSize:20 }}>{isOpen?"v":">"}</span></button>{isOpen&&<div style={{ padding:"0 16px 16px",borderTop:"1px solid "+C.border }}>{children}</div>}</div>;
  }

  return(
    <div style={{ flex:1,overflowY:"auto",background:C.bg }}>
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
          <div style={{ marginTop:12 }}>{[["📚","study","Study Reminders","Daily reminder to study"],["📋","assignment","Assignment Reminder","Due date alerts"],["🎯","daily","Daily Goal Reminder","Track daily goals"],["🎙️","recording","Recording Reminder","Remind to record lectures"]].map(function(item){return<Row key={item[1]} icon={item[0]} label={item[2]} sub={item[3]} right={<Toggle value={notifs[item[1]]} onChange={function(v){setNotifs(function(p){return{...p,[item[1]]:v};});}} color={C.purple}/>}/>;})}</div>
        </Section>

        <Section id="lang" icon="🌍" title="Language" color="#34D399">
          <div style={{ marginTop:12 }}>{[["English","🇬🇧"],["Yoruba","🇳🇬"],["Hausa","🇳🇬"],["Igbo","🇳🇬"],["French","🇫🇷"]].map(function(item){return<div key={item[0]} onClick={function(){setLang(item[0]);}} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 0",borderBottom:"1px solid "+C.border,cursor:"pointer" }}><div style={{ display:"flex",alignItems:"center",gap:10 }}><span style={{ fontSize:20 }}>{item[1]}</span><span style={{ fontSize:14,fontWeight:600,color:lang===item[0]?C.green:C.text }}>{item[0]}</span></div>{lang===item[0]&&<span style={{ color:C.green,fontSize:18,fontWeight:700 }}>✓</span>}</div>;})}</div>
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
            <div style={{ marginBottom:14 }}><div style={{ fontSize:12,color:C.muted,marginBottom:8,fontWeight:600 }}>WRITING STYLE</div><div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>{["Academic","Simple","Detailed"].map(function(s){return<button key={s} onClick={function(){setAiStyle(s);}} style={{ padding:"8px 16px",borderRadius:10,border:"2px solid",borderColor:aiStyle===s?C.purple:C.border,background:aiStyle===s?C.purple:C.card,color:aiStyle===s?"#0A0F1E":C.muted,fontSize:13,fontWeight:700,cursor:"pointer" }}>{s}</button>;})}</div></div>
            <Row icon="🌐" label="AI Response Language" sub="English"/>
            <Row icon="📏" label="AI Summary Length" sub="Medium"/>
            <Row icon="📵" label="Offline AI Mode" sub="Available on Pro" right={<span style={{ background:"rgba(245,158,11,0.15)",color:C.amber,borderRadius:99,padding:"3px 10px",fontSize:11,fontWeight:700 }}>PRO</span>}/>
          </div>
        </Section>

        <Section id="privacy" icon="🔒" title="Privacy and Security" color="#F87171">
          <div style={{ marginTop:12 }}>{[["👆","fingerprint","Fingerprint Unlock","Use fingerprint to unlock"],["👤","face","Face Unlock","Unlock with face recognition"],["🔢","pin","PIN Lock","Set a 4-digit PIN"],["⏱","autoLock","Auto Lock","Lock after 1 minute"],["📁","hiddenFolder","Hidden Notes Folder","Keep private notes hidden"],["🔐","encrypt","Encrypt Notes","End-to-end encryption"]].map(function(item){return<Row key={item[1]} icon={item[0]} label={item[2]} sub={item[3]} right={<Toggle value={privacy[item[1]]} onChange={function(v){setPrivacy(function(p){return{...p,[item[1]]:v};});}} color={C.red}/>}/>;})}</div>
        </Section>

        <Section id="about" icon="ℹ️" title="About" color="#06B6D4">
          <div style={{ marginTop:12 }}>
            <Row icon="📱" label="App Version" sub="v4.0.0 - Login Edition" right={<span style={{ fontSize:13,color:C.muted }}>v4.0</span>}/>
            <Row icon="🆕" label="What's New" sub="Login, Firebase, Cloud sync!"/>
            <Row icon="🔏" label="Privacy Policy" sub="How we handle your data"/>
            <Row icon="📜" label="Terms of Service" sub="Rules and conditions"/>
            <Row icon="💬" label="Contact Support" sub="Get help from our team"/>
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
            <Row icon="✅" label="Email Verified" sub={user&&user.emailVerified?"Your email is verified":"Email not verified yet"} right={<span style={{ fontSize:13,color:user&&user.emailVerified?C.green:C.amber }}>{user&&user.emailVerified?"✓":"Pending"}</span>}/>
            <div onClick={onLogout} style={{ display:"flex",alignItems:"center",justifyContent:"center",padding:"14px",marginTop:12,background:"rgba(248,113,113,0.1)",borderRadius:12,cursor:"pointer",border:"1px solid "+C.red+"30" }}>
              <span style={{ fontSize:14,fontWeight:700,color:C.red }}>🚪 Logout</span>
            </div>
          </div>
        </Section>
      </div>
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
  var [cloudLoading, setCloudLoading] = useState(false);
  var [screen, setScreen] = useState("home");
  var [activeNote, setActiveNote] = useState(null);
  var [tab, setTab] = useState("home");
  var [recQuality, setRecQuality] = useState(function(){ try{ return localStorage.getItem("jotting_recQuality")||"Medium"; }catch(e){ return "Medium"; } });
  var [recSettings, setRecSettings] = useState(function(){
    try{ var raw=localStorage.getItem("jotting_recSettings"); return raw?JSON.parse(raw):{noise:true,autoTranscribe:false,speakerID:false,autoSave:false}; }
    catch(e){ return {noise:true,autoTranscribe:false,speakerID:false,autoSave:false}; }
  });
  var [plan, setPlan] = useState("free");
  var [credits, setCredits] = useState(PLANS.free.monthlyCredits);
  var [profile, setProfile] = useState({ school:"", department:"", level:"", streak:0 });
  var [notifEnabled, setNotifEnabled] = useState(function(){ try{ return localStorage.getItem("jotting_notifEnabled")==="1"; }catch(e){ return false; } });
  useEffect(function(){ try{ localStorage.setItem("jotting_notifEnabled", notifEnabled?"1":"0"); }catch(e){} }, [notifEnabled]);
  var [notifCenter, setNotifCenter] = useState([]);
  useEffect(function(){ try{ localStorage.setItem("jotting_recQuality", recQuality); }catch(e){} }, [recQuality]);
  useEffect(function(){ try{ localStorage.setItem("jotting_recSettings", JSON.stringify(recSettings)); }catch(e){} }, [recSettings]);

  function addNotification(type, title, message){
    setNotifCenter(function(list){
      var updated = [makeNotif(type,title,message), ...list].slice(0,50);
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
  async function saveProfile(fields){
    setProfile(function(p){ return {...p, ...fields}; });
    if (user) await saveProfileFields(user.uid, fields);
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
        var cached = loadNotesLocal(firebaseUser.uid);
        if (cached.length > 0) setNotes(cached);
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
            persistNotesLocal(firebaseUser.uid, merged);
            return merged;
          });
          setCloudLoading(false);
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
        loadOrInitAccount(firebaseUser.uid).then(function(account){
          var monthKey = currentMonthKey();
          // This is a display-only estimate — the real refill happens securely on the
          // server (in the Netlify function) the next time an AI request is made this
          // month. The client is never allowed to write its own credit balance directly.
          var displayCredits = account.creditsMonthKey !== monthKey
            ? (PLANS[account.plan]||PLANS.free).monthlyCredits
            : (typeof account.credits==="number" ? account.credits : PLANS.free.monthlyCredits);
          setPlan(account.plan||"free");
          setCredits(displayCredits);
        });
        var cachedNotifs = loadNotifsLocal(firebaseUser.uid);
        if (cachedNotifs.length > 0) setNotifCenter(cachedNotifs);
        // App update announcements: bump this version string whenever you ship something
        // worth telling students about, and each user sees the update notice once.
        var APP_UPDATE_VERSION = "2026-07-subscriptions";
        if (localStorage.getItem("jotting_lastUpdateSeen_"+firebaseUser.uid) !== APP_UPDATE_VERSION) {
          addNotificationRef.current("app_update", "🚀 New: Plans & AI Credits", "Jotting AI now has Free, Pro, and Premium plans — check Settings to see your usage.");
          localStorage.setItem("jotting_lastUpdateSeen_"+firebaseUser.uid, APP_UPDATE_VERSION);
        }
        loadOrInitProfile(firebaseUser.uid).then(function(prof){
          setProfile(prof);
          var milestones = [3,7,14,30,60,100];
          if (milestones.indexOf(prof.streak)!==-1) {
            addNotificationRef.current("streak", "🔥 "+prof.streak+"-day streak!", "You've used Jotting AI "+prof.streak+" days in a row. Keep it going!");
          }
        });
        var isNew = !localStorage.getItem("jotting_seen_"+firebaseUser.uid);
        if (isNew) { setShowOnboarding(true); localStorage.setItem("jotting_seen_"+firebaseUser.uid,"1"); }
      } else {
        setUser(null);
        setNotes([]);
        setChatSessions([]);
        setPlan("free");
        setCredits(PLANS.free.monthlyCredits);
        setProfile({ school:"", department:"", level:"", streak:0 });
        setNotifCenter([]);
        setAuthLoading(false);
      }
    });
    return unsub;
  }, []);

  function go(s,t){ setScreen(s); if(t)setTab(t); }

  function saveNote(note) {
    var newNote = {...note, userId: user&&user.uid, createdAt: note.createdAt || Date.now()};
    setNotes(function(n){
      var updated = [newNote, ...n];
      if (user) persistNotesLocal(user.uid, updated);
      return updated;
    });
    addNotification("ai_complete", "✨ Note ready", "\""+newNote.title+"\" has been generated and saved to your Library.");
    go("home","home");
    // Sync to Firestore in the background — a slow/broken connection should
    // never block the user from saving and moving on.
    if (user) {
      saveNoteToCloud(user.uid, newNote).then(function(firestoreId){
        if (firestoreId) {
          setNotes(function(n){
            var updated = n.map(function(x){ return x.id===newNote.id ? {...x, firestoreId:firestoreId} : x; });
            persistNotesLocal(user.uid, updated);
            return updated;
          });
        }
      }).catch(function(e){ console.error("Background cloud save failed:", e); });
    }
  }

  async function deleteNote(id) {
    var note = notes.find(function(n){ return n.id===id; });
    if (note&&note.firestoreId) await deleteNoteFromCloud(note.firestoreId);
    setNotes(function(n){
      var updated = n.filter(function(x){ return x.id!==id; });
      if (user) persistNotesLocal(user.uid, updated);
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
    if (user) saveChatToCloud(user.uid, session).catch(function(e){ console.error("Background chat save failed:", e); });
  }

  async function deleteChatSession(id) {
    await deleteChatFromCloud(id);
    setChatSessions(function(s){
      var updated = s.filter(function(x){ return x.id!==id; });
      if (user) persistChatsLocal(user.uid, updated);
      return updated;
    });
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
        <div style={{ width:70,height:70,borderRadius:20,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:34 }}>🎵</div>
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
          <LoginScreen onLogin={function(u){setUser(u);}}/>
        </div>
      </div>
    );
  }

  // Main app
  return (
    <div style={{ height:"100dvh",background:"#06081A",display:"flex",justifyContent:"center",alignItems:"center",overflow:"hidden" }}>
      <style>{"\n@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');\n*{box-sizing:border-box;font-family:'DM Sans',sans-serif;}\nhtml,body{height:100%;overflow:hidden;position:fixed;width:100%;margin:0;background:#06081A;}\nbutton,textarea,input{font-family:'DM Sans',sans-serif;}\n::-webkit-scrollbar{width:0;}\ninput::placeholder,textarea::placeholder{color:#4B5563;}\n@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}\n@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,0.4)}50%{box-shadow:0 0 0 20px rgba(239,68,68,0)}}\n@keyframes wv{from{transform:scaleY(0.3)}to{transform:scaleY(1.2)}}\n@keyframes dot{from{opacity:0.3;transform:scale(0.7)}to{opacity:1;transform:scale(1)}}\n.samx-md p{margin:6px 0;}\n.samx-md ul,.samx-md ol{padding-left:20px;margin:8px 0;}\n.samx-md li{margin:4px 0;}\n.samx-md h1{margin:4px 0 14px;font-size:22px;font-weight:800;color:#F1F5F9;border-bottom:2px solid rgba(6,182,212,0.3);padding-bottom:8px;}\n.samx-md h2{margin:20px 0 8px;font-size:16px;font-weight:800;color:#06B6D4;}\n.samx-md h3{margin:12px 0 6px;font-size:14px;font-weight:700;color:#A78BFA;}\n.samx-md strong{color:#F1F5F9;}\n.samx-md code{background:rgba(6,182,212,0.15);color:#06B6D4;padding:2px 6px;border-radius:5px;font-size:13px;font-family:monospace;}\n.samx-md pre{background:#0A0F1E;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px;overflow-x:auto;margin:8px 0;}\n.samx-md pre code{background:transparent;color:#E2E8F0;padding:0;}\n.samx-md table{border-collapse:collapse;width:100%;font-size:13px;margin:10px 0;}\n.samx-md th,.samx-md td{border:1px solid rgba(255,255,255,0.08);padding:6px 10px;text-align:left;}\n.samx-md th{background:rgba(255,255,255,0.05);}\n.samx-md blockquote{border-left:3px solid #06B6D4;padding-left:10px;margin:8px 0;color:#94A3B8;}\n"}</style>
      <div style={{ width:"100%",maxWidth:400,height:"100dvh",background:C.bg,overflow:"hidden",display:"flex",flexDirection:"column",boxShadow:"0 24px 80px rgba(6,182,212,0.12), 0 0 0 1px rgba(255,255,255,0.06)" }}>
        {cloudLoading&&<div style={{ background:"rgba(6,182,212,0.1)",padding:"10px",textAlign:"center",fontSize:12,color:C.cyan,fontWeight:600 }}>☁️ Syncing your notes...</div>}
        <div style={{ flex:1,display:"flex",flexDirection:"column",overflowY:"auto",minHeight:0 }}>
          {screen==="home"&&<HomeScreen notes={notes} user={user} profile={profile} onNote={function(n){setActiveNote(n);go("detail");}} onVoice={function(){go("voice","new");}} onDraw={function(){go("draw");}} onAIWrite={function(){go("aiwrite");}} onScan={function(){go("scan");}} onChat={function(){go("ai");}} onNotifications={function(){setScreen("notifications");}} onProfile={function(){setScreen("profile");}} unreadCount={notifCenter.filter(function(n){return !n.read;}).length}/>}
          {screen==="library"&&<LibraryScreen notes={notes} onNote={function(n){setActiveNote(n);go("detail");}} onDelete={deleteNote}/>}
          {screen==="dashboard"&&<DashboardScreen notes={notes} user={user} credits={credits} plan={plan}/>}
          {screen==="detail"&&activeNote&&<NoteDetail note={activeNote} onBack={function(){go(tab==="library"?"library":"home",tab);}} onDelete={deleteNote}/>}
          {screen==="voice"&&<VoiceNoteScreen onBack={function(){go("home","home");}} onSave={saveNote} recQuality={recQuality} recSettings={recSettings}/>}
          {screen==="draw"&&<DrawScreen onBack={function(){go("home","home");}} onSave={saveNote}/>}
          {screen==="aiwrite"&&<AIWriteScreen onBack={function(){go("home","home");}} onSave={saveNote}/>}
          {screen==="scan"&&<ScanDocScreen onBack={function(){go("home","home");}} onSave={saveNote}/>}
          {screen==="ai"&&<AIScreen notes={notes} onBack={function(){go("home","home");}} chatSessions={chatSessions} onSaveSession={saveChatSession} onDeleteSession={deleteChatSession}/>}
          {screen==="settings"&&<SettingsScreen user={user} onLogout={handleLogout} recQuality={recQuality} setRecQuality={setRecQuality} recSettings={recSettings} setRecSettings={setRecSettings} plan={plan} credits={credits} onViewPlans={function(){setScreen("pricing");}}/>}
          {screen==="pricing"&&<PricingScreen onBack={function(){go("settings","settings");}} plan={plan} credits={credits}/>}
          {screen==="notifications"&&<NotificationScreen onBack={function(){go(tab,tab);}} notifications={notifCenter} onMarkRead={markNotifRead} onMarkAllRead={markAllNotifsRead} notifEnabled={notifEnabled} setNotifEnabled={setNotifEnabled}/>}
          {screen==="profile"&&<ProfileScreen onBack={function(){go(tab,tab);}} user={user} plan={plan} credits={credits} profile={profile} onSaveProfile={saveProfile} onLogout={handleLogout}/>}
        </div>
        <div style={{ background:C.card2,borderTop:"1px solid "+C.border,padding:"10px 10px 16px",display:"flex",justifyContent:"space-around",alignItems:"center",flexShrink:0 }}>
          {NAV.map(function(item){return(
            <button key={item.id} onClick={function(){go(item.s,item.id);}} style={{ background:item.special?"linear-gradient(135deg,#06B6D4,#A78BFA)":"none",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:item.special?"0":"4px 8px",width:item.special?52:"auto",height:item.special?52:"auto",borderRadius:item.special?"50%":0,boxShadow:item.special?"0 4px 20px rgba(6,182,212,0.4)":"none",justifyContent:"center",flexShrink:0 }}>
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
