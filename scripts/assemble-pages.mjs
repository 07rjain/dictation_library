import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [outputArgument, revisionArgument] = process.argv.slice(2);
if (!outputArgument || !revisionArgument) {
  throw new Error("Usage: node scripts/assemble-pages.mjs <output-directory> <revision>");
}
if (!/^[A-Za-z0-9._-]+$/.test(revisionArgument)) {
  throw new Error("The Pages revision may contain only letters, numbers, dots, underscores, and hyphens.");
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(outputArgument);
const revision = revisionArgument;
const versionedLibrary = resolve(output, "library", revision);

await mkdir(versionedLibrary, { recursive: true });
await cp(resolve(root, "docs"), output, { recursive: true });
// Keep the stable path for cached older HTML while new HTML uses the immutable revision path.
await cp(resolve(root, "dist"), resolve(output, "library"), { recursive: true });
await cp(resolve(root, "dist"), versionedLibrary, { recursive: true });

const sourceApp = await readFile(resolve(root, "docs", "app.js"), "utf8");
const versionedAppName = `app-${revision}.js`;
const versionedApp = sourceApp.replace(
  'from "./library/index.js"',
  `from "./library/${revision}/index.js"`,
);
if (versionedApp === sourceApp) throw new Error("Could not version the Pages library import.");
await writeFile(resolve(output, versionedAppName), versionedApp);

const sourceHtml = await readFile(resolve(root, "docs", "index.html"), "utf8");
const versionedHtml = sourceHtml.replace('src="./app.js"', `src="./${versionedAppName}"`);
if (versionedHtml === sourceHtml) throw new Error("Could not version the Pages application script.");
await writeFile(resolve(output, "index.html"), versionedHtml);

console.log(JSON.stringify({ output, revision, versionedAppName }));
