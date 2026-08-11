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
  stateText: document.querySelector("#state span"),
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
let finalizing = false;
let recorderError;

elements.toggleKey.addEventListener("click", () => {
  const revealing = elements.apiKey.type === "password";
  elements.apiKey.type = revealing ? "text" : "password";
  elements.toggleKey.textContent = revealing ? "Hide" : "Show";
  elements.toggleKey.setAttribute("aria-label", revealing ? "Hide API key" : "Show API key");
});

elements.recordButton.addEventListener("click", toggleRecording);
elements.apiKey.addEventListener("input", updateKeyReadiness);
elements.liveMode.addEventListener("change", () => {
  if (recorder.isRecording) return;
  setNotice(elements.liveMode.checked
    ? "Live partials update about every 10 seconds, matching Groq's minimum billed duration."
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
  // Leaving the page is an explicit privacy boundary: stop capture and abort provider work
  // instead of keeping microphone/API activity alive in a hidden or closed tab.
  elements.apiKey.value = "";
  recorder.cancel();
  activeSession?.abort?.(new Error("Page closed"));
});

const recordingSupported = Boolean(globalThis.navigator?.mediaDevices?.getUserMedia && globalThis.MediaRecorder);
if (!recordingSupported) {
  elements.recordButton.disabled = true;
  elements.stateText.textContent = "Browser unsupported";
  setNotice("This browser cannot access MediaRecorder microphone capture. Try a current Chrome, Edge, Firefox, or Safari release.", true);
}

async function toggleRecording() {
  if (elements.recordButton.disabled || finalizing) return;
  if (recorder.isRecording) return stopAndTranscribe();
  return startRecording();
}

async function startRecording() {
  const apiKey = elements.apiKey.value.trim();
  if (!apiKey) {
    elements.stateText.textContent = "API key required";
    setNotice("Paste your Groq API key in the field on the left before recording.", true);
    elements.apiKey.focus();
    return;
  }

  try {
    setBusy(true, "Requesting microphone…");
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
        cleanup: elements.exactWording.checked ? { mode: "verbatim" } : { mode: "none" },
        context,
        onEvent: updateLiveState,
      });
      recorder = new BrowserLiveRecorder({
        windowMs: 10_000,
        overlapMs: 500,
        onWindow: (audio) => activeSession.push(audio),
        onError: handleRecorderError,
      });
    } else {
      activeSession = activePipeline.startSession(context);
      recorder = new BrowserRecorder();
    }

    setNotice("Requesting microphone access…");
    await recorder.start();
    startedAt = performance.now();
    timerId = window.setInterval(updateTimer, 50);
    setBusy(false);
    elements.recordButton.classList.add("recording");
    elements.visualizer.classList.add("active");
    elements.recordLabel.textContent = activeLiveMode ? "Stop & finish" : "Stop & transcribe";
    elements.stateText.textContent = "Listening";
    if (activeLiveMode) {
      elements.output.textContent = "Listening for the first live window…";
      elements.output.classList.add("empty", "streaming");
      setNotice("Keep speaking. Overlapping partial windows appear about every 10 seconds.");
    } else {
      setNotice("Speak naturally. You can correct yourself mid-sentence.");
    }
  } catch (error) {
    recorder.cancel();
    activeSession?.abort?.(error);
    showError(error);
    resetAfterRecording();
  }
}

async function stopAndTranscribe() {
  if (finalizing) return;
  finalizing = true;
  setFinalizingUi("Preparing audio");

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
    elements.stateText.textContent = "Complete";
    setNotice("Done. Your key remains only in this tab.");
  } catch (error) {
    if (activeLiveMode && recorderError && error === recorderError) {
      await preserveLiveResult(recorderError);
    } else {
      showError(error);
    }
  } finally {
    resetAfterRecording();
  }
}

async function handleRecorderError(error) {
  recorderError = error;
  // stopAndTranscribe owns finalization when a failure races with a user-requested stop.
  if (finalizing) return;
  finalizing = true;
  setFinalizingUi("Preserving partial transcript");
  try {
    await preserveLiveResult(error);
  } finally {
    resetAfterRecording();
  }
}

async function preserveLiveResult(error) {
  const session = activeSession;
  if (!activeLiveMode || !session) {
    showError(error);
    return false;
  }
  try {
    const result = await session.finish();
    if (!result.chunks.length) {
      showError(error);
      return false;
    }
    renderResult(result, {
      durationMs: Math.max(0, performance.now() - startedAt),
      windowCount: result.chunks.length,
    });
    elements.stateText.textContent = "Partial result preserved";
    setNotice(`${humanizeError(error instanceof Error ? error.message : "Recording stopped.")} The completed live windows were preserved.`, true);
    return true;
  } catch (finishError) {
    showError(finishError);
    return false;
  }
}

function updateLiveState(event) {
  if (event.type === "live.chunk.started") {
    elements.stateText.textContent = `Transcribing window ${event.sequence + 1}`;
  }
  if (event.type === "live.partial") {
    finalText = event.chunk.transcript;
    elements.output.textContent = finalText || "Listening…";
    elements.output.classList.toggle("empty", !finalText);
    elements.output.classList.add("streaming");
    elements.rawOutput.textContent = finalText || "No raw transcript yet.";
    elements.stateText.textContent = "Listening · live text updated";
  }
  if (event.type === "live.cleanup.started") elements.stateText.textContent = "Cleaning the full transcript";
}

function updatePipelineState(event) {
  const labels = {
    "transcription.started": "Transcribing with Whisper",
    "transcription.completed": "Cleaning the transcript",
    "cleanup.started": "Cleaning the transcript",
    "cleanup.completed": "Finishing",
  };
  if (labels[event.type]) elements.stateText.textContent = labels[event.type];
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
  window.clearInterval(timerId);
  elements.recordButton.classList.remove("recording");
  elements.visualizer.classList.remove("active");
  const message = error instanceof Error ? error.message : "Dictation failed.";
  elements.stateText.textContent = "Needs attention";
  setNotice(humanizeError(message), true);
  elements.recordButton.disabled = false;
  elements.recordButton.setAttribute("aria-busy", "false");
  elements.recordLabel.textContent = "Start dictating";
  elements.output.classList.remove("streaming");
}

function setFinalizingUi(state) {
  window.clearInterval(timerId);
  elements.recordButton.disabled = true;
  elements.recordButton.classList.remove("recording");
  elements.visualizer.classList.remove("active");
  elements.recordLabel.textContent = "Processing…";
  elements.stateText.textContent = state;
  elements.recordButton.setAttribute("aria-busy", "true");
}

function resetAfterRecording() {
  window.clearInterval(timerId);
  timerId = undefined;
  startedAt = 0;
  elements.timer.textContent = "00:00.0";
  elements.recordButton.disabled = !recordingSupported;
  elements.recordButton.setAttribute("aria-busy", "false");
  elements.recordButton.classList.remove("recording");
  elements.visualizer.classList.remove("active");
  elements.recordLabel.textContent = "Start dictating";
  activeSession = undefined;
  activePipeline = undefined;
  activeLiveMode = false;
  recorderError = undefined;
  finalizing = false;
}

function updateKeyReadiness() {
  if (recorder.isRecording || !recordingSupported) return;
  if (elements.apiKey.value.trim()) {
    elements.stateText.textContent = "Key ready";
    setNotice(elements.liveMode.checked
      ? "Ready for live partials. Your key remains only in this tab."
      : "Ready to record. Audio will be sent after you stop.");
  } else {
    elements.stateText.textContent = "Ready when you are";
    setNotice("Enter your key, then record a short message.");
  }
}

function setBusy(busy, label) {
  elements.recordButton.disabled = busy;
  elements.recordButton.setAttribute("aria-busy", String(busy));
  if (label) elements.recordLabel.textContent = label;
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
