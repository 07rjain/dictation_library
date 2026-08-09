import {
  BrowserLiveRecorder,
  BrowserRecorder,
  DictationPipeline,
} from "./library/index.js";

const elements = {
  apiKey: document.querySelector("#api-key"),
  toggleKey: document.querySelector("#toggle-key"),
  model: document.querySelector("#model"),
  language: document.querySelector("#language"),
  context: document.querySelector("#context"),
  exactWording: document.querySelector("#exact-wording"),
  liveMode: document.querySelector("#live-mode"),
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
let activeLiveMode = false;
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
elements.liveMode.addEventListener("change", () => {
  if (recorder.isRecording) return;
  setNotice(elements.liveMode.checked
    ? "Live partials will update about every 5 seconds. Short windows create more Groq requests."
    : "Single-upload mode sends audio only after you stop recording.");
});
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
    activeLiveMode = elements.liveMode.checked;
    const context = {
      appName: "Groq Dictation Kit demo",
      fieldType: "document",
      activity: elements.context.value.trim() || "Writing a message",
    };
    if (activeLiveMode) {
      activeSession = activePipeline.startLiveConversation({
        transcriptionModel: elements.model.value,
        language: elements.language.value || undefined,
        preserveExactWording: elements.exactWording.checked,
        context,
        onEvent: updateLiveState,
      });
      recorder = new BrowserLiveRecorder({
        windowMs: 5_000,
        onWindow: (audio) => activeSession.push(audio),
      });
    } else {
      activeSession = activePipeline.startSession(context);
      recorder = new BrowserRecorder();
    }

    setNotice("Requesting microphone access…");
    await recorder.start();
    startedAt = performance.now();
    timerId = window.setInterval(updateTimer, 50);
    elements.recordButton.classList.add("recording");
    elements.visualizer.classList.add("active");
    elements.recordLabel.textContent = activeLiveMode ? "Stop & finish" : "Stop & transcribe";
    elements.state.textContent = "Listening";
    if (activeLiveMode) {
      elements.output.textContent = "Listening for the first live window…";
      elements.output.classList.add("empty", "streaming");
      setNotice("Keep speaking. Partial text will appear about every 5 seconds.");
    } else {
      setNotice("Speak naturally. You can correct yourself mid-sentence.");
    }
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
    const result = activeLiveMode
      ? await activeSession.finish()
      : await activeSession.finish(
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
    activeLiveMode = false;
  }
}

function updateLiveState(event) {
  if (event.type === "live.chunk.started") {
    elements.state.textContent = `Transcribing window ${event.sequence + 1}`;
  }
  if (event.type === "live.partial") {
    finalText = event.chunk.transcript;
    elements.output.textContent = finalText || "Listening…";
    elements.output.classList.toggle("empty", !finalText);
    elements.output.classList.add("streaming");
    elements.rawOutput.textContent = finalText || "No raw transcript yet.";
    elements.state.textContent = "Listening · live text updated";
  }
  if (event.type === "live.cleanup.started") elements.state.textContent = "Cleaning the full transcript";
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
  elements.output.classList.remove("streaming");
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
    metric.querySelector("i").style.transform = `scaleX(${value ? Math.max(0.02, value / max) : 0})`;
  }
  elements.totalTime.textContent = `${formatMs(result.timings.totalMs)} pipeline`;
  const audioMeta = "blob" in recording
    ? `${formatBytes(recording.blob.size)} ${recording.mimeType}`
    : `${recording.windowCount} live window${recording.windowCount === 1 ? "" : "s"}`;
  elements.runMeta.textContent = `${result.transcriptionModel} → ${result.cleanupModel || "raw transcript"} · ${audioMeta}`;
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
  elements.output.classList.remove("streaming");
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
