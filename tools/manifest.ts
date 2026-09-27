import { realpath, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { requireThat } from "../src/core.js";
import { createPageManifest, bundleManifest } from "../src/source-formats.js";

// Generates a draft bundle manifest from a wiki workspace: every Markdown
// file under the root (or --subdir) becomes a page with a content hash.
// Golden cases and config must be added by hand before submission; ids come
// from the file path so they stay stable across regenerations.
const root = resolve(process.argv[2] ?? "."),
  subdir = process.argv[3],
  out = process.argv[4];
if (!out) {
  console.error(
    "usage: npm run manifest -- WORKSPACE_ROOT [SUBDIR] OUT_MANIFEST.json [PREVIOUS_MANIFEST.json] [RENAMES.json]",
  );
  process.exit(2);
}
const base = subdir ? resolve(root, subdir) : root;
requireThat(base === root || base.startsWith(root + sep), 400, "PATH_ESCAPE");
const previousFile = process.argv[5],
  renameFile = process.argv[6];
const previous = previousFile
  ? JSON.parse(await readFile(previousFile, "utf8"))
  : undefined;
const renames = renameFile
  ? JSON.parse(await readFile(renameFile, "utf8"))
  : {};
const canonicalRoot = await realpath(root),
  canonicalBase = await realpath(base);
requireThat(
  canonicalBase === canonicalRoot ||
    canonicalBase.startsWith(canonicalRoot + sep),
  400,
  "PATH_ESCAPE",
);
const pages = await createPageManifest(
  base,
  previous?.pages,
  renames,
  (previous?.sourceArtifacts ?? []).map((a: { path: string }) => a.path),
);
if (!pages.length) throw new Error("NO_MARKDOWN_PAGES");
const manifest = {
  ...(previous ? bundleManifest(previous) : {}),
  pages,
  cases: previous?.cases ?? [
    {
      id: "REPLACE-ME",
      question: "把真实业务问题写在这里，并补充 expectedCitations。",
    },
  ],
  config: previous?.config ?? {
    model: process.env.WIKIBOT_MODEL ?? "glm-5.3",
    modelRevision: process.env.WIKIBOT_MODEL_REVISION ?? "r1",
    promptVersion: "1",
    templateVersion: "1",
    retrievalVersion: "1",
    protocolVersion: "1",
    evaluationVersion: "1",
  },
};
await writeFile(out, JSON.stringify(manifest, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
console.error(
  `${pages.length} pages under ${relative(root, base) || "."} → ${out}; replace the placeholder case before submitting`,
);
