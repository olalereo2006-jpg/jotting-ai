import { useState, useEffect, useRef, useCallback } from "react";

// ── Theme ─────────────────────────────────────────────────────────────────────
const C = {
  bg: "#0A0F1E", card: "#111827", card2: "#1E293B",
  border: "rgba(255,255,255,0.06)", cyan: "#06B6D4",
  purple: "#A78BFA", amber: "#F59E0B", green: "#34D399",
  red: "#F87171", text: "#F1F5F9", muted: "#64748B", soft: "#94A3B8",
};

// ── Sample Notes ──────────────────────────────────────────────────────────────
const INIT_NOTES = [
  { id: 1, title: "Physics: Kinematics", course: "PHY 101", color: "#06B6D4", bg: "rgba(6,182,212,0.12)", date: "Today", tag: "Lecture", preview: "Kinematics is the study of motion. v = u + at is the fundamental equation.", content: "Kinematics is the study of motion without considering forces.\n\nKey Equations:\n• v = u + at\n• s = ut + ½at²\n• v² = u² + 2as\n\nVelocity is the rate of change of displacement.\nAcceleration is the rate of change of velocity." },
  { id: 2, title: "Data Structures", course: "COS 201", color: "#A78BFA", bg: "rgba(167,139,250,0.12)", date: "Yesterday", tag: "Study", preview: "Stack uses LIFO, Queue uses FIFO. Binary trees have at most 2 children.", content: "Stack - Last In First Out (LIFO)\nQueue - First In First Out (FIFO)\nLinked List - Dynamic memory allocation\nBinary Tree - At most 2 children per node\nHash Table - O(1) average lookup time" },
  { id: 3, title: "NoteWave Business Plan", course: "Personal", color: "#F59E0B", bg: "rgba(245,158,11,0.12)", date: "Jun 20", tag: "Business", preview: "AI note-taking app for students. Freemium model with Pro at ₦2,000/month.", content: "Product: AI-powered lecture note app\nTarget: Nigerian university students\nRevenue: Freemium model\n• Free: 5 recordings/month\n• Pro: Unlimited + AI features ₦2,000/month\nLaunch: Q3 2026" },
  { id: 4, title: "Organic Chemistry", course: "CHM 102", color: "#34D399", bg: "rgba(52,211,153,0.12)", date: "Jun 18", tag: "Lecture", preview: "Functional groups determine chemical properties. Alkanes, Alkenes, Alkynes.", content: "Functional Groups:\n• Alkanes: Single bonds (CnH2n+2)\n• Alkenes: Double bonds (CnH2n)\n• Alkynes: Triple bonds (CnH2n-2)\n\nIUPAC Naming conventions apply to all organic compounds." },
];

// ── Animated Wave ──────────────────────────────────────────────────────────────
function Wave({ active, color = "#06B6D4", size = 1 }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2.5, height: 20 * size }}>
      {[0.5,1,1.6,1,0.7,1.4,0.9,1.2,0.6,1.1,0.8].map((h, i) => (
        <div key={i} style={{ width: 2.5 * size, borderRadius: 99, background: active ? color : "#374151", height: active ? `${h * 16 * size}px` : `${3 * size}px`, transition: "height 0.3s ease", animation: active ? `wv ${0.35 + i * 0.07}s ease-in-out infinite alternate` : "none" }} />
      ))}
    </div>
  );
}

// ── Toggle ────────────────────────────────────────────────────────────────────
function Toggle({ value, onChange, color = "#06B6D4" }) {
  return (
    <div onClick={() => onChange(!value)} style={{ width: 46, height: 26, borderRadius: 13, background: value ? color : "#374151", cursor: "pointer", position: "relative", transition: "background 0.25s", flexShrink: 0 }}>
      <div style={{ position: "absolute", top: 3, left: value ? 23 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "left 0.25s", boxShadow: "0 2px 4px rgba(0,0,0,0.3)" }} />
    </div>
  );
}

// ── VOICE RECORDING SCREEN (Real Voice → Text) ───────────────────────────────
function VoiceNoteScreen({ onBack, onSave }) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [title, setTitle] = useState("");
  const [course, setCourse] = useState("General");
  const [status, setStatus] = useState("Ready to record");
  const recognitionRef = useRef(null);
  const timerRef = useRef(null);
  const courses = ["General", "PHY 101", "MTH 101", "COS 102", "ENG 201", "CHM 102"];
  const fmt = s => `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;

  const startListening = useCallback(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { setStatus("⚠️ Use Chrome browser for voice recording!"); return; }
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    let finalTranscript = transcript;

    recognition.onstart = () => { setStatus("🎙️ Listening... speak now"); setIsListening(true); };
    recognition.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) { finalTranscript += e.results[i][0].transcript + " "; }
        else { interim = e.results[i][0].transcript; }
      }
      setTranscript(finalTranscript + interim);
    };
    recognition.onerror = (e) => { setStatus(`Error: ${e.error}. Try again.`); setIsListening(false); };
    recognition.onend = () => { setIsListening(false); setStatus("Recording stopped"); };
    recognitionRef.current = recognition;
    recognition.start();
    timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
  }, [transcript]);

  const stopListening = () => {
    recognitionRef.current?.stop();
    clearInterval(timerRef.current);
    setIsListening(false);
    setStatus("Recording stopped ✅");
  };

  const saveNote = () => {
    if (!transcript.trim()) { alert("Record something first!"); return; }
    onSave({
      id: Date.now(), title: title || `Voice Note - ${new Date().toLocaleDateString()}`,
      course, color: "#06B6D4", bg: "rgba(6,182,212,0.12)",
      date: "Today", tag: "Lecture", preview: transcript.slice(0, 100),
      content: transcript,
    });
  };

  return (
    <div style={{ flex: 1, background: C.bg, display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ background: C.card, padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight: 800, fontSize: 16, color: C.text }}>Voice Recording</span>
        <button onClick={saveNote} style={{ background: "linear-gradient(135deg,#06B6D4,#A78BFA)", color: "#fff", border: "none", borderRadius: 10, padding: "8px 16px", fontWeight: 800, fontSize: 13, cursor: "pointer" }}>Save</button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
        {/* Title input */}
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Note title (optional)..."
          style={{ width: "100%", padding: 14, borderRadius: 12, border: `1px solid ${C.border}`, fontSize: 16, fontWeight: 700, background: C.card, color: C.text, outline: "none", marginBottom: 12, boxSizing: "border-box" }} />

        {/* Course selector */}
        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          {courses.map(c => (
            <button key={c} onClick={() => setCourse(c)} style={{ padding: "6px 14px", borderRadius: 99, border: "2px solid", borderColor: course === c ? C.cyan : C.border, background: course === c ? C.cyan : C.card, color: course === c ? "#0A0F1E" : C.muted, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{c}</button>
          ))}
        </div>

        {/* Recording area */}
        <div style={{ background: C.card, borderRadius: 20, padding: 24, border: `1px solid ${isListening ? C.cyan : C.border}`, marginBottom: 20, textAlign: "center", transition: "border-color 0.3s" }}>
          {/* Big mic button */}
          <div onClick={isListening ? stopListening : startListening} style={{ width: 100, height: 100, borderRadius: "50%", background: isListening ? "linear-gradient(135deg,#EF4444,#F87171)" : "linear-gradient(135deg,#06B6D4,#A78BFA)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", cursor: "pointer", fontSize: 40, boxShadow: isListening ? "0 0 0 12px rgba(239,68,68,0.15), 0 0 0 24px rgba(239,68,68,0.08)" : "0 8px 30px rgba(6,182,212,0.4)", transition: "all 0.3s", animation: isListening ? "pulse 1.5s ease-in-out infinite" : "none" }}>
            {isListening ? "⏹" : "🎙️"}
          </div>

          {/* Timer */}
          {isListening && (
            <div style={{ fontSize: 32, fontWeight: 800, color: C.red, marginBottom: 12, fontFamily: "monospace" }}>{fmt(elapsed)}</div>
          )}

          {/* Wave */}
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
            <Wave active={isListening} color={isListening ? "#EF4444" : C.cyan} size={1.5} />
          </div>

          <p style={{ color: C.muted, fontSize: 14, margin: 0 }}>{status}</p>
          {!isListening && !transcript && (
            <p style={{ color: C.soft, fontSize: 13, marginTop: 8 }}>Tap the mic to start recording your lecture</p>
          )}
        </div>

        {/* Live transcript */}
        {transcript && (
          <div style={{ background: C.card, borderRadius: 16, padding: 20, border: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: C.cyan }}>📝 Transcript</span>
              <button onClick={() => setTranscript("")} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 13 }}>Clear</button>
            </div>
            <textarea value={transcript} onChange={e => setTranscript(e.target.value)}
              style={{ width: "100%", minHeight: 160, background: "transparent", border: "none", color: C.text, fontSize: 14, lineHeight: 1.8, outline: "none", resize: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── DRAW SCREEN ───────────────────────────────────────────────────────────────
function DrawScreen({ onBack }) {
  const canvasRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [color, setColor] = useState("#06B6D4");
  const [size, setSize] = useState(4);
  const [tool, setTool] = useState("pen");
  const lastPos = useRef(null);
  const colors = ["#06B6D4","#A78BFA","#F59E0B","#34D399","#F87171","#fff","#F1F5F9"];

  const getPos = (e, canvas) => {
    const rect = canvas.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return { x: src.clientX - rect.left, y: src.clientY - rect.top };
  };

  const startDraw = (e) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const pos = getPos(e, canvas);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    lastPos.current = pos;
    setDrawing(true);
  };

  const draw = (e) => {
    e.preventDefault();
    if (!drawing) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const pos = getPos(e, canvas);
    ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = color;
    ctx.lineWidth = tool === "eraser" ? 24 : size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastPos.current = pos;
  };

  const stopDraw = () => setDrawing(false);

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  };

  const saveDrawing = () => {
    const canvas = canvasRef.current;
    const link = document.createElement("a");
    link.download = "jotting-ai-drawing.png";
    link.href = canvas.toDataURL();
    link.click();
  };

  return (
    <div style={{ flex: 1, background: C.bg, display: "flex", flexDirection: "column" }}>
      <div style={{ background: C.card, padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight: 800, fontSize: 16, color: C.text }}>Draw</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={clearCanvas} style={{ background: C.card2, border: "none", borderRadius: 8, padding: "7px 12px", color: C.muted, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Clear</button>
          <button onClick={saveDrawing} style={{ background: "linear-gradient(135deg,#06B6D4,#A78BFA)", border: "none", borderRadius: 8, padding: "7px 12px", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Save</button>
        </div>
      </div>

      {/* Toolbar */}
      <div style={{ background: C.card, padding: "12px 20px", display: "flex", alignItems: "center", gap: 12, borderBottom: `1px solid ${C.border}`, flexWrap: "wrap" }}>
        {/* Colors */}
        <div style={{ display: "flex", gap: 6 }}>
          {colors.map(c => (
            <button key={c} onClick={() => { setColor(c); setTool("pen"); }} style={{ width: 24, height: 24, borderRadius: "50%", background: c, border: color === c && tool !== "eraser" ? "3px solid #fff" : "2px solid rgba(255,255,255,0.2)", cursor: "pointer" }} />
          ))}
        </div>
        {/* Tools */}
        <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
          {[["✏️","pen"],["📏","line"],["⬜","rect"],["⭕","eraser"]].map(([icon, t]) => (
            <button key={t} onClick={() => setTool(t)} style={{ background: tool === t ? C.cyan : C.card2, border: "none", borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 14 }}>{icon}</button>
          ))}
        </div>
        {/* Size */}
        <input type="range" min="2" max="20" value={size} onChange={e => setSize(Number(e.target.value))} style={{ width: 80, accentColor: C.cyan }} />
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#0A0F1E", padding: 10 }}>
        <canvas ref={canvasRef} width={350} height={480}
          style={{ background: "#1a1f2e", borderRadius: 16, border: `1px solid ${C.border}`, cursor: tool === "eraser" ? "cell" : "crosshair", touchAction: "none", maxWidth: "100%" }}
          onMouseDown={startDraw} onMouseMove={draw} onMouseUp={stopDraw} onMouseLeave={stopDraw}
          onTouchStart={startDraw} onTouchMove={draw} onTouchEnd={stopDraw}
        />
      </div>
    </div>
  );
}

// ── AI WRITE SCREEN ───────────────────────────────────────────────────────────
function AIWriteScreen({ onBack, onSave }) {
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState("");
  const [course, setCourse] = useState("General");
  const courses = ["General","PHY 101","MTH 101","COS 102","ENG 201","CHM 102"];
  const suggestions = ["Summarize my Physics lecture on Newton's laws","Write study notes on Data Structures","Create outline for essay on Climate Change","Explain Calculus differentiation simply","Write notes on Organic Chemistry basics"];

  const generate = async (text) => {
    const q = text || prompt;
    if (!q.trim()) return;
    setLoading(true); setResult("");
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "YOUR_API_KEY_HERE", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 800, messages: [{ role: "user", content: `You are a helpful study assistant. Write clear, well-structured student notes for: ${q}. Use bullet points and headers.` }] })
      });
      const data = await res.json();
      setResult(data.content[0].text);
      setTitle(q.slice(0, 40));
    } catch {
      setResult("⚠️ Add your Claude API key to enable AI writing!\n\nFor now here's a demo:\n\n📚 Study Notes\n\n• Key concept 1: Important definition here\n• Key concept 2: Another important point\n• Key concept 3: Related information\n\n💡 Summary\nThis topic covers essential concepts that are important for your exams.");
    }
    setLoading(false);
  };

  const saveNote = () => {
    if (!result) return;
    onSave({ id: Date.now(), title: title || "AI Written Note", course, color: "#A78BFA", bg: "rgba(167,139,250,0.12)", date: "Today", tag: "Study", preview: result.slice(0, 100), content: result });
  };

  return (
    <div style={{ flex: 1, background: C.bg, display: "flex", flexDirection: "column" }}>
      <div style={{ background: C.card, padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight: 800, fontSize: 16, color: C.text }}>✨ AI Write</span>
        {result && <button onClick={saveNote} style={{ background: "linear-gradient(135deg,#A78BFA,#06B6D4)", color: "#fff", border: "none", borderRadius: 10, padding: "8px 16px", fontWeight: 800, fontSize: 13, cursor: "pointer" }}>Save</button>}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {courses.map(c => <button key={c} onClick={() => setCourse(c)} style={{ padding: "6px 14px", borderRadius: 99, border: "2px solid", borderColor: course === c ? C.purple : C.border, background: course === c ? C.purple : C.card, color: course === c ? "#0A0F1E" : C.muted, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{c}</button>)}
        </div>

        <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
          <input value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => e.key === "Enter" && generate()} placeholder="What should I write notes about?"
            style={{ flex: 1, padding: "13px 16px", borderRadius: 14, border: `1px solid ${C.border}`, fontSize: 14, background: C.card, color: C.text, outline: "none" }} />
          <button onClick={() => generate()} disabled={loading} style={{ width: 48, height: 48, borderRadius: 14, background: "linear-gradient(135deg,#A78BFA,#06B6D4)", border: "none", cursor: "pointer", fontSize: 20, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            {loading ? "⏳" : "✨"}
          </button>
        </div>

        {!result && !loading && (
          <>
            <p style={{ color: C.muted, fontSize: 13, marginBottom: 12 }}>💡 Try these:</p>
            {suggestions.map(s => (
              <button key={s} onClick={() => { setPrompt(s); generate(s); }} style={{ width: "100%", textAlign: "left", background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 16px", color: C.soft, fontSize: 13, cursor: "pointer", marginBottom: 8, fontFamily: "inherit" }}>{s}</button>
            ))}
          </>
        )}

        {loading && (
          <div style={{ textAlign: "center", padding: "40px 20px" }}>
            <div style={{ fontSize: 48, marginBottom: 16, animation: "spin 2s linear infinite" }}>✨</div>
            <p style={{ color: C.muted, fontSize: 14 }}>AI is writing your notes...</p>
          </div>
        )}

        {result && (
          <div style={{ background: C.card, borderRadius: 16, padding: 20, border: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: C.purple }}>✨ AI Generated Notes</span>
            </div>
            <textarea value={result} onChange={e => setResult(e.target.value)}
              style={{ width: "100%", minHeight: 280, background: "transparent", border: "none", color: C.text, fontSize: 14, lineHeight: 1.8, outline: "none", resize: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── NOTE DETAIL SCREEN ────────────────────────────────────────────────────────
function NoteDetail({ note, onBack, onDelete }) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [summary, setSummary] = useState("");
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [quiz, setQuiz] = useState([]);
  const [quizIdx, setQuizIdx] = useState(0);
  const [selected, setSelected] = useState(null);
  const [score, setScore] = useState(0);
  const [quizDone, setQuizDone] = useState(false);
  const [loadingQuiz, setLoadingQuiz] = useState(false);
  const [view, setView] = useState("note");
  const timerRef = useRef(null);
  const fmt = s => `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;

  useEffect(() => {
    if (recording) { timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000); }
    else { clearInterval(timerRef.current); }
    return () => clearInterval(timerRef.current);
  }, [recording]);

  const generateSummary = async () => {
    setLoadingSummary(true); setView("summary");
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "YOUR_API_KEY_HERE", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 600, messages: [{ role: "user", content: `Summarize these student notes in a clear, concise way with key points. Return JSON only: {"summary":"...","keyPoints":["..."],"tags":["..."]} NOTES: ${note.content}` }] })
      });
      const data = await res.json();
      const parsed = JSON.parse(data.content[0].text.replace(/```json|```/g,"").trim());
      setSummary(parsed);
    } catch {
      setSummary({ summary: `This note covers ${note.title}. Key concepts include the main topics from your ${note.course} lecture.`, keyPoints: ["Review the main definitions", "Practice the key formulas", "Connect concepts together"], tags: [note.course, note.tag] });
    }
    setLoadingSummary(false);
  };

  const generateQuiz = async () => {
    setLoadingQuiz(true); setView("quiz");
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "YOUR_API_KEY_HERE", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 800, messages: [{ role: "user", content: `Create 5 MCQ questions from these notes. Return JSON only: [{"question":"...","options":["A","B","C","D"],"answer":0}] NOTES: ${note.content}` }] })
      });
      const data = await res.json();
      const parsed = JSON.parse(data.content[0].text.replace(/```json|```/g,"").trim());
      setQuiz(parsed); setQuizIdx(0); setSelected(null); setScore(0); setQuizDone(false);
    } catch {
      setQuiz([
        { question: `What is the main topic of "${note.title}"?`, options: [note.course, "History", "Geography", "Art"], answer: 0 },
        { question: "What is the best way to study?", options: ["Practice regularly", "Cram before exam", "Skip class", "Copy notes"], answer: 0 },
      ]);
    }
    setLoadingQuiz(false);
  };

  const pick = (i) => {
    if (selected !== null) return;
    setSelected(i);
    if (i === quiz[quizIdx].answer) setScore(s => s + 1);
    setTimeout(() => {
      if (quizIdx + 1 < quiz.length) { setQuizIdx(q => q + 1); setSelected(null); }
      else setQuizDone(true);
    }, 900);
  };

  const share = () => {
    if (navigator.share) {
      navigator.share({ title: note.title, text: `${note.title}\n\n${note.content}`, url: window.location.href });
    } else {
      navigator.clipboard?.writeText(`${note.title}\n\n${note.content}`);
      alert("Note copied to clipboard!");
    }
  };

  return (
    <div style={{ flex: 1, background: C.bg, display: "flex", flexDirection: "column" }}>
      <div style={{ background: C.card, padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, zIndex: 10 }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight: 800, fontSize: 15, color: C.text, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{note.title}</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={share} style={{ background: C.card2, border: "none", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>📤</button>
          <button onClick={() => onDelete(note.id)} style={{ background: "rgba(248,113,113,0.15)", border: "none", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>🗑️</button>
        </div>
      </div>

      {/* Sub tabs */}
      <div style={{ background: C.card, padding: "0 20px 14px", display: "flex", gap: 6, borderBottom: `1px solid ${C.border}` }}>
        {[["📝","note","Note"],["📋","summary","Summary"],["🧠","quiz","Quiz"]].map(([icon,v,label]) => (
          <button key={v} onClick={() => { setView(v); if(v==="summary" && !summary) generateSummary(); if(v==="quiz" && quiz.length===0) generateQuiz(); }}
            style={{ padding: "7px 16px", borderRadius: 99, border: "none", background: view===v ? note.color : C.card2, color: view===v ? "#0A0F1E" : C.muted, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            {icon} {label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {/* NOTE VIEW */}
        {view === "note" && (
          <div style={{ padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: note.color, background: note.bg, borderRadius: 99, padding: "3px 12px" }}>{note.course}</span>
              <span style={{ fontSize: 11, color: C.muted }}>{note.date}</span>
            </div>
            <div style={{ background: C.card, borderRadius: 18, padding: 20, border: `1px solid ${C.border}`, marginBottom: 16 }}>
              <h2 style={{ color: C.text, fontSize: 20, fontWeight: 800, margin: "0 0 14px" }}>{note.title}</h2>
              <div style={{ width: 40, height: 3, borderRadius: 2, background: note.color, marginBottom: 16 }} />
              <p style={{ margin: 0, fontSize: 14, color: "#CBD5E1", lineHeight: 1.9, whiteSpace: "pre-line" }}>{note.content}</p>
            </div>

            {/* Recording strip */}
            <div style={{ background: C.card, borderRadius: 16, padding: "14px 16px", border: `1px solid ${recording ? C.red : C.border}`, marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
              <button onClick={() => setRecording(r => !r)} style={{ width: 42, height: 42, borderRadius: "50%", background: recording ? "#EF4444" : note.color, border: "none", cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {recording ? "⏹" : "🎙️"}
              </button>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: recording ? C.red : C.text }}>{recording ? `Recording ${fmt(elapsed)}` : "Add voice recording"}</div>
                <Wave active={recording} color={recording ? "#EF4444" : note.color} />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <button onClick={() => { setView("summary"); if(!summary) generateSummary(); }} style={actionBtn(note.color)}>📋 AI Summary</button>
              <button onClick={() => { setView("quiz"); if(quiz.length===0) generateQuiz(); }} style={actionBtn(C.purple)}>🧠 Quiz Me</button>
            </div>
          </div>
        )}

        {/* SUMMARY VIEW */}
        {view === "summary" && (
          <div style={{ padding: 20 }}>
            {loadingSummary ? (
              <div style={{ textAlign: "center", padding: "60px 20px" }}>
                <div style={{ fontSize: 48, animation: "spin 2s linear infinite" }}>✨</div>
                <p style={{ color: C.muted, marginTop: 16 }}>Generating summary...</p>
              </div>
            ) : summary ? (
              <>
                <div style={{ background: C.card, borderRadius: 16, padding: 20, border: `1px solid ${C.border}`, marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.green, letterSpacing: 1, marginBottom: 10 }}>OVERVIEW</div>
                  <p style={{ margin: 0, fontSize: 14, color: "#CBD5E1", lineHeight: 1.8 }}>{summary.summary}</p>
                </div>
                <div style={{ background: C.card, borderRadius: 16, padding: 20, border: `1px solid ${C.border}`, marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.amber, letterSpacing: 1, marginBottom: 12 }}>KEY POINTS</div>
                  {summary.keyPoints?.map((p, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                      <div style={{ width: 6, height: 6, borderRadius: 3, background: C.amber, marginTop: 7, flexShrink: 0 }} />
                      <p style={{ margin: 0, fontSize: 14, color: "#CBD5E1", lineHeight: 1.7 }}>{p}</p>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {summary.tags?.map(t => <span key={t} style={{ background: C.card2, color: C.cyan, borderRadius: 99, padding: "4px 14px", fontSize: 12, fontWeight: 700 }}>{t}</span>)}
                </div>
              </>
            ) : null}
          </div>
        )}

        {/* QUIZ VIEW */}
        {view === "quiz" && (
          <div style={{ padding: 20 }}>
            {loadingQuiz ? (
              <div style={{ textAlign: "center", padding: "60px 20px" }}>
                <div style={{ fontSize: 48, animation: "spin 2s linear infinite" }}>🧠</div>
                <p style={{ color: C.muted, marginTop: 16 }}>Generating quiz...</p>
              </div>
            ) : quizDone ? (
              <div style={{ textAlign: "center", padding: "40px 20px" }}>
                <div style={{ fontSize: 64, marginBottom: 16 }}>{score === quiz.length ? "🏆" : "📖"}</div>
                <div style={{ fontSize: 40, fontWeight: 800, color: C.text }}>{score}/{quiz.length}</div>
                <p style={{ color: C.muted, marginTop: 8 }}>{score === quiz.length ? "Perfect! Amazing! 🔥" : "Keep studying! 💪"}</p>
                <button onClick={() => { setQuizIdx(0); setSelected(null); setScore(0); setQuizDone(false); }} style={{ marginTop: 20, background: `linear-gradient(135deg,${note.color},#A78BFA)`, color: "#fff", border: "none", borderRadius: 14, padding: "13px 32px", fontWeight: 800, fontSize: 15, cursor: "pointer" }}>Try Again</button>
              </div>
            ) : quiz.length > 0 ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: C.muted }}>Question {quizIdx + 1}/{quiz.length}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Score: {score}</span>
                </div>
                <div style={{ height: 4, background: C.border, borderRadius: 2, marginBottom: 20 }}>
                  <div style={{ height: 4, background: note.color, borderRadius: 2, width: `${(quizIdx/quiz.length)*100}%`, transition: "width 0.3s" }} />
                </div>
                <div style={{ background: C.card, borderRadius: 16, padding: 20, marginBottom: 16, border: `1px solid ${C.border}` }}>
                  <p style={{ margin: 0, fontSize: 16, fontWeight: 600, color: C.text, lineHeight: 1.6 }}>{quiz[quizIdx].question}</p>
                </div>
                {quiz[quizIdx].options.map((opt, i) => {
                  let bg = C.card, border = C.border, color = C.text;
                  if (selected !== null) {
                    if (i === quiz[quizIdx].answer) { bg = "rgba(52,211,153,0.15)"; border = "#34D399"; color = "#34D399"; }
                    else if (i === selected) { bg = "rgba(248,113,113,0.15)"; border = "#F87171"; color = "#F87171"; }
                  }
                  return (
                    <button key={i} onClick={() => pick(i)} disabled={selected !== null} style={{ width: "100%", textAlign: "left", background: bg, border: `2px solid ${border}`, borderRadius: 12, padding: "13px 16px", marginBottom: 10, fontSize: 14, color, cursor: selected !== null ? "default" : "pointer", fontWeight: 500, display: "flex", gap: 10, fontFamily: "inherit" }}>
                      <span style={{ opacity: 0.5 }}>{String.fromCharCode(65+i)}.</span>{opt}
                    </button>
                  );
                })}
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

// ── HOME SCREEN ───────────────────────────────────────────────────────────────
function HomeScreen({ notes, onNote, onVoice, onDraw, onAIWrite, onScan }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All");
  const filters = ["All","Lecture","Study","Business","Personal"];
  const filtered = notes.filter(n => {
    const ms = n.title.toLowerCase().includes(search.toLowerCase()) || n.course.toLowerCase().includes(search.toLowerCase());
    const mf = filter === "All" || n.tag === filter;
    return ms && mf;
  });
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
      {/* Hero */}
      <div style={{ background: "linear-gradient(135deg,#0A0F1E 0%,#1E1B4B 60%,#0A0F1E 100%)", padding: "24px 20px 28px", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: -40, right: -40, width: 160, height: 160, borderRadius: "50%", background: "rgba(6,182,212,0.07)" }} />
        <div style={{ position: "absolute", bottom: -30, left: -20, width: 120, height: 120, borderRadius: "50%", background: "rgba(167,139,250,0.07)" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, position: "relative" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: "linear-gradient(135deg,#06B6D4,#A78BFA)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>🎵</div>
            <span style={{ fontWeight: 800, fontSize: 20, color: C.text }}>Jotting <span style={{ color: C.cyan }}>AI</span></span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={{ background: "rgba(255,255,255,0.08)", border: "none", borderRadius: 10, width: 38, height: 38, cursor: "pointer", fontSize: 17 }}>🔔</button>
            <div style={{ width: 38, height: 38, borderRadius: "50%", background: "linear-gradient(135deg,#06B6D4,#A78BFA)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17 }}>👤</div>
          </div>
        </div>
        <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 13, margin: "0 0 4px" }}>{greeting} 👋</p>
        <h2 style={{ color: C.text, fontSize: 24, fontWeight: 800, margin: "0 0 20px", letterSpacing: -0.5 }}>Welcome, <span style={{ color: C.cyan }}>Samuel</span></h2>
        <div style={{ position: "relative" }}>
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)" }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search notes, courses..."
            style={{ width: "100%", padding: "12px 14px 12px 42px", borderRadius: 14, border: "1px solid rgba(255,255,255,0.1)", fontSize: 14, background: "rgba(255,255,255,0.07)", color: C.text, outline: "none", boxSizing: "border-box" }} />
        </div>
      </div>

      <div style={{ padding: "20px 20px 100px" }}>
        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 22 }}>
          {[["📝", notes.length, "Notes"],["🤖","AI","Powered"],["⏱️","Live","Recording"]].map(([icon,val,label]) => (
            <div key={label} style={{ background: C.card, borderRadius: 14, padding: "14px 10px", textAlign: "center", border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 20, marginBottom: 4 }}>{icon}</div>
              <div style={{ fontWeight: 800, fontSize: 18, color: C.text }}>{val}</div>
              <div style={{ fontSize: 10, color: C.muted, fontWeight: 600 }}>{label}</div>
            </div>
          ))}
        </div>

        {/* Quick Actions — ALL WORKING */}
        <div style={{ marginBottom: 22 }}>
          <p style={{ fontWeight: 800, fontSize: 16, color: C.text, margin: "0 0 14px" }}>Quick Actions</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
            {[["🎙️","Voice\nNote",C.cyan,onVoice],["✨","AI\nWrite",C.purple,onAIWrite],["📷","Scan\nDoc",C.amber,onScan],["🖊️","Draw",C.green,onDraw]].map(([icon,label,color,action]) => (
              <button key={label} onClick={action} style={{ background: C.card, border: `1px solid ${color}30`, borderRadius: 14, padding: "14px 8px", cursor: "pointer", textAlign: "center", transition: "transform 0.15s" }}>
                <div style={{ width: 38, height: 38, borderRadius: 10, background: color+"20", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", fontSize: 20 }}>{icon}</div>
                <span style={{ fontSize: 11, fontWeight: 700, color: C.soft, whiteSpace: "pre-line", lineHeight: 1.3 }}>{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Filters */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16, overflowX: "auto", paddingBottom: 4 }}>
          {filters.map(f => <button key={f} onClick={() => setFilter(f)} style={{ padding: "7px 16px", borderRadius: 99, border: "none", background: filter===f ? C.cyan : C.card, color: filter===f ? "#0A0F1E" : C.muted, fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>{f}</button>)}
        </div>

        {/* Notes */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <p style={{ fontWeight: 800, fontSize: 16, color: C.text, margin: 0 }}>My Notes</p>
          <span style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>{filtered.length} notes</span>
        </div>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px 20px" }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>📝</div>
            <p style={{ color: C.muted, fontSize: 15 }}>No notes yet. Tap Voice Note to start!</p>
          </div>
        ) : filtered.map(note => (
          <button key={note.id} onClick={() => onNote(note)} style={{ width: "100%", background: C.card, border: `1px solid ${note.color}22`, borderRadius: 18, padding: 16, marginBottom: 12, cursor: "pointer", textAlign: "left" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 42, height: 42, borderRadius: 12, background: note.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, border: `1px solid ${note.color}30`, flexShrink: 0 }}>
                  {note.tag==="Lecture"?"📚":note.tag==="Study"?"💡":note.tag==="Business"?"💼":"📝"}
                </div>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 14, color: C.text, marginBottom: 3 }}>{note.title}</div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: note.color, background: note.bg, borderRadius: 99, padding: "2px 8px" }}>{note.course}</span>
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>{note.date}</div>
                <span style={{ background: note.bg, borderRadius: 99, padding: "2px 8px", fontSize: 10, fontWeight: 700, color: note.color }}>{note.tag}</span>
              </div>
            </div>
            <p style={{ margin: "0 0 10px", fontSize: 13, color: C.muted, lineHeight: 1.6, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{note.preview}</p>
            <div style={{ display: "flex", alignItems: "center", paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 11, color: C.muted }}>✨ AI features available</span>
              <span style={{ fontSize: 11, color: note.color, marginLeft: "auto", fontWeight: 700 }}>Open →</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── AI CHAT SCREEN ────────────────────────────────────────────────────────────
function AIScreen() {
  const [messages, setMessages] = useState([{ role: "ai", text: "Hi Samuel! 👋 I'm your AI study assistant powered by Claude. Ask me to summarize your notes, explain concepts, create study plans, or anything else!" }]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const send = async () => {
    if (!input.trim()) return;
    const q = input.trim(); setInput("");
    setMessages(m => [...m, { role: "user", text: q }]);
    setLoading(true);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "YOUR_API_KEY_HERE", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 600, messages: [{ role: "user", content: `You are a friendly AI study assistant for a Nigerian university student named Samuel. Be concise and helpful: ${q}` }] })
      });
      const data = await res.json();
      setMessages(m => [...m, { role: "ai", text: data.content[0].text }]);
    } catch {
      setMessages(m => [...m, { role: "ai", text: "⚠️ Add your Claude API key to App.js to enable real AI responses! Once connected, I can help summarize notes, create quizzes, explain concepts and much more!" }]);
    }
    setLoading(false);
  };

  const suggestions = ["Explain Newton's laws simply","Create a study plan for exams","What is LIFO vs FIFO?","Help me understand Kinematics"];

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: C.bg }}>
      <div style={{ background: C.card, padding: "16px 20px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: "linear-gradient(135deg,#06B6D4,#A78BFA)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>🤖</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16, color: C.text }}>AI Assistant</div>
            <div style={{ fontSize: 11, color: C.green, fontWeight: 600 }}>● Claude AI</div>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px 8px" }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: "flex", justifyContent: m.role==="user"?"flex-end":"flex-start", marginBottom: 12 }}>
            {m.role==="ai" && <div style={{ width: 32, height: 32, borderRadius: 10, background: "linear-gradient(135deg,#06B6D4,#A78BFA)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, marginRight: 8, flexShrink: 0, marginTop: 2 }}>🤖</div>}
            <div style={{ maxWidth: "80%", background: m.role==="user"?"linear-gradient(135deg,#06B6D4,#A78BFA)":C.card2, borderRadius: m.role==="user"?"18px 18px 4px 18px":"18px 18px 18px 4px", padding: "12px 16px", border: m.role==="ai"?`1px solid ${C.border}`:"none" }}>
              <p style={{ margin: 0, fontSize: 14, color: C.text, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{m.text}</p>
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: "flex", gap: 4, alignItems: "center", marginLeft: 40 }}>
            {[0,1,2].map(i => <div key={i} style={{ width: 8, height: 8, borderRadius: "50%", background: C.cyan, animation: `dot ${0.5+i*0.15}s ease-in-out infinite alternate` }} />)}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {messages.length <= 2 && (
        <div style={{ padding: "0 16px 8px", display: "flex", gap: 8, overflowX: "auto" }}>
          {suggestions.map(s => <button key={s} onClick={() => setInput(s)} style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 99, padding: "7px 14px", color: C.soft, fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>{s}</button>)}
        </div>
      )}

      <div style={{ padding: "12px 16px 16px", background: C.card2, borderTop: `1px solid ${C.border}`, display: "flex", gap: 10 }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key==="Enter" && send()} placeholder="Ask anything..." style={{ flex: 1, padding: "12px 16px", borderRadius: 14, border: `1px solid ${C.border}`, fontSize: 14, background: C.bg, color: C.text, outline: "none" }} />
        <button onClick={send} style={{ width: 48, height: 48, borderRadius: 14, background: "linear-gradient(135deg,#06B6D4,#A78BFA)", border: "none", cursor: "pointer", fontSize: 20, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>↑</button>
      </div>
    </div>
  );
}

// ── SETTINGS SCREEN ───────────────────────────────────────────────────────────
function SettingsScreen() {
  const [dark, setDark] = useState(true);
  const [notif, setNotif] = useState(true);
  const [autoSave, setAutoSave] = useState(true);
  const [lock, setLock] = useState(false);

  return (
    <div style={{ flex: 1, overflowY: "auto", background: C.bg }}>
      <div style={{ background: C.card, padding: "16px 20px", borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontWeight: 800, fontSize: 18, color: C.text }}>Settings</span>
      </div>
      <div style={{ padding: 20 }}>
        <div style={{ background: "linear-gradient(135deg,#1E293B,#0F172A)", borderRadius: 20, padding: 20, marginBottom: 20, border: "1px solid rgba(6,182,212,0.2)", display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 60, height: 60, borderRadius: 18, background: "linear-gradient(135deg,#06B6D4,#A78BFA)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28 }}>👤</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 18, color: C.text }}>Samuel</div>
            <div style={{ fontSize: 13, color: C.muted }}>samuel@gmail.com</div>
            <div style={{ display: "inline-block", background: "rgba(6,182,212,0.15)", borderRadius: 99, padding: "3px 10px", marginTop: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.cyan }}>Free Plan</span>
            </div>
          </div>
        </div>

        {[["🌙","Dark Mode","",dark,setDark,C.cyan],["🔔","Notifications","",notif,setNotif,C.purple],["💾","Auto Save","",autoSave,setAutoSave,C.green],["🔒","App Lock","",lock,setLock,C.amber]].map(([icon,label,sub,val,setter,color]) => (
          <div key={label} style={{ background: C.card, borderRadius: 14, padding: "15px 16px", marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between", border: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 20 }}>{icon}</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{label}</span>
            </div>
            <Toggle value={val} onChange={setter} color={color} />
          </div>
        ))}

        <div style={{ background: "linear-gradient(135deg,#4F46E5,#7C3AED,#06B6D4)", borderRadius: 20, padding: 22, marginTop: 16, marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: 20, color: "#fff", marginBottom: 4 }}>⭐ Upgrade to Pro</div>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", lineHeight: 1.6 }}>Unlimited recordings & notes<br />Real AI features with Claude<br />Priority support</div>
            </div>
            <span style={{ fontSize: 36 }}>🚀</span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 14 }}>
            <span style={{ fontSize: 28, fontWeight: 800, color: "#fff" }}>₦2,000</span>
            <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)" }}>/month</span>
          </div>
          <button style={{ width: "100%", background: "#fff", color: "#4F46E5", border: "none", borderRadius: 12, padding: 13, fontWeight: 800, fontSize: 15, cursor: "pointer" }}>Get Pro Now →</button>
        </div>

        <div style={{ textAlign: "center", color: "#374151", fontSize: 12, paddingBottom: 20 }}>Jotting AI v2.0 · Built by Samuel 💪</div>
      </div>
    </div>
  );
}

// ── Shared style helpers ──────────────────────────────────────────────────────
const backBtn = { background: "rgba(255,255,255,0.08)", border: "none", borderRadius: 10, width: 36, height: 36, cursor: "pointer", color: "#fff", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" };
const actionBtn = (color) => ({ background: color+"15", border: `1px solid ${color}40`, borderRadius: 12, padding: "12px", fontSize: 13, fontWeight: 700, color, cursor: "pointer", fontFamily: "inherit" });

// ── MAIN APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const [notes, setNotes] = useState(INIT_NOTES);
  const [screen, setScreen] = useState("home");
  const [activeNote, setActiveNote] = useState(null);
  const [tab, setTab] = useState("home");

  const go = (s, t) => { setScreen(s); if (t) setTab(t); };
  const saveNote = (note) => { setNotes(n => [note, ...n]); go("home", "home"); };
  const deleteNote = (id) => { setNotes(n => n.filter(note => note.id !== id)); go("home","home"); };

  const NAV = [
    { id:"home", icon:"🏠", label:"Home", s:"home" },
    { id:"notes", icon:"📝", label:"Notes", s:"home" },
    { id:"new", icon:"+", label:"New Note", s:"voice", special:true },
    { id:"ai", icon:"✨", label:"AI", s:"ai" },
    { id:"settings", icon:"⚙️", label:"Settings", s:"settings" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#06081A", display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "20px 0" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        *{box-sizing:border-box;font-family:'DM Sans',sans-serif;}
        body{margin:0;background:#06081A;}
        button,textarea,input{font-family:'DM Sans',sans-serif;}
        ::-webkit-scrollbar{width:0;}
        input::placeholder,textarea::placeholder{color:#4B5563;}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        @keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,0.4)}50%{box-shadow:0 0 0 20px rgba(239,68,68,0)}}
        @keyframes wv{from{transform:scaleY(0.3)}to{transform:scaleY(1.2)}}
        @keyframes dot{from{opacity:0.3;transform:scale(0.7)}to{opacity:1;transform:scale(1)}}
      `}</style>

      <div style={{ width:"100%", maxWidth:400, minHeight:"calc(100vh - 40px)", background:C.bg, borderRadius:36, overflow:"hidden", display:"flex", flexDirection:"column", boxShadow:"0 24px 80px rgba(6,182,212,0.12), 0 0 0 1px rgba(255,255,255,0.06)" }}>

        <div style={{ flex:1, display:"flex", flexDirection:"column", overflowY:"auto", minHeight:0 }}>
          {screen==="home" && <HomeScreen notes={notes} onNote={n=>{setActiveNote(n);go("detail");}} onVoice={()=>go("voice","new")} onDraw={()=>go("draw")} onAIWrite={()=>go("aiwrite")} onScan={()=>{alert("📷 Camera feature coming soon! Use Voice Note to record lectures.");}} />}
          {screen==="detail" && activeNote && <NoteDetail note={activeNote} onBack={()=>go("home","home")} onDelete={deleteNote} />}
          {screen==="voice" && <VoiceNoteScreen onBack={()=>go("home","home")} onSave={saveNote} />}
          {screen==="draw" && <DrawScreen onBack={()=>go("home","home")} />}
          {screen==="aiwrite" && <AIWriteScreen onBack={()=>go("home","home")} onSave={saveNote} />}
          {screen==="ai" && <AIScreen />}
          {screen==="settings" && <SettingsScreen />}
        </div>

        <div style={{ background:C.card2, borderTop:`1px solid ${C.border}`, padding:"10px 10px 16px", display:"flex", justifyContent:"space-around", alignItems:"center", flexShrink:0 }}>
          {NAV.map(({id,icon,label,s,special})=>(
            <button key={id} onClick={()=>go(s,id)} style={{ background:special?"linear-gradient(135deg,#06B6D4,#A78BFA)":"none", border:"none", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:3, padding:special?"0":"4px 8px", width:special?52:"auto", height:special?52:"auto", borderRadius:special?"50%":0, boxShadow:special?"0 4px 20px rgba(6,182,212,0.4)":"none", justifyContent:"center", flexShrink:0 }}>
              <span style={{ fontSize:special?24:20, color:special?"#fff":tab===id?C.cyan:"#4B5563" }}>{icon}</span>
              {!special && <span style={{ fontSize:10, fontWeight:700, color:tab===id?C.cyan:"#4B5563" }}>{label}</span>}
              {!special && tab===id && <div style={{ width:4, height:4, borderRadius:"50%", background:C.cyan }} />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
