import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("Pages assembly emits only a revision-addressed app and matching library import", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "dictation-pages-test-"));
  context.after(() => rm(output, { recursive: true, force: true }));
  const publishedLibrary = join(output, "published-library");
  await mkdir(publishedLibrary);
  await writeFile(join(publishedLibrary, "index.js"), "export const publishedMarker = true;\n");
  const revision = "abcdef1234567890";

  await run(process.execPath, [
    "scripts/assemble-pages.mjs",
    output,
    revision,
    publishedLibrary,
    "0.4.0",
  ], { cwd: root });

  await assert.rejects(
    access(join(output, "app.js")),
    (error) => error?.code === "ENOENT",
  );
  const html = await readFile(join(output, "index.html"), "utf8");
  const app = await readFile(join(output, `app-${revision}.js`), "utf8");
  assert.match(html, /npm 0\.4\.0 · abcdef123456/);
  assert.match(html, new RegExp(`src="\\./app-${revision}\\.js"`));
  assert.match(app, new RegExp(`from "\\./library/${revision}/index\\.js"`));
  await access(join(output, "library", "index.js"));
  await access(join(output, "library", revision, "index.js"));
  assert.equal(
    await readFile(join(output, "library", revision, "index.js"), "utf8"),
    "export const publishedMarker = true;\n",
  );
});
