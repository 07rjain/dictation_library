import { DictationError } from "../dist/index.js";

const apiKey = process.env.GROQ_API_KEY?.trim();
if (!apiKey) throw new Error("GROQ_API_KEY is required.");

const flags = new Set(process.argv.slice(2));
const runAll = flags.has("--all");
const runDirect = runAll || flags.size === 0 || flags.has("--direct-25");
const runBase64 = runAll || flags.has("--base64-100");
const runTemporaryUrl = runAll || flags.has("--temporary-url-100");
const runTemporaryUrl25 = runAll || flags.has("--temporary-url-25");
const runDuration = runAll || flags.has("--duration");
const runUrls = runAll || flags.size === 0 || flags.has("--urls");
const tier = process.env.GROQ_ACCOUNT_TIER?.trim().toLowerCase();
const results = [];

if (runDirect) {
  await probeGenerated("direct-below-25-mib", 25 * 1024 * 1024 - 8 * 1024, "file");
  await probeGenerated("direct-above-25-mib", 25 * 1024 * 1024 + 8 * 1024, "file");
}

if (runBase64) {
  await probeGenerated("base64-below-100-mib", 100 * 1024 * 1024 - 8 * 1024, "base64");
  await probeGenerated("base64-above-100-mib", 100 * 1024 * 1024 + 8 * 1024, "base64");
}

if (runTemporaryUrl) {
  await withTemporaryAudio("url-below-100-mib", 100 * 1024 * 1024 - 8 * 1024);
  await withTemporaryAudio("url-above-100-mib", 100 * 1024 * 1024 + 8 * 1024);
}

if (runTemporaryUrl25) {
  await withTemporaryAudio("url-below-25-mib", 25 * 1024 * 1024 - 8 * 1024);
  await withTemporaryAudio("url-above-25-mib", 25 * 1024 * 1024 + 8 * 1024);
}

if (runDuration) {
  const tenMinutes = createWavForDuration(10 * 60, 16_000, 1, 16);
  await probe("direct-ten-minute-duration", "file", tenMinutes);
}

if (runUrls) {
  await probeUrl(
    "public-url",
    process.env.GROQ_BOUNDARY_URL ?? "https://raw.githubusercontent.com/07rjain/dictation_library/main/test.wav",
    true,
  );
  await probeUrl(
    "redirect-url",
    process.env.GROQ_REDIRECT_URL ?? "https://github.com/07rjain/dictation_library/raw/main/test.wav",
    process.env.GROQ_REDIRECT_EXPECTED?.trim().toLowerCase() === "success",
  );
  await optionalUrl("expired-signed-url", process.env.GROQ_EXPIRED_SIGNED_URL, false);
  await optionalUrl("range-required-url", process.env.GROQ_RANGE_URL, true);
  await optionalUrl("slow-provider-fetch-url", process.env.GROQ_FETCH_TIMEOUT_URL, false);
  await optionalUrl("long-duration-url", process.env.GROQ_LONG_DURATION_URL, true);
}

validateKnownExpectations(results, tier);
console.log(JSON.stringify({
  observedAt: new Date().toISOString(),
  accountTier: tier ?? "unspecified",
  note: "Base64 probes exercise Groq's documented URL/base64 path; direct probes exercise multipart attachment behavior.",
  results,
}, null, 2));

async function probeGenerated(name, targetBytes, route) {
  const audio = createWavForExactSize(targetBytes);
  await probe(name, route, audio);
}

async function probe(name, route, audio) {
  const form = new FormData();
  if (route === "file") {
    form.append("file", audio, `${name}.wav`);
  } else {
    const bytes = Buffer.from(await audio.arrayBuffer());
    form.append("url", `data:audio/wav;base64,${bytes.toString("base64")}`);
  }
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "verbose_json");
  form.append("language", "en");
  const outcome = await request(name, form, audio.size);
  results.push({ name, route, sizeBytes: audio.size, ...outcome });
}

async function probeUrl(name, url, expectedSuccess) {
  const form = new FormData();
  form.append("url", url);
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "verbose_json");
  form.append("language", "en");
  const outcome = await request(name, form);
  results.push({ name, route: "https-url", url: redactUrl(url), expectedSuccess, ...outcome });
}

async function withTemporaryAudio(name, targetBytes) {
  const audio = createWavForExactSize(targetBytes);
  const upload = new FormData();
  upload.append("file", audio, `${name}.wav`);
  const uploadEndpoint = process.env.GROQ_TEMP_UPLOAD_ENDPOINT ?? "https://temp.sh/upload";
  const response = await fetch(uploadEndpoint, { method: "POST", body: upload });
  const url = (await response.text()).trim();
  const token = response.headers.get("x-token");
  if (!response.ok || !url.startsWith("https://")) {
    results.push({ name, route: "temporary-https-url", sizeBytes: audio.size, skipped: true, reason: `Temporary upload failed (${response.status}).` });
    return;
  }
  try {
    const form = new FormData();
    form.append("url", url);
    form.append("model", "whisper-large-v3-turbo");
    form.append("response_format", "verbose_json");
    form.append("language", "en");
    const outcome = await request(name, form, audio.size);
    results.push({
      name,
      route: "temporary-https-url",
      sizeBytes: audio.size,
      temporaryHost: new URL(uploadEndpoint).host,
      automaticExpiry: uploadEndpoint.includes("temp.sh") ? "3 days" : "host-defined",
      ...outcome,
    });
  } finally {
    if (token) {
      const remove = new FormData();
      remove.append("token", token);
      remove.append("delete", "");
      const deleted = await fetch(url, { method: "POST", body: remove }).catch(() => undefined);
      results.push({ name: `${name}-cleanup`, route: "temporary-host", deleted: Boolean(deleted?.ok) });
    }
  }
}

async function optionalUrl(name, url, expectedSuccess) {
  if (!url?.trim()) {
    results.push({ name, route: "https-url", skipped: true, reason: `Set ${environmentName(name)} to run this probe.` });
    return;
  }
  await probeUrl(name, url.trim(), expectedSuccess);
}

async function request(name, body, sizeBytes) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`${name} timed out`)), 12 * 60_000);
  try {
    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body,
      signal: controller.signal,
    });
    const bodyText = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      elapsedMs: Math.round(performance.now() - startedAt),
      retryAfter: response.headers.get("retry-after"),
      requestId: response.headers.get("x-request-id"),
      responsePreview: safePreview(bodyText),
      ...(sizeBytes === undefined ? {} : { billedInputBytes: sizeBytes }),
    };
  } catch (cause) {
    const error = cause instanceof DictationError ? cause : new Error(String(cause));
    return { ok: false, transportError: error.message, elapsedMs: Math.round(performance.now() - startedAt) };
  } finally {
    clearTimeout(timeout);
  }
}

function createWavForExactSize(targetBytes) {
  const sampleRate = 192_000;
  const channels = 2;
  const bitsPerSample = 32;
  const blockAlign = channels * bitsPerSample / 8;
  const dataBytes = Math.floor((targetBytes - 44) / blockAlign) * blockAlign;
  return createWav(dataBytes, sampleRate, channels, bitsPerSample);
}

function createWavForDuration(seconds, sampleRate, channels, bitsPerSample) {
  const blockAlign = channels * bitsPerSample / 8;
  return createWav(Math.floor(seconds * sampleRate) * blockAlign, sampleRate, channels, bitsPerSample);
}

function createWav(dataBytes, sampleRate, channels, bitsPerSample) {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  const blockAlign = channels * bitsPerSample / 8;
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  return new Blob([header, new Uint8Array(dataBytes)], { type: "audio/wav" });
}

function validateKnownExpectations(observed, accountTier) {
  const byName = new Map(observed.map((result) => [result.name, result]));
  const below25 = byName.get("direct-below-25-mib");
  if (below25 && !below25.ok) process.exitCode = 1;
  const above25 = byName.get("direct-above-25-mib");
  if (above25?.ok) process.exitCode = 1;
  const below100 = byName.get("base64-below-100-mib");
  const above100 = byName.get("base64-above-100-mib");
  if (accountTier === "developer" && below100 && !below100.ok) process.exitCode = 1;
  if (accountTier === "free" && below100?.ok) process.exitCode = 1;
  if (above100?.ok) process.exitCode = 1;
  const urlBelow100 = byName.get("url-below-100-mib");
  const urlAbove100 = byName.get("url-above-100-mib");
  if (accountTier === "developer" && urlBelow100 && !urlBelow100.ok) process.exitCode = 1;
  if (accountTier === "free" && urlBelow100?.ok) process.exitCode = 1;
  if (urlAbove100?.ok) process.exitCode = 1;
  const urlBelow25 = byName.get("url-below-25-mib");
  const urlAbove25 = byName.get("url-above-25-mib");
  if (urlBelow25 && !urlBelow25.ok) process.exitCode = 1;
  if (accountTier === "free" && urlAbove25?.ok) process.exitCode = 1;
  for (const result of observed) {
    if (result.expectedSuccess === true && !result.ok && !result.skipped) process.exitCode = 1;
    if (result.expectedSuccess === false && result.ok) process.exitCode = 1;
  }
}

function safePreview(value) {
  try {
    const parsed = JSON.parse(value);
    if (parsed.error) return JSON.stringify(parsed.error).slice(0, 400);
    return JSON.stringify({ text: parsed.text?.slice(0, 120), duration: parsed.duration }).slice(0, 400);
  } catch {
    return value.slice(0, 400);
  }
}

function redactUrl(value) {
  const parsed = new URL(value);
  return `${parsed.origin}${parsed.pathname}`;
}

function environmentName(name) {
  return ({
    "expired-signed-url": "GROQ_EXPIRED_SIGNED_URL",
    "range-required-url": "GROQ_RANGE_URL",
    "slow-provider-fetch-url": "GROQ_FETCH_TIMEOUT_URL",
    "long-duration-url": "GROQ_LONG_DURATION_URL",
  })[name];
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}
