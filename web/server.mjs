import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DictationPipeline } from "../dist/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
await loadEnv(join(root, "web", ".env"));
await loadEnv(join(root, ".env"));

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const maxAudioBytes = 25 * 1024 * 1024;
const apiKey = process.env.GROQ_API_KEY?.trim();

const server = createServer(async (request, response) => {
  const requestStartedAt = performance.now();
  const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, {
        ok: true,
        groqConfigured: Boolean(apiKey),
        models: {
          transcription: "whisper-large-v3-turbo",
          cleanup: "openai/gpt-oss-20b",
          fallback: "qwen/qwen3.6-27b",
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/api/dictate") {
      if (!apiKey) {
        return json(response, 503, {
          error: "GROQ_API_KEY is not configured on the server.",
          code: "MISSING_GROQ_API_KEY",
        });
      }

      const parseStartedAt = performance.now();
      const audioBytes = await readRequestBody(request, maxAudioBytes);
      const requestParseMs = performance.now() - parseStartedAt;
      if (audioBytes.length === 0) {
        return json(response, 400, { error: "The audio body is empty.", code: "EMPTY_AUDIO" });
      }

      const contentType = String(request.headers["content-type"] || "audio/webm").split(";")[0];
      const filename = String(request.headers["x-audio-filename"] || filenameForMime(contentType));
      const language = url.searchParams.get("language")?.trim() || undefined;
      const activity = url.searchParams.get("context")?.trim() || undefined;
      const fieldType = normalizeFieldType(url.searchParams.get("fieldType"));
      const events = [];
      const pipeline = new DictationPipeline({
        apiKey,
        onEvent(event) {
          if ("durationMs" in event) {
            events.push({ type: event.type, durationMs: round(event.durationMs) });
          }
        },
      });

      const result = await pipeline.dictate(
        { data: new Blob([audioBytes], { type: contentType }), filename },
        {
          ...(language ? { language } : {}),
          context: {
            appName: "Dictation Benchmark",
            fieldType,
            ...(activity ? { activity } : {}),
          },
        },
      );
      const serverTotalMs = performance.now() - requestStartedAt;

      return json(response, 200, {
        ...result,
        timings: {
          ...roundTimings(result.timings),
          requestParseMs: round(requestParseMs),
          serverOverheadMs: round(Math.max(0, serverTotalMs - requestParseMs - result.timings.totalMs)),
          serverTotalMs: round(serverTotalMs),
        },
        events,
        audio: {
          bytes: audioBytes.length,
          mimeType: contentType,
          filename,
        },
      });
    }

    if (request.method === "GET") {
      return serveStatic(url.pathname, response);
    }
    json(response, 405, { error: "Method not allowed." });
  } catch (error) {
    const status = error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 500;
    json(response, status, {
      error: error instanceof Error ? error.message : "Unexpected server error.",
      code: error?.code || "SERVER_ERROR",
    });
  }
});

server.listen(port, host, () => {
  console.log(`Dictation benchmark running at http://${host}:${port}`);
  console.log(apiKey ? "Groq is configured." : "Groq is not configured; add GROQ_API_KEY to .env for live benchmarks.");
});

async function serveStatic(pathname, response) {
  const webRoutes = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/app.js", "app.js"],
    ["/styles.css", "styles.css"],
  ]);
  let filePath;
  if (webRoutes.has(pathname)) {
    filePath = join(root, "web", webRoutes.get(pathname));
  } else if (/^\/library\/[a-z0-9-]+\.js(?:\.map)?$/i.test(pathname)) {
    filePath = join(root, "dist", pathname.slice("/library/".length));
  } else {
    return json(response, 404, { error: "Not found." });
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      ...securityHeaders(),
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    json(response, 404, { error: "Not found." });
  }
}

function readRequestBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error("Audio exceeds the 25 MB request limit.");
        error.code = "PAYLOAD_TOO_LARGE";
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function loadEnv(path) {
  try {
    const source = await readFile(path, "utf8");
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function json(response, status, body) {
  response.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function normalizeFieldType(value) {
  return ["chat", "email", "document", "code", "search", "other"].includes(value) ? value : "document";
}

function filenameForMime(mime) {
  if (mime.includes("ogg")) return "dictation.ogg";
  if (mime.includes("mp4")) return "dictation.m4a";
  if (mime.includes("wav")) return "dictation.wav";
  return "dictation.webm";
}

function contentTypeFor(path) {
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".map": "application/json; charset=utf-8",
  })[extname(path)] || "application/octet-stream";
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function roundTimings(timings) {
  return Object.fromEntries(Object.entries(timings).map(([key, value]) => [key, round(value)]));
}
