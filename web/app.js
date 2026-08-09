import { BrowserRecorder } from "/library/browser-recorder.js";

const elements = {
  health: document.querySelector("#health"),
  button: document.querySelector("#record-button"),
  label: document.querySelector("#record-label"),
  state: document.querySelector("#state"),
  time: document.querySelector("#recording-time"),
  waveform: document.querySelector("#waveform"),
  language: document.querySelector("#language"),
  context: document.querySelector("#context"),
  notice: document.querySelector("#notice"),
  output: document.querySelector("#output"),
  raw: document.querySelector("#raw-output"),
  copy: document.querySelector("#copy-button"),
  total: document.querySelector("#total-latency"),
  modelMeta: document.querySelector("#model-meta"),
  audioMeta: document.querySelector("#audio-meta"),
};

let recorder = new BrowserRecorder();
let timer;
let startedAt = 0;
let finalText = "";
let groqConfigured = false;

await checkHealth();

elements.button.addEventListener("click", async () => {
  if (recorder.isRecording) {
    await stopAndTranscribe();
  } else {
    await startRecording();
  }
});

elements.copy.addEventListener("click", async () => {
  if (!finalText) return;
  await navigator.clipboard.writeText(finalText);
  const previous = elements.copy.textContent;
  elements.copy.textContent = "Copied";
  setTimeout(() => { elements.copy.textContent = previous; }, 1200);
});

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    groqConfigured = Boolean(health.groqConfigured);
    elements.health.classList.toggle("ready", groqConfigured);
    elements.health.classList.toggle("warning", !groqConfigured);
    elements.health.querySelector("span:last-child").textContent = groqConfigured
      ? "Groq connected"
      : "Groq key required";
    if (!groqConfigured) {
      elements.notice.textContent = "Add GROQ_API_KEY to .env, then restart the server to run a live benchmark.";
      elements.notice.classList.add("warning");
    }
  } catch {
    elements.health.classList.add("warning");
    elements.health.querySelector("span:last-child").textContent = "Backend unavailable";
  }
}

async function startRecording() {
  try {
    elements.notice.textContent = "Requesting microphone access…";
    await recorder.start();
    startedAt = performance.now();
    elements.button.classList.add("recording");
    elements.waveform.classList.add("active");
    elements.label.textContent = "Stop & transcribe";
    elements.state.textContent = "Listening";
    elements.notice.textContent = "Speak naturally. Filler words and self-corrections are cleaned after transcription.";
    timer = setInterval(updateTimer, 50);
  } catch (error) {
    showError(error.message || "Could not start the microphone.");
  }
}

async function stopAndTranscribe() {
  clearInterval(timer);
  elements.button.disabled = true;
  elements.button.classList.remove("recording");
  elements.waveform.classList.remove("active");
  elements.state.textContent = "Processing";
  elements.label.textContent = "Working…";

  try {
    const recording = await recorder.stop();
    const query = new URLSearchParams({
      language: elements.language.value,
      context: elements.context.value.trim(),
      fieldType: "document",
    });
    const requestStartedAt = performance.now();
    const response = await fetch(`/api/dictate?${query}`, {
      method: "POST",
      headers: {
        "Content-Type": recording.mimeType,
        "X-Audio-Filename": recording.filename,
      },
      body: recording.blob,
    });
    const responseReceivedAt = performance.now();
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed with HTTP ${response.status}`);

    const roundTripMs = responseReceivedAt - requestStartedAt;
    const networkOverheadMs = Math.max(0, roundTripMs - payload.timings.serverTotalMs);
    renderResult(payload, {
      recordingMs: recording.durationMs,
      networkOverheadMs,
      browserRoundTripMs: roundTripMs,
    });
    elements.state.textContent = "Complete";
    elements.notice.textContent = `Completed in ${formatMs(roundTripMs)} from upload to response.`;
  } catch (error) {
    showError(error.message || "Dictation failed.");
  } finally {
    elements.button.disabled = false;
    elements.label.textContent = "Start dictating";
  }
}

function renderResult(payload, clientTimings) {
  finalText = payload.text || "";
  elements.output.textContent = finalText || "No speech detected.";
  elements.output.classList.toggle("empty", !finalText);
  elements.raw.textContent = payload.rawTranscript || "No raw transcript.";
  elements.copy.disabled = !finalText;

  const metrics = { ...payload.timings, ...clientTimings };
  const displayedKeys = ["recordingMs", "requestParseMs", "transcriptionMs", "cleanupMs", "serverOverheadMs", "networkOverheadMs"];
  const maxValue = Math.max(1, ...displayedKeys.map((key) => Number(metrics[key] || 0)));
  for (const node of document.querySelectorAll(".metric")) {
    const value = Number(metrics[node.dataset.key] || 0);
    node.querySelector("strong").textContent = formatMs(value);
    node.querySelector("i").style.width = `${Math.max(value > 0 ? 2 : 0, (value / maxValue) * 100)}%`;
  }

  elements.total.textContent = `${formatMs(payload.timings.serverTotalMs)} server · ${formatMs(clientTimings.browserRoundTripMs)} round trip`;
  elements.modelMeta.textContent = `${payload.transcriptionModel} → ${payload.cleanupModel || "no cleanup"}`;
  elements.audioMeta.textContent = `${formatBytes(payload.audio.bytes)} · ${payload.audio.mimeType}`;
}

function updateTimer() {
  const elapsed = performance.now() - startedAt;
  const seconds = elapsed / 1000;
  elements.time.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}.${Math.floor((seconds % 1) * 10)}`;
}

function showError(message) {
  elements.state.textContent = "Error";
  elements.notice.textContent = message;
  elements.notice.classList.add("warning");
}

function formatMs(value) {
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}
