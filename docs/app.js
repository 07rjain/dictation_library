import {
  BrowserRecorder,
  DictationPipeline,
} from "https://esm.sh/groq-dictation-kit@0.1.0?bundle&target=es2022";

const elements = {
  apiKey: document.querySelector("#api-key"),
  toggleKey: document.querySelector("#toggle-key"),
  model: document.querySelector("#model"),
  language: document.querySelector("#language"),
  context: document.querySelector("#context"),
  exactWording: document.querySelector("#exact-wording"),
  recordButton: document.querySelector("#record-button"),
  recordLabel: document.querySelector("#record-button span"),
  state: document.querySelector("#state span"),
  timer: document.querySelector("#timer"),
  visualizer: document.querySelector("#visualizer"),
  notice: document.querySelector("#notice"),
  output: document.querySelector("#output"),
  rawOutput: document.querySelector("#raw-output"),
  copyButton: document.querySelector("#copy-button"),
  totalTime: document.querySelector("#total-time"),
  runMeta: document.querySelector("#run-meta"),
};

let recorder = new BrowserRecorder();
let activeSession;
let activePipeline;
let timerId;
let startedAt = 0;
let finalText = "";

elements.toggleKey.addEventListener("click", () => {
  const revealing = elements.apiKey.type === "password";
  elements.apiKey.type = revealing ? "text" : "password";
  elements.toggleKey.textContent = revealing ? "Hide" : "Show";
  elements.toggleKey.setAttribute("aria-label", revealing ? "Hide API key" : "Show API key");
});

elements.recordButton.addEventListener("click", toggleRecording);
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat || isTypingTarget(event.target)) return;
  event.preventDefault();
  toggleRecording();
});

elements.copyButton.addEventListener("click", async () => {
  if (!finalText) return;
  await navigator.clipboard.writeText(finalText);
  elements.copyButton.textContent = "Copied";
  window.setTimeout(() => { elements.copyButton.textContent = "Copy text"; }, 1200);
});

window.addEventListener("pagehide", () => {
  elements.apiKey.value = "";
  recorder.cancel();
});

async function toggleRecording() {
  if (elements.recordButton.disabled) return;
  if (recorder.isRecording) return stopAndTranscribe();
  return startRecording();
}

async function startRecording() {
  const apiKey = elements.apiKey.value.trim();
  if (!apiKey) {
    setNotice("Enter your Groq API key before recording.", true);
    elements.apiKey.focus();
    return;
  }

  try {
    activePipeline = new DictationPipeline({
      apiKey,
      dangerouslyAllowBrowser: true,
      transcriptionModel: elements.model.value,
      onEvent: updatePipelineState,
    });
    activeSession = activePipeline.startSession({
      appName: "Groq Dictation Kit demo",
      fieldType: "document",
      activity: elements.context.value.trim() || "Writing a message",
    });

    setNotice("Requesting microphone access…");
    await recorder.start();
    startedAt = performance.now();
    timerId = window.setInterval(updateTimer, 50);
    elements.recordButton.classList.add("recording");
    elements.visualizer.classList.add("active");
    elements.recordLabel.textContent = "Stop & transcribe";
    elements.state.textContent = "Listening";
    setNotice("Speak naturally. You can correct yourself mid-sentence.");
  } catch (error) {
    showError(error);
  }
}

async function stopAndTranscribe() {
  window.clearInterval(timerId);
  elements.recordButton.disabled = true;
  elements.recordButton.classList.remove("recording");
  elements.visualizer.classList.remove("active");
  elements.recordLabel.textContent = "Processing…";
  elements.state.textContent = "Preparing audio";

  try {
    const recording = await recorder.stop();
    const result = await activeSession.finish(
      { data: recording.blob, filename: recording.filename },
      {
        transcriptionModel: elements.model.value,
        language: elements.language.value || undefined,
        preserveExactWording: elements.exactWording.checked,
      },
    );
    renderResult(result, recording);
    elements.state.textContent = "Complete";
    setNotice("Done. Your key remains only in this tab.");
  } catch (error) {
    showError(error);
  } finally {
    elements.recordButton.disabled = false;
    elements.recordLabel.textContent = "Start dictating";
    activeSession = undefined;
    activePipeline = undefined;
  }
}

function updatePipelineState(event) {
  const labels = {
    "transcription.started": "Transcribing with Whisper",
    "transcription.completed": "Cleaning the transcript",
    "cleanup.started": "Cleaning the transcript",
    "cleanup.completed": "Finishing",
  };
  if (labels[event.type]) elements.state.textContent = labels[event.type];
}

function renderResult(result, recording) {
  finalText = result.text;
  elements.output.textContent = finalText || "No speech detected.";
  elements.output.classList.toggle("empty", !finalText);
  elements.rawOutput.textContent = result.rawTranscript || "No raw transcript.";
  elements.copyButton.disabled = !finalText;

  const timings = { ...result.timings, recordingMs: recording.durationMs };
  const keys = ["recordingMs", "transcriptionMs", "cleanupMs", "totalMs"];
  const max = Math.max(1, ...keys.map((key) => Number(timings[key] || 0)));
  for (const metric of document.querySelectorAll(".metric")) {
    const value = Number(timings[metric.dataset.key] || 0);
    metric.querySelector("b").textContent = formatMs(value);
    metric.querySelector("i").style.width = `${Math.max(value ? 2 : 0, value / max * 100)}%`;
  }
  elements.totalTime.textContent = `${formatMs(result.timings.totalMs)} pipeline`;
  elements.runMeta.textContent = `${result.transcriptionModel} → ${result.cleanupModel || "raw transcript"} · ${formatBytes(recording.blob.size)} ${recording.mimeType}`;
}

function updateTimer() {
  const seconds = (performance.now() - startedAt) / 1000;
  elements.timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}.${Math.floor((seconds % 1) * 10)}`;
}

function showError(error) {
  const message = error instanceof Error ? error.message : "Dictation failed.";
  elements.state.textContent = "Needs attention";
  setNotice(humanizeError(message), true);
  elements.recordButton.disabled = false;
  elements.recordLabel.textContent = "Start dictating";
}

function humanizeError(message) {
  if (/401|invalid api key|authentication/i.test(message)) return "Groq rejected this API key. Check the key and try again.";
  if (/429|rate limit/i.test(message)) return "This Groq account is rate-limited. Wait briefly and try again.";
  if (/permission|notallowed/i.test(message)) return "Microphone permission was denied. Allow it in your browser settings and retry.";
  return message;
}

function setNotice(message, isError = false) {
  elements.notice.textContent = message;
  elements.notice.classList.toggle("error", isError);
}

function formatMs(value) {
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}

function formatBytes(value) {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;
}

function isTypingTarget(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
}
