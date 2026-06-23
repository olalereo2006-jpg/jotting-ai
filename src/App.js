import { useState, useEffect, useRef } from "react";

const NOTES = [
  { id: 1, title: "Physics: Kinematics", course: "PHY 101", color: "#06B6D4", bg: "rgba(6,182,212,0.12)", date: "Today", tag: "Lecture", preview: "Kinematics is the study of motion. v = u + at is the fundamental equation of motion.", content: ["Kinematics is the study of motion without considering forces.", "Key Equations:", "• v = u + at", "• s = ut + ½at²", "• v² = u² + 2as", "", "Velocity is the rate of change of displacement.", "Acceleration is the rate of change of velocity."] },
  { id: 2, title: "Data Structures", course: "COS 201", color: "#A78BFA", bg: "rgba(167,139,250,0.12)", date: "Yesterday", tag: "Study", preview: "Stack uses LIFO, Queue uses FIFO. Binary trees have at most 2 children per node.", content: ["Stack - Last In First Out (LIFO)", "Queue - First In First Out (FIFO)", "Linked List - Dynamic memory allocation", "Binary Tree - At most 2 children per node", "Hash Table - O(1) average lookup time"] },
  { id: 3, title: "NoteWave Business Plan", course: "Personal", color: "#F59E0B", bg: "rgba(245,158,11,0.12)", date: "Jun 20", tag: "Business", preview: "AI note-taking app for students. Revenue model: freemium with Pro tier at ₦2,000/month.", content: ["Product: AI-powered lecture note app", "Target: Nigerian university students", "Revenue: Freemium model", "• Free: 5 recordings/month", "• Pro: Unlimited + AI features ₦2,000/month", "• Institution: Custom pricing", "Launch: Q3 2026"] },
  { id: 4, title: "Organic Chemistry", course: "CHM 102", color: "#34D399", bg: "rgba(52,211,153,0.12)", date: "Jun 18", tag: "Lecture", preview: "Functional groups determine chemical properties. Alkanes, Alkenes, and Alkynes differ by bonds.", content: ["Functional Groups:", "• Alkanes: Single bonds (CnH2n+2)", "• Alkenes: Double bonds (CnH2n)", "• Alkynes: Triple bonds (CnH2n-2)", "", "IUPAC Naming conventions apply to all organic compounds."] },
];

const QUICK_ACTIONS = [
  { icon: "🎙️", label: "Voice Note", color: "#06B6D4" },
  { icon: "✨", label: "AI Write", color: "#A78BFA" },
  { icon: "📷", label: "Scan Doc", color: "#F59E0B" },
  { icon: "🖊️", label: "Draw", color: "#34D399" },
];

// ── Reusable Toggle ───────────────────────────────────────────────────────────
function Toggle({ value, onChange, color = "#06B6D4" }) {
  return (
    <div onClick={() => onChange(!value)} style={{ width: 46, height: 26, borderRadius: 13, background: value ? color : "#374151", cursor: "pointer", position: "relative", transition: "background 0.25s", flexShrink: 0 }}>
      <div style={{ position: "absolute", top: 3, left: value ? 23 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "left 0.25s", boxShadow: "0 2px 4px rgba(0,0,0,0.3)" }} />
    </div>
  );
}

// ── Recording Wave ────────────────────────────────────────────────────────────
function Wave({ active, color = "#06B6D4" }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2.5, height: 20 }}>
      {[0.5,1,1.6,1,0.7,1.4,0.9,1.2,0.6].map((h, i) => (
        <div key={i} style={{ width: 2.5, borderRadius: 99, background: active ? color : "#4B5563", height: active ? `${h * 18}px` : "3px", transition: "height 0.3s ease", animation: active ? `wv ${0.4 + i * 0.08}s ease-in-out infinite alternate` : "none" }} />
      ))}
      <style>{`@keyframes wv{from{transform:scaleY(0.3)}to{transform:scaleY(1.2)}}`}</style>
    </div>
  );
}

// ── Home Screen ───────────────────────────────────────────────────────────────
function HomeScreen({ notes, onNote, onNew }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All");
  const filters = ["All", "Lecture", "Study", "Business", "Personal"];
  const filtered = notes.filter(n => {
    const matchSearch = n.title.toLowerCase().includes(search.toLowerCase()) || n.course.toLowerCase().includes(search.toLowerCase());
    const matchFilter = filter === "All" || n.tag === filter;
    return matchSearch && matchFilter;
  });
  const now = new Date();
  const greeting = now.getHours() < 12 ? "Good morning" : now.getHours() < 17 ? "Good afternoon" : "Good evening";

  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
      {/* Hero Header */}
      <div style={{ background: "linear-gradient(135deg, #0F172A 0%, #1E1B4B 50%, #0F172A 100%)", padding: "24px 20px 28px", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: -40, right: -40, width: 160, height: 160, borderRadius: "50%", background: "rgba(6,182,212,0.08)" }} />
        <div style={{ position: "absolute", bottom: -30, left: -20, width: 120, height: 120, borderRadius: "50%", background: "rgba(167,139,250,0.08)" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, position: "relative" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 38, height: 38, borderRadius: 12, background: "linear-gradient(135deg,#06B6D4,#A78BFA)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🎵</div>
            <div>
              <span style={{ fontWeight: 800, fontSize: 19, color: "#fff", letterSpacing: -0.3 }}>Jotting <span style={{ color: "#06B6D4" }}>AI</span></span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button style={{ background: "rgba(255,255,255,0.08)", border: "none", borderRadius: 10, width: 36, height: 36, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ fontSize: 16 }}>🔔</span>
            </button>
            <div style={{ width: 36, height: 36, borderRadius: "50%", background: "linear-gradient(135deg,#06B6D4,#A78BFA)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>👤</div>
          </div>
        </div>
        <div style={{ position: "relative" }}>
          <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, margin: "0 0 4px" }}>{greeting} 👋</p>
          <h2 style={{ color: "#fff", fontSize: 24, fontWeight: 800, margin: "0 0 20px", letterSpacing: -0.5 }}>Welcome, <span style={{ color: "#06B6D4" }}>Samuel</span></h2>
          {/* Search */}
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontSize: 15 }}>🔍</span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search notes, courses..."
              style={{ width: "100%", padding: "12px 14px 12px 42px", borderRadius: 14, border: "1px solid rgba(255,255,255,0.1)", fontSize: 14, background: "rgba(255,255,255,0.07)", color: "#fff", outline: "none", boxSizing: "border-box" }}
            />
          </div>
        </div>
      </div>

      <div style={{ padding: "20px 20px 24px" }}>
        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 22 }}>
          {[["📝", notes.length, "Notes"], ["🧠", "12", "AI Chats"], ["⏱️", "4.2h", "Recorded"]].map(([icon, val, label]) => (
            <div key={label} style={{ background: "#1E293B", borderRadius: 14, padding: "14px 10px", textAlign: "center", border: "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ fontSize: 20, marginBottom: 4 }}>{icon}</div>
              <div style={{ fontWeight: 800, fontSize: 18, color: "#fff" }}>{val}</div>
              <div style={{ fontSize: 11, color: "#6B7280", fontWeight: 600 }}>{label}</div>
            </div>
          ))}
        </div>

        {/* Quick Actions */}
        <div style={{ marginBottom: 22 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
            <span style={{ fontWeight: 800, fontSize: 16, color: "#F1F5F9" }}>Quick Actions</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
            {QUICK_ACTIONS.map(({ icon, label, color }) => (
              <button key={label} onClick={label === "Voice Note" ? onNew : undefined} style={{ background: "#1E293B", border: `1px solid ${color}30`, borderRadius: 14, padding: "14px 8px", cursor: "pointer", textAlign: "center" }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: color + "20", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", fontSize: 18 }}>{icon}</div>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#94A3B8" }}>{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Filters */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16, overflowX: "auto", paddingBottom: 4 }}>
          {filters.map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{ padding: "7px 16px", borderRadius: 99, border: "none", background: filter === f ? "#06B6D4" : "#1E293B", color: filter === f ? "#0F172A" : "#6B7280", fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>{f}</button>
          ))}
        </div>

        {/* Notes */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontWeight: 800, fontSize: 16, color: "#F1F5F9" }}>My Notes</span>
          <span style={{ fontSize: 12, color: "#6B7280", fontWeight: 600 }}>{filtered.length} notes</span>
        </div>
        {filtered.map(note => (
          <button key={note.id} onClick={() => onNote(note)} style={{ width: "100%", background: "#1E293B", border: `1px solid ${note.color}25`, borderRadius: 18, padding: "16px", marginBottom: 12, cursor: "pointer", textAlign: "left", transition: "transform 0.15s" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 40, height: 40, borderRadius: 12, background: note.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, border: `1px solid ${note.color}30` }}>
                  {note.tag === "Lecture" ? "📚" : note.tag === "Study" ? "💡" : note.tag === "Business" ? "💼" : "📝"}
                </div>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 14, color: "#F1F5F9", marginBottom: 2 }}>{note.title}</div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: note.color, background: note.bg, borderRadius: 99, padding: "2px 8px" }}>{note.course}</span>
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: "#4B5563", marginBottom: 4 }}>{note.date}</div>
                <div style={{ background: note.bg, borderRadius: 99, padding: "2px 8px" }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: note.color }}>{note.tag}</span>
                </div>
              </div>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: "#64748B", lineHeight: 1.6, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{note.preview}</p>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.05)" }}>
              <span style={{ fontSize: 11, color: "#4B5563" }}>✨ AI Summary available</span>
              <span style={{ fontSize: 11, color: "#4B5563", marginLeft: "auto" }}>→ Open</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Note Detail ───────────────────────────────────────────────────────────────
function NoteDetail({ note, onBack }) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [showToolbox, setShowToolbox] = useState(true);
  const timerRef = useRef(null);

  useEffect(() => {
    if (recording) { timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000); }
    else { clearInterval(timerRef.current); }
    return () => clearInterval(timerRef.current);
  }, [recording]);

  const fmt = s => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div style={{ flex: 1, overflowY: "auto", background: "#0F172A" }}>
      {/* Header */}
      <div style={{ background: "#1E293B", padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,0.06)", position: "sticky", top: 0, zIndex: 10 }}>
        <button onClick={onBack} style={{ background: "rgba(255,255,255,0.08)", border: "none", borderRadius: 10, width: 36, height: 36, cursor: "pointer", color: "#fff", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>←</button>
        <span style={{ fontWeight: 800, fontSize: 16, color: "#F1F5F9", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{note.title}</span>
        <button style={{ background: "rgba(255,255,255,0.08)", border: "none", borderRadius: 10, width: 36, height: 36, cursor: "pointer", color: "#fff", fontSize: 18 }}>⋯</button>
      </div>

      {/* Recent tag */}
      <div style={{ padding: "14px 20px 0" }}>
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
          <div style={{ background: note.bg, borderRadius: 8, padding: "5px 12px", display: "flex", alignItems: "center", gap: 6, flexShrink: 0, border: `1px solid ${note.color}40` }}>
            <span style={{ fontSize: 12 }}>📄</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: note.color }}>{note.title.slice(0, 16)}</span>
          </div>
          <div style={{ background: "#1E293B", borderRadius: 8, padding: "5px 12px", flexShrink: 0, border: "1px solid rgba(255,255,255,0.08)" }}>
            <span style={{ fontSize: 12, color: "#64748B" }}>{note.course}</span>
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: "20px" }}>
        <div style={{ background: "#1E293B", borderRadius: 18, padding: "20px", border: "1px solid rgba(255,255,255,0.06)", marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
            <h2 style={{ color: "#F1F5F9", fontSize: 20, fontWeight: 800, margin: 0, lineHeight: 1.3 }}>{note.title}</h2>
            <span style={{ fontSize: 18 }}>🤍</span>
          </div>
          <div style={{ width: 40, height: 3, borderRadius: 2, background: note.color, marginBottom: 16 }} />
          {note.content.map((line, i) => (
            <p key={i} style={{ margin: "0 0 6px", fontSize: 14, color: line.startsWith("•") ? "#94A3B8" : line === "" ? "transparent" : "#CBD5E1", lineHeight: 1.7, fontWeight: line.endsWith(":") ? 700 : 400 }}>{line || "\u00A0"}</p>
          ))}
        </div>

        {/* AI Summary Button */}
        <button style={{ width: "100%", background: `linear-gradient(135deg, ${note.color}, #A78BFA)`, color: "#fff", border: "none", borderRadius: 14, padding: "15px", fontSize: 15, fontWeight: 800, cursor: "pointer", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, boxShadow: `0 4px 20px ${note.color}40` }}>
          <span>✨</span> Generate AI Summary <span>💡</span>
        </button>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
          <button style={{ background: "#1E293B", color: "#94A3B8", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "12px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>🧠 Make Quiz</button>
          <button style={{ background: "#1E293B", color: "#94A3B8", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "12px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>🃏 Flashcards</button>
        </div>
      </div>

      {/* Toolbox */}
      {showToolbox && (
        <div style={{ margin: "0 20px 20px", background: "#1E293B", borderRadius: 18, padding: "16px", border: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <span style={{ fontWeight: 800, fontSize: 14, color: "#F1F5F9" }}>Toolbox</span>
            <button onClick={() => setShowToolbox(false)} style={{ background: "none", border: "none", color: "#6B7280", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <div style={{ background: "#0F172A", borderRadius: 12, padding: "12px 8px", textAlign: "center", border: "1px solid rgba(255,255,255,0.05)" }}>
              <div style={{ fontSize: 18, marginBottom: 6 }}>✨</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#94A3B8", marginBottom: 8 }}>AI-Assisted Writing</div>
              <Wave active={false} color="#A78BFA" />
            </div>
            <button onClick={() => setRecording(r => !r)} style={{ background: "#0F172A", borderRadius: 12, padding: "12px 8px", textAlign: "center", border: `1px solid ${recording ? "#06B6D4" : "rgba(255,255,255,0.05)"}`, cursor: "pointer" }}>
              <div style={{ fontSize: 18, marginBottom: 6 }}>🎙️</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#94A3B8", marginBottom: 6 }}>Voice Recording</div>
              {recording ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                  <Wave active color="#06B6D4" />
                  <span style={{ fontSize: 11, color: "#06B6D4", fontWeight: 700 }}>{fmt(elapsed)}</span>
                  <div style={{ display: "flex", gap: 4 }}>
                    <div style={{ width: 18, height: 18, borderRadius: 4, background: "#374151", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9 }}>⏸</div>
                    <div style={{ width: 18, height: 18, borderRadius: 4, background: "#EF4444", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9 }}>⏹</div>
                  </div>
                </div>
              ) : <Wave active={false} color="#06B6D4" />}
            </button>
            <div style={{ background: "#0F172A", borderRadius: 12, padding: "12px 8px", textAlign: "center", border: "1px solid rgba(255,255,255,0.05)" }}>
              <div style={{ fontSize: 18, marginBottom: 6 }}>🖊️</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#94A3B8", marginBottom: 8 }}>Drawing</div>
              <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
                <span style={{ fontSize: 14 }}>✏️</span><span style={{ fontSize: 14 }}>🔶</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── New Note Screen ───────────────────────────────────────────────────────────
function NewNoteScreen({ onBack, onSave }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [course, setCourse] = useState("General");
  const [tag, setTag] = useState("Lecture");
  const [colorIdx, setColorIdx] = useState(0);
  const colors = ["#06B6D4", "#A78BFA", "#F59E0B", "#34D399", "#F87171", "#60A5FA"];
  const courses = ["General", "PHY 101", "MTH 101", "COS 102", "ENG 201", "CHM 102"];
  const tags = ["Lecture", "Study", "Business", "Personal"];

  const save = () => {
    if (!title.trim()) { alert("Add a title!"); return; }
    onSave({ id: Date.now(), title, course, color: colors[colorIdx], bg: colors[colorIdx] + "20", date: "Today", tag, preview: content.slice(0, 90), content: content.split("\n") });
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", background: "#0F172A" }}>
      <div style={{ background: "#1E293B", padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <button onClick={onBack} style={{ background: "rgba(255,255,255,0.08)", border: "none", borderRadius: 10, width: 36, height: 36, cursor: "pointer", color: "#fff", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>←</button>
        <span style={{ fontWeight: 800, fontSize: 16, color: "#F1F5F9" }}>New Note</span>
        <button onClick={save} style={{ background: "linear-gradient(135deg,#06B6D4,#A78BFA)", color: "#fff", border: "none", borderRadius: 10, padding: "8px 18px", fontWeight: 800, fontSize: 13, cursor: "pointer" }}>Save</button>
      </div>
      <div style={{ padding: 20 }}>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Note title..."
          style={{ width: "100%", padding: "14px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.1)", fontSize: 17, fontWeight: 800, background: "#1E293B", color: "#F1F5F9", outline: "none", marginBottom: 12, boxSizing: "border-box" }} />

        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          {courses.map(c => <button key={c} onClick={() => setCourse(c)} style={{ padding: "6px 14px", borderRadius: 99, border: "2px solid", borderColor: course === c ? "#06B6D4" : "rgba(255,255,255,0.1)", background: course === c ? "#06B6D4" : "#1E293B", color: course === c ? "#0F172A" : "#6B7280", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{c}</button>)}
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {tags.map(t => <button key={t} onClick={() => setTag(t)} style={{ padding: "6px 14px", borderRadius: 99, border: "2px solid", borderColor: tag === t ? "#A78BFA" : "rgba(255,255,255,0.1)", background: tag === t ? "#A78BFA" : "#1E293B", color: tag === t ? "#0F172A" : "#6B7280", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{t}</button>)}
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          {colors.map((c, i) => <button key={c} onClick={() => setColorIdx(i)} style={{ width: 30, height: 30, borderRadius: "50%", background: c, border: colorIdx === i ? "3px solid #fff" : "3px solid transparent", cursor: "pointer" }} />)}
        </div>
        <textarea value={content} onChange={e => setContent(e.target.value)} placeholder="Start typing your notes here..."
          style={{ width: "100%", minHeight: 240, padding: "16px", borderRadius: 14, border: "1px solid rgba(255,255,255,0.08)", fontSize: 14, lineHeight: 1.8, background: "#1E293B", color: "#CBD5E1", outline: "none", resize: "vertical", fontFamily: "inherit", boxSizing: "border-box" }} />
      </div>
    </div>
  );
}

// ── AI Assistant Screen ───────────────────────────────────────────────────────
function AIScreen() {
  const [messages, setMessages] = useState([{ role: "ai", text: "Hi Samuel! 👋 I'm your AI study assistant. Ask me anything about your notes, request a summary, quiz, or just ask a question!" }]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const send = async () => {
    if (!input.trim()) return;
    const userMsg = input.trim(); setInput("");
    setMessages(m => [...m, { role: "user", text: userMsg }]);
    setLoading(true);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "YOUR_API_KEY_HERE", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 500, messages: [{ role: "user", content: `You are a friendly AI study assistant for a student named Samuel. Answer concisely and helpfully: ${userMsg}` }] })
      });
      const data = await res.json();
      setMessages(m => [...m, { role: "ai", text: data.content[0].text }]);
    } catch {
      setMessages(m => [...m, { role: "ai", text: "⚠️ Add your Claude API key in App.js to enable AI chat! For now, I'm in demo mode. You can ask me anything and I'll respond once connected." }]);
    }
    setLoading(false);
  };

  const suggestions = ["Summarize my Physics notes", "Create a quiz on Data Structures", "Explain kinematics simply", "What's LIFO vs FIFO?"];

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#0F172A" }}>
      <div style={{ background: "#1E293B", padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 38, height: 38, borderRadius: 12, background: "linear-gradient(135deg,#06B6D4,#A78BFA)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🤖</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16, color: "#F1F5F9" }}>AI Assistant</div>
            <div style={{ fontSize: 11, color: "#06B6D4", fontWeight: 600 }}>● Online</div>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px 8px" }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 12 }}>
            {m.role === "ai" && <div style={{ width: 30, height: 30, borderRadius: 10, background: "linear-gradient(135deg,#06B6D4,#A78BFA)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, marginRight: 8, flexShrink: 0, marginTop: 2 }}>🤖</div>}
            <div style={{ maxWidth: "78%", background: m.role === "user" ? "linear-gradient(135deg,#06B6D4,#A78BFA)" : "#1E293B", borderRadius: m.role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px", padding: "12px 16px", border: m.role === "ai" ? "1px solid rgba(255,255,255,0.06)" : "none" }}>
              <p style={{ margin: 0, fontSize: 14, color: "#F1F5F9", lineHeight: 1.6 }}>{m.text}</p>
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 12 }}>
            <div style={{ width: 30, height: 30, borderRadius: 10, background: "linear-gradient(135deg,#06B6D4,#A78BFA)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, marginRight: 8 }}>🤖</div>
            {[0,1,2].map(i => <div key={i} style={{ width: 8, height: 8, borderRadius: "50%", background: "#06B6D4", animation: `dot ${0.6 + i * 0.2}s ease-in-out infinite alternate` }} />)}
            <style>{`@keyframes dot{from{opacity:0.3;transform:scale(0.7)}to{opacity:1;transform:scale(1)}}`}</style>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Suggestions */}
      {messages.length <= 2 && (
        <div style={{ padding: "0 16px 8px", display: "flex", gap: 8, overflowX: "auto" }}>
          {suggestions.map(s => (
            <button key={s} onClick={() => { setInput(s); }} style={{ background: "#1E293B", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 99, padding: "7px 14px", color: "#94A3B8", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>{s}</button>
          ))}
        </div>
      )}

      <div style={{ padding: "12px 16px 16px", background: "#1E293B", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", gap: 10 }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} placeholder="Ask anything about your notes..."
          style={{ flex: 1, padding: "12px 16px", borderRadius: 14, border: "1px solid rgba(255,255,255,0.1)", fontSize: 14, background: "#0F172A", color: "#F1F5F9", outline: "none" }} />
        <button onClick={send} style={{ width: 46, height: 46, borderRadius: 14, background: "linear-gradient(135deg,#06B6D4,#A78BFA)", border: "none", cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>↑</button>
      </div>
    </div>
  );
}

// ── Settings Screen ───────────────────────────────────────────────────────────
function SettingsScreen() {
  const [dark, setDark] = useState(true);
  const [notif, setNotif] = useState(true);
  const [autoSave, setAutoSave] = useState(true);
  const [lock, setLock] = useState(false);

  const Section = ({ title, children }) => (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#4B5563", letterSpacing: 1, textTransform: "uppercase", marginBottom: 10, paddingLeft: 4 }}>{title}</div>
      <div style={{ background: "#1E293B", borderRadius: 16, overflow: "hidden", border: "1px solid rgba(255,255,255,0.06)" }}>{children}</div>
    </div>
  );

  const Row = ({ icon, label, sub, right, last }) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: last ? "none" : "1px solid rgba(255,255,255,0.04)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 20 }}>{icon}</span>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#F1F5F9" }}>{label}</div>
          {sub && <div style={{ fontSize: 11, color: "#6B7280" }}>{sub}</div>}
        </div>
      </div>
      {right || <span style={{ color: "#4B5563", fontSize: 16 }}>›</span>}
    </div>
  );

  return (
    <div style={{ flex: 1, overflowY: "auto", background: "#0F172A" }}>
      <div style={{ background: "#1E293B", padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <span style={{ fontWeight: 800, fontSize: 18, color: "#F1F5F9" }}>Settings</span>
      </div>
      <div style={{ padding: 20 }}>
        {/* Profile Card */}
        <div style={{ background: "linear-gradient(135deg, #1E293B, #0F172A)", borderRadius: 20, padding: "20px", marginBottom: 20, border: "1px solid rgba(6,182,212,0.2)", display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 60, height: 60, borderRadius: 18, background: "linear-gradient(135deg,#06B6D4,#A78BFA)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26 }}>👤</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 18, color: "#F1F5F9" }}>Samuel</div>
            <div style={{ fontSize: 13, color: "#6B7280" }}>samuel@gmail.com</div>
            <div style={{ display: "inline-block", background: "rgba(6,182,212,0.15)", borderRadius: 99, padding: "3px 10px", marginTop: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#06B6D4" }}>Free Plan</span>
            </div>
          </div>
          <button style={{ background: "rgba(255,255,255,0.06)", border: "none", borderRadius: 10, padding: "8px 14px", color: "#94A3B8", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Edit</button>
        </div>

        <Section title="Appearance">
          <Row icon="🌙" label="Dark Mode" sub="Current theme" right={<Toggle value={dark} onChange={setDark} />} />
          <Row icon="🎨" label="Theme Color" sub="Cyan (Default)" last />
        </Section>

        <Section title="Preferences">
          <Row icon="🔔" label="Notifications" right={<Toggle value={notif} onChange={setNotif} color="#A78BFA" />} />
          <Row icon="💾" label="Auto Save" right={<Toggle value={autoSave} onChange={setAutoSave} color="#34D399" />} />
          <Row icon="🔒" label="App Lock" right={<Toggle value={lock} onChange={setLock} color="#F59E0B" />} last />
        </Section>

        <Section title="AI Features">
          <Row icon="🤖" label="AI Model" sub="Claude Haiku (Fast)" />
          <Row icon="🔑" label="API Key" sub="Not configured" last />
        </Section>

        {/* Pro Card */}
        <div style={{ background: "linear-gradient(135deg, #4F46E5, #7C3AED, #06B6D4)", borderRadius: 20, padding: "22px", marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: 20, color: "#fff", marginBottom: 4 }}>⭐ Upgrade to Pro</div>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", lineHeight: 1.6 }}>Unlimited notes & recordings<br />Advanced AI features<br />Priority support</div>
            </div>
            <span style={{ fontSize: 36 }}>🚀</span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 14 }}>
            <span style={{ fontSize: 28, fontWeight: 800, color: "#fff" }}>₦2,000</span>
            <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)" }}>/month</span>
          </div>
          <button style={{ width: "100%", background: "#fff", color: "#4F46E5", border: "none", borderRadius: 12, padding: "13px", fontWeight: 800, fontSize: 15, cursor: "pointer" }}>Get Pro Now →</button>
        </div>

        <Section title="Support">
          <Row icon="💬" label="Feedback" />
          <Row icon="📧" label="Contact Us" />
          <Row icon="⭐" label="Rate the App" last />
        </Section>

        <div style={{ textAlign: "center", padding: "16px 0", color: "#374151", fontSize: 12 }}>
          Jotting AI v1.0.0 · Made with ❤️ by Samuel
        </div>
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [notes, setNotes] = useState(NOTES);
  const [screen, setScreen] = useState("home");
  const [activeNote, setActiveNote] = useState(null);
  const [tab, setTab] = useState("home");

  const go = (s, t) => { setScreen(s); if (t) setTab(t); };

  const NAV = [
    { id: "home", icon: "🏠", label: "Home", screen: "home" },
    { id: "notes", icon: "📝", label: "Notes", screen: "home" },
    { id: "new", icon: "+", label: "New Note", screen: "new", special: true },
    { id: "ai", icon: "✨", label: "AI Assistant", screen: "ai" },
    { id: "settings", icon: "⚙️", label: "Settings", screen: "settings" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#06081A", display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "20px 0" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        *{box-sizing:border-box;font-family:'DM Sans',sans-serif;}
        body{margin:0;background:#06081A;}
        button{font-family:'DM Sans',sans-serif;}
        textarea,input{font-family:'DM Sans',sans-serif;}
        ::-webkit-scrollbar{width:0;}
        input::placeholder{color:#4B5563;}
        textarea::placeholder{color:#4B5563;}
      `}</style>

      <div style={{ width: "100%", maxWidth: 400, minHeight: "calc(100vh - 40px)", background: "#0F172A", borderRadius: 36, overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 24px 80px rgba(6,182,212,0.15), 0 0 0 1px rgba(255,255,255,0.06)" }}>

        {/* Screen */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflowY: "auto", minHeight: 0 }}>
          {screen === "home" && <HomeScreen notes={notes} onNote={n => { setActiveNote(n); go("detail"); }} onNew={() => go("new", "new")} />}
          {screen === "detail" && activeNote && <NoteDetail note={activeNote} onBack={() => go("home", "home")} />}
          {screen === "new" && <NewNoteScreen onBack={() => go("home", "home")} onSave={n => { setNotes(ns => [n, ...ns]); go("home", "home"); }} />}
          {screen === "ai" && <AIScreen />}
          {screen === "settings" && <SettingsScreen />}
        </div>

        {/* Bottom Nav */}
        <div style={{ background: "#1E293B", borderTop: "1px solid rgba(255,255,255,0.06)", padding: "10px 10px 16px", display: "flex", justifyContent: "space-around", alignItems: "center", flexShrink: 0 }}>
          {NAV.map(({ id, icon, label, screen: s, special }) => (
            <button key={id} onClick={() => go(s, id)} style={{ background: special ? "linear-gradient(135deg,#06B6D4,#A78BFA)" : "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: special ? "0" : "4px 8px", width: special ? 52 : "auto", height: special ? 52 : "auto", borderRadius: special ? "50%" : 0, boxShadow: special ? "0 4px 20px rgba(6,182,212,0.4)" : "none", justifyContent: "center" }}>
              <span style={{ fontSize: special ? 24 : 20, fontWeight: special ? 300 : 400, color: special ? "#fff" : tab === id ? "#06B6D4" : "#4B5563" }}>{icon}</span>
              {!special && <span style={{ fontSize: 10, fontWeight: 700, color: tab === id ? "#06B6D4" : "#4B5563" }}>{label}</span>}
              {!special && tab === id && <div style={{ width: 4, height: 4, borderRadius: "50%", background: "#06B6D4" }} />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
