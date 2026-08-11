import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [outputArgument, revisionArgument, libraryArgument, packageVersionArgument] = process.argv.slice(2);
if (!outputArgument || !revisionArgument) {
  throw new Error("Usage: node scripts/assemble-pages.mjs <output-directory> <revision> [library-directory] [package-version]");
}
if (!/^[A-Za-z0-9._-]+$/.test(revisionArgument)) {
  throw new Error("The Pages revision may contain only letters, numbers, dots, underscores, and hyphens.");
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(outputArgument);
const revision = revisionArgument;
const librarySource = libraryArgument ? resolve(libraryArgument) : resolve(root, "dist");
const packageVersion = packageVersionArgument
  ?? JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageVersion)) {
  throw new Error("The Pages package version is invalid.");
}
const versionedLibrary = resolve(output, "library", revision);
const docsRoot = resolve(root, "docs");
const sourceAppPath = resolve(docsRoot, "app.js");

await mkdir(versionedLibrary, { recursive: true });
await cp(docsRoot, output, {
  recursive: true,
  // Only the immutable app-{revision}.js entry point is deployed. Keeping app.js beside it can
  // make stale assets look executable during cache and deployment diagnostics.
  filter: (source) => source !== sourceAppPath,
});
// Keep the stable path for cached older HTML while new HTML uses the immutable revision path.
await cp(librarySource, resolve(output, "library"), { recursive: true });
await cp(librarySource, versionedLibrary, { recursive: true });

const sourceApp = await readFile(sourceAppPath, "utf8");
const versionedAppName = `app-${revision}.js`;
const versionedApp = sourceApp.replace(
  'from "./library/index.js"',
  `from "./library/${revision}/index.js"`,
);
if (versionedApp === sourceApp) throw new Error("Could not version the Pages library import.");
await writeFile(resolve(output, versionedAppName), versionedApp);

const sourceHtml = await readFile(resolve(root, "docs", "index.html"), "utf8");
const versionedHtml = sourceHtml
  .replace('src="./app.js"', `src="./${versionedAppName}"`)
  .replace(
    '<span class="version" data-revision>npm package · live preview</span>',
    `<span class="version" data-revision>npm ${packageVersion} · ${revision.slice(0, 12)}</span>`,
  );
if (versionedHtml === sourceHtml || !versionedHtml.includes(`npm ${packageVersion} · ${revision.slice(0, 12)}`)) {
  throw new Error("Could not version the Pages application script and revision label.");
}
await writeFile(resolve(output, "index.html"), versionedHtml);

console.log(JSON.stringify({ output, revision, packageVersion, librarySource, versionedAppName }));
