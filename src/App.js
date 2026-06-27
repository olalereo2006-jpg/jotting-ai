import { useState, useEffect, useRef, useCallback } from "react";

const C = {
  bg: "#0A0F1E", card: "#111827", card2: "#1E293B",
  border: "rgba(255,255,255,0.06)", cyan: "#06B6D4",
  purple: "#A78BFA", amber: "#F59E0B", green: "#34D399",
  red: "#F87171", text: "#F1F5F9", muted: "#64748B", soft: "#94A3B8",
};

const INIT_NOTES = [
  { id: 1, title: "Physics: Kinematics", course: "PHY 101", color: "#06B6D4", bg: "rgba(6,182,212,0.12)", date: "Today", tag: "Lecture", preview: "Kinematics is the study of motion. v = u + at is the fundamental equation.", content: "Kinematics is the study of motion without considering forces.\n\nKey Equations:\nv = u + at\ns = ut + half at squared\n\nVelocity is the rate of change of displacement.\nAcceleration is the rate of change of velocity." },
  { id: 2, title: "Data Structures", course: "COS 201", color: "#A78BFA", bg: "rgba(167,139,250,0.12)", date: "Yesterday", tag: "Study", preview: "Stack uses LIFO, Queue uses FIFO. Binary trees have at most 2 children.", content: "Stack - Last In First Out (LIFO)\nQueue - First In First Out (FIFO)\nLinked List - Dynamic memory allocation\nBinary Tree - At most 2 children per node" },
  { id: 3, title: "NoteWave Business Plan", course: "Personal", color: "#F59E0B", bg: "rgba(245,158,11,0.12)", date: "Jun 20", tag: "Business", preview: "AI note-taking app for students. Freemium model with Pro at 2000 per month.", content: "Product: AI-powered lecture note app\nTarget: Nigerian university students\nRevenue: Freemium\nPro: Unlimited plus AI features\nLaunch: Q3 2026" },
];

// Safe formula converter - no regex, just string replacement
const convertFormulas = (text) => {
  const rules = [
    ["v equals u plus a t", "v = u + at"],
    ["f equals m a", "F = ma"],
    ["e equals m c squared", "E = mc2"],
    ["plus or minus", "+-"],
    ["is equal to", "="],
    ["greater than or equal to", ">="],
    ["less than or equal to", "<="],
    ["greater than", ">"],
    ["less than", "<"],
    ["multiplied by", "x"],
    ["divided by", "/"],
    ["square root of", "sqrt"],
    ["squared", "^2"],
    ["cubed", "^3"],
    ["approximately", "~"],
    ["not equal", "!="],
    ["infinity", "inf"],
    ["therefore", ":."],
    ["percent", "%"],
    ["degrees", "deg"],
    ["alpha", "a"],
    ["beta", "B"],
    ["gamma", "y"],
    ["delta", "d"],
    ["theta", "0"],
    ["lambda", "A"],
    ["mu", "u"],
    ["pi", "3.14"],
    ["sigma", "E"],
    ["omega", "w"],
    ["phi", "p"],
    ["h two o", "H2O"],
    ["c o two", "CO2"],
    ["one half", "1/2"],
    ["sum of", "SUM"],
    ["integral of", "INT"],
  ];

  // Use safe symbol replacements
  const symbols = {
    "+-": "\u00b1",
    "x": "\u00d7",
    "sqrt": "\u221a",
    "^2": "\u00b2",
    "^3": "\u00b3",
    "~": "\u2248",
    "!=": "\u2260",
    "inf": "\u221e",
    ":.": "\u2234",
    ">=": "\u2265",
    "<=": "\u2264",
    "3.14": "\u03c0",
    "H2O": "H\u2082O",
    "CO2": "CO\u2082",
    "1/2": "\u00bd",
    "SUM": "\u03a3",
    "INT": "\u222b",
    "a": "\u03b1",
    "B": "\u03b2",
    "y": "\u03b3",
    "d": "\u03b4",
    "0": "\u03b8",
    "A": "\u03bb",
    "u": "\u03bc",
    "E": "\u03c3",
    "w": "\u03c9",
    "p": "\u03c6",
  };

  let result = text.toLowerCase();
  rules.forEach(([find, replace]) => {
    while (result.includes(find)) {
      result = result.split(find).join(symbols[replace] || replace);
    }
  });
  return result;
};

// Remove duplicate words safely
const removeDuplicates = (text) => {
  const words = text.trim().split(" ").filter(w => w.length > 0);
  const result = [];
  for (let i = 0; i < words.length; i++) {
    if (i < 3) { result.push(words[i]); continue; }
    const last3 = result.slice(-3).join(" ").toLowerCase();
    const current = words[i].toLowerCase();
    if (!last3.endsWith(current + " " + current) && !(result[result.length-1] || "").toLowerCase() === current) {
      result.push(words[i]);
    } else if ((result[result.length-1] || "").toLowerCase() !== current) {
      result.push(words[i]);
    }
  }
  return result.join(" ");
};

function Wave({ active, color, size }) {
  const c = color || "#06B6D4";
  const s = size || 1;
  const heights = [0.5,1,1.6,1,0.7,1.4,0.9,1.2,0.6,1.1,0.8];
  return (
    <div style={{ display:"flex", alignItems:"center", gap:2.5, height:20*s }}>
      {heights.map(function(h, i) {
        return (
          <div key={i} style={{
            width: 2.5*s,
            borderRadius: 99,
            background: active ? c : "#374151",
            height: active ? (h*16*s)+"px" : (3*s)+"px",
            transition: "height 0.3s ease",
            animation: active ? ("wv "+(0.35+i*0.07)+"s ease-in-out infinite alternate") : "none"
          }} />
        );
      })}
    </div>
  );
}

function Toggle({ value, onChange, color }) {
  const c = color || "#06B6D4";
  return (
    <div onClick={function(){ onChange(!value); }} style={{ width:46, height:26, borderRadius:13, background:value ? c : "#374151", cursor:"pointer", position:"relative", transition:"background 0.25s", flexShrink:0 }}>
      <div style={{ position:"absolute", top:3, left:value ? 23 : 3, width:20, height:20, borderRadius:"50%", background:"#fff", transition:"left 0.25s" }} />
    </div>
  );
}

const backBtn = { background:"rgba(255,255,255,0.08)", border:"none", borderRadius:10, width:36, height:36, cursor:"pointer", color:"#fff", fontSize:18, display:"flex", alignItems:"center", justifyContent:"center" };

function actionBtn(color) {
  return { background:color+"15", border:"1px solid "+color+"40", borderRadius:12, padding:"12px", fontSize:13, fontWeight:700, color:color, cursor:"pointer", fontFamily:"inherit" };
}

// VOICE RECORDING SCREEN
function VoiceNoteScreen({ onBack, onSave }) {
  const [mode, setMode] = useState("text");
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [title, setTitle] = useState("");
  const [courses, setCourses] = useState(["General"]);
  const [course, setCourse] = useState("General");
  const [status, setStatus] = useState("Tap microphone to start");
  const [showAddCourse, setShowAddCourse] = useState(false);
  const [newCourse, setNewCourse] = useState("");
  const [formulaMode, setFormulaMode] = useState(true);
  const [audioURL, setAudioURL] = useState(null);

  const recognitionRef = useRef(null);
  const timerRef = useRef(null);
  const finalRef = useRef("");
  const sessionBaseRef = useRef("");
  const isRecordingRef = useRef(false);
  const isPausedRef = useRef(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const restartTimerRef = useRef(null);

  const fmt = function(s) {
    return String(Math.floor(s/60)).padStart(2,"0") + ":" + String(s%60).padStart(2,"0");
  };

  function addCourse() {
    var c = newCourse.trim().toUpperCase();
    if (!c || courses.includes(c)) return;
    setCourses(function(p){ return [...p, c]; });
    setNewCourse(""); setShowAddCourse(false);
  }

  function removeCourse(c) {
    if (c === "General") return;
    setCourses(function(p){ return p.filter(function(x){ return x !== c; }); });
    if (course === c) setCourse("General");
  }

  const startVoiceToText = useCallback(function() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setStatus("Please use Chrome browser!"); return; }

    var recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = "en-US";

    sessionBaseRef.current = finalRef.current;
    var sessionText = "";

    recognition.onstart = function() { setStatus("Listening... speak clearly"); };

    recognition.onresult = function(e) {
      var newFinal = "";
      var interim = "";
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var text = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          var processed = formulaMode ? convertFormulas(text) : text;
          var trimmed = processed.trim();
          if (!sessionText.trim().endsWith(trimmed)) {
            newFinal += trimmed + " ";
          }
        } else {
          interim = formulaMode ? convertFormulas(text) : text;
        }
      }
      if (newFinal) {
        sessionText += newFinal;
        finalRef.current = sessionBaseRef.current + sessionText;
      }
      setTranscript(finalRef.current + interim);
    };

    recognition.onerror = function(e) {
      if (e.error === "no-speech" || e.error === "aborted") return;
      setStatus("Reconnecting...");
    };

    recognition.onend = function() {
      if (isRecordingRef.current && !isPausedRef.current) {
        restartTimerRef.current = setTimeout(function() {
          if (isRecordingRef.current && !isPausedRef.current) {
            sessionBaseRef.current = finalRef.current;
            sessionText = "";
            try { recognition.start(); } catch(err) {}
          }
        }, 500);
      } else {
        setStatus("Recording complete");
      }
    };

    recognitionRef.current = recognition;
    try { recognition.start(); } catch(err) {}
  }, [formulaMode]);

  async function startAudioRecording() {
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true } });
      audioChunksRef.current = [];
      var mr = new MediaRecorder(stream);
      mr.ondataavailable = function(e) { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.onstop = function() { var blob = new Blob(audioChunksRef.current, { type:"audio/webm" }); setAudioURL(URL.createObjectURL(blob)); stream.getTracks().forEach(function(t){ t.stop(); }); };
      mr.start(100); mediaRecorderRef.current = mr; setStatus("Audio recording in progress...");
    } catch(e) { setStatus("Microphone access denied!"); }
  }

  async function startRecording() {
    isRecordingRef.current = true; isPausedRef.current = false;
    setIsRecording(true); setIsPaused(false); setElapsed(0);
    timerRef.current = setInterval(function(){ setElapsed(function(e){ return e+1; }); }, 1000);
    if (mode === "text") { finalRef.current = ""; sessionBaseRef.current = ""; startVoiceToText(); }
    else { await startAudioRecording(); }
  }

  function pauseRecording() {
    isPausedRef.current = true; setIsPaused(true);
    clearInterval(timerRef.current); clearTimeout(restartTimerRef.current);
    if (mode === "text") { try { recognitionRef.current && recognitionRef.current.stop(); } catch(e) {} setStatus("Paused - tap Resume to continue"); }
    else { mediaRecorderRef.current && mediaRecorderRef.current.pause(); }
  }

  function resumeRecording() {
    isPausedRef.current = false; setIsPaused(false);
    timerRef.current = setInterval(function(){ setElapsed(function(e){ return e+1; }); }, 1000);
    if (mode === "text") { startVoiceToText(); setStatus("Resumed - listening..."); }
    else { mediaRecorderRef.current && mediaRecorderRef.current.resume(); }
  }

  function stopRecording() {
    isRecordingRef.current = false; isPausedRef.current = false;
    setIsRecording(false); setIsPaused(false);
    clearInterval(timerRef.current); clearTimeout(restartTimerRef.current);
    try { recognitionRef.current && recognitionRef.current.stop(); } catch(e) {}
    mediaRecorderRef.current && mediaRecorderRef.current.stop();
    setStatus("Recording complete");
  }

  useEffect(function() {
    return function() {
      clearInterval(timerRef.current);
      clearTimeout(restartTimerRef.current);
      isRecordingRef.current = false;
      try { recognitionRef.current && recognitionRef.current.stop(); } catch(e) {}
    };
  }, []);

  function saveNote() {
    if (mode === "text" && !transcript.trim()) { alert("Record something first!"); return; }
    onSave({ id:Date.now(), title:title||("Voice Note - "+new Date().toLocaleDateString()), course, color:"#06B6D4", bg:"rgba(6,182,212,0.12)", date:"Today", tag:"Lecture", preview:transcript.slice(0,100)||"Audio recording", content:transcript||"Audio recording saved." });
  }

  return (
    <div style={{ flex:1, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.card, padding:"16px 20px", display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800, fontSize:16, color:C.text }}>Voice Recording</span>
        <button onClick={saveNote} style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)", color:"#fff", border:"none", borderRadius:10, padding:"8px 18px", fontWeight:800, fontSize:14, cursor:"pointer" }}>Save</button>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:20 }}>
        <div style={{ display:"flex", background:C.card, borderRadius:14, padding:4, marginBottom:16 }}>
          {[["🎙️ Voice to Text","text"],["🔊 Audio Recording","audio"]].map(function(item) {
            return (
              <button key={item[1]} onClick={function(){ if (!isRecording) setMode(item[1]); }} style={{ flex:1, padding:"10px", borderRadius:11, border:"none", background:mode===item[1]?"linear-gradient(135deg,#06B6D4,#A78BFA)":"transparent", color:mode===item[1]?"#fff":C.muted, fontWeight:700, fontSize:13, cursor:isRecording?"not-allowed":"pointer" }}>{item[0]}</button>
            );
          })}
        </div>
        <input value={title} onChange={function(e){ setTitle(e.target.value); }} placeholder="Note title (optional)..." style={{ width:"100%", padding:"13px 16px", borderRadius:12, border:"1px solid "+C.border, fontSize:15, fontWeight:700, background:C.card, color:C.text, outline:"none", marginBottom:14, boxSizing:"border-box" }} />
        <div style={{ marginBottom:16 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
            <span style={{ fontSize:13, fontWeight:700, color:C.soft }}>Select Course</span>
            <button onClick={function(){ setShowAddCourse(function(s){ return !s; }); }} style={{ background:C.cyan+"20", border:"1px solid "+C.cyan+"40", borderRadius:8, padding:"5px 12px", color:C.cyan, fontSize:12, fontWeight:700, cursor:"pointer" }}>+ Add Course</button>
          </div>
          {showAddCourse && (
            <div style={{ background:C.card2, borderRadius:14, padding:14, marginBottom:12, border:"1px solid "+C.cyan+"30" }}>
              <div style={{ display:"flex", gap:8 }}>
                <input value={newCourse} onChange={function(e){ setNewCourse(e.target.value); }} onKeyDown={function(e){ if(e.key==="Enter") addCourse(); }} placeholder="e.g. BIO 201" style={{ flex:1, padding:"10px 14px", borderRadius:10, border:"1px solid "+C.border, background:C.bg, color:C.text, outline:"none", fontSize:14 }} />
                <button onClick={addCourse} style={{ background:C.cyan, border:"none", borderRadius:10, padding:"10px 16px", color:"#0A0F1E", fontWeight:800, cursor:"pointer" }}>Add</button>
                <button onClick={function(){ setShowAddCourse(false); }} style={{ background:C.card, border:"1px solid "+C.border, borderRadius:10, padding:"10px 12px", color:C.muted, cursor:"pointer" }}>X</button>
              </div>
            </div>
          )}
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            {courses.map(function(c) {
              return (
                <div key={c} style={{ display:"flex" }}>
                  <button onClick={function(){ setCourse(c); }} style={{ padding:"7px 14px", borderRadius:c==="General"?99:"99px 0 0 99px", border:"2px solid", borderColor:course===c?C.cyan:C.border, borderRight:c!=="General"?"none":undefined, background:course===c?C.cyan:C.card, color:course===c?"#0A0F1E":C.muted, fontSize:12, fontWeight:700, cursor:"pointer" }}>{c}</button>
                  {c !== "General" && <button onClick={function(){ removeCourse(c); }} style={{ padding:"7px 8px", borderRadius:"0 99px 99px 0", border:"2px solid", borderColor:course===c?C.cyan:C.border, borderLeft:"none", background:course===c?C.cyan:C.card, color:C.red, fontSize:11, cursor:"pointer" }}>X</button>}
                </div>
              );
            })}
          </div>
        </div>
        {mode === "text" && (
          <div style={{ background:C.card, borderRadius:14, padding:"12px 16px", marginBottom:16, display:"flex", justifyContent:"space-between", alignItems:"center", border:"1px solid "+C.border }}>
            <div>
              <div style={{ fontWeight:700, fontSize:14, color:C.text }}>Formula Recognition</div>
              <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>Say "pi", "equals", "squared" and it writes the symbol</div>
            </div>
            <Toggle value={formulaMode} onChange={setFormulaMode} color={C.purple} />
          </div>
        )}
        <div style={{ background:C.card, borderRadius:24, padding:"28px 20px", border:"2px solid "+(isRecording&&!isPaused?C.red:isPaused?C.amber:C.border), marginBottom:16, textAlign:"center", transition:"border-color 0.3s" }}>
          <div onClick={!isRecording?startRecording:undefined} style={{ width:110, height:110, borderRadius:"50%", background:isRecording?(isPaused?"linear-gradient(135deg,"+C.amber+",#F59E0B)":"linear-gradient(135deg,#EF4444,#F87171)"):"linear-gradient(135deg,#06B6D4,#A78BFA)", display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 20px", cursor:!isRecording?"pointer":"default", fontSize:46, boxShadow:isRecording&&!isPaused?"0 0 0 14px rgba(239,68,68,0.12)":"0 8px 32px rgba(6,182,212,0.35)", transition:"all 0.3s", animation:isRecording&&!isPaused?"pulse 1.5s ease-in-out infinite":"none" }}>
            {isPaused?"⏸":"🎙️"}
          </div>
          {isRecording && <div style={{ fontSize:36, fontWeight:800, color:isPaused?C.amber:C.red, marginBottom:12, fontFamily:"monospace", letterSpacing:2 }}>{fmt(elapsed)}</div>}
          <div style={{ display:"flex", justifyContent:"center", marginBottom:14 }}>
            <Wave active={isRecording&&!isPaused} color={isRecording&&!isPaused?"#EF4444":C.cyan} size={1.6} />
          </div>
          <p style={{ color:isRecording?(isPaused?C.amber:C.red):C.muted, fontSize:14, fontWeight:600, margin:"0 0 20px" }}>{status}</p>
          <div style={{ display:"flex", gap:10, justifyContent:"center", flexWrap:"wrap" }}>
            {!isRecording ? (
              <button onClick={startRecording} style={{ background:"linear-gradient(135deg,#EF4444,#F87171)", color:"#fff", border:"none", borderRadius:14, padding:"13px 32px", fontWeight:800, fontSize:15, cursor:"pointer" }}>Start Recording</button>
            ) : (
              <div style={{ display:"flex", gap:10 }}>
                {!isPaused
                  ? <button onClick={pauseRecording} style={{ background:C.amber, color:"#0A0F1E", border:"none", borderRadius:14, padding:"13px 24px", fontWeight:800, fontSize:14, cursor:"pointer" }}>Pause</button>
                  : <button onClick={resumeRecording} style={{ background:C.green, color:"#0A0F1E", border:"none", borderRadius:14, padding:"13px 24px", fontWeight:800, fontSize:14, cursor:"pointer" }}>Resume</button>
                }
                <button onClick={stopRecording} style={{ background:"rgba(248,113,113,0.15)", color:C.red, border:"2px solid "+C.red+"40", borderRadius:14, padding:"13px 24px", fontWeight:800, fontSize:14, cursor:"pointer" }}>Stop</button>
              </div>
            )}
          </div>
        </div>
        {mode==="audio" && audioURL && (
          <div style={{ background:C.card, borderRadius:16, padding:16, marginBottom:16, border:"1px solid "+C.border }}>
            <div style={{ fontWeight:700, fontSize:14, color:C.green, marginBottom:10 }}>Recording Saved</div>
            <audio controls src={audioURL} style={{ width:"100%", borderRadius:8 }} />
            <a href={audioURL} download="recording.webm" style={{ display:"block", marginTop:10, textAlign:"center", background:C.card2, borderRadius:10, padding:"9px", color:C.cyan, fontWeight:700, fontSize:13, textDecoration:"none" }}>Download Audio</a>
          </div>
        )}
        {mode==="text" && (
          <div style={{ background:C.card, borderRadius:16, padding:20, border:"1px solid "+(transcript?C.cyan+"40":C.border) }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
              <span style={{ fontWeight:700, fontSize:14, color:C.cyan }}>Transcript</span>
              <div style={{ display:"flex", gap:8 }}>
                {transcript && <button onClick={function(){ finalRef.current=""; sessionBaseRef.current=""; setTranscript(""); }} style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:12, fontWeight:600 }}>Clear</button>}
                {transcript && <button onClick={function(){ navigator.clipboard && navigator.clipboard.writeText(transcript); }} style={{ background:C.card2, border:"none", borderRadius:8, padding:"4px 10px", color:C.cyan, cursor:"pointer", fontSize:12, fontWeight:600 }}>Copy</button>}
              </div>
            </div>
            <textarea value={transcript} onChange={function(e){ setTranscript(e.target.value); finalRef.current=e.target.value; sessionBaseRef.current=e.target.value; }} placeholder={isRecording?"Listening... your words appear here":"Tap microphone to start recording"} style={{ width:"100%", minHeight:180, background:"transparent", border:"none", color:transcript?C.text:C.muted, fontSize:14, lineHeight:1.9, outline:"none", resize:"none", fontFamily:"inherit", boxSizing:"border-box" }} />
            {transcript && (
              <div style={{ marginTop:8, paddingTop:10, borderTop:"1px solid "+C.border, display:"flex", justifyContent:"space-between" }}>
                <span style={{ fontSize:11, color:C.muted }}>{transcript.split(" ").filter(function(w){ return w; }).length} words</span>
                <span style={{ fontSize:11, color:C.muted }}>{transcript.length} chars</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// DRAW SCREEN
function DrawScreen({ onBack }) {
  const canvasRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [color, setColor] = useState("#06B6D4");
  const [size, setSize] = useState(4);
  const [tool, setTool] = useState("pen");
  const colors = ["#06B6D4","#A78BFA","#F59E0B","#34D399","#F87171","#fff"];

  function getPos(e, c) {
    var rect = c.getBoundingClientRect();
    var src = e.touches ? e.touches[0] : e;
    return { x:(src.clientX-rect.left)*(c.width/rect.width), y:(src.clientY-rect.top)*(c.height/rect.height) };
  }
  function startDraw(e) { e.preventDefault(); var c=canvasRef.current; var ctx=c.getContext("2d"); var p=getPos(e,c); ctx.beginPath(); ctx.moveTo(p.x,p.y); setDrawing(true); }
  function draw(e) { e.preventDefault(); if (!drawing) return; var c=canvasRef.current; var ctx=c.getContext("2d"); var p=getPos(e,c); ctx.globalCompositeOperation=tool==="eraser"?"destination-out":"source-over"; ctx.strokeStyle=color; ctx.lineWidth=tool==="eraser"?28:size; ctx.lineCap="round"; ctx.lineJoin="round"; ctx.lineTo(p.x,p.y); ctx.stroke(); }
  function saveDrawing() { var c=canvasRef.current; var l=document.createElement("a"); l.download="drawing.png"; l.href=c.toDataURL(); l.click(); }

  return (
    <div style={{ flex:1, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.card, padding:"16px 20px", display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800, fontSize:16, color:C.text }}>Draw</span>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={function(){ var c=canvasRef.current; c.getContext("2d").clearRect(0,0,c.width,c.height); }} style={{ background:C.card2, border:"none", borderRadius:8, padding:"7px 12px", color:C.muted, fontSize:12, fontWeight:700, cursor:"pointer" }}>Clear</button>
          <button onClick={saveDrawing} style={{ background:"linear-gradient(135deg,#06B6D4,#A78BFA)", border:"none", borderRadius:8, padding:"7px 12px", color:"#fff", fontSize:12, fontWeight:700, cursor:"pointer" }}>Save</button>
        </div>
      </div>
      <div style={{ background:C.card, padding:"12px 16px", display:"flex", alignItems:"center", gap:10, borderBottom:"1px solid "+C.border, flexWrap:"wrap" }}>
        <div style={{ display:"flex", gap:6 }}>
          {colors.map(function(c) {
            return <button key={c} onClick={function(){ setColor(c); setTool("pen"); }} style={{ width:26, height:26, borderRadius:"50%", background:c, border:color===c&&tool!=="eraser"?"3px solid #fff":"2px solid rgba(255,255,255,0.15)", cursor:"pointer" }} />;
          })}
        </div>
        <div style={{ display:"flex", gap:6, marginLeft:"auto" }}>
          {[["pen","✏️"],["eraser","⭕"]].map(function(item) {
            return <button key={item[0]} onClick={function(){ setTool(item[0]); }} style={{ background:tool===item[0]?C.cyan:C.card2, border:"none", borderRadius:8, padding:"6px 10px", cursor:"pointer", fontSize:16 }}>{item[1]}</button>;
          })}
        </div>
        <input type="range" min="2" max="24" value={size} onChange={function(e){ setSize(Number(e.target.value)); }} style={{ width:80, accentColor:C.cyan }} />
      </div>
      <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", background:"#06081A", padding:10 }}>
        <canvas ref={canvasRef} width={360} height={500} style={{ background:"#111827", borderRadius:16, border:"1px solid "+C.border, cursor:tool==="eraser"?"cell":"crosshair", touchAction:"none", maxWidth:"100%" }}
          onMouseDown={startDraw} onMouseMove={draw} onMouseUp={function(){ setDrawing(false); }} onMouseLeave={function(){ setDrawing(false); }}
          onTouchStart={startDraw} onTouchMove={draw} onTouchEnd={function(){ setDrawing(false); }} />
      </div>
    </div>
  );
}

// AI WRITE SCREEN
function AIWriteScreen({ onBack, onSave }) {
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [course, setCourse] = useState("General");
  const courses = ["General","PHY 101","MTH 101","COS 102","ENG 201","CHM 102"];
  const suggestions = ["Summarize Newton laws of motion","Write notes on Data Structures","Explain Organic Chemistry basics","Create outline for Kinematics"];

  async function generate(text) {
    var q = text || prompt; if (!q.trim()) return;
    setLoading(true); setResult("");
    try {
      var res = await fetch("https://api.anthropic.com/v1/messages", { method:"POST", headers:{"Content-Type":"application/json","x-api-key":"YOUR_API_KEY_HERE","anthropic-version":"2023-06-01"}, body:JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:800, messages:[{role:"user",content:"Write clear structured student notes with bullet points and headers for: "+q}] }) });
      var data = await res.json();
      setResult(data.content[0].text);
    } catch(e) {
      setResult("Notes on: "+q+"\n\nKey Point 1: Important definition\nKey Point 2: Another important point\nKey Point 3: Related information\n\nAdd Claude API key for real AI notes!");
    }
    setLoading(false);
  }

  return (
    <div style={{ flex:1, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.card, padding:"16px 20px", display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom:"1px solid "+C.border }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800, fontSize:16, color:C.text }}>AI Write</span>
        {result && <button onClick={function(){ onSave({ id:Date.now(), title:prompt.slice(0,40)||"AI Note", course, color:"#A78BFA", bg:"rgba(167,139,250,0.12)", date:"Today", tag:"Study", preview:result.slice(0,100), content:result }); }} style={{ background:"linear-gradient(135deg,#A78BFA,#06B6D4)", color:"#fff", border:"none", borderRadius:10, padding:"8px 16px", fontWeight:800, fontSize:13, cursor:"pointer" }}>Save</button>}
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:20 }}>
        <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap" }}>
          {courses.map(function(c) {
            return <button key={c} onClick={function(){ setCourse(c); }} style={{ padding:"6px 14px", borderRadius:99, border:"2px solid", borderColor:course===c?C.purple:C.border, background:course===c?C.purple:C.card, color:course===c?"#0A0F1E":C.muted, fontSize:12, fontWeight:700, cursor:"pointer" }}>{c}</button>;
          })}
        </div>
        <div style={{ display:"flex", gap:10, marginBottom:16 }}>
          <input value={prompt} onChange={function(e){ setPrompt(e.target.value); }} onKeyDown={function(e){ if(e.key==="Enter") generate(); }} placeholder="What should I write notes about?" style={{ flex:1, padding:"13px 16px", borderRadius:14, border:"1px solid "+C.border, fontSize:14, background:C.card, color:C.text, outline:"none" }} />
          <button onClick={function(){ generate(); }} disabled={loading} style={{ width:48, height:48, borderRadius:14, background:"linear-gradient(135deg,#A78BFA,#06B6D4)", border:"none", cursor:"pointer", fontSize:20, flexShrink:0 }}>✨</button>
        </div>
        {!result && !loading && suggestions.map(function(s) {
          return <button key={s} onClick={function(){ setPrompt(s); generate(s); }} style={{ width:"100%", textAlign:"left", background:C.card, border:"1px solid "+C.border, borderRadius:12, padding:"12px 16px", color:C.soft, fontSize:13, cursor:"pointer", marginBottom:8, fontFamily:"inherit" }}>{s}</button>;
        })}
        {loading && <div style={{ textAlign:"center", padding:"40px 20px" }}><div style={{ fontSize:48, animation:"spin 2s linear infinite" }}>✨</div><p style={{ color:C.muted }}>Writing your notes...</p></div>}
        {result && <div style={{ background:C.card, borderRadius:16, padding:20, border:"1px solid "+C.border }}><textarea value={result} onChange={function(e){ setResult(e.target.value); }} style={{ width:"100%", minHeight:280, background:"transparent", border:"none", color:C.text, fontSize:14, lineHeight:1.9, outline:"none", resize:"none", fontFamily:"inherit", boxSizing:"border-box" }} /></div>}
      </div>
    </div>
  );
}

// NOTE DETAIL SCREEN
function NoteDetail({ note, onBack, onDelete }) {
  const [view, setView] = useState("note");
  const [summary, setSummary] = useState(null);
  const [quiz, setQuiz] = useState([]);
  const [quizIdx, setQuizIdx] = useState(0);
  const [selected, setSelected] = useState(null);
  const [score, setScore] = useState(0);
  const [quizDone, setQuizDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function callAI(prompt) {
    var res = await fetch("https://api.anthropic.com/v1/messages", { method:"POST", headers:{"Content-Type":"application/json","x-api-key":"YOUR_API_KEY_HERE","anthropic-version":"2023-06-01"}, body:JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:800, messages:[{role:"user",content:prompt}] }) });
    var data = await res.json();
    return data.content[0].text;
  }

  async function generateSummary() {
    setLoading(true); setView("summary");
    try {
      var raw = await callAI("Summarize these notes. Return ONLY JSON: {\"summary\":\"...\",\"keyPoints\":[\"...\"],\"tags\":[\"...\"]} NOTES: "+note.content);
      setSummary(JSON.parse(raw.split("```json").join("").split("```").join("").trim()));
    } catch(e) {
      setSummary({ summary:"This covers "+note.title+". Review the key concepts.", keyPoints:["Review definitions","Practice problems","Connect concepts"], tags:[note.course,note.tag] });
    }
    setLoading(false);
  }

  async function generateQuiz() {
    setLoading(true); setView("quiz");
    try {
      var raw = await callAI("Create 5 MCQ from these notes. Return ONLY JSON array: [{\"question\":\"...\",\"options\":[\"A\",\"B\",\"C\",\"D\"],\"answer\":0}] NOTES: "+note.content);
      var q = JSON.parse(raw.split("```json").join("").split("```").join("").trim());
      setQuiz(q); setQuizIdx(0); setSelected(null); setScore(0); setQuizDone(false);
    } catch(e) {
      setQuiz([{ question:"What is the main topic of "+note.title+"?", options:[note.course,"History","Math","Art"], answer:0 }]);
    }
    setLoading(false);
  }

  function pick(i) {
    if (selected !== null) return;
    setSelected(i);
    if (i === quiz[quizIdx].answer) setScore(function(s){ return s+1; });
    setTimeout(function() {
      if (quizIdx+1 < quiz.length) { setQuizIdx(function(q){ return q+1; }); setSelected(null); }
      else setQuizDone(true);
    }, 900);
  }

  function shareNote() {
    if (navigator.share) { navigator.share({ title:note.title, text:note.content }); }
    else { navigator.clipboard && navigator.clipboard.writeText(note.content); alert("Copied!"); }
  }

  return (
    <div style={{ flex:1, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ background:C.card, padding:"16px 20px", display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom:"1px solid "+C.border, position:"sticky", top:0, zIndex:10 }}>
        <button onClick={onBack} style={backBtn}>←</button>
        <span style={{ fontWeight:800, fontSize:15, color:C.text, maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{note.title}</span>
        <div style={{ display:"flex", gap:6 }}>
          <button onClick={shareNote} style={{ background:C.card2, border:"none", borderRadius:8, width:32, height:32, cursor:"pointer", fontSize:14, display:"flex", alignItems:"center", justifyContent:"center" }}>📤</button>
          <button onClick={function(){ onDelete(note.id); }} style={{ background:"rgba(248,113,113,0.12)", border:"none", borderRadius:8, width:32, height:32, cursor:"pointer", fontSize:14, display:"flex", alignItems:"center", justifyContent:"center" }}>🗑</button>
        </div>
      </div>
      <div style={{ background:C.card, padding:"0 20px 12px", display:"flex", gap:6, borderBottom:"1px solid "+C.border }}>
        {[["📝","note","Note"],["📋","summary","Summary"],["🧠","quiz","Quiz"]].map(function(item) {
          return (
            <button key={item[1]} onClick={function(){ setView(item[1]); if(item[1]==="summary"&&!summary) generateSummary(); if(item[1]==="quiz"&&quiz.length===0) generateQuiz(); }} style={{ padding:"7px 16px", borderRadius:99, border:"none", background:view===item[1]?note.color:C.card2, color:view===item[1]?"#0A0F1E":C.muted, fontSize:13, fontWeight:700, cursor:"pointer", marginTop:12 }}>{item[0]+" "+item[2]}</button>
          );
        })}
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:20 }}>
        {view==="note" && (
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:16 }}>
              <span style={{ fontSize:11, fontWeight:700, color:note.color, background:note.bg, borderRadius:99, padding:"3px 12px" }}>{note.course}</span>
              <span style={{ fontSize:11, color:C.muted }}>{note.date}</span>
            </div>
            <div style={{ background:C.card, borderRadius:18, padding:20, border:"1px solid "+C.border, marginBottom:16 }}>
              <h2 style={{ color:C.text, fontSize:20, fontWeight:800, margin:"0 0 12px" }}>{note.title}</h2>
              <div style={{ width:40, height:3, background:note.color, borderRadius:2, marginBottom:16 }} />
              <p style={{ margin:0, fontSize:14, color:"#CBD5E1", lineHeight:1.9, whiteSpace:"pre-line" }}>{note.content}</p>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              <button onClick={function(){ setView("summary"); if (!summary) generateSummary(); }} style={actionBtn(note.color)}>📋 AI Summary</button>
              <button onClick={function(){ setView("quiz"); if (quiz.length===0) generateQuiz(); }} style={actionBtn(C.purple)}>🧠 Quiz Me</button>
            </div>
          </div>
        )}
        {view==="summary" && (
          loading
            ? <div style={{ textAlign:"center", padding:"60px 20px" }}><div style={{ fontSize:48, animation:"spin 2s linear infinite" }}>✨</div><p style={{ color:C.muted, marginTop:16 }}>Generating summary...</p></div>
            : summary ? (
              <div>
                <div style={{ background:C.card, borderRadius:16, padding:20, border:"1px solid "+C.border, marginBottom:14 }}>
                  <div style={{ fontSize:11, fontWeight:700, color:C.green, letterSpacing:1, marginBottom:10 }}>OVERVIEW</div>
                  <p style={{ margin:0, fontSize:14, color:"#CBD5E1", lineHeight:1.8 }}>{summary.summary}</p>
                </div>
                <div style={{ background:C.card, borderRadius:16, padding:20, border:"1px solid "+C.border, marginBottom:14 }}>
                  <div style={{ fontSize:11, fontWeight:700, color:C.amber, letterSpacing:1, marginBottom:12 }}>KEY POINTS</div>
                  {summary.keyPoints && summary.keyPoints.map(function(p, i) {
                    return <div key={i} style={{ display:"flex", gap:10, marginBottom:10 }}><div style={{ width:6, height:6, borderRadius:3, background:C.amber, marginTop:7, flexShrink:0 }} /><p style={{ margin:0, fontSize:14, color:"#CBD5E1", lineHeight:1.7 }}>{p}</p></div>;
                  })}
                </div>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                  {summary.tags && summary.tags.map(function(t) {
                    return <span key={t} style={{ background:C.card2, color:C.cyan, borderRadius:99, padding:"4px 14px", fontSize:12, fontWeight:700 }}>{t}</span>;
                  })}
                </div>
              </div>
            ) : null
        )}
        {view==="quiz" && (
          loading
            ? <div style={{ textAlign:"center", padding:"60px 20px" }}><div style={{ fontSize:48, animation:"spin 2s linear infinite" }}>🧠</div><p style={{ color:C.muted, marginTop:16 }}>Generating quiz...</p></div>
            : quizDone ? (
              <div style={{ textAlign:"center", padding:"40px 20px" }}>
                <div style={{ fontSize:64, marginBottom:16 }}>{score===quiz.length?"🏆":"📖"}</div>
                <div style={{ fontSize:40, fontWeight:800, color:C.text }}>{score}/{quiz.length}</div>
                <p style={{ color:C.muted, marginTop:8 }}>{score===quiz.length?"Perfect! 🔥":"Keep studying! 💪"}</p>
                <button onClick={function(){ setQuizIdx(0); setSelected(null); setScore(0); setQuizDone(false); }} style={{ marginTop:20, background:"linear-gradient(135deg,"+note.color+",#A78BFA)", color:"#fff", border:"none", borderRadius:14, padding:"13px 32px", fontWeight:800, fontSize:15, cursor:"pointer" }}>Try Again</button>
              </div>
            ) : quiz.length > 0 ? (
              <div>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                  <span style={{ fontSize:13, color:C.muted }}>Question {quizIdx+1}/{quiz.length}</span>
                  <span style={{ fontSize:13, fontWeight:700, color:C.text }}>Score: {score}</span>
                </div>
                <div style={{ height:4, background:C.border, borderRadius:2, marginBottom:20 }}>
                  <div style={{ height:4, background:note.color, borderRadius:2, width:(quizIdx/quiz.length*100)+"%", transition:"width 0.3s" }} />
                </div>
                <div style={{ background:C.card, borderRadius:16, padding:20, marginBottom:16, border:"1px solid "+C.border }}>
                  <p style={{ margin:0, fontSize:16, fontWeight:600, color:C.text, lineHeight:1.6 }}>{quiz[quizIdx].question}</p>
                </div>
                {quiz[quizIdx].options.map(function(opt, i) {
                  var bg = C.card; var border = C.border; var color = C.text;
                  if (selected !== null) {
                    if (i === quiz[quizIdx].answer) { bg="rgba(52,211,153,0.15)"; border="#34D399"; color="#34D399"; }
                    else if (i === selected) { bg="rgba(248,113,113,0.15)"; border="#F87171"; color="#F87171"; }
                  }
                  return <button key={i} onClick={function(){ pick(i); }} disabled={selected!==null} style={{ width:"100%", textAlign:"left", background:bg, border:"2px solid "+border, borderRadius:12, padding:"13px 16px", marginBottom:10, fontSize:14, color:color, cursor:selected!==null?"default":"pointer", fontWeight:500, display:"flex", gap:10, fontFamily:"inherit" }}><span style={{ opacity:0.5 }}>{String.fromCharCode(65+i)}.</span>{opt}</button>;
                })}
              </div>
            ) : null
        )}
      </div>
    </div>
  );
}

// HOME SCREEN
function HomeScreen({ notes, onNote, onVoice, onDraw, onAIWrite, onScan }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All");
  const filters = ["All","Lecture","Study","Business","Personal"];
  const filtered = notes.filter(function(n) {
    var ms = n.title.toLowerCase().includes(search.toLowerCase()) || n.course.toLowerCase().includes(search.toLowerCase());
    var mf = filter==="All" || n.tag===filter;
    return ms && mf;
  });
  var hour = new Date().getHours();
  var greeting = hour<12?"Good morning":hour<17?"Good afternoon":"Good evening";
  return (
    <div style={{ flex:1, overflowY:"auto" }}>
      <div style={{ background:"linear-gradient(135deg,#0A0F1E 0%,#1E1B4B 60%,#0A0F1E 100%)", padding:"24px 20px 28px", position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", top:-40, right:-40, width:160, height:160, borderRadius:"50%", background:"rgba(6,182,212,0.07)" }} />
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20, position:"relative" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:40, height:40, borderRadius:12, background:"linear-gradient(135deg,#06B6D4,#A78BFA)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>🎵</div>
            <span style={{ fontWeight:800, fontSize:20, color:C.text }}>Jotting <span style={{ color:C.cyan }}>AI</span></span>
          </div>
          <div style={{ display:"flex", gap:8 }}>
            <button style={{ background:"rgba(255,255,255,0.08)", border:"none", borderRadius:10, width:38, height:38, cursor:"pointer", fontSize:17 }}>🔔</button>
            <div style={{ width:38, height:38, borderRadius:"50%", background:"linear-gradient(135deg,#06B6D4,#A78BFA)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:17 }}>👤</div>
          </div>
        </div>
        <p style={{ color:"rgba(255,255,255,0.45)", fontSize:13, margin:"0 0 4px" }}>{greeting} 👋</p>
        <h2 style={{ color:C.text, fontSize:24, fontWeight:800, margin:"0 0 20px", letterSpacing:-0.5 }}>Welcome, <span style={{ color:C.cyan }}>Samuel</span></h2>
        <div style={{ position:"relative" }}>
          <span style={{ position:"absolute", left:14, top:"50%", transform:"translateY(-50%)" }}>🔍</span>
          <input value={search} onChange={function(e){ setSearch(e.target.value); }} placeholder="Search notes, courses..." style={{ width:"100%", padding:"12px 14px 12px 42px", borderRadius:14, border:"1px solid rgba(255,255,255,0.1)", fontSize:14, background:"rgba(255,255,255,0.07)", color:C.text, outline:"none", boxSizing:"border-box" }} />
        </div>
      </div>
      <div style={{ padding:"20px 20px 100px" }}>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:22 }}>
          {[["📝",notes.length,"Notes"],["🤖","AI","Powered"],["⏱","Live","Recording"]].map(function(item) {
            return (
              <div key={item[2]} style={{ background:C.card, borderRadius:14, padding:"14px 10px", textAlign:"center", border:"1px solid "+C.border }}>
                <div style={{ fontSize:20, marginBottom:4 }}>{item[0]}</div>
                <div style={{ fontWeight:800, fontSize:18, color:C.text }}>{item[1]}</div>
                <div style={{ fontSize:10, color:C.muted, fontWeight:600 }}>{item[2]}</div>
              </div>
            );
          })}
        </div>
        <div style={{ marginBottom:22 }}>
          <p style={{ fontWeight:800, fontSize:16, color:C.text, margin:"0 0 14px" }}>Quick Actions</p>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:10 }}>
            {[["🎙️","Voice\nNote",C.cyan,onVoice],["✨","AI\nWrite",C.purple,onAIWrite],["📷","Scan\nDoc",C.amber,onScan],["🖊️","Draw",C.green,onDraw]].map(function(item) {
              return (
                <button key={item[1]} onClick={item[3]} style={{ background:C.card, border:"1px solid "+item[2]+"30", borderRadius:14, padding:"14px 8px", cursor:"pointer", textAlign:"center" }}>
                  <div style={{ width:38, height:38, borderRadius:10, background:item[2]+"20", display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 8px", fontSize:20 }}>{item[0]}</div>
                  <span style={{ fontSize:11, fontWeight:700, color:C.soft, whiteSpace:"pre-line", lineHeight:1.3 }}>{item[1]}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ display:"flex", gap:8, marginBottom:16, overflowX:"auto", paddingBottom:4 }}>
          {filters.map(function(f) {
            return <button key={f} onClick={function(){ setFilter(f); }} style={{ padding:"7px 16px", borderRadius:99, border:"none", background:filter===f?C.cyan:C.card, color:filter===f?"#0A0F1E":C.muted, fontSize:13, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap", flexShrink:0 }}>{f}</button>;
          })}
        </div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
          <p style={{ fontWeight:800, fontSize:16, color:C.text, margin:0 }}>My Notes</p>
          <span style={{ fontSize:12, color:C.muted, fontWeight:600 }}>{filtered.length} notes</span>
        </div>
        {filtered.length===0
          ? <div style={{ textAlign:"center", padding:"40px 20px" }}><div style={{ fontSize:48, marginBottom:12 }}>📝</div><p style={{ color:C.muted, fontSize:15 }}>No notes yet. Tap Voice Note to start!</p></div>
          : filtered.map(function(note) {
            return (
              <button key={note.id} onClick={function(){ onNote(note); }} style={{ width:"100%", background:C.card, border:"1px solid "+note.color+"22", borderRadius:18, padding:16, marginBottom:12, cursor:"pointer", textAlign:"left" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <div style={{ width:42, height:42, borderRadius:12, background:note.bg, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, border:"1px solid "+note.color+"30", flexShrink:0 }}>{note.tag==="Lecture"?"📚":note.tag==="Study"?"💡":note.tag==="Business"?"💼":"📝"}</div>
                    <div>
                      <div style={{ fontWeight:800, fontSize:14, color:C.text, marginBottom:3 }}>{note.title}</div>
                      <span style={{ fontSize:11, fontWeight:700, color:note.color, background:note.bg, borderRadius:99, padding:"2px 8px" }}>{note.course}</span>
                    </div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:11, color:C.muted, marginBottom:4 }}>{note.date}</div>
                    <span style={{ background:note.bg, borderRadius:99, padding:"2px 8px", fontSize:10, fontWeight:700, color:note.color }}>{note.tag}</span>
                  </div>
                </div>
                <p style={{ margin:"0 0 10px", fontSize:13, color:C.muted, lineHeight:1.6, display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical", overflow:"hidden" }}>{note.preview}</p>
                <div style={{ display:"flex", alignItems:"center", paddingTop:10, borderTop:"1px solid "+C.border }}>
                  <span style={{ fontSize:11, color:C.muted }}>✨ AI features available</span>
                  <span style={{ fontSize:11, color:note.color, marginLeft:"auto", fontWeight:700 }}>Open →</span>
                </div>
              </button>
            );
          })
        }
      </div>
    </div>
  );
}

// AI CHAT SCREEN
function AIScreen() {
  const [messages, setMessages] = useState([{ role:"ai", text:"Hi Samuel! 👋 I am your AI study assistant. Ask me to summarize notes, explain concepts, or create study plans!" }]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const endRef = useRef(null);
  useEffect(function() { endRef.current && endRef.current.scrollIntoView({ behavior:"smooth" }); }, [messages]);

  async function send() {
    if (!input.trim()) return;
    var q = input.trim(); setInput("");
    setMessages(function(m){ return [...m, { role:"user", text:q }]; });
    setLoading(true);
    try {
      var res = await fetch("https://api.anthropic.com/v1/messages", { method:"POST", headers:{"Content-Type":"application/json","x-api-key":"YOUR_API_KEY_HERE","anthropic-version":"2023-06-01"}, body:JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:600, messages:[{role:"user",content:"You are a helpful AI study assistant for a Nigerian university student named Samuel. Be concise and helpful: "+q}] }) });
      var data = await res.json();
      setMessages(function(m){ return [...m, { role:"ai", text:data.content[0].text }]; });
    } catch(e) {
      setMessages(function(m){ return [...m, { role:"ai", text:"Add your Claude API key to App.js to enable real AI!" }]; });
    }
    setLoading(false);
  }

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", background:C.bg }}>
      <div style={{ background:C.card, padding:"16px 20px", borderBottom:"1px solid "+C.border }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:40, height:40, borderRadius:12, background:"linear-gradient(135deg,#06B6D4,#A78BFA)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>🤖</div>
          <div>
            <div style={{ fontWeight:800, fontSize:16, color:C.text }}>AI Assistant</div>
            <div style={{ fontSize:11, color:C.green, fontWeight:600 }}>Claude AI</div>
          </div>
        </div>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"16px 16px 8px" }}>
        {messages.map(function(m, i) {
          return (
            <div key={i} style={{ display:"flex", justifyContent:m.role==="user"?"flex-end":"flex-start", marginBottom:12 }}>
              {m.role==="ai" && <div style={{ width:32, height:32, borderRadius:10, background:"linear-gradient(135deg,#06B6D4,#A78BFA)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:15, marginRight:8, flexShrink:0, marginTop:2 }}>🤖</div>}
              <div style={{ maxWidth:"80%", background:m.role==="user"?"linear-gradient(135deg,#06B6D4,#A78BFA)":C.card2, borderRadius:m.role==="user"?"18px 18px 4px 18px":"18px 18px 18px 4px", padding:"12px 16px", border:m.role==="ai"?"1px solid "+C.border:"none" }}>
                <p style={{ margin:0, fontSize:14, color:C.text, lineHeight:1.7, whiteSpace:"pre-wrap" }}>{m.text}</p>
              </div>
            </div>
          );
        })}
        {loading && (
          <div style={{ display:"flex", gap:4, alignItems:"center", marginLeft:40 }}>
            {[0,1,2].map(function(i){ return <div key={i} style={{ width:8, height:8, borderRadius:"50%", background:C.cyan, animation:"dot "+(0.5+i*0.15)+"s ease-in-out infinite alternate" }} />; })}
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div style={{ padding:"12px 16px 16px", background:C.card2, borderTop:"1px solid "+C.border, display:"flex", gap:10 }}>
        <input value={input} onChange={function(e){ setInput(e.target.value); }} onKeyDown={function(e){ if(e.key==="Enter") send(); }} placeholder="Ask anything..." style={{ flex:1, padding:"12px 16px", borderRadius:14, border:"1px solid "+C.border, fontSize:14, background:C.bg, color:C.text, outline:"none" }} />
        <button onClick={send} style={{ width:48, height:48, borderRadius:14, background:"linear-gradient(135deg,#06B6D4,#A78BFA)", border:"none", cursor:"pointer", fontSize:20, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>↑</button>
      </div>
    </div>
  );
}

// FULL SETTINGS SCREEN
function SettingsScreen() {
  const [openSection, setOpenSection] = useState(null);
  const [plan] = useState("Free");
  const [lang, setLang] = useState("English");
  const [aiModel, setAiModel] = useState("Claude");
  const [aiStyle, setAiStyle] = useState("Academic");
  const [recQuality, setRecQuality] = useState("High");
  const [notifs, setNotifs] = useState({ study:true, assignment:false, daily:true, recording:false });
  const [recSettings, setRecSettings] = useState({ noise:true, autoTranscribe:true, speakerID:false, autoSave:true });
  const [privacy, setPrivacy] = useState({ fingerprint:false, face:false, pin:false, autoLock:true, hiddenFolder:false, encrypt:false });
  const [editProfile, setEditProfile] = useState(false);
  const [profile, setProfile] = useState({ name:"Samuel", email:"samuel@gmail.com", username:"@samuel_dev" });

  function Section({ id, icon, title, color, children }) {
    var isOpen = openSection === id;
    return (
      <div style={{ background:C.card, borderRadius:16, marginBottom:12, border:"1px solid "+C.border, overflow:"hidden" }}>
        <button onClick={function(){ setOpenSection(isOpen ? null : id); }} style={{ width:"100%", display:"flex", justifyContent:"space-between", alignItems:"center", padding:"16px", background:"none", border:"none", cursor:"pointer" }}>
          <div style={{ display:"flex", alignItems:"center", gap:12 }}>
            <div style={{ width:36, height:36, borderRadius:10, background:color+"20", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>{icon}</div>
            <span style={{ fontWeight:700, fontSize:15, color:C.text }}>{title}</span>
          </div>
          <span style={{ color:C.muted, fontSize:20 }}>{isOpen ? "v" : ">"}</span>
        </button>
        {isOpen && <div style={{ padding:"0 16px 16px", borderTop:"1px solid "+C.border }}>{children}</div>}
      </div>
    );
  }

  function Row({ icon, label, sub, right, danger, onPress }) {
    return (
      <div onClick={onPress} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"13px 0", borderBottom:"1px solid "+C.border, cursor:onPress?"pointer":"default" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          {icon && <span style={{ fontSize:18 }}>{icon}</span>}
          <div>
            <div style={{ fontSize:14, fontWeight:600, color:danger?C.red:C.text }}>{label}</div>
            {sub && <div style={{ fontSize:11, color:C.muted, marginTop:1 }}>{sub}</div>}
          </div>
        </div>
        {right !== undefined ? right : <span style={{ color:C.muted, fontSize:16 }}>›</span>}
      </div>
    );
  }

  return (
    <div style={{ flex:1, overflowY:"auto", background:C.bg }}>
      <div style={{ background:C.card, padding:"16px 20px", borderBottom:"1px solid "+C.border }}>
        <span style={{ fontWeight:800, fontSize:18, color:C.text }}>Settings</span>
      </div>
      <div style={{ padding:"16px 16px 100px" }}>

        {/* Profile Card */}
        <div style={{ background:"linear-gradient(135deg,#1E293B,#0F172A)", borderRadius:20, padding:20, marginBottom:16, border:"1px solid rgba(6,182,212,0.2)" }}>
          {editProfile ? (
            <div>
              <input value={profile.name} onChange={function(e){ setProfile(function(p){ return {...p,name:e.target.value}; }); }} style={{ width:"100%", padding:"10px", borderRadius:10, border:"1px solid "+C.border, background:C.bg, color:C.text, outline:"none", marginBottom:8, boxSizing:"border-box", fontSize:14 }} placeholder="Full Name" />
              <input value={profile.email} onChange={function(e){ setProfile(function(p){ return {...p,email:e.target.value}; }); }} style={{ width:"100%", padding:"10px", borderRadius:10, border:"1px solid "+C.border, background:C.bg, color:C.text, outline:"none", marginBottom:8, boxSizing:"border-box", fontSize:14 }} placeholder="Email" />
              <input value={profile.username} onChange={function(e){ setProfile(function(p){ return {...p,username:e.target.value}; }); }} style={{ width:"100%", padding:"10px", borderRadius:10, border:"1px solid "+C.border, background:C.bg, color:C.text, outline:"none", marginBottom:12, boxSizing:"border-box", fontSize:14 }} placeholder="Username" />
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={function(){ setEditProfile(false); }} style={{ flex:1, background:"linear-gradient(135deg,#06B6D4,#A78BFA)", color:"#fff", border:"none", borderRadius:10, padding:"10px", fontWeight:700, cursor:"pointer" }}>Save</button>
                <button onClick={function(){ setEditProfile(false); }} style={{ flex:1, background:C.card2, color:C.muted, border:"none", borderRadius:10, padding:"10px", fontWeight:700, cursor:"pointer" }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div style={{ display:"flex", alignItems:"center", gap:16 }}>
              <div style={{ width:60, height:60, borderRadius:18, background:"linear-gradient(135deg,#06B6D4,#A78BFA)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:28, flexShrink:0 }}>👤</div>
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:800, fontSize:18, color:C.text }}>{profile.name}</div>
                <div style={{ fontSize:13, color:C.muted }}>{profile.email}</div>
                <div style={{ fontSize:12, color:C.cyan }}>{profile.username}</div>
              </div>
              <button onClick={function(){ setEditProfile(true); }} style={{ background:"rgba(6,182,212,0.15)", border:"1px solid "+C.cyan+"30", borderRadius:10, padding:"8px 14px", color:C.cyan, fontSize:12, fontWeight:700, cursor:"pointer" }}>Edit</button>
            </div>
          )}
        </div>

        {/* Subscription */}
        <Section id="sub" icon="⭐" title="Subscription" color="#F59E0B">
          <div style={{ marginTop:12 }}>
            <div style={{ background:C.card2, borderRadius:12, padding:"12px 16px", marginBottom:10, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div><div style={{ fontWeight:700, fontSize:14, color:C.text }}>Current Plan</div><div style={{ fontSize:12, color:C.muted }}>Free - 5 recordings/month</div></div>
              <span style={{ background:"rgba(6,182,212,0.15)", color:C.cyan, borderRadius:99, padding:"4px 14px", fontSize:12, fontWeight:700 }}>{plan}</span>
            </div>
            <div style={{ background:"linear-gradient(135deg,#4F46E5,#7C3AED,#06B6D4)", borderRadius:16, padding:20, marginBottom:10 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12 }}>
                <div>
                  <div style={{ fontWeight:800, fontSize:18, color:"#fff" }}>Upgrade to Pro</div>
                  <div style={{ fontSize:12, color:"rgba(255,255,255,0.7)", marginTop:4, lineHeight:1.8 }}>Unlimited recordings and notes{"\n"}Real AI features with Claude{"\n"}Priority support</div>
                </div>
                <span style={{ fontSize:32 }}>🚀</span>
              </div>
              <div style={{ display:"flex", alignItems:"baseline", gap:4, marginBottom:14 }}>
                <span style={{ fontSize:28, fontWeight:800, color:"#fff" }}>₦2,000</span>
                <span style={{ fontSize:12, color:"rgba(255,255,255,0.6)" }}>/month</span>
              </div>
              <button style={{ width:"100%", background:"#fff", color:"#4F46E5", border:"none", borderRadius:12, padding:"12px", fontWeight:800, fontSize:14, cursor:"pointer" }}>Get Pro Now →</button>
            </div>
            <Row icon="🔄" label="Restore Purchase" sub="Restore previous subscription" />
            <Row icon="📜" label="Payment History" sub="View past transactions" />
          </div>
        </Section>

        {/* Notifications */}
        <Section id="notif" icon="🔔" title="Notifications" color="#A78BFA">
          <div style={{ marginTop:12 }}>
            {[["📚","study","Study Reminders","Remind you to study daily"],["📋","assignment","Assignment Reminder","Due date alerts"],["🎯","daily","Daily Goal Reminder","Track your daily goals"],["🎙️","recording","Recording Reminder","Remind to record lectures"]].map(function(item) {
              return <Row key={item[1]} icon={item[0]} label={item[2]} sub={item[3]} right={<Toggle value={notifs[item[1]]} onChange={function(v){ setNotifs(function(p){ return {...p,[item[1]]:v}; }); }} color={C.purple} />} />;
            })}
          </div>
        </Section>

        {/* Language */}
        <Section id="lang" icon="🌍" title="Language" color="#34D399">
          <div style={{ marginTop:12 }}>
            {[["English","🇬🇧"],["Yoruba","🇳🇬"],["Hausa","🇳🇬"],["Igbo","🇳🇬"],["French","🇫🇷"]].map(function(item) {
              return (
                <div key={item[0]} onClick={function(){ setLang(item[0]); }} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 0", borderBottom:"1px solid "+C.border, cursor:"pointer" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <span style={{ fontSize:20 }}>{item[1]}</span>
                    <span style={{ fontSize:14, fontWeight:600, color:lang===item[0]?C.green:C.text }}>{item[0]}</span>
                  </div>
                  {lang===item[0] && <span style={{ color:C.green, fontSize:18, fontWeight:700 }}>✓</span>}
                </div>
              );
            })}
          </div>
        </Section>

        {/* Recording Settings */}
        <Section id="rec" icon="🎤" title="Recording Settings" color="#06B6D4">
          <div style={{ marginTop:12 }}>
            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:12, color:C.muted, marginBottom:8, fontWeight:600 }}>RECORDING QUALITY</div>
              <div style={{ display:"flex", gap:8 }}>
                {["Low","Medium","High"].map(function(q) {
                  return <button key={q} onClick={function(){ setRecQuality(q); }} style={{ flex:1, padding:"8px", borderRadius:10, border:"2px solid", borderColor:recQuality===q?C.cyan:C.border, background:recQuality===q?C.cyan:C.card, color:recQuality===q?"#0A0F1E":C.muted, fontSize:13, fontWeight:700, cursor:"pointer" }}>{q}</button>;
                })}
              </div>
            </div>
            {[["🔇","noise","Noise Reduction","Filter background noise"],["📝","autoTranscribe","Auto Transcription","Convert voice to text automatically"],["👥","speakerID","Speaker Identification","Identify different speakers (Pro)"],["💾","autoSave","Auto Save Recording","Save recordings automatically"]].map(function(item) {
              return <Row key={item[1]} icon={item[0]} label={item[2]} sub={item[3]} right={<Toggle value={recSettings[item[1]]} onChange={function(v){ setRecSettings(function(p){ return {...p,[item[1]]:v}; }); }} color={C.cyan} />} />;
            })}
          </div>
        </Section>

        {/* AI Settings */}
        <Section id="ai" icon="🤖" title="AI Settings" color="#A78BFA">
          <div style={{ marginTop:12 }}>
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:12, color:C.muted, marginBottom:8, fontWeight:600 }}>AI MODEL</div>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                {["Claude","GPT-4","Gemini"].map(function(m) {
                  return <button key={m} onClick={function(){ setAiModel(m); }} style={{ padding:"8px 16px", borderRadius:10, border:"2px solid", borderColor:aiModel===m?C.purple:C.border, background:aiModel===m?C.purple:C.card, color:aiModel===m?"#0A0F1E":C.muted, fontSize:13, fontWeight:700, cursor:"pointer" }}>{m}</button>;
                })}
              </div>
            </div>
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:12, color:C.muted, marginBottom:8, fontWeight:600 }}>WRITING STYLE</div>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                {["Academic","Simple","Detailed"].map(function(s) {
                  return <button key={s} onClick={function(){ setAiStyle(s); }} style={{ padding:"8px 16px", borderRadius:10, border:"2px solid", borderColor:aiStyle===s?C.purple:C.border, background:aiStyle===s?C.purple:C.card, color:aiStyle===s?"#0A0F1E":C.muted, fontSize:13, fontWeight:700, cursor:"pointer" }}>{s}</button>;
                })}
              </div>
            </div>
            <Row icon="🌐" label="AI Response Language" sub="English" />
            <Row icon="📏" label="AI Summary Length" sub="Medium" />
            <Row icon="📵" label="Offline AI Mode" sub="Available on Pro" right={<span style={{ background:"rgba(245,158,11,0.15)", color:C.amber, borderRadius:99, padding:"3px 10px", fontSize:11, fontWeight:700 }}>PRO</span>} />
            <Row icon="🎙️" label="Voice Assistant" sub="Configure voice commands" />
          </div>
        </Section>

        {/* Privacy & Security */}
        <Section id="privacy" icon="🔒" title="Privacy and Security" color="#F87171">
          <div style={{ marginTop:12 }}>
            {[["👆","fingerprint","Fingerprint Unlock","Use fingerprint to unlock"],["👤","face","Face Unlock","Unlock with face recognition"],["🔢","pin","PIN Lock","Set a 4-digit PIN"],["⏱","autoLock","Auto Lock","Lock after 1 minute"],["📁","hiddenFolder","Hidden Notes Folder","Keep private notes hidden"],["🔐","encrypt","Encrypt Notes","End-to-end encryption"]].map(function(item) {
              return <Row key={item[1]} icon={item[0]} label={item[2]} sub={item[3]} right={<Toggle value={privacy[item[1]]} onChange={function(v){ setPrivacy(function(p){ return {...p,[item[1]]:v}; }); }} color={C.red} />} />;
            })}
          </div>
        </Section>

        {/* About */}
        <Section id="about" icon="ℹ️" title="About" color="#06B6D4">
          <div style={{ marginTop:12 }}>
            <Row icon="📱" label="App Version" sub="v2.1.0" right={<span style={{ fontSize:13, color:C.muted }}>v2.1</span>} />
            <Row icon="🆕" label="What's New" sub="See latest updates" />
            <Row icon="🔏" label="Privacy Policy" sub="How we handle your data" />
            <Row icon="📜" label="Terms of Service" sub="Rules and conditions" />
            <Row icon="💬" label="Contact Support" sub="Get help from our team" />
            <Row icon="⭐" label="Rate the App" sub="Love the app? Rate us!" onPress={function(){ alert("Thank you! Rating feature coming soon!"); }} />
            <Row icon="📤" label="Share the App" sub="Tell your friends about Jotting AI" onPress={function(){ if(navigator.share){navigator.share({title:"Jotting AI",text:"Check out this AI note-taking app!",url:"https://jotting-ai.vercel.app"});}else{alert("Link: jotting-ai.vercel.app");} }} />
            <Row icon="🐛" label="Report a Bug" sub="Help us improve the app" onPress={function(){ alert("Report bugs to: samuel@gmail.com"); }} />
            <div style={{ textAlign:"center", marginTop:16, color:C.muted, fontSize:12 }}>Jotting AI v2.1 - Built with love by Samuel</div>
          </div>
        </Section>

        {/* Account */}
        <Section id="account" icon="👤" title="Account" color="#34D399">
          <div style={{ marginTop:12 }}>
            <Row icon="✏️" label="Edit Profile" sub="Change your name and info" onPress={function(){ setEditProfile(true); }} />
            <Row icon="🖼️" label="Change Profile Picture" sub="Update your photo" />
            <Row icon="@" label="Change Username" sub={profile.username} />
            <Row icon="🔑" label="Change Password" sub="Update your password" />
            <Row icon="📧" label="Email Verification" sub="Verify your email address" />
            <div onClick={function(){ alert("Logout coming soon!"); }} style={{ display:"flex", alignItems:"center", justifyContent:"center", padding:"14px", marginTop:8, background:"rgba(248,113,113,0.1)", borderRadius:12, cursor:"pointer", border:"1px solid "+C.red+"30" }}>
              <span style={{ fontSize:14, fontWeight:700, color:C.red }}>🚪 Logout</span>
            </div>
          </div>
        </Section>

      </div>
    </div>
  );
}

// MAIN APP
export default function App() {
  const [notes, setNotes] = useState(INIT_NOTES);
  const [screen, setScreen] = useState("home");
  const [activeNote, setActiveNote] = useState(null);
  const [tab, setTab] = useState("home");

  function go(s, t) { setScreen(s); if (t) setTab(t); }
  function saveNote(note) { setNotes(function(n){ return [note, ...n]; }); go("home","home"); }
  function deleteNote(id) { setNotes(function(n){ return n.filter(function(x){ return x.id !== id; }); }); go("home","home"); }

  var NAV = [
    { id:"home", icon:"🏠", label:"Home", s:"home" },
    { id:"notes", icon:"📝", label:"Notes", s:"home" },
    { id:"new", icon:"+", label:"New", s:"voice", special:true },
    { id:"ai", icon:"✨", label:"AI", s:"ai" },
    { id:"settings", icon:"⚙️", label:"Settings", s:"settings" },
  ];

  return (
    <div style={{ minHeight:"100vh", background:"#06081A", display:"flex", justifyContent:"center", alignItems:"flex-start", padding:"20px 0" }}>
      <style>{"\n        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');\n        *{box-sizing:border-box;font-family:'DM Sans',sans-serif;}\n        body{margin:0;background:#06081A;}\n        button,textarea,input{font-family:'DM Sans',sans-serif;}\n        ::-webkit-scrollbar{width:0;}\n        input::placeholder,textarea::placeholder{color:#4B5563;}\n        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}\n        @keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,0.4)}50%{box-shadow:0 0 0 20px rgba(239,68,68,0)}}\n        @keyframes wv{from{transform:scaleY(0.3)}to{transform:scaleY(1.2)}}\n        @keyframes dot{from{opacity:0.3;transform:scale(0.7)}to{opacity:1;transform:scale(1)}}\n      "}</style>
      <div style={{ width:"100%", maxWidth:400, minHeight:"calc(100vh - 40px)", background:C.bg, borderRadius:36, overflow:"hidden", display:"flex", flexDirection:"column", boxShadow:"0 24px 80px rgba(6,182,212,0.12), 0 0 0 1px rgba(255,255,255,0.06)" }}>
        <div style={{ flex:1, display:"flex", flexDirection:"column", overflowY:"auto", minHeight:0 }}>
          {screen==="home" && <HomeScreen notes={notes} onNote={function(n){ setActiveNote(n); go("detail"); }} onVoice={function(){ go("voice","new"); }} onDraw={function(){ go("draw"); }} onAIWrite={function(){ go("aiwrite"); }} onScan={function(){ alert("Camera scan coming soon!"); }} />}
          {screen==="detail" && activeNote && <NoteDetail note={activeNote} onBack={function(){ go("home","home"); }} onDelete={deleteNote} />}
          {screen==="voice" && <VoiceNoteScreen onBack={function(){ go("home","home"); }} onSave={saveNote} />}
          {screen==="draw" && <DrawScreen onBack={function(){ go("home","home"); }} />}
          {screen==="aiwrite" && <AIWriteScreen onBack={function(){ go("home","home"); }} onSave={saveNote} />}
          {screen==="ai" && <AIScreen />}
          {screen==="settings" && <SettingsScreen />}
        </div>
        <div style={{ background:C.card2, borderTop:"1px solid "+C.border, padding:"10px 10px 16px", display:"flex", justifyContent:"space-around", alignItems:"center", flexShrink:0 }}>
          {NAV.map(function(item) {
            return (
              <button key={item.id} onClick={function(){ go(item.s, item.id); }} style={{ background:item.special?"linear-gradient(135deg,#06B6D4,#A78BFA)":"none", border:"none", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:3, padding:item.special?"0":"4px 8px", width:item.special?52:"auto", height:item.special?52:"auto", borderRadius:item.special?"50%":0, boxShadow:item.special?"0 4px 20px rgba(6,182,212,0.4)":"none", justifyContent:"center", flexShrink:0 }}>
                <span style={{ fontSize:item.special?24:20, color:item.special?"#fff":tab===item.id?C.cyan:"#4B5563" }}>{item.icon}</span>
                {!item.special && <span style={{ fontSize:10, fontWeight:700, color:tab===item.id?C.cyan:"#4B5563" }}>{item.label}</span>}
                {!item.special && tab===item.id && <div style={{ width:4, height:4, borderRadius:"50%", background:C.cyan }} />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
