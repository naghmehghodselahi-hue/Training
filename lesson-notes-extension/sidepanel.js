// Lesson Notes side panel.
// Flow: capture tab audio -> cut into short parts -> speech to text (OpenAI)
// -> transcript -> structured study notes and Q&A (Claude).

const $ = (id) => document.getElementById(id);

const SEGMENT_SECONDS = 180; // each audio part sent for transcription
const SILENCE_PEAK = 0.01;   // parts quieter than this are skipped (avoids made-up text on silence)

const DEFAULTS = {
  openaiKey: "",
  anthropicKey: "",
  sttModel: "gpt-4o-transcribe",
  claudeModel: "claude-sonnet-5-5",
  language: "fa",
  speed: "1",
  vocab: "",
  goal: "",
  outputLang: "fa",
};
const SETTING_IDS = Object.keys(DEFAULTS);

const rec = {
  active: false,
  stream: null,
  audioCtx: null,
  analyser: null,
  recorder: null,
  startMs: 0,
  segStartMs: 0,
  segPeak: 0,
  segIndex: 0,
  speed: 1,
  segTimer: null,
  uiTimer: null,
  queue: Promise.resolve(),
  pending: 0,
  failed: [],
};

let segments = []; // [{ start: seconds in video time, text }]
let notesMarkdown = "";

// ---------- helpers ----------

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function getSettings() {
  const s = {};
  for (const id of SETTING_IDS) s[id] = $(id).value.trim();
  return s;
}

async function saveSettings() {
  await chrome.storage.local.set({ settings: getSettings() });
}

function renderTranscript() {
  segments.sort((a, b) => a.start - b.start);
  $("transcript").value = segments.map((s) => `[${fmtTime(s.start)}] ${s.text}`).join("\n");
  persist();
}

function persist() {
  chrome.storage.local.set({
    transcript: $("transcript").value,
    notes: notesMarkdown,
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Small, safe markdown renderer: headings, lists, bold, inline code, paragraphs.
function renderMarkdown(src) {
  const inline = (t) =>
    escapeHtml(t)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of src.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      closeList();
      const lvl = Math.min(m[1].length, 3);
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join("\n");
}

// ---------- speech to text ----------

async function transcribePart(part) {
  const s = getSettings();
  if (!s.openaiKey) throw new Error("Add your OpenAI API key in Settings.");

  const previous = segments.length ? segments[segments.length - 1].text.slice(-200) : "";
  const prompt = [s.vocab, previous].filter(Boolean).join(" ").slice(-400);

  const fd = new FormData();
  fd.append("file", part.blob, `part-${part.index}.webm`);
  fd.append("model", s.sttModel);
  if (s.language !== "auto") fd.append("language", s.language);
  if (prompt) fd.append("prompt", prompt);
  const verbose = s.sttModel === "whisper-1";
  fd.append("response_format", verbose ? "verbose_json" : "json");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${s.openaiKey}` },
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Transcription failed (${res.status})`);

  if (verbose && Array.isArray(data.segments) && data.segments.length) {
    for (const seg of data.segments) {
      const text = (seg.text || "").trim();
      if (text) segments.push({ start: part.offset + seg.start * part.speed, text });
    }
  } else if ((data.text || "").trim()) {
    segments.push({ start: part.offset, text: data.text.trim() });
  }
  renderTranscript();
}

function enqueue(part) {
  rec.pending++;
  rec.queue = rec.queue.then(async () => {
    try {
      await transcribePart(part);
    } catch (err) {
      rec.failed.push(part);
      $("retryBtn").hidden = false;
      setStatus(`Part ${part.index + 1} failed: ${err.message}`, true);
    } finally {
      rec.pending--;
      updateProgressStatus();
    }
  });
}

function updateProgressStatus() {
  if (rec.active) {
    setStatus(`Recording. ${rec.pending ? `Transcribing ${rec.pending} part(s)...` : "Transcript is up to date."}`);
  } else if (rec.pending) {
    setStatus(`Finishing transcription of ${rec.pending} part(s)...`);
  } else if (!rec.failed.length) {
    setStatus(segments.length ? "Transcript ready. You can edit it, then create notes." : "Stopped. No speech detected.");
  }
}

// ---------- recording ----------

async function getTargetTabId() {
  const { targetTabId } = await chrome.storage.session.get("targetTabId");
  if (targetTabId) return targetTabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function startSegment() {
  rec.segStartMs = Date.now();
  rec.segPeak = 0;
  const chunks = [];
  const recorder = new MediaRecorder(rec.stream, {
    mimeType: "audio/webm;codecs=opus",
    audioBitsPerSecond: 32000,
  });
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const index = rec.segIndex++;
    const offset = ((rec.segStartMs - rec.startMs) / 1000) * rec.speed;
    const peak = rec.segPeak;
    if (rec.active) startSegment(); // start next part straight away
    if (chunks.length && peak >= SILENCE_PEAK) {
      enqueue({ blob: new Blob(chunks, { type: "audio/webm" }), offset, index, speed: rec.speed });
    }
    updateProgressStatus();
  };
  recorder.start();
  rec.recorder = recorder;
  rec.segTimer = setTimeout(() => recorder.state !== "inactive" && recorder.stop(), SEGMENT_SECONDS * 1000);
}

async function startRecording() {
  const s = getSettings();
  if (!s.openaiKey) {
    $("settingsBox").open = true;
    setStatus("Add your OpenAI API key in Settings first.", true);
    return;
  }
  try {
    const targetTabId = await getTargetTabId();
    if (!targetTabId) throw new Error("No tab selected.");
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId });
    rec.stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false,
    });
  } catch (err) {
    setStatus(
      `Couldn't capture the tab: ${err.message}. Go to the video tab, click the Lesson Notes icon in the toolbar, then press Start again.`,
      true
    );
    return;
  }

  // Capturing mutes the tab, so route the audio back to the speakers.
  rec.audioCtx = new AudioContext();
  const source = rec.audioCtx.createMediaStreamSource(rec.stream);
  source.connect(rec.audioCtx.destination);
  rec.analyser = rec.audioCtx.createAnalyser();
  rec.analyser.fftSize = 2048;
  source.connect(rec.analyser);
  const buf = new Float32Array(rec.analyser.fftSize);

  rec.active = true;
  rec.speed = parseFloat(s.speed) || 1;
  rec.startMs = Date.now();
  rec.segIndex = 0;
  rec.failed = [];
  $("retryBtn").hidden = true;
  $("transcript").readOnly = true;
  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;
  for (const id of ["speed", "language", "sttModel"]) $(id).disabled = true;

  rec.uiTimer = setInterval(() => {
    $("timer").textContent = fmtTime((Date.now() - rec.startMs) / 1000);
    rec.analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    rec.segPeak = Math.max(rec.segPeak, peak);
    $("level").firstElementChild.style.width = `${Math.min(100, peak * 200)}%`;
  }, 250);

  startSegment();
  setStatus("Recording. Press play on the video now.");
}

function stopRecording() {
  if (!rec.active) return;
  rec.active = false;
  clearTimeout(rec.segTimer);
  clearInterval(rec.uiTimer);
  if (rec.recorder && rec.recorder.state !== "inactive") rec.recorder.stop();
  rec.stream?.getTracks().forEach((t) => t.stop());
  // Close audio a moment later so the last part's data is flushed first.
  setTimeout(() => rec.audioCtx?.close(), 500);
  $("level").firstElementChild.style.width = "0";
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
  $("transcript").readOnly = false;
  for (const id of ["speed", "language", "sttModel"]) $(id).disabled = false;
  updateProgressStatus();
}

function retryFailed() {
  const parts = rec.failed.splice(0);
  $("retryBtn").hidden = true;
  parts.forEach(enqueue);
  updateProgressStatus();
}

// ---------- Claude ----------

async function callClaude(system, userText, maxTokens = 6000) {
  const s = getSettings();
  if (!s.anthropicKey) {
    $("settingsBox").open = true;
    throw new Error("Add your Anthropic API key in Settings.");
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": s.anthropicKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: s.claudeModel || DEFAULTS.claudeModel,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Claude request failed (${res.status})`);
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

function notesSystemPrompt(outputLang) {
  const lang = outputLang === "fa" ? "Persian (Farsi), natural and clear, keeping technical English terms in English where professionals would" : "clear, natural English";
  return `You are an experienced instructional designer turning a video transcript into study notes for an adult professional learner.

The transcript was produced by automatic speech recognition, so it may contain misheard words, especially in Persian or with technical English terms. Infer the intended meaning from context when it is obvious. When something is genuinely unclear, say so instead of guessing.

Rules:
- Use only what is in the transcript. Do not add facts, examples or advice the speaker did not give. If you add a brief clarification of your own, label it "(my note)".
- Lines start with [mm:ss] timestamps. Cite the timestamp for examples, frameworks and important claims, like (12:40).
- Prefer the speaker's concrete examples over generic restatements.
- Skip filler, greetings, sponsor messages and repetition.
- Write in ${lang}. Use markdown headings and bullet lists. No emojis.

Structure:
## Summary
3 to 5 sentences: what the video teaches and its main argument.
## Learning objectives
What a learner should be able to do after this video, as action verbs.
## Key concepts
Each concept in bold with a one or two sentence definition as the speaker uses it.
## Frameworks, models and steps
Any process, method or model, with its steps in order. Omit this section if there are none.
## Examples and cases
The speaker's examples, each with its timestamp and the point it illustrates.
## Practical takeaways
Concrete things the learner can apply.
## Review questions
4 to 6 questions that check understanding (not just recall), each followed by a short answer based on the video.
## Unclear parts
Places where the transcript was unclear or likely misheard, with timestamps. Omit if none.`;
}

async function createNotes() {
  const transcript = $("transcript").value.trim();
  if (!transcript) return setStatus("There is no transcript yet.", true);
  const s = getSettings();
  const btn = $("notesBtn");
  btn.disabled = true;
  setStatus("Creating study notes...");
  try {
    const goal = s.goal ? `\n\nThe learner's goal for this video: ${s.goal}\nGive extra attention to what serves this goal.` : "";
    notesMarkdown = await callClaude(
      notesSystemPrompt(s.outputLang),
      `Video: ${$("target").dataset.title || "unknown title"}${goal}\n\n<transcript>\n${transcript}\n</transcript>`
    );
    $("notes").innerHTML = renderMarkdown(notesMarkdown);
    persist();
    setStatus("Notes ready.");
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function ask() {
  const q = $("question").value.trim();
  const transcript = $("transcript").value.trim();
  if (!q) return;
  if (!transcript) return setStatus("There is no transcript yet.", true);
  const btn = $("askBtn");
  btn.disabled = true;
  $("answer").textContent = "Thinking...";
  try {
    const answer = await callClaude(
      "Answer the learner's question using only the video transcript provided. Cite [mm:ss] timestamps for the parts you rely on. If the video does not cover it, say so plainly. The transcript comes from speech recognition and may contain errors. Answer in the same language as the question. No emojis.",
      `<transcript>\n${transcript}\n</transcript>\n\nQuestion: ${q}`,
      2000
    );
    $("answer").innerHTML = renderMarkdown(answer);
  } catch (err) {
    $("answer").textContent = "";
    setStatus(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------- export ----------

async function copyNotes() {
  if (!notesMarkdown) return setStatus("Create notes first.", true);
  await navigator.clipboard.writeText(notesMarkdown);
  setStatus("Notes copied.");
}

function downloadNotes() {
  const transcript = $("transcript").value.trim();
  if (!notesMarkdown && !transcript) return setStatus("Nothing to download yet.", true);
  const title = $("target").dataset.title || "video";
  const md = `# ${title}\n\n${notesMarkdown || "(no notes yet)"}\n\n---\n\n## Full transcript\n\n${transcript}\n`;
  const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80).trim() || "notes"}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clearAll() {
  if (rec.active) return;
  if (!confirm("Clear the transcript, notes and answer?")) return;
  segments = [];
  notesMarkdown = "";
  $("transcript").value = "";
  $("notes").innerHTML = "";
  $("answer").innerHTML = "";
  rec.failed = [];
  $("retryBtn").hidden = true;
  persist();
  setStatus("");
}

// ---------- init ----------

// Turn "[mm:ss] text" lines back into segments. Lines without a timestamp
// join the previous segment, so pasted or edited text is never lost.
function parseTranscript(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\[(\d{1,2}(?::\d{2}){1,2})\]\s?(.*)$/);
    if (m) {
      const sec = m[1].split(":").reduce((acc, n) => acc * 60 + Number(n), 0);
      out.push({ start: sec, text: m[2] });
    } else if (line.trim()) {
      if (out.length) out[out.length - 1].text += `\n${line}`;
      else out.push({ start: 0, text: line });
    }
  }
  return out;
}

async function showTarget() {
  const { targetTitle } = await chrome.storage.session.get("targetTitle");
  if (targetTitle) {
    $("target").textContent = `Video tab: ${targetTitle}`;
    $("target").dataset.title = targetTitle;
  }
}

async function init() {
  const stored = await chrome.storage.local.get(["settings", "transcript", "notes"]);
  const settings = { ...DEFAULTS, ...(stored.settings || {}) };
  for (const id of SETTING_IDS) $(id).value = settings[id];
  if (!settings.openaiKey || !settings.anthropicKey) $("settingsBox").open = true;

  $("transcript").value = stored.transcript || "";
  notesMarkdown = stored.notes || "";
  if (notesMarkdown) $("notes").innerHTML = renderMarkdown(notesMarkdown);
  segments = parseTranscript($("transcript").value);

  await showTarget();
  chrome.storage.session.onChanged.addListener(showTarget);

  for (const id of SETTING_IDS) $(id).addEventListener("change", saveSettings);
  $("transcript").addEventListener("input", () => {
    // Keep edits (or a pasted transcript) when a new recording appends to it.
    segments = parseTranscript($("transcript").value);
    persist();
  });
  $("startBtn").addEventListener("click", startRecording);
  $("stopBtn").addEventListener("click", stopRecording);
  $("retryBtn").addEventListener("click", retryFailed);
  $("notesBtn").addEventListener("click", createNotes);
  $("askBtn").addEventListener("click", ask);
  $("question").addEventListener("keydown", (e) => { if (e.key === "Enter") ask(); });
  $("copyBtn").addEventListener("click", copyNotes);
  $("downloadBtn").addEventListener("click", downloadNotes);
  $("clearBtn").addEventListener("click", clearAll);
}

init();
