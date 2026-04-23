// frontend/src/App.jsx
import React, { useEffect, useRef, useState } from "react";

/*
  Full-featured App.jsx:
  - token-based sentence model (tokens = consonant | vowel | space | other)
  - compose vattakshara when vowel key pressed after consonant
  - add predicted letter from backend (websocket)
  - undo, clear, autocorrect, copy, export
  - browser TTS with automatic fallback to server gTTS (http://127.0.0.1:8000/tts)
  - prediction % bar, websocket status, frame interval control
  - Kannada keyboard panels (consonants + vowels)
*/

const BACKEND_BASE = "http://127.0.0.1:8000"; // change if your backend host/port is different

// Matra map for Kannada vowels (independent vowels and vowel-signs)
const VOWEL_MATRAS = {
  "a": "",          // inherent vowel (no matra) -> independent vowel used instead when alone
  "aa": "\u0CBE",   // ಾ
  "i": "\u0CBF",    // ಿ
  "ii": "\u0CC0",   // ೀ
  "u": "\u0CC1",    // ು
  "uu": "\u0CC2",   // ೂ
  "e": "\u0CC6",    // ೆ
  "ee": "\u0CC7",   // ೇ
  "ai": "\u0CC8",   // ೈ
  "o": "\u0CCA",    // ೊ
  "oo": "\u0CCB",   // ೋ
  "au": "\u0CCC",   // ೌ
  "anusvara": "\u0C82", // ಂ
  "visarga": "\u0C83"   // ಃ
};

// Independent vowel characters for "a, aa, i, ..." (used if vowel is inserted standalone)
const INDEPENDENT_VOWELS = {
  "a": "ಅ",
  "aa": "ಆ",
  "i": "ಇ",
  "ii": "ಈ",
  "u": "ಉ",
  "uu": "ಊ",
  "e": "ಎ",
  "ee": "ಏ",
  "ai": "ಐ",
  "o": "ಒ",
  "oo": "ಓ",
  "au": "ಔ"
};

// Unicode detection helpers
function isKannadaConsonantChar(ch) {
  if (!ch) return false;
  const code = ch.codePointAt(0);
  // Kannada consonants roughly U+0C95..U+0CB9 (ಕ..ಹ)
  return code >= 0x0C95 && code <= 0x0CB9;
}
function isKannadaIndependentVowelChar(ch) {
  if (!ch) return false;
  const code = ch.codePointAt(0);
  // Kannada independent vowels U+0C85..0C94
  return code >= 0x0C85 && code <= 0x0C94;
}

// Helper: render token list to a display string
function tokensToString(tokens) {
  return tokens.map(t => {
    if (t.type === "consonant") return t.base + (t.matra || "");
    if (t.type === "vowel") return t.base; // independent vowel
    if (t.type === "space") return " ";
    return t.text || "";
  }).join("");
}

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const intervalRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [predLabel, setPredLabel] = useState(""); // predicted character from backend
  const [prob, setProb] = useState(0);
  const [tokens, setTokens] = useState([]); // token array
  const [labels, setLabels] = useState([]); // idx2label as array by index
  const [sendingIntervalMs, setSendingIntervalMs] = useState(150);

  // load idx2label.json from backend static (copy idx2label.json to backend/static)
  useEffect(() => {
    fetch(BACKEND_BASE + "/static/idx2label.json")
      .then(r => r.json())
      .then(data => {
        // convert map like {"0":"ಕ","1":"ಖ",...} to array sorted by numeric index
        const keys = Object.keys(data).sort((a,b)=>Number(a)-Number(b));
        const arr = keys.map(k => data[k]);
        setLabels(arr);
      })
      .catch(err => {
        console.warn("Could not load idx2label.json from backend/static:", err);
        setLabels([]);
      });
  }, []);

  // Setup camera + WS on mount
  useEffect(() => {
    connectWS();
    startCamera();
    return () => {
      stopCamera();
      disconnectWS();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- WebSocket handlers --
  function connectWS() {
    disconnectWS();
    try {
      const ws = new WebSocket((BACKEND_BASE.startsWith("http://") ? "ws://" : "wss://") + BACKEND_BASE.replace(/^https?:\/\//, "") + "/ws/predict");
      wsRef.current = ws;
      ws.onopen = () => { setConnected(true); console.log("WS connected"); };
      ws.onclose = () => { setConnected(false); console.log("WS closed"); };
      ws.onerror = (e) => { setConnected(false); console.error("WS error", e); };
      ws.onmessage = (evt) => {
        try {
          const d = JSON.parse(evt.data);
          if (d.prediction !== undefined) {
            setPredLabel(d.prediction);
            setProb(Math.round((d.score || 0) * 100));
          }
        } catch (e) {
          console.error("WS parse error", e);
        }
      };
    } catch (e) {
      console.error("Failed to connect WS", e);
    }
  }
  function disconnectWS() {
    try { if (wsRef.current) wsRef.current.close(); } catch(e){}
    wsRef.current = null;
    setConnected(false);
  }

  // -- Camera & sending frames --
  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      const canvas = canvasRef.current;
      canvas.width = 640; canvas.height = 480;
      startSendingFrames();
    } catch (e) {
      console.error("Camera error", e);
      alert("Camera access failed. Check permissions.");
    }
  }
  function stopCamera() {
    try {
      const s = videoRef.current?.srcObject;
      if (s && s.getTracks) s.getTracks().forEach(t => t.stop());
      if (intervalRef.current) clearInterval(intervalRef.current);
    } catch(e) {}
  }
  function startSendingFrames() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => sendFrame(), sendingIntervalMs);
  }
  function sendFrame() {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
    const dataURL = canvas.toDataURL("image/jpeg", 0.7);
    try {
      wsRef.current.send(JSON.stringify({ frame: dataURL }));
    } catch (e) {
      console.error("WS send error", e);
    }
  }

  // -- Token operations --
  function pushConsonant(char) {
    setTokens(prev => ([...prev, { type: "consonant", base: char, matra: "" }]));
  }
  function pushIndependentVowel(key) {
    // key like "a","aa" -> INDEPENDENT_VOWELS
    const ch = INDEPENDENT_VOWELS[key] || key;
    setTokens(prev => ([...prev, { type: "vowel", base: ch }]));
  }
  function pushSpace() {
    setTokens(prev => ([...prev, { type: "space" }]));
  }
  function attachMatraToLastConsonant(matra) {
    setTokens(prev => {
      if (prev.length === 0) return [...prev];
      const last = prev[prev.length -1];
      if (last.type === "consonant") {
        const copy = prev.slice();
        copy[copy.length - 1] = { ...last, matra: (matra || "") };
        return copy;
      } else {
        // last is not consonant -> append independent vowel mark if matra=="" then append nothing
        // fallback: append independent vowel character if mapping exists
        return [...prev];
      }
    });
  }
  function addRawText(text) {
    // fallback for other text insertion
    setTokens(prev => ([...prev, { type: "other", text }]));
  }

  function undoLast() {
    setTokens(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.type === "consonant" && last.matra && last.matra.length > 0) {
        // remove matra only
        const copy = prev.slice();
        copy[copy.length - 1] = { ...last, matra: "" };
        return copy;
      } else {
        // pop token
        const copy = prev.slice(0, -1);
        return copy;
      }
    });
  }

  function clearSentence() {
    setTokens([]);
  }

  // Basic token-based autocorrect:
  // - collapse runs of identical consonant tokens longer than 2 into single
  // - trim leading/trailing spaces
  function autocorrect() {
    setTokens(prev => {
      if (!prev || prev.length === 0) return prev;
      const out = [];
      for (let t of prev) {
        if (t.type === "consonant") {
          const last = out[out.length - 1];
          if (last && last.type === "consonant" && last.base === t.base && (!last.matra && !t.matra)) {
            // collapse duplicates: keep a single instance (so AAA -> A)
            continue;
          }
        }
        out.push(t);
      }
      // trim front/back spaces
      while (out.length > 0 && out[0].type === "space") out.shift();
      while (out.length > 0 && out[out.length - 1].type === "space") out.pop();
      return out;
    });
  }

  // Insert label via keyboard click or other UI: item object { type, key?, char? }
  // type: 'consonant' -> char should be Kannada consonant char
  // type: 'vowel' -> key should be like 'aa','i' etc
  // type: 'space' or 'other'
  function insertLabelItem(item) {
    if (!item) return;
    if (item.type === "consonant") {
      pushConsonant(item.char || item.label || "");
      return;
    }
    if (item.type === "vowel") {
      const key = item.key; // 'aa','i' etc
      if (key === "a") {
        // standalone independent vowel
        pushIndependentVowel(key);
        return;
      }
      // attach matra if previous token is consonant, else append independent vowel
      const matra = VOWEL_MATRAS[key] || "";
      setTokens(prev => {
        if (prev.length === 0) {
          // no previous -> append independent vowel
          return [...prev, { type: "vowel", base: INDEPENDENT_VOWELS[key] || "" }];
        }
        const last = prev[prev.length - 1];
        if (last.type === "consonant") {
          const copy = prev.slice();
          copy[copy.length - 1] = { ...last, matra: matra };
          return copy;
        } else {
          // previous not consonant -> independent vowel append
          return [...prev, { type: "vowel", base: INDEPENDENT_VOWELS[key] || "" }];
        }
      });
      return;
    }
    if (item.type === "space") {
      pushSpace();
      return;
    }
    // fallback
    addRawText(item.char || item.label || "");
  }

  // Add predicted letter (called on Add Letter button)
  function addPredictedLetter() {
    if (!predLabel) return;
    // normalize predictions "nothing" -> ignore, "space" -> space
    const pl = predLabel;
    if (typeof pl === "string") {
      if (pl.toLowerCase() === "nothing") return;
      if (pl.toLowerCase() === "space") {
        pushSpace();
        return;
      }
    }
    // if predicted is a Kannada consonant -> add consonant token
    if (isKannadaConsonantChar(pl)) {
      pushConsonant(pl);
      return;
    }
    // if predicted is independent vowel (model may predict) -> append vowel token
    if (isKannadaIndependentVowelChar(pl)) {
      setTokens(prev => ([...prev, { type: "vowel", base: pl }]));
      return;
    }
    // otherwise append as 'other' text
    addRawText(pl);
  }

  // Export/Download text as .txt
  function downloadText() {
    const text = tokensToString(tokens);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sentence.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  // Copy to clipboard
  function copyToClipboard() {
    const text = tokensToString(tokens);
    navigator.clipboard.writeText(text);
    alert("Copied to clipboard");
  }

  // Browser TTS with auto-fallback to server gTTS
  async function speakBrowserAutoFallback() {
    const sentence = tokensToString(tokens);
    if (!sentence || sentence.trim().length === 0) {
      alert("No text to speak");
      return;
    }

    // Wait for voices to populate if empty
    if (speechSynthesis.getVoices().length === 0) {
      await new Promise(res => {
        const h = () => { speechSynthesis.removeEventListener("voiceschanged", h); res(); };
        speechSynthesis.addEventListener("voiceschanged", h);
        setTimeout(h, 1200);
      });
    }

    const voices = speechSynthesis.getVoices();
    const knVoice = voices.find(v => v.lang && v.lang.toLowerCase().startsWith("kn"));
    if (knVoice) {
      try {
        const utter = new SpeechSynthesisUtterance(sentence);
        utter.lang = knVoice.lang || "kn-IN";
        utter.voice = knVoice;
        speechSynthesis.speak(utter);
        return;
      } catch (e) {
        console.warn("Browser TTS failed, falling back", e);
      }
    }
    // fallback to server gTTS
    try {
      const res = await fetch(BACKEND_BASE + "/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sentence })
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error("TTS server error: " + txt);
      }
      const j = await res.json();
      if (!j.url) throw new Error("No url returned by TTS");
      // Ensure absolute URL for audio
      const audioUrl = (j.url.startsWith("/") ? (BACKEND_BASE + j.url) : j.url);
      const audio = new Audio(audioUrl);
      await audio.play();
    } catch (e) {
      console.error("Server TTS failed:", e);
      alert("Both browser and server TTS failed. See console for details.");
    }
  }

  // UI helpers
  const renderedSentence = tokensToString(tokens);
  const lastToken = tokens.length ? tokens[tokens.length - 1] : null;
  const lastWaitingForVowel = lastToken && lastToken.type === "consonant" && (!lastToken.matra || lastToken.matra === "");

  // Prebuilt keyboard arrays (consonants + vowels). You may update labels order as needed.
  const consonantKeys = [
    // common Kannada consonants (use actual glyphs)
    { type: "consonant", char: "ಕ" }, { type: "consonant", char: "ಖ" }, { type: "consonant", char: "ಗ" }, { type: "consonant", char: "ಘ" }, { type: "consonant", char: "ಙ" },
    { type: "consonant", char: "ಚ" }, { type: "consonant", char: "ಛ" }, { type: "consonant", char: "ಜ" }, { type: "consonant", char: "ಝ" }, { type: "consonant", char: "ಞ" },
    { type: "consonant", char: "ಟ" }, { type: "consonant", char: "ಠ" }, { type: "consonant", char: "ಡ" }, { type: "consonant", char: "ಢ" }, { type: "consonant", char: "ಣ" },
    { type: "consonant", char: "ತ" }, { type: "consonant", char: "ಥ" }, { type: "consonant", char: "ದ" }, { type: "consonant", char: "ಧ" }, { type: "consonant", char: "ನ" },
    { type: "consonant", char: "ಪ" }, { type: "consonant", char: "ಫ" }, { type: "consonant", char: "ಬ" }, { type: "consonant", char: "ಭ" }, { type: "consonant", char: "ಮ" },
    { type: "consonant", char: "ಯ" }, { type: "consonant", char: "ರ" }, { type: "consonant", char: "ಲ" }, { type: "consonant", char: "ವ" }, { type: "consonant", char: "ಶ" },
    { type: "consonant", char: "ಷ" }, { type: "consonant", char: "ಸ" }, { type: "consonant", char: "ಹ" }, { type: "consonant", char: "ಳ" }, { type: "consonant", char: "ಕ್ಷ" }
  ];
  // vowel keys with 'key' mapping used for matra mapping
  const vowelKeys = [
    { type: "vowel", key: "a", char: "ಅ" }, { type: "vowel", key: "aa", char: "ಆ" }, { type: "vowel", key: "i", char: "ಇ" }, { type: "vowel", key: "ii", char: "ಈ" },
    { type: "vowel", key: "u", char: "ಉ" }, { type: "vowel", key: "uu", char: "ಊ" }, { type: "vowel", key: "e", char: "ಎ" }, { type: "vowel", key: "ee", char: "ಏ" },
    { type: "vowel", key: "ai", char: "ಐ" }, { type: "vowel", key: "o", char: "ಒ" }, { type: "vowel", key: "oo", char: "ಓ" }, { type: "vowel", key: "au", char: "ಔ" },
    { type: "vowel", key: "anusvara", char: "ಂ" }, { type: "vowel", key: "visarga", char: "ಃ" }
  ];

  return (
    <div style={{ fontFamily: "Arial, sans-serif", padding: 18, maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>Kannada Sign Language — Real-Time (Tokens & Vattakshara)</h1>

      <div style={{ display: "flex", gap: 18 }}>
        <div style={{ flex: "0 0 640px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 12, height: 12, borderRadius: 7, backgroundColor: connected ? "#2ecc71" : "#e74c3c", boxShadow: connected ? "0 0 8px rgba(46,204,113,0.3)" : "none" }} />
            <div>{connected ? "WebSocket connected" : "WebSocket disconnected"}</div>
          </div>

          <video ref={videoRef} style={{ width: "100%", height: "420px", marginTop: 10, borderRadius: 8, border: "1px solid #ddd" }} autoPlay muted playsInline />

          <canvas ref={canvasRef} style={{ display: "none" }} />

          <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{predLabel || "-"}</div>
            <div style={{ fontSize: 14, color: "#444" }}>Confidence: {prob}%</div>
            <div style={{ width: 200, height: 12, background: "#eee", borderRadius: 8, overflow: "hidden" }}>
              <div style={{ width: `${prob}%`, height: "100%", background: prob > 70 ? "#2ecc71" : (prob > 40 ? "#f1c40f" : "#e74c3c"), transition: "width 200ms" }} />
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button onClick={addPredictedLetter} style={{ padding: "8px 10px" }}>Add Letter</button>
              <button onClick={undoLast} style={{ padding: "8px 10px" }}>Undo</button>
              <button onClick={clearSentence} style={{ padding: "8px 10px" }}>Clear</button>
            </div>
          </div>

        </div>

        <div style={{ flex: 1 }}>
          <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
            <h3 style={{ marginTop: 0 }}>Constructed Sentence</h3>
            <div style={{ minHeight: 64, padding: 12, border: lastWaitingForVowel ? "2px dashed #2ecc71" : "1px solid #ccc", borderRadius: 6, background: "#fff" }}>
              <div style={{ fontSize: 22 }}>{renderedSentence || <span style={{ color: "#888" }}>No text yet</span>}</div>
              { lastWaitingForVowel && <div style={{ fontSize: 12, color: "#2ecc71", marginTop: 6 }}>Last consonant is waiting for vowel — press a vowel key or Add Letter</div> }
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button onClick={autocorrect} style={{ padding: "8px 12px" }}>Auto-correct</button>
              <button onClick={copyToClipboard} style={{ padding: "8px 12px" }}>Copy</button>
              <button onClick={downloadText} style={{ padding: "8px 12px" }}>Download .txt</button>
              <button onClick={speakBrowserAutoFallback} style={{ padding: "8px 12px" }}>Speak (Browser / fallback)</button>
            </div>

            <div style={{ marginTop: 10 }}>
              <label>Frame send interval (ms): </label>
              <input type="number" value={sendingIntervalMs} onChange={(e) => { setSendingIntervalMs(Number(e.target.value)); startSendingFrames(); }} style={{ width: 90, marginLeft: 6 }} />
              <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>Lower = more frequent frames (higher CPU/BW).</div>
            </div>
          </div>

          <div style={{ marginTop: 12, padding: 12, border: "1px solid #eee", borderRadius: 8 }}>
            <h3 style={{ marginTop: 0 }}>Keyboard: Consonants</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {consonantKeys.map((k, i) => (
                <button key={i} onClick={() => insertLabelItem(k)} style={{
                  padding: "8px 12px",
                  minWidth: 44,
                  borderRadius: 6,
                  background: (lastWaitingForVowel && tokens.length && tokens[tokens.length - 1].base === k.char) ? "#dff7e2" : "#fff",
                  border: "1px solid #ccc"
                }}>{k.char}</button>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 12, padding: 12, border: "1px solid #eee", borderRadius: 8 }}>
            <h3 style={{ marginTop: 0 }}>Keyboard: Vowels</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>

            {vowelKeys.map((v, i) => (
                <button
                key={i}
                onClick={() => insertLabelItem(v)}
                style={{
                    padding: "8px 12px",
                    minWidth: 44,
                    borderRadius: 6,
                    border: "1px solid #ccc"
                }}
                >
                {v.char}
                </button>
            ))}

            {/* SPACE BUTTON FIX */}
            <button
                onClick={() => insertLabelItem({ type: "space" })}
                style={{
                padding: "8px 18px",
                minWidth: 60,
                borderRadius: 6,
                border: "1px solid #ccc",
                background: "#fafafa",
                fontWeight: "bold"
                }}
            >
                Space
            </button>

            </div>

          </div>

          <div style={{ marginTop: 12, padding: 12, border: "1px solid #eee", borderRadius: 8 }}>
            <h3 style={{ marginTop: 0 }}>Model labels (optional)</h3>
            <div style={{ maxHeight: 120, overflow: "auto", padding: 6, border: "1px dashed #f0f0f0", borderRadius: 6 }}>
              {labels.length ? labels.map((l, idx) => <span key={idx} style={{ padding: 6, display: "inline-block" }}>{l}</span>) : <div style={{ color: "#888" }}>idx2label not loaded</div>}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}



// // frontend/src/App.jsx
// import React, { useEffect, useRef, useState } from "react";

// /*
//   Token format:
//     { type: 'consonant'|'vowel'|'space'|'other', base: 'ಕ' (string), matra: '\u0CBE' or '' }
//   Rendering: token.base + (token.matra||'')
// */

// const VOWEL_MATRAS = {
//   "a": { char: "ಅ", matra: "" },         // independent vowel
//   "aa": { char: "ಆ", matra: "\u0CBE" },  // ಾ
//   "i": { char: "ಇ", matra: "\u0CBF" },   // ಿ
//   "ii": { char: "ಈ", matra: "\u0CC0" },  // ೀ
//   "u": { char: "ಉ", matra: "\u0CC1" },   // ು
//   "uu": { char: "ಊ", matra: "\u0CC2" },  // ೂ
//   "e": { char: "ಎ", matra: "\u0CC6" },   // ೆ
//   "ee": { char: "ಏ", matra: "\u0CC7" },  // ೇ
//   "ai": { char: "ಐ", matra: "\u0CC8" },  // ೈ
//   "o": { char: "ಒ", matra: "\u0CCA" },   // ೊ
//   "oo": { char: "ಓ", matra: "\u0CCB" },  // ೋ
//   "au": { char: "ಔ", matra: "\u0CCC" },  // ೌ
//   "anusvara": { char: "ಂ", matra: "\u0C82" }, // ಂ
//   "visarga": { char: "ಃ", matra: "\u0C83" }   // ಃ
// };

// function composeTokenString(token) {
//   if (!token) return "";
//   return (token.base || "") + (token.matra || "");
// }

// function renderSentence(tokens) {
//   return tokens.map(composeTokenString).join("");
// }

// // simple heuristic: Kannada consonants codepoints U+0C95..U+0CB9
// function isKannadaConsonantChar(ch) {
//   if (!ch || ch.length === 0) return false;
//   const cp = ch.codePointAt(0);
//   return cp >= 0x0C95 && cp <= 0x0CB9;
// }

// export default function App() {
//   const videoRef = useRef(null);
//   const canvasRef = useRef(null);
//   const wsRef = useRef(null);
//   const intervalRef = useRef(null);

//   const [connected, setConnected] = useState(false);
//   const [prediction, setPrediction] = useState({ label: "", score: 0 });
//   const [labels, setLabels] = useState([]); // consonant list from idx2label.json
//   const [sentenceTokens, setSentenceTokens] = useState([]);
//   const [sendingIntervalMs, setSendingIntervalMs] = useState(150);

//   // load consonants mapping from backend static idx2label.json
//   useEffect(() => {
//     fetch("/static/idx2label.json")
//       .then(r => r.json())
//       .then(data => {
//         // data keys probably "0":"ಕ" etc. Convert to ordered array
//         const keys = Object.keys(data).sort((a,b) => Number(a)-Number(b));
//         const arr = keys.map(k => data[k]);
//         // Filter consonants by heuristic (keeps other labels too)
//         setLabels(arr);
//       })
//       .catch(err => {
//         console.warn("Could not load idx2label.json", err);
//         setLabels([]);
//       });

//     startCamera();
//     connectWS();

//     return () => {
//       stopCamera();
//       disconnectWS();
//     };
//     // eslint-disable-next-line
//   }, []);

//   // ---------------- WebSocket ----------------
//   function connectWS() {
//     disconnectWS();
//     try {
//       const ws = new WebSocket("ws://127.0.0.1:8000/ws/predict");
//       wsRef.current = ws;
//       ws.onopen = () => { setConnected(true); console.log("WS open"); };
//       ws.onclose = () => { setConnected(false); console.log("WS closed"); };
//       ws.onerror = (e) => { setConnected(false); console.error("WS error", e); };
//       ws.onmessage = (evt) => {
//         try {
//           const data = JSON.parse(evt.data);
//           if (data.prediction !== undefined) {
//             setPrediction({ label: data.prediction, score: Math.round((data.score||0)*100) });
//           }
//         } catch (e) {
//           console.error("WS parse error", e);
//         }
//       };
//     } catch (e) {
//       console.error("WS connect error", e);
//     }
//   }
//   function disconnectWS() {
//     try {
//       if (wsRef.current) wsRef.current.close();
//     } catch (e) {}
//     wsRef.current = null;
//     setConnected(false);
//   }

//   // ---------------- Camera & frames ----------------
//   async function startCamera() {
//     try {
//       const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
//       videoRef.current.srcObject = stream;
//       await videoRef.current.play();
//       const canvas = canvasRef.current;
//       canvas.width = 640; canvas.height = 480;
//       startSendingFrames();
//     } catch (e) {
//       console.error("Camera error", e);
//       alert("Camera access failed. Check permissions.");
//     }
//   }
//   function stopCamera() {
//     try {
//       const s = videoRef.current.srcObject;
//       if (s) s.getTracks().forEach(t => t.stop());
//       if (intervalRef.current) clearInterval(intervalRef.current);
//     } catch (e) {}
//   }
//   function startSendingFrames() {
//     if (intervalRef.current) clearInterval(intervalRef.current);
//     intervalRef.current = setInterval(() => sendFrame(), sendingIntervalMs);
//   }
//   function sendFrame() {
//     if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
//     const canvas = canvasRef.current;
//     const ctx = canvas.getContext("2d");
//     ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
//     const dataURL = canvas.toDataURL("image/jpeg", 0.7);
//     try {
//       wsRef.current.send(JSON.stringify({ frame: dataURL }));
//     } catch (e) {
//       console.error("WS send error", e);
//     }
//   }

//   // ---------------- Token operations ----------------
//   // push a consonant token
//   function appendConsonant(ch) {
//     if (!ch) return;
//     setSentenceTokens(prev => [...prev, { type: "consonant", base: ch, matra: "" }]);
//   }
//   // insert a vowel key (may be independent vowel or matra)
//   function insertVowelByKey(key) {
//     const info = VOWEL_MATRAS[key];
//     if (!info) return;
//     // if independent vowel 'a' (no matra) -> append vowel as standalone char
//     if (key === "a") {
//       setSentenceTokens(prev => [...prev, { type: "vowel", base: info.char, matra: "" }]);
//       return;
//     }
//     // otherwise, try to attach matra to last consonant token
//     setSentenceTokens(prev => {
//       if (prev.length === 0) {
//         // no consonant to attach - append independent vowel letter
//         return [...prev, { type: "vowel", base: info.char, matra: "" }];
//       }
//       const last = prev[prev.length - 1];
//       if (last.type === "consonant") {
//         // attach matra
//         const newLast = { ...last, matra: info.matra };
//         return [...prev.slice(0, -1), newLast];
//       } else {
//         // last not consonant -> append independent vowel letter
//         return [...prev, { type: "vowel", base: info.char, matra: "" }];
//       }
//     });
//   }

//   function insertSpace() {
//     setSentenceTokens(prev => [...prev, { type: "space", base: " ", matra: "" }]);
//   }

//   // Add predicted label (model's prediction). The model probably outputs consonants; handle vowels/space if model returns such labels.
//   function addPredictedAsToken() {
//     const lbl = prediction.label;
//     if (!lbl || lbl === "nothing") return;
//     if (lbl === "space") {
//       insertSpace(); return;
//     }
//     // If predicted lbl is a Kannada vowel char matching any VOWEL_MATRAS char, treat as independent vowel
//     const vowelKey = Object.keys(VOWEL_MATRAS).find(k => VOWEL_MATRAS[k].char === lbl);
//     if (vowelKey) {
//       // if vowel is matra-type (not 'a') try attach; otherwise append independent
//       if (vowelKey === "a") {
//         setSentenceTokens(prev => [...prev, { type: "vowel", base: lbl, matra: "" }]);
//       } else {
//         // treat like user pressing that vowel key
//         insertVowelByKey(vowelKey);
//       }
//       return;
//     }
//     // else assume consonant
//     appendConsonant(lbl);
//   }

//   // Undo: remove last matra if present, else remove last token
//   function undoLast() {
//     setSentenceTokens(prev => {
//       if (prev.length === 0) return prev;
//       const last = prev[prev.length - 1];
//       if (last.type === "consonant" && last.matra && last.matra.length > 0) {
//         // remove matra only
//         const newLast = { ...last, matra: "" };
//         return [...prev.slice(0, -1), newLast];
//       }
//       // otherwise drop last token
//       return prev.slice(0, -1);
//     });
//   }

//   // Backspace: If last token is consonant with matra -> remove matra; else remove token; if vowel token that's independent, remove it
//   function backspace() {
//     setSentenceTokens(prev => {
//       if (prev.length === 0) return prev;
//       const last = prev[prev.length - 1];
//       if (last.type === "consonant" && last.matra) {
//         const newLast = { ...last, matra: "" };
//         return [...prev.slice(0, -1), newLast];
//       }
//       // else drop last token
//       return prev.slice(0, -1);
//     });
//   }

//   function clearSentence() {
//     setSentenceTokens([]);
//   }

//   // Auto-correct (simple): trim leading/trailing spaces, collapse multiple spaces, collapse triple char repeats
//   function autocorrect() {
//     setSentenceTokens(prev => {
//       // render to string, apply clean, then re-tokenize naively by characters
//       const s = renderSentence(prev);
//       let t = s.trim();
//       t = t.replace(/\s{2,}/g, " ");
//       t = t.replace(/(.)\1{2,}/g, "$1");
//       // re-tokenize: naive per-codepoint; try to group consonant+matra by checking matras
//       // We'll parse left->right building tokens: if codepoint is consonant then peek next codepoints if match matra
//       const tokens = [];
//       for (let i = 0; i < t.length; ++i) {
//         const ch = t[i];
//         if (isKannadaConsonantChar(ch)) {
//           // look ahead for matra (one code unit matra or combined) - we check next char and see if it's in known matra values
//           const next = t[i+1] || "";
//           // if next is any of matra chars -> attach
//           const matraKeys = Object.values(VOWEL_MATRAS).map(v=>v.matra).filter(Boolean);
//           if (next && matraKeys.includes(next)) {
//             tokens.push({ type: "consonant", base: ch, matra: next });
//             i++; // skip matra
//           } else {
//             tokens.push({ type: "consonant", base: ch, matra: "" });
//           }
//         } else if (ch === " ") {
//           tokens.push({ type: "space", base: " ", matra: "" });
//         } else {
//           // vowel independent or other char
//           tokens.push({ type: "vowel", base: ch, matra: "" });
//         }
//       }
//       return tokens;
//     });
//   }

//   // Rendered sentence string for UI
//   const sentenceString = renderSentence(sentenceTokens);

//   // --------------- TTS ---------------
//   async function speakBrowserAutoFallback() {
//     if (!sentenceString || sentenceString.trim().length === 0) { alert("No text to speak"); return; }

//     const tryBrowser = () => new Promise((resolve, reject) => {
//       try {
//         const utter = new SpeechSynthesisUtterance(sentenceString);
//         utter.lang = "kn-IN";
//         const voices = speechSynthesis.getVoices();
//         const kn = voices.find(v => v.lang && v.lang.startsWith("kn"));
//         if (!kn) return reject(new Error("No Kannada browser voice"));
//         utter.voice = kn;
//         utter.onend = () => resolve(true);
//         utter.onerror = (e) => reject(e);
//         speechSynthesis.speak(utter);
//         setTimeout(() => { if (!speechSynthesis.speaking) reject(new Error("Browser TTS did not start")); }, 2000);
//       } catch (e) { reject(e); }
//     });

//     if (speechSynthesis.getVoices().length === 0) {
//       await new Promise(res => {
//         const h = () => { speechSynthesis.removeEventListener("voiceschanged", h); res(); };
//         speechSynthesis.addEventListener("voiceschanged", h);
//         setTimeout(() => { try { speechSynthesis.removeEventListener("voiceschanged", h); res(); } catch {} }, 1200);
//       });
//     }

//     try {
//       await tryBrowser();
//       return;
//     } catch (e) {
//       console.warn("Browser TTS failed or not available, falling back to server gTTS:", e);
//       // server fallback
//       try {
//         const res = await fetch("http://127.0.0.1:8000/tts", {
//           method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: sentenceString })
//         });
//         if (!res.ok) throw new Error("TTS endpoint failed");
//         const j = await res.json();
//         const audio = new Audio("http://127.0.0.1:8000" + j.url);
//         audio.play();
//       } catch (err) {
//         console.error("Server TTS failed:", err);
//         alert("Both browser and server TTS failed. See console.");
//       }
//     }
//   }

//   // direct server fallback (POST)
//   async function speakServer() {
//     if (!sentenceString || sentenceString.trim().length === 0) { alert("No text to speak"); return; }
//     try {
//       const res = await fetch("http://127.0.0.1:8000/tts", {
//         method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: sentenceString })
//       });
//       if (!res.ok) { const t = await res.text(); throw new Error(t); }
//       const j = await res.json();
//       const audio = new Audio("http://127.0.0.1:8000" + j.url);
//       audio.play();
//     } catch (e) {
//       console.error("Server TTS error", e);
//       alert("Server TTS failed: " + (e.message || e));
//     }
//   }

//   // copy
//   function copySentence() {
//     navigator.clipboard.writeText(sentenceString || "").then(() => alert("Copied"));
//   }

//   // --------------- UI rendering ---------------
//   return (
//     <div style={{ fontFamily: "Arial, sans-serif", padding: 20, maxWidth: 1200, margin: "0 auto" }}>
//       <h1>Kannada SLR — Tokenized Composer</h1>

//       <div style={{ display: "flex", gap: 20 }}>
//         <div style={{ flex: "0 0 640px" }}>
//           <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
//             <div style={{
//               width: 14, height: 14, borderRadius: 7,
//               backgroundColor: connected ? "#2ecc71" : "#e74c3c",
//               boxShadow: connected ? "0 0 8px rgba(46,204,113,0.4)" : "none"
//             }} />
//             <div>{connected ? "WebSocket: Connected" : "WebSocket: Disconnected"}</div>
//           </div>

//           <div style={{ marginTop: 12 }}>
//             <video ref={videoRef} style={{ width: 640, height: 480, borderRadius: 8, border: "1px solid #ddd" }} autoPlay muted />
//             <canvas ref={canvasRef} style={{ display: "none" }} />
//           </div>
//         </div>

//         <div style={{ flex: 1 }}>
//           <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
//             <h3>Live Prediction & Controls</h3>
//             <div style={{ fontSize: 36, fontWeight: 700 }}>{prediction.label || "-"}</div>
//             <div style={{ marginTop: 8 }}>Confidence: {prediction.score || 0}%</div>
//             <div style={{ width: "100%", background: "#eee", height: 18, borderRadius: 9, marginTop: 8 }}>
//               <div style={{
//                 width: (prediction.score || 0) + "%",
//                 height: "100%",
//                 background: (prediction.score || 0) > 70 ? "#2ecc71" : ((prediction.score || 0) > 40 ? "#f1c40f" : "#e74c3c"),
//                 borderRadius: 9,
//                 transition: "width 200ms"
//               }} />
//             </div>

//             <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
//               <button onClick={addPredictedAsToken} style={{ padding: "8px 12px" }}>Add Predicted</button>
//               <button onClick={undoLast} style={{ padding: "8px 12px" }}>Undo</button>
//               <button onClick={backspace} style={{ padding: "8px 12px" }}>Backspace</button>
//               <button onClick={clearSentence} style={{ padding: "8px 12px" }}>Clear</button>
//               <button onClick={autocorrect} style={{ padding: "8px 12px" }}>Auto-correct</button>
//             </div>

//             <div style={{ marginTop: 12 }}>
//               <div style={{ fontSize: 14, color: "#333" }}>Constructed sentence</div>
//               <div style={{ minHeight: 60, padding: 10, border: "1px solid #ccc", borderRadius: 6, marginTop: 6, fontSize: 20 }}>
//                 {sentenceString || <span style={{ color: "#999" }}>No text yet</span>}
//               </div>

//               <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
//                 <button onClick={speakBrowserAutoFallback} style={{ padding: "8px 12px" }}>Play (browser or fallback)</button>
//                 <button onClick={speakServer} style={{ padding: "8px 12px" }}>Play (gTTS fallback)</button>
//                 <button onClick={copySentence} style={{ padding: "8px 12px" }}>Copy</button>
//               </div>
//             </div>
//           </div>

//           <div style={{ marginTop: 14, padding: 12, border: "1px solid #eee", borderRadius: 8 }}>
//             <h3>Consonant Keyboard</h3>
//             <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
//               {labels.length > 0 ? labels.map((lbl, idx) => (
//                 <button key={idx} onClick={() => appendConsonant(lbl)} style={{ padding: "8px 10px", minWidth: 44, borderRadius: 6 }}>{lbl}</button>
//               )) : <div>Loading consonants...</div>}
//             </div>
//           </div>

//           <div style={{ marginTop: 12, padding: 12, border: "1px solid #eee", borderRadius: 8 }}>
//             <h3>Vowel Keys (click to combine)</h3>
//             <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
//               {Object.keys(VOWEL_MATRAS).map(k => (
//                 <button key={k} onClick={() => insertVowelByKey(k)} style={{ padding: "8px 12px", borderRadius: 6 }}>
//                   {VOWEL_MATRAS[k].char}
//                 </button>
//               ))}
//               <button onClick={insertSpace} style={{ padding: "8px 12px", borderRadius: 6 }}>space</button>
//             </div>
//             <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>
//               Click a consonant then click a vowel to form vattakshara (consonant+vowel). Independent vowel (ಅ) inserts as standalone.
//             </div>
//           </div>

//           <div style={{ marginTop: 12 }}>
//             <label>Frame send interval (ms): </label>
//             <input type="number" value={sendingIntervalMs} onChange={(e) => { const v = Number(e.target.value) || 150; setSendingIntervalMs(v); startSendingFrames(); }} style={{ width: 80, marginLeft: 8 }} />
//             <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>Lower = more frames (higher CPU & bandwidth).</div>
//           </div>

//         </div>
//       </div>
//     </div>
//   );
// }



// // frontend/src/App.jsx (updated)
// import React, { useEffect, useRef, useState } from "react";

// export default function App() {
//   const videoRef = useRef(null);
//   const canvasRef = useRef(null);
//   const wsRef = useRef(null);
//   const intervalRef = useRef(null);

//   const [connected, setConnected] = useState(false);
//   const [predLetter, setPredLetter] = useState("");
//   const [prob, setProb] = useState(0);
//   const [sentence, setSentence] = useState("");
//   const [labels, setLabels] = useState([]);
//   const [sendingIntervalMs, setSendingIntervalMs] = useState(150);

//   useEffect(() => {
//     // fetch labels (copy idx2label.json into backend/static/)
//     fetch("/static/idx2label.json")
//       .then((r) => r.json())
//       .then((data) => {
//         const keys = Object.keys(data).sort((a,b)=>Number(a)-Number(b));
//         setLabels(keys.map(k => data[k]));
//       })
//       .catch(()=>setLabels([]));

//     connectWS();
//     startCamera();

//     // ensure we cleanup on unmount
//     return () => {
//       stopCamera();
//       disconnectWS();
//     };
//   }, []);

//   function connectWS() {
//     disconnectWS();
//     const ws = new WebSocket("ws://127.0.0.1:8000/ws/predict");
//     wsRef.current = ws;
//     ws.onopen = () => setConnected(true);
//     ws.onclose = () => setConnected(false);
//     ws.onerror = (e) => {
//       console.error("WS error", e);
//       setConnected(false);
//     };
//     ws.onmessage = (evt) => {
//       try {
//         const data = JSON.parse(evt.data);
//         if (data.prediction !== undefined) {
//           setPredLetter(data.prediction);
//           setProb(Math.round((data.score || 0) * 100));
//         }
//       } catch (e) {
//         console.error("WS parse error", e);
//       }
//     };
//   }

//   function disconnectWS() {
//     try {
//       if (wsRef.current) wsRef.current.close();
//     } catch(e){}
//     wsRef.current = null;
//     setConnected(false);
//   }

//   async function startCamera() {
//     try {
//       const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
//       videoRef.current.srcObject = stream;
//       await videoRef.current.play();
//       canvasRef.current.width = 640;
//       canvasRef.current.height = 480;
//       startSendingFrames();
//     } catch (e) {
//       console.error("Camera error", e);
//       alert("Camera access failed. Check permissions.");
//     }
//   }

//   function stopCamera() {
//     try {
//       const s = videoRef.current.srcObject;
//       if (s) s.getTracks().forEach(t => t.stop());
//       if (intervalRef.current) clearInterval(intervalRef.current);
//     } catch(e){}
//   }

//   function startSendingFrames() {
//     if (intervalRef.current) clearInterval(intervalRef.current);
//     intervalRef.current = setInterval(() => {
//       sendFrame();
//     }, sendingIntervalMs);
//   }

//   function sendFrame() {
//     if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
//     const canvas = canvasRef.current;
//     const ctx = canvas.getContext("2d");
//     ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
//     const dataURL = canvas.toDataURL("image/jpeg", 0.7);
//     try {
//       wsRef.current.send(JSON.stringify({ frame: dataURL }));
//     } catch (e) {
//       console.error("WS send error", e);
//     }
//   }

//   function addLetter() {
//     if (!predLetter || predLetter === "nothing") return;
//     if (predLetter === "space") setSentence(s => s + " ");
//     else setSentence(s => s + predLetter);
//   }

//   function clearSentence() {
//     setSentence("");
//   }

//   function autocorrectSentence() {
//     if (!sentence || sentence.trim().length === 0) {
//       alert("No sentence to correct");
//       return;
//     }
//     let s = sentence.trim();
//     // collapse runs of 3+ identical chars to single
//     s = s.replace(/(.)\1{2,}/g, "$1");
//     // collapse multiple spaces
//     s = s.replace(/\s{2,}/g, " ");
//     // remove stray non-printable chars
//     s = s.replace(/[^\S\r\n]+/g, " ").trim();
//     setSentence(s);
//     alert("Auto-correct applied");
//   }

//   // Browser TTS with voices availability handling
//   function speakBrowser() {
//     if (!sentence || sentence.trim().length === 0) {
//       alert("No text to speak");
//       return;
//     }
//     const speakNow = () => {
//       const utter = new SpeechSynthesisUtterance(sentence);
//       utter.lang = "kn-IN";
//       const voices = speechSynthesis.getVoices();
//       const kn = voices.find(v => v.lang && v.lang.startsWith("kn"));
//       if (kn) utter.voice = kn;
//       speechSynthesis.speak(utter);
//     };

//     // ensure voices loaded (some browsers load asynchronously)
//     const voices = speechSynthesis.getVoices();
//     if (voices.length > 0) {
//       speakNow();
//     } else {
//       // wait for 'voiceschanged'
//       const handler = () => {
//         speakNow();
//         speechSynthesis.removeEventListener("voiceschanged", handler);
//       };
//       speechSynthesis.addEventListener("voiceschanged", handler);
//       // fallback timeout: if voices not available after 1.5s notify
//       setTimeout(() => {
//         const v = speechSynthesis.getVoices();
//         if (!v.find(x => x.lang && x.lang.startsWith("kn"))) {
//           alert("No Kannada voice available in browser. Use gTTS fallback.");
//         }
//       }, 1500);
//     }
//   }

//   // Server-side gTTS fallback (POST JSON)
//   async function speakFallbackServer() {
//     if (!sentence || sentence.trim().length === 0) {
//       alert("No text to speak");
//       return;
//     }
//     try {
//       const res = await fetch("http://127.0.0.1:8000/tts", {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify({ text: sentence })
//       });
//       if (!res.ok) {
//         const txt = await res.text();
//         throw new Error("TTS failed: " + txt);
//       }
//       const j = await res.json();
//       if (!j.url) throw new Error("No url returned from server");
//       const audio = new Audio("http://127.0.0.1:8000" + j.url);
//       audio.play();
//     } catch (e) {
//       console.error("TTS fallback error", e);
//       alert("Server TTS failed: " + (e.message || e));
//     }
//   }

//   function insertLabel(lbl) {
//     if (lbl === "space") setSentence(s => s + " ");
//     else setSentence(s => s + lbl);
//   }

//   return (
//     <div style={{ fontFamily: "Arial, sans-serif", padding: 20, maxWidth: 1100, margin: "0 auto" }}>
//       <h1>Kannada Sign Language — Real-Time</h1>
//       <div style={{ display: "flex", gap: 20 }}>
//         <div>
//           <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
//             <div style={{
//               width: 14, height: 14, borderRadius: 7,
//               backgroundColor: connected ? "#2ecc71" : "#e74c3c",
//               boxShadow: connected ? "0 0 8px rgba(46,204,113,0.5)" : "none"
//             }} />
//             <div>{connected ? "WebSocket: Connected" : "WebSocket: Disconnected"}</div>
//           </div>

//           <div style={{ marginTop: 12 }}>
//             <video ref={videoRef} style={{ width: 560, height: 420, borderRadius: 8, border: "1px solid #ddd" }} autoPlay muted />
//             <canvas ref={canvasRef} style={{ display: "none" }} />
//           </div>
//         </div>

//         <div style={{ flex: 1 }}>
//           <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
//             <h3>Live Prediction</h3>
//             <div style={{ fontSize: 28, fontWeight: 700 }}>{predLetter || "-"}</div>
//             <div style={{ marginTop: 8 }}>Confidence: {prob}%</div>
//             <div style={{ width: "100%", background: "#eee", height: 18, borderRadius: 9, marginTop: 8 }}>
//               <div style={{
//                 width: `${prob}%`,
//                 height: "100%",
//                 background: prob > 70 ? "#2ecc71" : (prob > 40 ? "#f1c40f" : "#e74c3c"),
//                 borderRadius: 9,
//                 transition: "width 200ms"
//               }} />
//             </div>

//             <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
//               <button onClick={addLetter} style={{ padding: "8px 12px" }}>Add Letter</button>
//               <button onClick={autocorrectSentence} style={{ padding: "8px 12px" }}>Auto-correct</button>
//               <button onClick={clearSentence} style={{ padding: "8px 12px" }}>Clear Word</button>
//             </div>

//             <div style={{ marginTop: 12 }}>
//               <div style={{ fontSize: 14, color: "#333" }}>Constructed Word:</div>
//               <div style={{ minHeight: 40, padding: 10, border: "1px solid #ccc", borderRadius: 6, marginTop: 6 }}>
//                 {sentence || <span style={{ color: "#999" }}>No text yet</span>}
//               </div>

//               <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
//                 <button onClick={speakBrowser} style={{ padding: "8px 12px" }}>Play (Browser TTS)</button>
//                 <button onClick={speakFallbackServer} style={{ padding: "8px 12px" }}>Play (gTTS fallback)</button>
//                 <button onClick={() => { navigator.clipboard.writeText(sentence) }} style={{ padding: "8px 12px" }}>Copy</button>
//               </div>
//             </div>
//           </div>

//           <div style={{ marginTop: 14, padding: 12, border: "1px solid #eee", borderRadius: 8 }}>
//             <h3>Kannada Keyboard / Suggestions</h3>
//             <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
//               {labels.length > 0 ? labels.map((lbl, idx) =>
//                 <button key={idx} onClick={() => insertLabel(lbl)} style={{ padding: "8px 10px", minWidth: 44, borderRadius: 6 }}>
//                   {lbl}
//                 </button>
//               ) : <div>Loading labels...</div>}
//             </div>
//           </div>

//           <div style={{ marginTop: 14 }}>
//             <label>Frame send interval (ms): </label>
//             <input type="number" value={sendingIntervalMs} onChange={(e) => { setSendingIntervalMs(Number(e.target.value)); startSendingFrames(); }} style={{ width: 80, marginLeft: 8 }} />
//             <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>Lower → more frequent frames (more BW & CPU). Higher → less frequent.</div>
//           </div>

//         </div>
//       </div>
//     </div>
//   );
// }



// // frontend/src/App.jsx
// import React, { useEffect, useRef, useState } from "react";

// export default function App() {
//   const videoRef = useRef(null);
//   const canvasRef = useRef(null);
//   const wsRef = useRef(null);
//   const intervalRef = useRef(null);

//   const [connected, setConnected] = useState(false);
//   const [predLetter, setPredLetter] = useState("");
//   const [prob, setProb] = useState(0);
//   const [sentence, setSentence] = useState("");
//   const [labels, setLabels] = useState([]); // idx2label list
//   const [topSuggestions, setTopSuggestions] = useState([]);
//   const [sendingIntervalMs, setSendingIntervalMs] = useState(150);

//   useEffect(() => {
//     // fetch idx2label.json from backend static
//     fetch("/static/idx2label.json")
//       .then((r) => r.json())
//       .then((data) => {
//         // data may be {"0":"ಅ",...} etc - we convert to array by index order
//         const keys = Object.keys(data).sort((a,b)=>Number(a)-Number(b));
//         const arr = keys.map(k => data[k]);
//         setLabels(arr);
//       })
//       .catch(() => setLabels([]));
//     connectWS();
//     startCamera();

//     return () => {
//       stopCamera();
//       disconnectWS();
//     };
//   }, []);

//   function connectWS() {
//     const ws = new WebSocket("ws://127.0.0.1:8000/ws/predict");
//     wsRef.current = ws;
//     ws.onopen = () => { setConnected(true); console.log("WS open"); };
//     ws.onclose = () => { setConnected(false); console.log("WS closed"); };
//     ws.onerror = (e) => { setConnected(false); console.error("WS error", e); };
//     ws.onmessage = (evt) => {
//       try {
//         const data = JSON.parse(evt.data);
//         if (data.prediction !== undefined) {
//           setPredLetter(data.prediction);
//           setProb(Math.round(data.score * 100));
//           // leave top suggestions for future extension if backend sends them
//           setTopSuggestions([data.prediction]);
//         }
//       } catch (e) {
//         console.error("WS parse error", e);
//       }
//     }
//   }

//   function disconnectWS() {
//     try {
//       if (wsRef.current) wsRef.current.close();
//     } catch(e){}
//     wsRef.current = null;
//     setConnected(false);
//   }

//   async function startCamera() {
//     try {
//       const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
//       videoRef.current.srcObject = stream;
//       await videoRef.current.play();
//       // create hidden canvas same size
//       const canvas = canvasRef.current;
//       canvas.width = 640; canvas.height = 480;
//       startSendingFrames();
//     } catch (e) {
//       console.error("Camera error", e);
//     }
//   }

//   function stopCamera() {
//     try {
//       const stream = videoRef.current.srcObject;
//       if (stream) {
//         stream.getTracks().forEach(t => t.stop());
//       }
//       if (intervalRef.current) clearInterval(intervalRef.current);
//     } catch(e){}
//   }

//   function startSendingFrames() {
//     if (intervalRef.current) clearInterval(intervalRef.current);
//     intervalRef.current = setInterval(() => {
//       sendFrame();
//     }, sendingIntervalMs);
//   }

//   function sendFrame() {
//     if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
//     const canvas = canvasRef.current;
//     const ctx = canvas.getContext("2d");
//     ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
//     // get jpeg
//     const dataURL = canvas.toDataURL("image/jpeg", 0.7);
//     wsRef.current.send(JSON.stringify({ frame: dataURL }));
//   }

//   function addLetter() {
//     if (!predLetter || predLetter === "nothing") return;
//     if (predLetter === "space") setSentence(s => s + " ");
//     else setSentence(s => s + predLetter);
//   }

//   function clearSentence() {
//     setSentence("");
//   }

//   // Simple autocorrect function: trim, collapse repeats (aaa->a), remove stray non-chars
//   function autocorrectSentence() {
//     let s = sentence.trim();
//     // collapse 3+ repeats to single
//     s = s.replace(/(.)\1{2,}/g, "$1");
//     // collapse double spaces
//     s = s.replace(/\s{2,}/g, " ");
//     // you might add dictionary checks here
//     setSentence(s);
//   }

//   async function speakBrowser() {
//     if (!sentence) return;
//     // attempt Kannada voice
//     const utter = new SpeechSynthesisUtterance(sentence);
//     utter.lang = "kn-IN";
//     // pick a voice with kn-IN if available
//     const voices = speechSynthesis.getVoices();
//     const kn = voices.find(v => v.lang && v.lang.startsWith("kn"));
//     if (kn) utter.voice = kn;
//     // if no kn voice, still attempt — fallback handled below
//     speechSynthesis.speak(utter);
//     // if no kn voice installed, user can use fallback button (server-side)
//   }

//   async function speakFallbackServer() {
//     if (!sentence) return;
//     try {
//       const body = new URLSearchParams();
//       body.append("text", sentence);

//       const res = await fetch("/tts", { method: "POST", body });
//       const j = await res.json();
//       const url = j.url; // e.g. /static/tts/<uuid>.mp3
//       // play it
//       const audio = new Audio(url);
//       audio.play();
//     } catch (e) {
//       console.error("TTS fallback error", e);
//     }
//   }

//   // when user clicks a label in Kannada keyboard panel
//   function insertLabel(lbl) {
//     if (lbl === "space") setSentence(s => s + " ");
//     else setSentence(s => s + lbl);
//   }

//   return (
//     <div style={{fontFamily:"Arial, sans-serif", padding:20, maxWidth:1000, margin:"0 auto"}}>
//       <h1>Kannada Sign Language — Real-Time</h1>

//       <div style={{display:"flex", gap:20}}>
//         <div>
//           <div style={{display:"flex", alignItems:"center", gap:10}}>
//             <div style={{
//               width:14, height:14, borderRadius:7,
//               backgroundColor: connected ? "#2ecc71" : "#e74c3c",
//               boxShadow: connected ? "0 0 8px rgba(46,204,113,0.5)" : "none"
//             }} />
//             <div>{connected ? "WebSocket: Connected" : "WebSocket: Disconnected"}</div>
//           </div>

//           <div style={{marginTop:12}}>
//             <video ref={videoRef} style={{width:560, height:420, borderRadius:8, border:"1px solid #ddd"}} autoPlay muted />
//             <canvas ref={canvasRef} style={{display:"none"}} />
//           </div>
//         </div>

//         <div style={{flex:1}}>
//           <div style={{padding:12, border:"1px solid #ddd", borderRadius:8}}>
//             <h3>Live Prediction</h3>
//             <div style={{fontSize:28, fontWeight:700}}>{predLetter || "-"}</div>
//             <div style={{marginTop:8}}>Confidence: {prob}%</div>
//             <div style={{width:"100%", background:"#eee", height:18, borderRadius:9, marginTop:8}}>
//               <div style={{
//                 width:`${prob}%`,
//                 height:"100%",
//                 background: prob>70 ? "#2ecc71" : (prob>40 ? "#f1c40f" : "#e74c3c"),
//                 borderRadius:9,
//                 transition:"width 200ms"
//               }} />
//             </div>

//             <div style={{marginTop:12, display:"flex", gap:8}}>
//               <button onClick={addLetter} style={{padding:"8px 12px"}}>Add Letter</button>
//               <button onClick={autocorrectSentence} style={{padding:"8px 12px"}}>Auto-correct</button>
//               <button onClick={clearSentence} style={{padding:"8px 12px"}}>Clear Sentence</button>
//             </div>

//             <div style={{marginTop:12}}>
//               <div style={{fontSize:14, color:"#333"}}>Constructed sentence:</div>
//               <div style={{minHeight:40, padding:10, border:"1px solid #ccc", borderRadius:6, marginTop:6}}>
//                 {sentence || <span style={{color:"#999"}}>No text yet</span>}
//               </div>

//               <div style={{display:"flex", gap:8, marginTop:10}}>
//                 <button onClick={speakBrowser} style={{padding:"8px 12px"}}>Play (Browser TTS)</button>
//                 <button onClick={speakFallbackServer} style={{padding:"8px 12px"}}>Play (gTTS fallback)</button>
//                 <button onClick={() => { navigator.clipboard.writeText(sentence) }} style={{padding:"8px 12px"}}>Copy</button>
//               </div>
//             </div>
//           </div>

//           <div style={{marginTop:14, padding:12, border:"1px solid #eee", borderRadius:8}}>
//             <h3>Kannada Keyboard / Suggestions</h3>
//             <div style={{display:"flex", flexWrap:"wrap", gap:8}}>
//               {labels.length>0 ? labels.map((lbl, idx) =>
//                 <button key={idx} onClick={()=>insertLabel(lbl)} style={{padding:"8px 10px", minWidth:44, borderRadius:6}}>
//                   {lbl}
//                 </button>
//               ) : <div>Loading labels...</div>}
//             </div>
//           </div>

//           <div style={{marginTop:14, padding:12, border:"1px solid #eee", borderRadius:8}}>
//             <h3>Top suggestion</h3>
//             <div>{topSuggestions.length ? topSuggestions.join(", ") : "-"}</div>
//           </div>

//           <div style={{marginTop:14}}>
//             <label>Frame send interval (ms): </label>
//             <input type="number" value={sendingIntervalMs} onChange={(e)=>{ setSendingIntervalMs(Number(e.target.value)); startSendingFrames(); }} style={{width:80, marginLeft:8}} />
//             <div style={{fontSize:12, color:"#666", marginTop:6}}>Lower → more frequent frames (more BW & CPU). Higher → less frequent.</div>
//           </div>

//         </div>
//       </div>
//     </div>
//   );
// }


// import React, { useEffect, useRef, useState } from "react";

// export default function App() {
//   const videoRef = useRef(null);
//   const canvasRef = useRef(null);
//   const ws = useRef(null);

//   const [predLetter, setPredLetter] = useState("");
//   const [sentence, setSentence] = useState("");

//   useEffect(() => {
//     ws.current = new WebSocket("ws://127.0.0.1:8000/ws/predict");

//     ws.current.onmessage = (msg) => {
//       const data = JSON.parse(msg.data);
//       if (data.prediction) {
//         setPredLetter(data.prediction);
//       }
//     };

//     startCamera();
//   }, []);

//   const startCamera = async () => {
//     const stream = await navigator.mediaDevices.getUserMedia({
//       video: true,
//     });
//     videoRef.current.srcObject = stream;
//     videoRef.current.play();
//     sendFramesLoop();
//   };

//   const sendFramesLoop = () => {
//     const canvas = canvasRef.current;
//     const ctx = canvas.getContext("2d");

//     setInterval(() => {
//       ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
//       const dataURL = canvas.toDataURL("image/jpeg");

//       ws.current.send(JSON.stringify({ frame: dataURL }));
//     }, 150);
//   };

//   const addLetter = () => {
//     if (predLetter === "nothing") return;
//     if (predLetter === "space") {
//       setSentence((s) => s + " ");
//     } else {
//       setSentence((s) => s + predLetter);
//     }
//   };

//   const speakSentence = () => {
//     const utter = new SpeechSynthesisUtterance(sentence);
//     utter.lang = "kn-IN"; // Kannada voice (if available)
//     speechSynthesis.speak(utter);
//   };

//   return (
//     <div style={{ padding: "20px", fontFamily: "Arial" }}>
//       <h1>Kannada Sign Language Recognition</h1>

//       <video
//         ref={videoRef}
//         style={{ width: "400px", borderRadius: "10px" }}
//       ></video>

//       <canvas
//         ref={canvasRef}
//         width={400}
//         height={300}
//         style={{ display: "none" }}
//       ></canvas>

//       <h2>Predicted Letter: {predLetter}</h2>

//       <button onClick={addLetter} style={{ padding: "10px", marginRight: "10px" }}>
//         Add Letter
//       </button>

//       <button onClick={speakSentence} style={{ padding: "10px" }}>
//         Speak Sentence
//       </button>

//       <h3>Constructed Sentence:</h3>
//       <div
//         style={{
//           minHeight: "40px",
//           padding: "10px",
//           border: "1px solid gray",
//           borderRadius: "5px",
//         }}
//       >
//         {sentence}
//       </div>
//     </div>
//   );
// }
