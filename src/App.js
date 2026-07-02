import { useState, useEffect, useRef } from "react";

const C = {
  bg: "#0A0F1E", card: "#111827", card2: "#1E293B",
  border: "rgba(255,255,255,0.06)", cyan: "#06B6D4",
  purple: "#A78BFA", amber: "#F59E0B", green: "#34D399",
  red: "#F87171", text: "#F1F5F9", muted: "#64748B", soft: "#94A3B8",
};

const GEMINI_KEY = "AQ.Ab8RN6IbBnG7ziM4LHDj1Cuh8qr_uo2XKtRH3XxWnFdGA2zoww";
const GEMINI_MODEL = "gemini-2.5-flash";

// Shared helpers for calling Google's free Gemini API (text-only and vision).
async function callGeminiText(promptText, maxTokens){
  var res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/"+GEMINI_MODEL+":generateContent?key="+GEMINI_KEY,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: promptText }] }],
        generationConfig: { maxOutputTokens: maxTokens || 800 }
      })
    }
  );
  var data = await res.json();
  var text = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  if(!text){ throw new Error((data && data.error && data.error.message) || "No response from Gemini"); }
  return text;
}

async function callGeminiVision(base64, mediaType, promptText, maxTokens){
  var res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/"+GEMINI_MODEL+":generateContent?key="+GEMINI_KEY,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [
          { inline_data: { mime_type: mediaType, data: base64 } },
          { text: promptText }
        ] }],
        generationConfig: { maxOutputTokens: maxTokens || 1200 }
      })
    }
  );
  var data = await res.json();
  var text = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  if(!text){ throw new Error((data && data.error && data.error.message) || "No response from Gemini"); }
  return text;
}

const INIT_NOTES = [
  { id: 1, title: "Physics: Kinematics", course: "PHY 101", color: "#06B6D4", bg: "rgba(6,182,212,0.12)", date: "Today", tag: "Lecture", words: 120, preview: "Kinematics is the study of motion. v = u + at is the fundamental equation.", content: "Kinematics is the study of motion without considering forces.\n\nKey Equations:\nv = u + at\ns = ut + half at squared\n\nVelocity is the rate of change of displacement.\nAcceleration is the rate of change of velocity." },
  { id: 2, title: "Data Structures", course: "COS 201", color: "#A78BFA", bg: "rgba(167,139,250,0.12)", date: "Yesterday", tag: "Study", words: 89, preview: "Stack uses LIFO, Queue uses FIFO. Binary trees have at most 2 children.", content: "Stack - Last In First Out (LIFO)\nQueue - First In First Out (FIFO)\nLinked List - Dynamic memory allocation\nBinary Tree - At most 2 children per node" },
  { id: 3, title: "NoteWave Business Plan", course: "Personal", color: "#F59E0B", bg: "rgba(245,158,11,0.12)", date: "Jun 20", tag: "Business", words: 200, preview: "AI note-taking app for students. Freemium with Pro at 550 per month.", content: "Product: AI-powered lecture note app\nTarget: Nigerian university students\nRevenue: Freemium\nPro: Unlimited AI features 550 per month\nLaunch: Q3 2026" },
  { id: 4, title: "Organic Chemistry", course: "CHM 102", color: "#34D399", bg: "rgba(52,211,153,0.12)", date: "Jun 18", tag: "Lecture", words: 145, preview: "Functional groups determine chemical properties. Alkanes, Alkenes, Alkynes.", content: "Functional Groups:\nAlkanes: Single bonds (CnH2n+2)\nAlkenes: Double bonds (CnH2n)\nAlkynes: Triple bonds\n\nIUPAC Naming conventions apply to all organic compounds." },
  { id: 5, title: "Calculus Notes", course: "MTH 101", color: "#F87171", bg: "rgba(248,113,113,0.12)", date: "Jun 17", tag: "Study", words: 178, preview: "Differentiation and integration are the two main operations of calculus.", content: "Differentiation:\nd/dx(x^n) = nx^(n-1)\nd/dx(sin x) = cos x\nd/dx(cos x) = -sin x\n\nIntegration:\nIntegral of x^n = x^(n+1)/(n+1) + C" },
];

// ── Push Notifications ────────────────────────────────────────────────────────
function requestNotificationPermission() {
  if ("Notification" in window) {
    Notification.requestPermission();
  }
}

function sendNotification(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, {
      body: body,
      icon: "/logo192.png",
      badge: "/logo192.png",
    });
  }
}

// Config for each individual reminder toggle: what time it fires and what it says.
// "assignment" has no real due-date data yet, so it's a generic daily nudge, not a
// due-date-specific alert — flagged honestly rather than faked.
const REMINDER_CONFIG = {
  study:      { hour: 9,  minute: 0,  title: "Study Reminder",     message: "Time to review your notes and study a bit!" },
  assignment: { hour: 18, minute: 0,  title: "Assignment Check",   message: "Quick check-in: any assignments due soon?" },
  daily:      { hour: 20, minute: 0,  title: "Daily Goal Reminder", message: "Have you hit your daily study goal today?" },
  recording:  { hour: 7,  minute: 30, title: "Recording Reminder", message: "Got a lecture today? Don't forget to record it!" },
};

// Module-level registry of live timers, keyed by reminder id, so each toggle can be
// scheduled/cancelled independently without stacking duplicate timers.
var reminderTimers = {};

function cancelReminder(key) {
  if (reminderTimers[key]) {
    clearTimeout(reminderTimers[key]);
    clearInterval(reminderTimers[key]);
    delete reminderTimers[key];
  }
}

function scheduleDailyReminder(key) {
  cancelReminder(key);
  var cfg = REMINDER_CONFIG[key];
  if (!cfg) return;
  var now = new Date();
  var next = new Date();
  next.setHours(cfg.hour, cfg.minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  reminderTimers[key] = setTimeout(function fire() {
    sendNotification(cfg.title, cfg.message);
    reminderTimers[key] = setInterval(function() {
      sendNotification(cfg.title, cfg.message);
    }, 24 * 60 * 60 * 1000);
  }, next - now);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function Wave({ active, color, size }) {
  var c = color || "#06B6D4"; var s = size || 1;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:2.5, height:20*s }}>
      {[0.5,1,1.6,1,0.7,1.4,0.9,1.2,0.6,1.1,0.8].map(function(h,i){
        return <div key={i} style={{ width:2.5*s, borderRadius:99, background:active?c:"#374151", height:active?(h*16*s)+"px":(3*s)+"px", transition:"height 0.3s ease", animation:active?("wv "+(0.35+i*0.07)+"s ease-in-out infinite alternate"):"none" }} />;
      })}
    </div>
  );
}

function Toggle({ value, onChange, color }) {
  var c = color || "#06B6D4";
  return (
    <div onClick={function(){ onChange(!value); }} style={{ width:46, height:26, borderRadius:13, background:value?c:"#374151", cursor:"pointer", position:"relative", transition:"background 0.25s", flexShrink:0 }}>
      <div style={{ position:"absolute", top:3, left:value?23:3, width:20, height:20, borderRadius:"50%", background:"#fff", transition:"left 0.25s" }} />
    </div>
  );
}

var backBtn = { background:"rgba(255,255,255,0.08)", border:"none", borderRadius:10, width:36, height:36, cursor:"pointer", color:"#fff", fontSize:18, display:"flex", alignItems:"center", justifyContent:"center" };
function actionBtn(color){ return { background:color+"15", border:"1px solid "+color+"40", borderRadius:12, padding:"12px", fontSize:13, fontWeight:700, color:color, cursor:"pointer", fontFamily:"inherit" }; }

// ── DASHBOARD SCREEN ──────────────────────────────────────────────────────────
function DashboardScreen({ notes }) {
  var totalWords = notes.reduce(function(sum, n){ return sum + (n.words || n.content.split(" ").length); }, 0);
  var totalNotes = notes.length;
  var todayNotes = notes.filter(function(n){ return n.date === "Today"; }).length;
  var streak = 7; // demo streak

  // Notes by course
  var courseCounts = {};
  notes.forEach(function(n){
    courseCounts[n.course] = (courseCounts[n.course] || 0) + 1;
  });

  // Notes by tag
  var tagCounts = { Lecture:0, Study:0, Business:0, Personal:0 };
  notes.forEach(function(n){ if(tagCounts[n.tag]!==undefined) tagCounts[n.tag]++; });

  // Weekly activity (demo data)
  var weekDays = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  var weekActivity = [3, 1, 4, 2, 5, 0, 2];
  var maxActivity = Math.max.apply(null, weekActivity);

  var tagColors = { Lecture:C.cyan, Study:C.purple, Business:C.amber, Personal:C.green };

  return (
    <div style={{ flex:1, overflowY:"auto", background:C.bg }}>
      {/* Header */}
      <div style={{ background:"linear-gradient(135deg,#0A0F1E,#1E1B4B)", padding:"20px 20px 24px" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
          <div style={{ width:40, height:40, borderRadius:12, background:"linear-gradient(135deg,#06B6D4,#A78BFA)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>🎵</div>
          <span style={{ fontWeight:800, fontSize:20, color:C.text }}>Jotting <span style={{ color:C.cyan }}>AI</span></span>
        </div>
        <h2 style={{ color:C.text, fontSize:22, fontWeight:800, margin:"12px 0 4px" }}>Your Dashboard 📊</h2>
        <p style={{ color:C.muted, fontSize:13, margin:0 }}>Track your study progress</p>
      </div>

      <div style={{ padding:"16px 16px 100px" }}>
        {/* Study Streak */}
        <div style={{ background:"linear-gradient(135deg,#F59E0B,#EF4444)", borderRadius:20, padding:"20px", marginBottom:16, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontSize:13, color:"rgba(255,255,255,0.8)", fontWeight:600, marginBottom:4 }}>Study Streak 🔥</div>
            <div style={{ fontSize:40, fontWeight:800, color:"#fff" }}>{streak} Days</div>
            <div style={{ fontSize:12, color:"rgba(255,255,255,0.7)", marginTop:4 }}>Keep it up! You are on fire!</div>
          </div>
          <div style={{ fontSize:64 }}>🔥</div>
        </div>

        {/* Stats Grid */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:16 }}>
          {[
            ["📝", totalNotes, "Total Notes", C.cyan],
            ["💬", totalWords, "Total Words", C.purple],
            ["📅", todayNotes, "Notes Today", C.green],
            ["⭐", "4.8", "Avg Rating", C.amber],
          ].map(function(item){
            return (
              <div key={item[2]} style={{ background:C.card, borderRadius:16, padding:"16px", border:"1px solid "+C.border }}>
                <div style={{ fontSize:24, marginBottom:8 }}>{item[0]}</div>
                <div style={{ fontSize:28, fontWeight:800, color:item[3] }}>{item[1]}</div>
                <div style={{ fontSize:12, color:C.muted, fontWeight:600, marginTop:2 }}>{item[2]}</div>
              </div>
            );
          })}
        </div>

        {/* Weekly Activity */}
        <div style={{ background:C.card, borderRadius:18, padding:"20px", marginBottom:16, border:"1px solid "+C.border }}>
          <div style={{ fontWeight:800, fontSize:15, color:C.text, marginBottom:16 }}>Weekly Activity 📈</div>
          <div style={{ display:"flex", alignItems:"flex-end", gap:8, height:80 }}>
            {weekDays.map(function(day, i){
              var height = maxActivity > 0 ? (weekActivity[i]/maxActivity)*70 : 4;
              return (
                <div key={day} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:6 }}>
                  <div style={{ width:"100%", height:height+"px", background:weekActivity[i]>0?"linear-gradient(135deg,#06B6D4,#A78BFA)":"rgba(255,255,255,0.05)", borderRadius:6, minHeight:4, transition:"height 0.3s" }} />
                  <span style={{ fontSize:10, color:C.muted, fontWeight:600 }}>{day}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Notes by Course */}
        <div style={{ background:C.card, borderRadius:18, padding:"20px", marginBottom:16, border:"1px solid "+C.border }}>
          <div style={{ fontWeight:800, fontSize:15, color:C.text, marginBottom:16 }}>Notes by Course 📚</div>
          {Object.keys(courseCounts).map(function(course){
            var count = courseCounts[course];
            var pct = Math.round((count/totalNotes)*100);
            var note = notes.find(function(n){ return n.course===course; });
            var color = note ? note.color : C.cyan;
            return (
              <div key={course} style={{ marginBottom:14 }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                  <span style={{ fontSize:13, fontWeight:700, color:C.text }}>{course}</span>
                  <span style={{ fontSize:13, color:C.muted }}>{count} note{count!==1?"s":""} · {pct}%</span>
                </div>
                <div style={{ height:8, background:"rgba(255,255,255,0.05)", borderRadius:4 }}>
                  <div style={{ height:8, width:pct+"%", background:color, borderRadius:4, transition:"width 0.5s" }} />
                </div>
              </div>
            );
          })}
        </div>

        {/* Notes by Type */}
        <div style={{ background:C.card, borderRadius:18, padding:"20px", marginBottom:16, border:"1px solid "+C.border }}>
          <div style={{ fontWeight:800, fontSize:15, color:C.text, marginBottom:16 }}>Notes by Type 🏷️</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            {Object.keys(tagCounts).map(function(tag){
              var count = tagCounts[tag];
              var color = tagColors[tag] || C.cyan;
              var icons = { Lecture:"📚", Study:"💡", Business:"💼", Personal:"📝" };
              return (
                <div key={tag} style={{ background:color+"15", borderRadius:14, padding:"14px", border:"1px solid "+color+"30" }}>
                  <div style={{ fontSize:24, marginBottom:6 }}>{icons[tag]}</div>
                  <div style={{ fontSize:22, fontWeight:800, color:color }}>{count}</div>
                  <div style={{ fontSize:11, color:C.muted, fontWeight:600 }}>{tag}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Recent Activity */}
        <div style={{ background:C.card, borderRadius:18, padding:"20px", border:"1px solid "+C.border }}>
          <div style={{ fontWeight:800, fontSize:15, color:C.text, marginBottom:16 }}>Recent Activity ⏰</div>
          {notes.slice(0,4).map(function(note){
            return (
              <div key={note.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 0", borderBottom:"1px solid "+C.border }}>
                <div style={{ width:38, height:38, borderRadius:10, background:note.bg, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, flexShrink:0 }}>
                  {note.tag==="Lecture"?"📚":note.tag==="Study"?"💡":note.tag==="Business"?"💼":"📝"}
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:700, color:C.text }}>{note.title}</div>
                  <div style={{ fontSize:11, color:C.muted }}>{note.date} · {note.course}</div>
                </div>
                <span style={{ fontSize:11, color:note.color, fontWeight:700, background:note.bg, borderRadius:99, padding:"2px 8px" }}>{note.tag}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── LIBRARY SCREEN ────────────────────────────────────────────────────────────
function LibraryScreen({ notes, onNote, onDelete }) {
  var [search, setSearch] = useState("");
  var [sort, setSort] = useState("date");
  var [filter, setFilter] = useState("All");
  var [view, setView] = useState("list"); // list or grid
  var [selected, setSelected] = useState([]);

  var filters = ["All","Lecture","Study","Business","Personal"];
  var sorts = [["date","📅 Date"],["title","🔤 Title"],["course","📚 Course"],["words","💬 Words"]];

  var filtered = notes.filter(function(n){
    var ms = n.title.toLowerCase().includes(search.toLowerCase()) || n.course.toLowerCase().includes(search.toLowerCase()) || n.content.toLowerCase().includes(search.toLowerCase());
    var mf = filter==="All" || n.tag===filter;
    return ms && mf;
  });

  filtered = filtered.slice().sort(function(a,b){
    if (sort==="title") return a.title.localeCompare(b.title);
    if (sort==="course") return a.course.localeCompare(b.course);
    if (sort==="words") return (b.words||0)-(a.words||0);
    return 0; // date - keep original order
  });

  function toggleSelect(id){
    setSelected(function(s){
      return s.includes(id) ? s.filter(function(x){ return x!==id; }) : [...s, id];
    });
  }

  function deleteSelected(){
    selected.forEach(function(id){ onDelete(id); });
    setSelected([]);
  }

  return (
    <div style={{ flex:1, background:C.bg, display:"flex", flexDirection:"column" }}>
      {/* Header */}
      <div style={{ background:"linear-gradient(135deg,#0A0F1E,#1E1B4B)", padding:"20px 20px 0" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div>
            <h2 style={{ color:C.text, fontSize:22, fontWeight:800, margin:0 }}>Library 📚</h2>
            <p style={{ color:C.muted, fontSize:12, margin:"4px 0 0" }}>{notes.length} notes saved</p>
          </div>
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={function(){ setView(view==="list"?"grid":"list"); }} style={{ background:"rgba(255,255,255,0.08)", border:"none", borderRadius:10, width:36, height:36, cursor:"pointer", fontSize:16, display:"flex", alignItems:"center", justifyContent:"center" }}>
              {view==="list"?"⊞":"☰"}
            </button>
          </div>
        </div>
        {/* Search */}
        <div style={{ position:"relative", marginBottom:14 }}>
          <span style={{ position:"absolute", left:14, top:"50%", transform:"translateY(-50%)" }}>🔍</span>
          <input value={search} onChange={function(e){ setSearch(e.target.value); }} placeholder="Search notes, courses, content..." style={{ width:"100%", padding:"11px 14px 11px 42px", borderRadius:12, border:"1px solid rgba(255,255,255,0.1)", fontSize:13, background:"rgba(255,255,255,0.07)", color:C.text, outline:"none", boxSizing:"border-box" }} />
        </div>
        {/* Filter tabs */}
        <div style={{ display:"flex", gap:6, overflowX:"auto", paddingBottom:14 }}>
          {filters.map(function(f){
            return <button key={f} onClick={function(){ setFilter(f); }} style={{ padding:"6px 14px", borderRadius:99, border:"none", background:filter===f?C.cyan:"rgba(255,255,255,0.07)", color:filter===f?"#0A0F1E":C.muted, fontSize:12, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap", flexShrink:0 }}>{f}</button>;
          })}
        </div>
      </div>

      {/* Sort & Actions bar */}
      <div style={{ background:C.card, padding:"10px 16px", display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom:"1px solid "+C.border }}>
        <div style={{ display:"flex", gap:6, overflowX:"auto" }}>
          {sorts.map(function(s){
            return <button key={s[0]} onClick={function(){ setSort(s[0]); }} style={{ padding:"5px 12px", borderRadius:99, border:"none", background:sort===s[0]?C.purple+"30":"transparent", color:sort===s[0]?C.purple:C.muted, fontSize:11, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap" }}>{s[1]}</button>;
          })}
        </div>
        {selected.length > 0 && (
          <button onClick={deleteSelected} style={{ background:"rgba(248,113,113,0.15)", border:"1px solid "+C.red+"40", borderRadius:8, padding:"5px 12px", color:C.red, fontSize:11, fontWeight:700, cursor:"pointer", flexShrink:0 }}>
            🗑 Delete {selected.length}
          </button>
        )}
      </div>

      {/* Notes list */}
      <div style={{ flex:1, overflowY:"auto", padding:16 }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign:"center", padding:"60px 20px" }}>
            <div style={{ fontSize:52, marginBottom:12 }}>🔍</div>
            <div style={{ fontWeight:800, fontSize:18, color:C.text }}>No notes found</div>
            <div style={{ color:C.muted, fontSize:14, marginTop:8 }}>Try a different search or filter</div>
          </div>
        ) : view === "grid" ? (
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            {filtered.map(function(note){
              var isSelected = selected.includes(note.id);
              return (
                <div key={note.id} style={{ background:C.card, border:"2px solid "+(isSelected?C.cyan:note.color+"22"), borderRadius:16, padding:14, cursor:"pointer", position:"relative" }}
                  onClick={function(){ onNote(note); }}>
                  <div onClick={function(e){ e.stopPropagation(); toggleSelect(note.id); }} style={{ position:"absolute", top:10, right:10, width:20, height:20, borderRadius:"50%", border:"2px solid "+(isSelected?C.cyan:C.border), background:isSelected?C.cyan:"transparent", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11 }}>{isSelected?"✓":""}</div>
                  <div style={{ width:36, height:36, borderRadius:10, background:note.bg, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, marginBottom:10 }}>{note.tag==="Lecture"?"📚":note.tag==="Study"?"💡":note.tag==="Business"?"💼":"📝"}</div>
                  <div style={{ fontWeight:700, fontSize:13, color:C.text, marginBottom:4 }}>{note.title}</div>
                  <div style={{ fontSize:10, color:note.color, fontWeight:700, background:note.bg, borderRadius:99, padding:"2px 8px", display:"inline-block", marginBottom:6 }}>{note.course}</div>
                  <div style={{ fontSize:11, color:C.muted }}>{note.date}</div>
                </div>
              );
            })}
          </div>
        ) : (
          filtered.map(function(note){
            var isSelected = selected.includes(note.id);
            return (
              <div key={note.id} style={{ background:C.card, border:"2px solid "+(isSelected?C.cyan:note.color+"22"), borderRadius:16, padding:16, marginBottom:10, cursor:"pointer", display:"flex", gap:12, alignItems:"flex-start" }}
                onClick={function(){ onNote(note); }}>
                <div onClick={function(e){ e.stopPropagation(); toggleSelect(note.id); }} style={{ width:22, height:22, borderRadius:"50%", border:"2px solid "+(isSelected?C.cyan:C.border), background:isSelected?C.cyan:"transparent", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, flexShrink:0, marginTop:2 }}>{isSelected?"✓":""}</div>
                <div style={{ width:42, height:42, borderRadius:12, background:note.bg, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>{note.tag==="Lecture"?"📚":note.tag==="Study"?"💡":note.tag==="Business"?"💼":"📝"}</div>
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:4 }}>
                    <div style={{ fontWeight:800, fontSize:14, color:C.text }}>{note.title}</div>
                    <div style={{ fontSize:11, color:C.muted, flexShrink:0, marginLeft:8 }}>{note.date}</div>
                  </div>
                  <div style={{ display:"flex", gap:6, marginBottom:6 }}>
                    <span style={{ fontSize:10, color:note.color, fontWeight:700, background:note.bg, borderRadius:99, padding:"2px 8px" }}>{note.course}</span>
                    <span style={{ fontSize:10, color:C.muted, background:"rgba(255,255,255,0.04)", borderRadius:99, padding:"2px 8px" }}>{note.tag}</span>
                  </div>
                  <div style={{ fontSize:12, color:C.muted, lineHeight:1.5, display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical", overflow:"hidden" }}>{note.preview}</div>
                  <div style={{ display:"flex", gap:12, marginTop:8 }}>
                    <span style={{ fontSize:11, color:C.soft }}>💬 {note.words||note.content.split(" ").length} words</span>
                    <span style={{ fontSize:11, color:note.color, marginLeft:"auto" }}>Open →</span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── VOICE RECORDING SCREEN ─────────────────────────────────────────────────
function VoiceNoteScreen({ onBack, onSave, recSettings }) {
  recSettings = recSettings || { noise:true, autoTranscribe:true, speakerID:false, autoSave:false };
  var [isRecording, setIsRecording] = useState(false);
  var [isPaused, setIsPaused] = useState(false);
  var [elapsed, setElapsed] = useState(0);
  var [title, setTitle] = useState("");
  var [courses, setCourses] = useState(["General"]);
  var [course, setCourse] = useState("General");
  var [status, setStatus] = useState("Tap microphone to start recording");
  var [showAddCourse, setShowAddCourse] = useState(false);
  var [newCourse, setNewCourse] = useState("");
  var [transcript, setTranscript] = useState("");
  var timerRef = useRef(null);
  var recognitionRef = useRef(null);
  var allTextRef = useRef("");
  var isActiveRef = useRef(false);
  var sessionIdRef = useRef(0); // guards against stale/overlapping recognition instances
  var fmt = function(s){ return String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0"); };
  function addCourse(){ var c=newCourse.trim().toUpperCase(); if(!c||courses.includes(c))return; setCourses(function(p){return [...p,c];}); setNewCourse(""); setShowAddCourse(false); }
  function removeCourse(c){ if(c==="General")return; setCourses(function(p){return p.filter(function(x){return x!==c;});}); if(course===c)setCourse("General"); }

  // Trims duplicate words at the point where `addition` overlaps the tail of `base`.
  // Catches cases where a restarted recognition session re-captures a word or two
  // of audio the previous session had already finalized.
  function mergeNoDupe(base, addition){
    if(!base) return addition;
    if(!addition) return base;
    var baseWords = base.trim().split(/\s+/);
    var addWords = addition.trim().split(/\s+/);
    var maxOverlap = Math.min(6, baseWords.length, addWords.length);
    for(var len=maxOverlap; len>0; len--){
      var tail = baseWords.slice(baseWords.length-len).join(" ").toLowerCase();
      var head = addWords.slice(0,len).join(" ").toLowerCase();
      if(tail === head){
        return base + " " + addWords.slice(len).join(" ");
      }
    }
    return base + " " + addition;
  }

  function createRecognition(baseText, sessionId){
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!SR)return null;
    var r = new SR();
    r.continuous = true; r.interimResults = true; r.lang = "en-US";
    var sessionNew = "";
    r.onresult = function(e){
      if(sessionIdRef.current !== sessionId) return; // a newer session has taken over; ignore stale events
      var final = ""; var interim = "";
      for(var i=e.resultIndex;i<e.results.length;i++){
        if(e.results[i].isFinal){ final += e.results[i][0].transcript+" "; }
        else{ interim += e.results[i][0].transcript; }
      }
      if(final){ sessionNew = mergeNoDupe(sessionNew, final); }
      var combined = mergeNoDupe(baseText, sessionNew);
      allTextRef.current = combined;
      setTranscript((combined + " " + interim).replace(/\s+/g," ").trim());
      setStatus("Listening... speak clearly");
    };
    r.onerror = function(e){ if(e.error==="no-speech"||e.error==="aborted")return; };
    r.onend = function(){
      if(sessionIdRef.current !== sessionId) return; // stale instance; a restart already happened elsewhere
      if(isActiveRef.current){
        var newBase = mergeNoDupe(baseText, sessionNew);
        allTextRef.current = newBase;
        setTimeout(function(){
          if(isActiveRef.current && sessionIdRef.current === sessionId){
            var newId = sessionId + 1;
            sessionIdRef.current = newId;
            var next = createRecognition(newBase, newId);
            if(next){ recognitionRef.current=next; try{next.start();}catch(err){} }
          }
        },300);
      } else { setStatus("Recording complete"); }
    };
    return r;
  }

  function startRecording(){
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!SR){setStatus("Please use Chrome browser!");return;}
    // Best-effort: ask the browser for a noise-suppressed mic before the Speech API
    // grabs its own audio access. The recognizer manages capture internally, so this
    // won't transform the transcription itself, but it does apply real OS/browser-level
    // noise suppression to the mic session and primes the permission early.
    if(recSettings.noise && navigator.mediaDevices && navigator.mediaDevices.getUserMedia){
      navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression:true, echoCancellation:true } })
        .then(function(stream){ stream.getTracks().forEach(function(t){ t.stop(); }); })
        .catch(function(){});
    }
    allTextRef.current=""; setTranscript(""); isActiveRef.current=true;
    setIsRecording(true); setIsPaused(false); setElapsed(0);
    timerRef.current = setInterval(function(){setElapsed(function(e){return e+1;});},1000);
    var newId = sessionIdRef.current + 1;
    sessionIdRef.current = newId;
    var r = createRecognition("", newId);
    if(r){ recognitionRef.current=r; try{r.start();}catch(e){} }
  }
  function pauseRecording(){ isActiveRef.current=false; setIsPaused(true); sessionIdRef.current++; clearInterval(timerRef.current); try{recognitionRef.current&&recognitionRef.current.stop();}catch(e){} setStatus("Paused"); }
  function resumeRecording(){ isActiveRef.current=true; setIsPaused(false); timerRef.current=setInterval(function(){setElapsed(function(e){return e+1;});},1000); var newId=sessionIdRef.current+1; sessionIdRef.current=newId; var r=createRecognition(allTextRef.current, newId); if(r){recognitionRef.current=r;try{r.start();}catch(e){}} setStatus("Resumed..."); }
  function stopRecording(){
    isActiveRef.current=false; setIsRecording(false); setIsPaused(false); sessionIdRef.current++; clearInterval(timerRef.current);
    try{recognitionRef.current&&recognitionRef.current.stop();}catch(e){}
    setStatus("Recording complete");
    if(recSettings.autoSave){
      // Small delay lets the final onresult/onend from the recognizer settle before we read it.
      setTimeout(function(){
        var finalText = allTextRef.current;
        if(finalText && finalText.trim()){
          onSave({id:Date.now(),title:title||("Voice Note - "+new Date().toLocaleDateString()),course,color:"#06B6D4",bg:"rgba(6,182,212,0.12)",date:"Today",tag:"Lecture",words:finalText.split(" ").length,preview:finalText.slice(0,100),content:finalText});
        }
      }, 500);
    }
  }
  useEffect(function(){ return function(){ isActiveRef.current=false; clearInterval(timerRef.current); try{recognitionRef.current&&recognitionRef.current.stop();}catch(e){}; }; },[]);
  function saveNote(){ if(!transcript.trim()){alert("Record something first!");return;} onSave({id:Date.now(),title:title||("Voice Note - "+new Date().toLocaleDateString()),course,color:"#06B6D4",bg:"rgba(6,182,212,0.12)",date:"Today",tag:"Lecture",words:transcript.split(" ").length,preview:transcript.slice(0,100),content:transcript}); }

  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>Voice Recording</span>
        {recSettings.autoSave
          ? <span style={{ fontSize:11,fontWeight:700,color:C.green,background:"rgba(52,211,153,0.12)",borderRadius:99,padding:"6px 12px" }}>💾 Auto-saves on stop</span>
          : <button onClick={saveNote} style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:10,padding:"8px 18px",fontWeight:800,fontSize:14,cursor:"pointer" }}>Save</button>}
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        <div style={{ background:"linear-gradient(135deg,rgba(52,211,153,0.1),rgba(6,182,212,0.1))",borderRadius:14,padding:"10px 16px",marginBottom:16,border:"1px solid rgba(52,211,153,0.2)",display:"flex",alignItems:"center",gap:10 }}>
          <span style={{ fontSize:20 }}>🆓</span>
          <div><div style={{ fontWeight:700,fontSize:13,color:C.green }}>Google Free Speech API</div><div style={{ fontSize:11,color:C.muted }}>Completely free - no API key needed</div></div>
        </div>
        <input value={title} onChange={function(e){setTitle(e.target.value);}} placeholder="Note title (optional)..." style={{ width:"100%",padding:"13px 16px",borderRadius:12,border:"1px solid "+C.border,fontSize:15,fontWeight:700,background:C.card,color:C.text,outline:"none",marginBottom:14,boxSizing:"border-box" }} />
        <div style={{ marginBottom:16 }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
            <span style={{ fontSize:13,fontWeight:700,color:C.soft }}>Select Course</span>
            <button onClick={function(){setShowAddCourse(function(s){return !s;});}} style={{ background:C.cyan+"20",border:"1px solid "+C.cyan+"40",borderRadius:8,padding:"5px 12px",color:C.cyan,fontSize:12,fontWeight:700,cursor:"pointer" }}>+ Add Course</button>
          </div>
          {showAddCourse&&(<div style={{ background:C.card2,borderRadius:14,padding:14,marginBottom:12,border:"1px solid "+C.cyan+"30" }}><div style={{ display:"flex",gap:8 }}><input value={newCourse} onChange={function(e){setNewCourse(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")addCourse();}} placeholder="e.g. BIO 201" style={{ flex:1,padding:"10px 14px",borderRadius:10,border:"1px solid "+C.border,background:C.bg,color:C.text,outline:"none",fontSize:14 }} /><button onClick={addCourse} style={{ background:C.cyan,border:"none",borderRadius:10,padding:"10px 16px",color:"#0A0F1E",fontWeight:800,cursor:"pointer" }}>Add</button><button onClick={function(){setShowAddCourse(false);}} style={{ background:C.card,border:"1px solid "+C.border,borderRadius:10,padding:"10px 12px",color:C.muted,cursor:"pointer" }}>X</button></div></div>)}
          <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
            {courses.map(function(c){return(<div key={c} style={{ display:"flex" }}><button onClick={function(){setCourse(c);}} style={{ padding:"7px 14px",borderRadius:c==="General"?99:"99px 0 0 99px",border:"2px solid",borderColor:course===c?C.cyan:C.border,borderRight:c!=="General"?"none":undefined,background:course===c?C.cyan:C.card,color:course===c?"#0A0F1E":C.muted,fontSize:12,fontWeight:700,cursor:"pointer" }}>{c}</button>{c!=="General"&&<button onClick={function(){removeCourse(c);}} style={{ padding:"7px 8px",borderRadius:"0 99px 99px 0",border:"2px solid",borderColor:course===c?C.cyan:C.border,borderLeft:"none",background:course===c?C.cyan:C.card,color:C.red,fontSize:11,cursor:"pointer" }}>X</button>}</div>);})}
          </div>
        </div>
        <div style={{ background:C.card,borderRadius:24,padding:"28px 20px",border:"2px solid "+(isRecording&&!isPaused?C.red:isPaused?C.amber:C.border),marginBottom:16,textAlign:"center",transition:"border-color 0.3s" }}>
          <div onClick={!isRecording?startRecording:undefined} style={{ width:110,height:110,borderRadius:"50%",background:isRecording?(isPaused?"linear-gradient(135deg,#F59E0B,#FCD34D)":"linear-gradient(135deg,#EF4444,#F87171)"):"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 20px",cursor:!isRecording?"pointer":"default",fontSize:46,boxShadow:isRecording&&!isPaused?"0 0 0 14px rgba(239,68,68,0.12)":"0 8px 32px rgba(6,182,212,0.35)",animation:isRecording&&!isPaused?"pulse 1.5s ease-in-out infinite":"none" }}>{isPaused?"⏸":"🎙️"}</div>
          {isRecording&&<div style={{ fontSize:40,fontWeight:800,color:isPaused?C.amber:C.red,marginBottom:12,fontFamily:"monospace",letterSpacing:3 }}>{fmt(elapsed)}</div>}
          <div style={{ display:"flex",justifyContent:"center",marginBottom:14 }}><Wave active={isRecording&&!isPaused} color={isRecording&&!isPaused?"#EF4444":C.cyan} size={1.6} /></div>
          <p style={{ color:isRecording?(isPaused?C.amber:C.red):C.muted,fontSize:14,fontWeight:600,margin:"0 0 20px" }}>{status}</p>
          <div style={{ display:"flex",gap:10,justifyContent:"center" }}>
            {!isRecording?(<button onClick={startRecording} style={{ background:"linear-gradient(135deg,#EF4444,#F87171)",color:"#fff",border:"none",borderRadius:14,padding:"14px 36px",fontWeight:800,fontSize:15,cursor:"pointer",boxShadow:"0 4px 20px rgba(239,68,68,0.4)" }}>Start Recording</button>):(
              <div style={{ display:"flex",gap:10 }}>{!isPaused?<button onClick={pauseRecording} style={{ background:C.amber,color:"#0A0F1E",border:"none",borderRadius:14,padding:"13px 24px",fontWeight:800,fontSize:14,cursor:"pointer" }}>⏸ Pause</button>:<button onClick={resumeRecording} style={{ background:C.green,color:"#0A0F1E",border:"none",borderRadius:14,padding:"13px 24px",fontWeight:800,fontSize:14,cursor:"pointer" }}>▶ Resume</button>}<button onClick={stopRecording} style={{ background:"rgba(248,113,113,0.15)",color:C.red,border:"2px solid "+C.red+"40",borderRadius:14,padding:"13px 24px",fontWeight:800,fontSize:14,cursor:"pointer" }}>⏹ Stop</button></div>
            )}
          </div>
        </div>
        <div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+(transcript?C.cyan+"40":C.border) }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12 }}>
            <div style={{ display:"flex",alignItems:"center",gap:8 }}><span style={{ fontWeight:700,fontSize:14,color:C.cyan }}>📝 Live Transcript</span>{isRecording&&!isPaused&&<div style={{ width:8,height:8,borderRadius:"50%",background:C.red,animation:"pulse 1s ease-in-out infinite" }} />}</div>
            <div style={{ display:"flex",gap:8 }}>{transcript&&<button onClick={function(){allTextRef.current="";setTranscript("");}} style={{ background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:12,fontWeight:600 }}>Clear</button>}{transcript&&<button onClick={function(){navigator.clipboard&&navigator.clipboard.writeText(transcript);}} style={{ background:C.card2,border:"none",borderRadius:8,padding:"4px 10px",color:C.cyan,cursor:"pointer",fontSize:12,fontWeight:600 }}>Copy</button>}</div>
          </div>
          <div style={{ minHeight:120,fontSize:14,lineHeight:1.9,color:transcript?C.text:C.muted }}>{transcript||"Tap Start Recording — your words appear here instantly..."}</div>
          {transcript&&(<div style={{ marginTop:10,paddingTop:10,borderTop:"1px solid "+C.border,display:"flex",justifyContent:"space-between" }}><span style={{ fontSize:11,color:C.muted }}>{transcript.split(" ").filter(function(w){return w;}).length} words</span><span style={{ fontSize:11,color:C.muted }}>{transcript.length} characters</span></div>)}
        </div>
      </div>
    </div>
  );
}

// ── DRAW SCREEN ───────────────────────────────────────────────────────────────
function DrawScreen({ onBack }) {
  var canvasRef = useRef(null); var [drawing, setDrawing] = useState(false); var [color, setColor] = useState("#06B6D4"); var [size, setSize] = useState(4); var [tool, setTool] = useState("pen");
  var colors = ["#06B6D4","#A78BFA","#F59E0B","#34D399","#F87171","#fff"];
  function getPos(e,c){ var r=c.getBoundingClientRect(); var s=e.touches?e.touches[0]:e; return {x:(s.clientX-r.left)*(c.width/r.width),y:(s.clientY-r.top)*(c.height/r.height)}; }
  function startDraw(e){ e.preventDefault(); var c=canvasRef.current; var ctx=c.getContext("2d"); var p=getPos(e,c); ctx.beginPath(); ctx.moveTo(p.x,p.y); setDrawing(true); }
  function draw(e){ e.preventDefault(); if(!drawing)return; var c=canvasRef.current; var ctx=c.getContext("2d"); var p=getPos(e,c); ctx.globalCompositeOperation=tool==="eraser"?"destination-out":"source-over"; ctx.strokeStyle=color; ctx.lineWidth=tool==="eraser"?28:size; ctx.lineCap="round"; ctx.lineJoin="round"; ctx.lineTo(p.x,p.y); ctx.stroke(); }
  function saveDrawing(){ var c=canvasRef.current; var l=document.createElement("a"); l.download="drawing.png"; l.href=c.toDataURL(); l.click(); }
  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>Draw</span>
        <div style={{ display:"flex",gap:8 }}><button onClick={function(){var c=canvasRef.current;c.getContext("2d").clearRect(0,0,c.width,c.height);}} style={{ background:C.card2,border:"none",borderRadius:8,padding:"7px 12px",color:C.muted,fontSize:12,fontWeight:700,cursor:"pointer" }}>Clear</button><button onClick={saveDrawing} style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)",border:"none",borderRadius:8,padding:"7px 12px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer" }}>Save</button></div>
      </div>
      <div style={{ background:C.card,padding:"12px 16px",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid "+C.border,flexWrap:"wrap" }}>
        <div style={{ display:"flex",gap:6 }}>{colors.map(function(c){return <button key={c} onClick={function(){setColor(c);setTool("pen");}} style={{ width:26,height:26,borderRadius:"50%",background:c,border:color===c&&tool!=="eraser"?"3px solid #fff":"2px solid rgba(255,255,255,0.15)",cursor:"pointer" }} />;})}</div>
        <div style={{ display:"flex",gap:6,marginLeft:"auto" }}>{[["pen","✏️"],["eraser","⭕"]].map(function(item){return <button key={item[0]} onClick={function(){setTool(item[0]);}} style={{ background:tool===item[0]?C.cyan:C.card2,border:"none",borderRadius:8,padding:"6px 10px",cursor:"pointer",fontSize:16 }}>{item[1]}</button>;})}</div>
        <input type="range" min="2" max="24" value={size} onChange={function(e){setSize(Number(e.target.value));}} style={{ width:80,accentColor:C.cyan }} />
      </div>
      <div style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",background:"#06081A",padding:10 }}>
        <canvas ref={canvasRef} width={360} height={500} style={{ background:"#111827",borderRadius:16,border:"1px solid "+C.border,cursor:tool==="eraser"?"cell":"crosshair",touchAction:"none",maxWidth:"100%" }} onMouseDown={startDraw} onMouseMove={draw} onMouseUp={function(){setDrawing(false);}} onMouseLeave={function(){setDrawing(false);}} onTouchStart={startDraw} onTouchMove={draw} onTouchEnd={function(){setDrawing(false);}} />
      </div>
    </div>
  );
}

// ── AI WRITE ──────────────────────────────────────────────────────────────────
function AIWriteScreen({ onBack, onSave }) {
  var [prompt, setPrompt] = useState(""); var [result, setResult] = useState(""); var [loading, setLoading] = useState(false); var [course, setCourse] = useState("General");
  var courses = ["General","PHY 101","MTH 101","COS 102","ENG 201","CHM 102"];
  var suggestions = ["Summarize Newton laws of motion","Write notes on Data Structures","Explain Organic Chemistry basics","Create outline for Kinematics"];
  async function generate(text){ var q=text||prompt; if(!q.trim())return; setLoading(true); setResult(""); try{ var out = await callGeminiText("Write clear structured student notes with bullet points and headers for: "+q, 800); setResult(out); }catch(e){ setResult("Notes on: "+q+"\n\nKey Point 1: Important definition\nKey Point 2: Another point\n\nAdd your Gemini API key to enable real AI!"); } setLoading(false); }
  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>AI Write</span>
        {result&&<button onClick={function(){onSave({id:Date.now(),title:prompt.slice(0,40)||"AI Note",course,color:"#A78BFA",bg:"rgba(167,139,250,0.12)",date:"Today",tag:"Study",words:result.split(" ").length,preview:result.slice(0,100),content:result});}} style={{ background:"linear-gradient(135deg,#A78BFA,#06B6D4)",color:"#fff",border:"none",borderRadius:10,padding:"8px 16px",fontWeight:800,fontSize:13,cursor:"pointer" }}>Save</button>}
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        <div style={{ display:"flex",gap:8,marginBottom:14,flexWrap:"wrap" }}>{courses.map(function(c){return <button key={c} onClick={function(){setCourse(c);}} style={{ padding:"6px 14px",borderRadius:99,border:"2px solid",borderColor:course===c?C.purple:C.border,background:course===c?C.purple:C.card,color:course===c?"#0A0F1E":C.muted,fontSize:12,fontWeight:700,cursor:"pointer" }}>{c}</button>;})}</div>
        <div style={{ display:"flex",gap:10,marginBottom:16 }}>
          <input value={prompt} onChange={function(e){setPrompt(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")generate();}} placeholder="What should I write notes about?" style={{ flex:1,padding:"13px 16px",borderRadius:14,border:"1px solid "+C.border,fontSize:14,background:C.card,color:C.text,outline:"none" }} />
          <button onClick={function(){generate();}} disabled={loading} style={{ width:48,height:48,borderRadius:14,background:"linear-gradient(135deg,#A78BFA,#06B6D4)",border:"none",cursor:"pointer",fontSize:20,flexShrink:0 }}>✨</button>
        </div>
        {!result&&!loading&&suggestions.map(function(s){return <button key={s} onClick={function(){setPrompt(s);generate(s);}} style={{ width:"100%",textAlign:"left",background:C.card,border:"1px solid "+C.border,borderRadius:12,padding:"12px 16px",color:C.soft,fontSize:13,cursor:"pointer",marginBottom:8,fontFamily:"inherit" }}>{s}</button>;})}
        {loading&&<div style={{ textAlign:"center",padding:"40px 20px" }}><div style={{ fontSize:48,animation:"spin 2s linear infinite" }}>✨</div><p style={{ color:C.muted }}>Writing your notes...</p></div>}
        {result&&<div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.border }}><textarea value={result} onChange={function(e){setResult(e.target.value);}} style={{ width:"100%",minHeight:280,background:"transparent",border:"none",color:C.text,fontSize:14,lineHeight:1.9,outline:"none",resize:"none",fontFamily:"inherit",boxSizing:"border-box" }} /></div>}
      </div>
    </div>
  );
}

// ── SCAN DOC ──────────────────────────────────────────────────────────────────
function ScanDocScreen({ onBack, onSave }) {
  var [image, setImage] = useState(null);       // {dataUrl, base64, mediaType}
  var [result, setResult] = useState("");
  var [loading, setLoading] = useState(false);
  var [error, setError] = useState("");
  var [course, setCourse] = useState("General");
  var fileInputRef = useRef(null);
  var courses = ["General","PHY 101","MTH 101","COS 102","ENG 201","CHM 102"];

  function handleFile(e){
    var file = e.target.files && e.target.files[0];
    if(!file) return;
    setResult(""); setError("");
    var reader = new FileReader();
    reader.onload = function(){
      var dataUrl = reader.result;
      var base64 = dataUrl.split(",")[1];
      setImage({ dataUrl: dataUrl, base64: base64, mediaType: file.type || "image/jpeg" });
    };
    reader.readAsDataURL(file);
  }

  async function extractText(){
    if(!image) return;
    setLoading(true); setError(""); setResult("");
    try{
      var out = await callGeminiVision(
        image.base64,
        image.mediaType,
        "Transcribe all readable text from this document/page image into clean, well-organized student notes. Keep headers, bullet points and structure where relevant. Return only the notes text, no preamble.",
        1200
      );
      setResult(out);
    }catch(e){
      setError("Couldn't reach Gemini (check the API key in the code, or your connection). Add your Gemini API key to GEMINI_KEY to enable real scanning.");
    }
    setLoading(false);
  }

  function saveScanned(){
    if(!result.trim()) return;
    onSave({ id:Date.now(), title:"Scanned Doc - "+new Date().toLocaleDateString(), course, color:"#F59E0B", bg:"rgba(245,158,11,0.12)", date:"Today", tag:"Lecture", words:result.split(" ").length, preview:result.slice(0,100), content:result });
  }

  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:16,color:C.text }}>Scan Doc</span>
        {result&&<button onClick={saveScanned} style={{ background:"linear-gradient(135deg,#F59E0B,#A78BFA)",color:"#fff",border:"none",borderRadius:10,padding:"8px 16px",fontWeight:800,fontSize:13,cursor:"pointer" }}>Save</button>}
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        <input ref={fileInputRef} type="file" accept="image/*" capture="environment" onChange={handleFile} style={{ display:"none" }} />

        {!image && (
          <div>
            <div onClick={function(){fileInputRef.current&&fileInputRef.current.click();}} style={{ background:C.card,border:"2px dashed "+C.border,borderRadius:16,padding:"48px 20px",textAlign:"center",cursor:"pointer" }}>
              <div style={{ fontSize:44,marginBottom:12 }}>📷</div>
              <div style={{ fontWeight:700,fontSize:15,color:C.text,marginBottom:4 }}>Tap to scan a page</div>
              <div style={{ fontSize:12,color:C.muted }}>Take a photo or upload an image of your notes/textbook</div>
            </div>
          </div>
        )}

        {image && !result && !loading && (
          <div>
            <img src={image.dataUrl} alt="scanned" style={{ width:"100%",borderRadius:14,marginBottom:14,border:"1px solid "+C.border }} />
            <div style={{ display:"flex",gap:10 }}>
              <button onClick={function(){setImage(null);setResult("");setError("");}} style={{ flex:1,background:C.card2,color:C.muted,border:"none",borderRadius:12,padding:"12px",fontWeight:700,cursor:"pointer" }}>Retake</button>
              <button onClick={extractText} style={{ flex:2,background:"linear-gradient(135deg,#F59E0B,#A78BFA)",color:"#fff",border:"none",borderRadius:12,padding:"12px",fontWeight:800,cursor:"pointer" }}>✨ Extract Text</button>
            </div>
          </div>
        )}

        {loading && <div style={{ textAlign:"center",padding:"40px 20px" }}><div style={{ fontSize:48,animation:"spin 2s linear infinite" }}>📄</div><p style={{ color:C.muted }}>Reading your document...</p></div>}

        {error && <div style={{ background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",borderRadius:12,padding:14,color:C.red,fontSize:13,marginTop:12 }}>{error}</div>}

        {result && (
          <div>
            <div style={{ display:"flex",gap:8,marginBottom:14,flexWrap:"wrap" }}>{courses.map(function(c){return <button key={c} onClick={function(){setCourse(c);}} style={{ padding:"6px 14px",borderRadius:99,border:"2px solid",borderColor:course===c?C.amber:C.border,background:course===c?C.amber:C.card,color:course===c?"#0A0F1E":C.muted,fontSize:12,fontWeight:700,cursor:"pointer" }}>{c}</button>;})}</div>
            <div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.border }}>
              <textarea value={result} onChange={function(e){setResult(e.target.value);}} style={{ width:"100%",minHeight:280,background:"transparent",border:"none",color:C.text,fontSize:14,lineHeight:1.9,outline:"none",resize:"none",fontFamily:"inherit",boxSizing:"border-box" }} />
            </div>
            <button onClick={function(){setImage(null);setResult("");setError("");}} style={{ width:"100%",marginTop:10,background:"none",border:"1px solid "+C.border,borderRadius:12,padding:"10px",color:C.muted,fontWeight:700,cursor:"pointer" }}>Scan Another</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── NOTE DETAIL ───────────────────────────────────────────────────────────────
function NoteDetail({ note, onBack, onDelete }) {
  var [view, setView] = useState("note"); var [summary, setSummary] = useState(null); var [quiz, setQuiz] = useState([]); var [quizIdx, setQuizIdx] = useState(0); var [selected, setSelected] = useState(null); var [score, setScore] = useState(0); var [quizDone, setQuizDone] = useState(false); var [loading, setLoading] = useState(false);
  async function callAI(p){ return await callGeminiText(p, 800); }
  async function generateSummary(){ setLoading(true); setView("summary"); try{ var raw=await callAI("Summarize these notes. Return ONLY JSON: {\"summary\":\"...\",\"keyPoints\":[\"...\"],\"tags\":[\"...\"]} NOTES: "+note.content); setSummary(JSON.parse(raw.split("```json").join("").split("```").join("").trim())); }catch(e){ setSummary({summary:"This covers "+note.title+".",keyPoints:["Review definitions","Practice problems"],tags:[note.course,note.tag]}); } setLoading(false); }
  async function generateQuiz(){ setLoading(true); setView("quiz"); try{ var raw=await callAI("Create 5 MCQ from these notes. Return ONLY JSON: [{\"question\":\"...\",\"options\":[\"A\",\"B\",\"C\",\"D\"],\"answer\":0}] NOTES: "+note.content); var q=JSON.parse(raw.split("```json").join("").split("```").join("").trim()); setQuiz(q); setQuizIdx(0); setSelected(null); setScore(0); setQuizDone(false); }catch(e){ setQuiz([{question:"What is the main topic?",options:[note.course,"History","Math","Art"],answer:0}]); } setLoading(false); }
  function pick(i){ if(selected!==null)return; setSelected(i); if(i===quiz[quizIdx].answer)setScore(function(s){return s+1;}); setTimeout(function(){if(quizIdx+1<quiz.length){setQuizIdx(function(q){return q+1;});setSelected(null);}else setQuizDone(true);},900); }
  return (
    <div style={{ flex:1,background:C.bg,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.card,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+C.border,position:"sticky",top:0,zIndex:10 }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800,fontSize:15,color:C.text,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{note.title}</span>
        <div style={{ display:"flex",gap:6 }}>
          <button onClick={function(){if(navigator.share)navigator.share({title:note.title,text:note.content});else{navigator.clipboard&&navigator.clipboard.writeText(note.content);alert("Copied!");}}} style={{ background:C.card2,border:"none",borderRadius:8,width:32,height:32,cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center" }}>📤</button>
          <button onClick={function(){onDelete(note.id);}} style={{ background:"rgba(248,113,113,0.12)",border:"none",borderRadius:8,width:32,height:32,cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center" }}>🗑</button>
        </div>
      </div>
      <div style={{ background:C.card,padding:"0 20px 12px",display:"flex",gap:6,borderBottom:"1px solid "+C.border }}>
        {[["📝","note","Note"],["📋","summary","Summary"],["🧠","quiz","Quiz"]].map(function(item){return <button key={item[1]} onClick={function(){setView(item[1]);if(item[1]==="summary"&&!summary)generateSummary();if(item[1]==="quiz"&&quiz.length===0)generateQuiz();}} style={{ padding:"7px 16px",borderRadius:99,border:"none",background:view===item[1]?note.color:C.card2,color:view===item[1]?"#0A0F1E":C.muted,fontSize:13,fontWeight:700,cursor:"pointer",marginTop:12 }}>{item[0]+" "+item[2]}</button>;})}
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:20 }}>
        {view==="note"&&(<div><div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:16 }}><span style={{ fontSize:11,fontWeight:700,color:note.color,background:note.bg,borderRadius:99,padding:"3px 12px" }}>{note.course}</span><span style={{ fontSize:11,color:C.muted }}>{note.date}</span></div><div style={{ background:C.card,borderRadius:18,padding:20,border:"1px solid "+C.border,marginBottom:16 }}><h2 style={{ color:C.text,fontSize:20,fontWeight:800,margin:"0 0 12px" }}>{note.title}</h2><div style={{ width:40,height:3,background:note.color,borderRadius:2,marginBottom:16 }} /><p style={{ margin:0,fontSize:14,color:"#CBD5E1",lineHeight:1.9,whiteSpace:"pre-line" }}>{note.content}</p></div><div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10 }}><button onClick={function(){setView("summary");if(!summary)generateSummary();}} style={actionBtn(note.color)}>📋 AI Summary</button><button onClick={function(){setView("quiz");if(quiz.length===0)generateQuiz();}} style={actionBtn(C.purple)}>🧠 Quiz Me</button></div></div>)}
        {view==="summary"&&(loading?<div style={{ textAlign:"center",padding:"60px 20px" }}><div style={{ fontSize:48,animation:"spin 2s linear infinite" }}>✨</div><p style={{ color:C.muted,marginTop:16 }}>Generating...</p></div>:summary?(<div><div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.border,marginBottom:14 }}><div style={{ fontSize:11,fontWeight:700,color:C.green,letterSpacing:1,marginBottom:10 }}>OVERVIEW</div><p style={{ margin:0,fontSize:14,color:"#CBD5E1",lineHeight:1.8 }}>{summary.summary}</p></div><div style={{ background:C.card,borderRadius:16,padding:20,border:"1px solid "+C.border,marginBottom:14 }}><div style={{ fontSize:11,fontWeight:700,color:C.amber,letterSpacing:1,marginBottom:12 }}>KEY POINTS</div>{summary.keyPoints&&summary.keyPoints.map(function(p,i){return <div key={i} style={{ display:"flex",gap:10,marginBottom:10 }}><div style={{ width:6,height:6,borderRadius:3,background:C.amber,marginTop:7,flexShrink:0 }} /><p style={{ margin:0,fontSize:14,color:"#CBD5E1",lineHeight:1.7 }}>{p}</p></div>;})}</div><div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>{summary.tags&&summary.tags.map(function(t){return <span key={t} style={{ background:C.card2,color:C.cyan,borderRadius:99,padding:"4px 14px",fontSize:12,fontWeight:700 }}>{t}</span>;})}</div></div>):null)}
        {view==="quiz"&&(loading?<div style={{ textAlign:"center",padding:"60px 20px" }}><div style={{ fontSize:48,animation:"spin 2s linear infinite" }}>🧠</div><p style={{ color:C.muted,marginTop:16 }}>Generating quiz...</p></div>:quizDone?(<div style={{ textAlign:"center",padding:"40px 20px" }}><div style={{ fontSize:64,marginBottom:16 }}>{score===quiz.length?"🏆":"📖"}</div><div style={{ fontSize:40,fontWeight:800,color:C.text }}>{score}/{quiz.length}</div><p style={{ color:C.muted,marginTop:8 }}>{score===quiz.length?"Perfect! 🔥":"Keep studying! 💪"}</p><button onClick={function(){setQuizIdx(0);setSelected(null);setScore(0);setQuizDone(false);}} style={{ marginTop:20,background:"linear-gradient(135deg,"+note.color+",#A78BFA)",color:"#fff",border:"none",borderRadius:14,padding:"13px 32px",fontWeight:800,fontSize:15,cursor:"pointer" }}>Try Again</button></div>):quiz.length>0?(<div><div style={{ display:"flex",justifyContent:"space-between",marginBottom:8 }}><span style={{ fontSize:13,color:C.muted }}>Question {quizIdx+1}/{quiz.length}</span><span style={{ fontSize:13,fontWeight:700,color:C.text }}>Score: {score}</span></div><div style={{ height:4,background:C.border,borderRadius:2,marginBottom:20 }}><div style={{ height:4,background:note.color,borderRadius:2,width:(quizIdx/quiz.length*100)+"%",transition:"width 0.3s" }} /></div><div style={{ background:C.card,borderRadius:16,padding:20,marginBottom:16,border:"1px solid "+C.border }}><p style={{ margin:0,fontSize:16,fontWeight:600,color:C.text,lineHeight:1.6 }}>{quiz[quizIdx].question}</p></div>{quiz[quizIdx].options.map(function(opt,i){var bg=C.card,border=C.border,color=C.text;if(selected!==null){if(i===quiz[quizIdx].answer){bg="rgba(52,211,153,0.15)";border="#34D399";color="#34D399";}else if(i===selected){bg="rgba(248,113,113,0.15)";border="#F87171";color="#F87171";}}return <button key={i} onClick={function(){pick(i);}} disabled={selected!==null} style={{ width:"100%",textAlign:"left",background:bg,border:"2px solid "+border,borderRadius:12,padding:"13px 16px",marginBottom:10,fontSize:14,color:color,cursor:selected!==null?"default":"pointer",fontWeight:500,display:"flex",gap:10,fontFamily:"inherit" }}><span style={{opacity:0.5}}>{String.fromCharCode(65+i)}.</span>{opt}</button>;})}</div>):null)}
      </div>
    </div>
  );
}

// ── HOME SCREEN ───────────────────────────────────────────────────────────────
function HomeScreen({ notes, onNote, onVoice, onDraw, onAIWrite, onScan }) {
  var [search, setSearch] = useState(""); var [filter, setFilter] = useState("All");
  var filters = ["All","Lecture","Study","Business","Personal"];
  var filtered = notes.filter(function(n){return (n.title.toLowerCase().includes(search.toLowerCase())||n.course.toLowerCase().includes(search.toLowerCase()))&&(filter==="All"||n.tag===filter);});
  var hour = new Date().getHours();
  var greeting = hour<12?"Good morning":hour<17?"Good afternoon":"Good evening";
  return (
    <div style={{ flex:1,overflowY:"auto" }}>
      <div style={{ background:"linear-gradient(135deg,#0A0F1E 0%,#1E1B4B 60%,#0A0F1E 100%)",padding:"24px 20px 28px",position:"relative",overflow:"hidden" }}>
        <div style={{ position:"absolute",top:-40,right:-40,width:160,height:160,borderRadius:"50%",background:"rgba(6,182,212,0.07)" }} />
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,position:"relative" }}>
          <div style={{ display:"flex",alignItems:"center",gap:10 }}>
            <div style={{ width:40,height:40,borderRadius:12,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20 }}>🎵</div>
            <span style={{ fontWeight:800,fontSize:20,color:C.text }}>Jotting <span style={{ color:C.cyan }}>AI</span></span>
          </div>
          <div style={{ display:"flex",gap:8 }}>
            <button onClick={function(){ requestNotificationPermission(); sendNotification("Jotting AI","Notifications enabled! You will get study reminders."); }} style={{ background:"rgba(255,255,255,0.08)",border:"none",borderRadius:10,width:38,height:38,cursor:"pointer",fontSize:17 }}>🔔</button>
            <div style={{ width:38,height:38,borderRadius:"50%",background:"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:17 }}>👤</div>
          </div>
        </div>
        <p style={{ color:"rgba(255,255,255,0.45)",fontSize:13,margin:"0 0 4px" }}>{greeting} 👋</p>
        <h2 style={{ color:C.text,fontSize:24,fontWeight:800,margin:"0 0 20px",letterSpacing:-0.5 }}>Welcome, <span style={{ color:C.cyan }}>Samuel</span></h2>
        <div style={{ position:"relative" }}>
          <span style={{ position:"absolute",left:14,top:"50%",transform:"translateY(-50%)" }}>🔍</span>
          <input value={search} onChange={function(e){setSearch(e.target.value);}} placeholder="Search notes, courses..." style={{ width:"100%",padding:"12px 14px 12px 42px",borderRadius:14,border:"1px solid rgba(255,255,255,0.1)",fontSize:14,background:"rgba(255,255,255,0.07)",color:C.text,outline:"none",boxSizing:"border-box" }} />
        </div>
      </div>
      <div style={{ padding:"20px 20px 100px" }}>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:22 }}>
          {[["📝",notes.length,"Notes"],["🤖","AI","Powered"],["🆓","Free","Speech"]].map(function(item){return <div key={item[2]} style={{ background:C.card,borderRadius:14,padding:"14px 10px",textAlign:"center",border:"1px solid "+C.border }}><div style={{ fontSize:20,marginBottom:4 }}>{item[0]}</div><div style={{ fontWeight:800,fontSize:18,color:C.text }}>{item[1]}</div><div style={{ fontSize:10,color:C.muted,fontWeight:600 }}>{item[2]}</div></div>;}) }
        </div>
        <div style={{ marginBottom:22 }}>
          <p style={{ fontWeight:800,fontSize:16,color:C.text,margin:"0 0 14px" }}>Quick Actions</p>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:10 }}>
            {[["🎙️","Voice\nNote",C.cyan,onVoice],["✨","AI\nWrite",C.purple,onAIWrite],["📷","Scan\nDoc",C.amber,onScan],["🖊️","Draw",C.green,onDraw]].map(function(item){return <button key={item[1]} onClick={item[3]} style={{ background:C.card,border:"1px solid "+item[2]+"30",borderRadius:14,padding:"14px 8px",cursor:"pointer",textAlign:"center" }}><div style={{ width:38,height:38,borderRadius:10,background:item[2]+"20",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 8px",fontSize:20 }}>{item[0]}</div><span style={{ fontSize:11,fontWeight:700,color:C.soft,whiteSpace:"pre-line",lineHeight:1.3 }}>{item[1]}</span></button>;}) }
          </div>
        </div>
        <div style={{ display:"flex",gap:8,marginBottom:16,overflowX:"auto",paddingBottom:4 }}>
          {filters.map(function(f){return <button key={f} onClick={function(){setFilter(f);}} style={{ padding:"7px 16px",borderRadius:99,border:"none",background:filter===f?C.cyan:C.card,color:filter===f?"#0A0F1E":C.muted,fontSize:13,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0 }}>{f}</button>;}) }
        </div>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
          <p style={{ fontWeight:800,fontSize:16,color:C.text,margin:0 }}>Recent Notes</p>
          <span style={{ fontSize:12,color:C.muted,fontWeight:600 }}>{filtered.length} notes</span>
        </div>
        {filtered.length===0?<div style={{ textAlign:"center",padding:"40px 20px" }}><div style={{ fontSize:48,marginBottom:12 }}>📝</div><p style={{ color:C.muted,fontSize:15 }}>No notes yet. Tap Voice Note to start!</p></div>
        :filtered.slice(0,5).map(function(note){return <button key={note.id} onClick={function(){onNote(note);}} style={{ width:"100%",background:C.card,border:"1px solid "+note.color+"22",borderRadius:18,padding:16,marginBottom:12,cursor:"pointer",textAlign:"left" }}><div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10 }}><div style={{ display:"flex",alignItems:"center",gap:10 }}><div style={{ width:42,height:42,borderRadius:12,background:note.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,border:"1px solid "+note.color+"30",flexShrink:0 }}>{note.tag==="Lecture"?"📚":note.tag==="Study"?"💡":note.tag==="Business"?"💼":"📝"}</div><div><div style={{ fontWeight:800,fontSize:14,color:C.text,marginBottom:3 }}>{note.title}</div><span style={{ fontSize:11,fontWeight:700,color:note.color,background:note.bg,borderRadius:99,padding:"2px 8px" }}>{note.course}</span></div></div><div style={{ textAlign:"right" }}><div style={{ fontSize:11,color:C.muted,marginBottom:4 }}>{note.date}</div><span style={{ background:note.bg,borderRadius:99,padding:"2px 8px",fontSize:10,fontWeight:700,color:note.color }}>{note.tag}</span></div></div><p style={{ margin:"0 0 10px",fontSize:13,color:C.muted,lineHeight:1.6,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden" }}>{note.preview}</p><div style={{ display:"flex",alignItems:"center",paddingTop:10,borderTop:"1px solid "+C.border }}><span style={{ fontSize:11,color:C.muted }}>✨ AI features available</span><span style={{ fontSize:11,color:note.color,marginLeft:"auto",fontWeight:700 }}>Open →</span></div></button>;})}
      </div>
    </div>
  );
}

// ── AI CHAT ───────────────────────────────────────────────────────────────────
function AIScreen() {
  var [messages, setMessages] = useState([{role:"ai",text:"Hi Samuel! 👋 I am your AI study assistant. Ask me to summarize notes, explain concepts, or create study plans!"}]);
  var [input, setInput] = useState(""); var [loading, setLoading] = useState(false); var endRef = useRef(null);
  useEffect(function(){endRef.current&&endRef.current.scrollIntoView({behavior:"smooth"});},[messages]);
  async function send(){ if(!input.trim())return; var q=input.trim(); setInput(""); setMessages(function(m){return [...m,{role:"user",text:q}];}); setLoading(true); try{ var out = await callGeminiText("You are a helpful AI study assistant for a Nigerian university student named Samuel. Be concise and helpful: "+q, 600); setMessages(function(m){return [...m,{role:"ai",text:out}];}); }catch(e){ setMessages(function(m){return [...m,{role:"ai",text:"Add your Gemini API key to enable real AI!"}];}); } setLoading(false); }
  return (
    <div style={{ flex:1,display:"flex",flexDirection:"column",background:C.bg }}>
      <div style={{ background:C.card,padding:"16px 20px",borderBottom:"1px solid "+C.border }}><div style={{ display:"flex",alignItems:"center",gap:10 }}><div style={{ width:40,height:40,borderRadius:12,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20 }}>🤖</div><div><div style={{ fontWeight:800,fontSize:16,color:C.text }}>AI Assistant</div><div style={{ fontSize:11,color:C.green,fontWeight:600 }}>Claude AI</div></div></div></div>
      <div style={{ flex:1,overflowY:"auto",padding:"16px 16px 8px" }}>
        {messages.map(function(m,i){return <div key={i} style={{ display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",marginBottom:12 }}>{m.role==="ai"&&<div style={{ width:32,height:32,borderRadius:10,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,marginRight:8,flexShrink:0,marginTop:2 }}>🤖</div>}<div style={{ maxWidth:"80%",background:m.role==="user"?"linear-gradient(135deg,#06B6D4,#A78BFA)":C.card2,borderRadius:m.role==="user"?"18px 18px 4px 18px":"18px 18px 18px 4px",padding:"12px 16px",border:m.role==="ai"?"1px solid "+C.border:"none" }}><p style={{ margin:0,fontSize:14,color:C.text,lineHeight:1.7,whiteSpace:"pre-wrap" }}>{m.text}</p></div></div>;})}
        {loading&&<div style={{ display:"flex",gap:4,alignItems:"center",marginLeft:40 }}>{[0,1,2].map(function(i){return <div key={i} style={{ width:8,height:8,borderRadius:"50%",background:C.cyan,animation:"dot "+(0.5+i*0.15)+"s ease-in-out infinite alternate" }} />;})}</div>}
        <div ref={endRef} />
      </div>
      <div style={{ padding:"12px 16px 16px",background:C.card2,borderTop:"1px solid "+C.border,display:"flex",gap:10 }}>
        <input value={input} onChange={function(e){setInput(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")send();}} placeholder="Ask anything..." style={{ flex:1,padding:"12px 16px",borderRadius:14,border:"1px solid "+C.border,fontSize:14,background:C.bg,color:C.text,outline:"none" }} />
        <button onClick={send} style={{ width:48,height:48,borderRadius:14,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",border:"none",cursor:"pointer",fontSize:20,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>↑</button>
      </div>
    </div>
  );
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────
function SettingsScreen({ notifEnabled, setNotifEnabled, notifs, setNotifs, recSettings, setRecSettings }) {
  var [openSection, setOpenSection] = useState(null);
  var [lang, setLang] = useState("English");
  var [aiModel, setAiModel] = useState("Claude");
  var [aiStyle, setAiStyle] = useState("Academic");
  var [privacy, setPrivacy] = useState({fingerprint:false,face:false,pin:false,autoLock:true,hiddenFolder:false,encrypt:false});
  var [editProfile, setEditProfile] = useState(false);
  var [profile, setProfile] = useState({name:"Samuel",email:"samuel@gmail.com",username:"@samuel_dev"});

  function Section({ id, icon, title, color, children }) {
    var isOpen = openSection===id;
    return <div style={{ background:C.card,borderRadius:16,marginBottom:12,border:"1px solid "+C.border,overflow:"hidden" }}><button onClick={function(){setOpenSection(isOpen?null:id);}} style={{ width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"16px",background:"none",border:"none",cursor:"pointer" }}><div style={{ display:"flex",alignItems:"center",gap:12 }}><div style={{ width:36,height:36,borderRadius:10,background:color+"20",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18 }}>{icon}</div><span style={{ fontWeight:700,fontSize:15,color:C.text }}>{title}</span></div><span style={{ color:C.muted,fontSize:20 }}>{isOpen?"v":">"}</span></button>{isOpen&&<div style={{ padding:"0 16px 16px",borderTop:"1px solid "+C.border }}>{children}</div>}</div>;
  }

  function Row({ icon, label, sub, right, danger, onPress }) {
    return <div onClick={onPress} style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:"13px 0",borderBottom:"1px solid "+C.border,cursor:onPress?"pointer":"default" }}><div style={{ display:"flex",alignItems:"center",gap:10 }}>{icon&&<span style={{ fontSize:18 }}>{icon}</span>}<div><div style={{ fontSize:14,fontWeight:600,color:danger?C.red:C.text }}>{label}</div>{sub&&<div style={{ fontSize:11,color:C.muted,marginTop:1 }}>{sub}</div>}</div></div>{right!==undefined?right:<span style={{ color:C.muted,fontSize:16 }}>›</span>}</div>;
  }

  return (
    <div style={{ flex:1,overflowY:"auto",background:C.bg }}>
      <div style={{ background:C.card,padding:"16px 20px",borderBottom:"1px solid "+C.border }}><span style={{ fontWeight:800,fontSize:18,color:C.text }}>Settings</span></div>
      <div style={{ padding:"16px 16px 100px" }}>
        <div style={{ background:"linear-gradient(135deg,#1E293B,#0F172A)",borderRadius:20,padding:20,marginBottom:16,border:"1px solid rgba(6,182,212,0.2)" }}>
          {editProfile?(<div><input value={profile.name} onChange={function(e){setProfile(function(p){return {...p,name:e.target.value};});}} style={{ width:"100%",padding:"10px",borderRadius:10,border:"1px solid "+C.border,background:C.bg,color:C.text,outline:"none",marginBottom:8,boxSizing:"border-box",fontSize:14 }} placeholder="Full Name" /><input value={profile.email} onChange={function(e){setProfile(function(p){return {...p,email:e.target.value};});}} style={{ width:"100%",padding:"10px",borderRadius:10,border:"1px solid "+C.border,background:C.bg,color:C.text,outline:"none",marginBottom:8,boxSizing:"border-box",fontSize:14 }} placeholder="Email" /><input value={profile.username} onChange={function(e){setProfile(function(p){return {...p,username:e.target.value};});}} style={{ width:"100%",padding:"10px",borderRadius:10,border:"1px solid "+C.border,background:C.bg,color:C.text,outline:"none",marginBottom:12,boxSizing:"border-box",fontSize:14 }} placeholder="Username" /><div style={{ display:"flex",gap:8 }}><button onClick={function(){setEditProfile(false);}} style={{ flex:1,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",color:"#fff",border:"none",borderRadius:10,padding:"10px",fontWeight:700,cursor:"pointer" }}>Save</button><button onClick={function(){setEditProfile(false);}} style={{ flex:1,background:C.card2,color:C.muted,border:"none",borderRadius:10,padding:"10px",fontWeight:700,cursor:"pointer" }}>Cancel</button></div></div>)
          :(<div style={{ display:"flex",alignItems:"center",gap:16 }}><div style={{ width:60,height:60,borderRadius:18,background:"linear-gradient(135deg,#06B6D4,#A78BFA)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,flexShrink:0 }}>👤</div><div style={{ flex:1 }}><div style={{ fontWeight:800,fontSize:18,color:C.text }}>{profile.name}</div><div style={{ fontSize:13,color:C.muted }}>{profile.email}</div><div style={{ fontSize:12,color:C.cyan }}>{profile.username}</div></div><button onClick={function(){setEditProfile(true);}} style={{ background:"rgba(6,182,212,0.15)",border:"1px solid "+C.cyan+"30",borderRadius:10,padding:"8px 14px",color:C.cyan,fontSize:12,fontWeight:700,cursor:"pointer" }}>Edit</button></div>)}
        </div>

        <Section id="sub" icon="⭐" title="Subscription" color="#F59E0B">
          <div style={{ marginTop:12 }}>
            <div style={{ background:C.card2,borderRadius:12,padding:"12px 16px",marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center" }}><div><div style={{ fontWeight:700,fontSize:14,color:C.text }}>Current Plan</div><div style={{ fontSize:12,color:C.muted }}>Free - 5 recordings per month</div></div><span style={{ background:"rgba(6,182,212,0.15)",color:C.cyan,borderRadius:99,padding:"4px 14px",fontSize:12,fontWeight:700 }}>Free</span></div>
            <div style={{ background:"linear-gradient(135deg,#4F46E5,#7C3AED,#06B6D4)",borderRadius:16,padding:20,marginBottom:10 }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12 }}><div><div style={{ fontWeight:800,fontSize:18,color:"#fff" }}>Upgrade to Pro</div><div style={{ fontSize:12,color:"rgba(255,255,255,0.75)",marginTop:4,lineHeight:1.8 }}>Unlimited recordings and notes{"\n"}Real AI with Claude{"\n"}Priority support</div></div><span style={{ fontSize:32 }}>🚀</span></div>
              <div style={{ display:"flex",alignItems:"baseline",gap:4,marginBottom:14 }}><span style={{ fontSize:32,fontWeight:800,color:"#fff" }}>₦550</span><span style={{ fontSize:13,color:"rgba(255,255,255,0.6)" }}>/month</span></div>
              <button style={{ width:"100%",background:"#fff",color:"#4F46E5",border:"none",borderRadius:12,padding:"13px",fontWeight:800,fontSize:15,cursor:"pointer" }}>Get Pro Now →</button>
            </div>
            <Row icon="🔄" label="Restore Purchase" sub="Restore previous subscription" />
            <Row icon="📜" label="Payment History" sub="View past transactions" />
          </div>
        </Section>

        <Section id="notif" icon="🔔" title="Notifications" color="#A78BFA">
          <div style={{ marginTop:12 }}>
            <Row icon="📳" label="Enable Notifications" sub="Allow push notifications" right={<Toggle value={notifEnabled} onChange={function(v){ setNotifEnabled(v); if(v){ requestNotificationPermission(); sendNotification("Notifications Enabled!","You'll get reminders based on what's toggled below"); } }} color={C.purple} />} />
            <div style={{ opacity:notifEnabled?1:0.4,pointerEvents:notifEnabled?"auto":"none" }}>
              {[["📚","study","Study Reminders","Daily at 9:00 AM"],["📋","assignment","Assignment Reminder","Daily check-in at 6:00 PM"],["🎯","daily","Daily Goal Reminder","Daily at 8:00 PM"],["🎙️","recording","Recording Reminder","Daily at 7:30 AM"]].map(function(item){return <Row key={item[1]} icon={item[0]} label={item[2]} sub={item[3]} right={<Toggle value={notifs[item[1]]} onChange={function(v){setNotifs(function(p){return {...p,[item[1]]:v};});}} color={C.purple} />} />;}) }
            </div>
            {!notifEnabled&&<div style={{ fontSize:11,color:C.muted,marginTop:8 }}>Turn on "Enable Notifications" above to activate any of these.</div>}
          </div>
        </Section>

        <Section id="lang" icon="🌍" title="Language" color="#34D399">
          <div style={{ marginTop:12 }}>{[["English","🇬🇧"],["Yoruba","🇳🇬"],["Hausa","🇳🇬"],["Igbo","🇳🇬"],["French","🇫🇷"]].map(function(item){return <div key={item[0]} onClick={function(){setLang(item[0]);}} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 0",borderBottom:"1px solid "+C.border,cursor:"pointer" }}><div style={{ display:"flex",alignItems:"center",gap:10 }}><span style={{ fontSize:20 }}>{item[1]}</span><span style={{ fontSize:14,fontWeight:600,color:lang===item[0]?C.green:C.text }}>{item[0]}</span></div>{lang===item[0]&&<span style={{ color:C.green,fontSize:18,fontWeight:700 }}>✓</span>}</div>;})}</div>
        </Section>

        <Section id="rec" icon="🎤" title="Recording Settings" color="#06B6D4">
          <div style={{ marginTop:12 }}>
            <div style={{ marginBottom:4,opacity:0.5 }}>
              <div style={{ display:"flex",alignItems:"center",gap:6,marginBottom:8 }}><span style={{ fontSize:12,color:C.muted,fontWeight:600 }}>RECORDING QUALITY</span><span style={{ fontSize:9,fontWeight:700,color:C.amber,background:"rgba(245,158,11,0.15)",borderRadius:99,padding:"2px 7px" }}>COMING SOON</span></div>
              <div style={{ display:"flex",gap:8 }}>{["Low","Medium","High"].map(function(q){return <div key={q} style={{ flex:1,padding:"8px",borderRadius:10,border:"2px solid "+C.border,background:C.card,color:C.muted,fontSize:13,fontWeight:700,textAlign:"center" }}>{q}</div>;})}</div>
              <div style={{ fontSize:11,color:C.muted,marginTop:6 }}>Needs real audio-file recording, which isn't built yet — right now the app transcribes live speech directly and doesn't save an audio file to apply quality to.</div>
            </div>
            <div style={{ height:12 }} />
            <Row icon="🔇" label="Noise Reduction" sub="Requests a noise-suppressed mic when you hit record" right={<Toggle value={recSettings.noise} onChange={function(v){setRecSettings(function(p){return {...p,noise:v};});}} color={C.cyan} />} />
            <Row icon="📝" label="Auto Transcription" sub="Google free speech API" right={<Toggle value={recSettings.autoTranscribe} onChange={function(v){setRecSettings(function(p){return {...p,autoTranscribe:v};});}} color={C.cyan} />} />
            <div style={{ opacity:0.5 }}>
              <Row icon="👥" label="Speaker Identification" sub="Needs a paid diarization API — not available on the free tier yet" right={<span style={{ fontSize:9,fontWeight:700,color:C.amber,background:"rgba(245,158,11,0.15)",borderRadius:99,padding:"3px 8px" }}>COMING SOON</span>} />
            </div>
            <Row icon="💾" label="Auto Save Recording" sub="Save automatically when you stop, no tap needed" right={<Toggle value={recSettings.autoSave} onChange={function(v){setRecSettings(function(p){return {...p,autoSave:v};});}} color={C.cyan} />} />
          </div>
        </Section>

        <Section id="ai" icon="🤖" title="AI Settings" color="#A78BFA">
          <div style={{ marginTop:12 }}>
            <div style={{ marginBottom:14 }}><div style={{ fontSize:12,color:C.muted,marginBottom:8,fontWeight:600 }}>AI MODEL</div><div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>{["Claude","GPT-4","Gemini"].map(function(m){return <button key={m} onClick={function(){setAiModel(m);}} style={{ padding:"8px 16px",borderRadius:10,border:"2px solid",borderColor:aiModel===m?C.purple:C.border,background:aiModel===m?C.purple:C.card,color:aiModel===m?"#0A0F1E":C.muted,fontSize:13,fontWeight:700,cursor:"pointer" }}>{m}</button>;})}</div></div>
            <div style={{ marginBottom:14 }}><div style={{ fontSize:12,color:C.muted,marginBottom:8,fontWeight:600 }}>WRITING STYLE</div><div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>{["Academic","Simple","Detailed"].map(function(s){return <button key={s} onClick={function(){setAiStyle(s);}} style={{ padding:"8px 16px",borderRadius:10,border:"2px solid",borderColor:aiStyle===s?C.purple:C.border,background:aiStyle===s?C.purple:C.card,color:aiStyle===s?"#0A0F1E":C.muted,fontSize:13,fontWeight:700,cursor:"pointer" }}>{s}</button>;})}</div></div>
            <Row icon="🌐" label="AI Response Language" sub="English" />
            <Row icon="📏" label="AI Summary Length" sub="Medium" />
            <Row icon="📵" label="Offline AI Mode" sub="Available on Pro" right={<span style={{ background:"rgba(245,158,11,0.15)",color:C.amber,borderRadius:99,padding:"3px 10px",fontSize:11,fontWeight:700 }}>PRO</span>} />
          </div>
        </Section>

        <Section id="privacy" icon="🔒" title="Privacy and Security" color="#F87171">
          <div style={{ marginTop:12 }}>{[["👆","fingerprint","Fingerprint Unlock","Use fingerprint to unlock"],["👤","face","Face Unlock","Unlock with face recognition"],["🔢","pin","PIN Lock","Set a 4-digit PIN"],["⏱","autoLock","Auto Lock","Lock after 1 minute"],["📁","hiddenFolder","Hidden Notes Folder","Keep private notes hidden"],["🔐","encrypt","Encrypt Notes","End-to-end encryption"]].map(function(item){return <Row key={item[1]} icon={item[0]} label={item[2]} sub={item[3]} right={<Toggle value={privacy[item[1]]} onChange={function(v){setPrivacy(function(p){return {...p,[item[1]]:v};});}} color={C.red} />} />;})}</div>
        </Section>

        <Section id="about" icon="ℹ️" title="About" color="#06B6D4">
          <div style={{ marginTop:12 }}>
            <Row icon="📱" label="App Version" sub="v3.0.0" right={<span style={{ fontSize:13,color:C.muted }}>v3.0</span>} />
            <Row icon="🆕" label="What's New" sub="Dashboard, Library, Notifications!" />
            <Row icon="🔏" label="Privacy Policy" sub="How we handle your data" />
            <Row icon="📜" label="Terms of Service" sub="Rules and conditions" />
            <Row icon="💬" label="Contact Support" sub="Get help from our team" />
            <Row icon="⭐" label="Rate the App" onPress={function(){alert("Thank you! Rating coming soon!");}} />
            <Row icon="📤" label="Share the App" onPress={function(){if(navigator.share){navigator.share({title:"Jotting AI",text:"Check out this AI note-taking app!",url:"https://notewave12.netlify.app"});}else{alert("Link: notewave12.netlify.app");}}} />
            <Row icon="🐛" label="Report a Bug" onPress={function(){alert("Report bugs to: samuel@gmail.com");}} />
            <div style={{ textAlign:"center",marginTop:16,color:C.muted,fontSize:12 }}>Jotting AI v3.0 - Built with love by Samuel</div>
          </div>
        </Section>

        <Section id="account" icon="👤" title="Account" color="#34D399">
          <div style={{ marginTop:12 }}>
            <Row icon="✏️" label="Edit Profile" sub="Change your name and info" onPress={function(){setEditProfile(true);}} />
            <Row icon="🖼️" label="Change Profile Picture" sub="Update your photo" />
            <Row icon="@" label="Change Username" sub={profile.username} />
            <Row icon="🔑" label="Change Password" sub="Update your password" />
            <Row icon="📧" label="Email Verification" sub="Verify your email address" />
            <div onClick={function(){alert("Logout coming soon!");}} style={{ display:"flex",alignItems:"center",justifyContent:"center",padding:"14px",marginTop:8,background:"rgba(248,113,113,0.1)",borderRadius:12,cursor:"pointer",border:"1px solid "+C.red+"30" }}><span style={{ fontSize:14,fontWeight:700,color:C.red }}>🚪 Logout</span></div>
          </div>
        </Section>
      </div>
    </div>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────────────────────
function loadStored(key, fallback) {
  try {
    var raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}

export default function App() {
  var [notes, setNotes] = useState(INIT_NOTES);
  var [screen, setScreen] = useState("home");
  var [activeNote, setActiveNote] = useState(null);
  var [tab, setTab] = useState("home");
  var [notifEnabled, setNotifEnabled] = useState(function(){ return loadStored("jotting_notifEnabled", false); });
  var [notifs, setNotifs] = useState(function(){ return loadStored("jotting_notifs", {study:true,assignment:false,daily:true,recording:false}); });
  var [recSettings, setRecSettings] = useState(function(){ return loadStored("jotting_recSettings", {noise:true,autoTranscribe:true,speakerID:false,autoSave:false}); });

  useEffect(function(){
    // Request notification permission on first load
    if ("Notification" in window && Notification.permission === "default") {
      setTimeout(function(){
        requestNotificationPermission();
      }, 3000);
    }
  }, []);

  // Persist settings so they survive a reload, and actually (de)schedule each
  // reminder for real whenever the master switch or an individual toggle changes.
  useEffect(function(){ try{ localStorage.setItem("jotting_notifEnabled", JSON.stringify(notifEnabled)); }catch(e){} }, [notifEnabled]);
  useEffect(function(){ try{ localStorage.setItem("jotting_notifs", JSON.stringify(notifs)); }catch(e){} }, [notifs]);
  useEffect(function(){ try{ localStorage.setItem("jotting_recSettings", JSON.stringify(recSettings)); }catch(e){} }, [recSettings]);

  useEffect(function(){
    Object.keys(REMINDER_CONFIG).forEach(function(key){
      if (notifEnabled && notifs[key]) {
        scheduleDailyReminder(key);
      } else {
        cancelReminder(key);
      }
    });
  }, [notifEnabled, notifs]);

  function go(s,t){ setScreen(s); if(t)setTab(t); }
  function saveNote(note){ setNotes(function(n){return [note,...n];}); go("home","home"); sendNotification("Note Saved!","Your note has been saved to Jotting AI"); }
  function deleteNote(id){ setNotes(function(n){return n.filter(function(x){return x.id!==id;});}); if(screen==="detail")go("home","home"); }

  // Updated NAV with Library and Dashboard
  var NAV = [
    {id:"home", icon:"🏠", label:"Home", s:"home"},
    {id:"library", icon:"📚", label:"Library", s:"library"},
    {id:"new", icon:"+", label:"New", s:"voice", special:true},
    {id:"dashboard", icon:"📊", label:"Stats", s:"dashboard"},
    {id:"settings", icon:"⚙️", label:"Settings", s:"settings"},
  ];

  return (
    <div style={{ minHeight:"100vh", background:"#06081A", display:"flex", justifyContent:"center", alignItems:"flex-start", padding:"20px 0" }}>
      <style>{"\n@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');\n*{box-sizing:border-box;font-family:'DM Sans',sans-serif;}\nbody{margin:0;background:#06081A;}\nbutton,textarea,input{font-family:'DM Sans',sans-serif;}\n::-webkit-scrollbar{width:0;}\ninput::placeholder,textarea::placeholder{color:#4B5563;}\n@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}\n@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,0.4)}50%{box-shadow:0 0 0 20px rgba(239,68,68,0)}}\n@keyframes wv{from{transform:scaleY(0.3)}to{transform:scaleY(1.2)}}\n@keyframes dot{from{opacity:0.3;transform:scale(0.7)}to{opacity:1;transform:scale(1)}}\n"}</style>
      <div style={{ width:"100%", maxWidth:400, minHeight:"calc(100vh - 40px)", background:C.bg, borderRadius:36, overflow:"hidden", display:"flex", flexDirection:"column", boxShadow:"0 24px 80px rgba(6,182,212,0.12), 0 0 0 1px rgba(255,255,255,0.06)" }}>
        <div style={{ flex:1, display:"flex", flexDirection:"column", overflowY:"auto", minHeight:0 }}>
          {screen==="home"&&<HomeScreen notes={notes} onNote={function(n){setActiveNote(n);go("detail");}} onVoice={function(){go("voice","new");}} onDraw={function(){go("draw");}} onAIWrite={function(){go("aiwrite");}} onScan={function(){go("scan");}} />}
          {screen==="library"&&<LibraryScreen notes={notes} onNote={function(n){setActiveNote(n);go("detail");}} onDelete={deleteNote} />}
          {screen==="dashboard"&&<DashboardScreen notes={notes} />}
          {screen==="detail"&&activeNote&&<NoteDetail note={activeNote} onBack={function(){go(tab==="library"?"library":"home",tab);}} onDelete={deleteNote} />}
          {screen==="voice"&&<VoiceNoteScreen onBack={function(){go("home","home");}} onSave={saveNote} recSettings={recSettings} />}
          {screen==="draw"&&<DrawScreen onBack={function(){go("home","home");}} />}
          {screen==="aiwrite"&&<AIWriteScreen onBack={function(){go("home","home");}} onSave={saveNote} />}
          {screen==="scan"&&<ScanDocScreen onBack={function(){go("home","home");}} onSave={saveNote} />}
          {screen==="ai"&&<AIScreen />}
          {screen==="settings"&&<SettingsScreen notifEnabled={notifEnabled} setNotifEnabled={setNotifEnabled} notifs={notifs} setNotifs={setNotifs} recSettings={recSettings} setRecSettings={setRecSettings} />}
        </div>
        <div style={{ background:C.card2, borderTop:"1px solid "+C.border, padding:"10px 10px 16px", display:"flex", justifyContent:"space-around", alignItems:"center", flexShrink:0 }}>
          {NAV.map(function(item){
            return (
              <button key={item.id} onClick={function(){go(item.s,item.id);}} style={{ background:item.special?"linear-gradient(135deg,#06B6D4,#A78BFA)":"none", border:"none", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:3, padding:item.special?"0":"4px 8px", width:item.special?52:"auto", height:item.special?52:"auto", borderRadius:item.special?"50%":0, boxShadow:item.special?"0 4px 20px rgba(6,182,212,0.4)":"none", justifyContent:"center", flexShrink:0 }}>
                <span style={{ fontSize:item.special?24:20, color:item.special?"#fff":tab===item.id?C.cyan:"#4B5563" }}>{item.icon}</span>
                {!item.special&&<span style={{ fontSize:10, fontWeight:700, color:tab===item.id?C.cyan:"#4B5563" }}>{item.label}</span>}
                {!item.special&&tab===item.id&&<div style={{ width:4, height:4, borderRadius:"50%", background:C.cyan }} />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
