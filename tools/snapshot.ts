import { readFile, writeFile } from "node:fs/promises";
import { snapshot } from "../src/snapshot.js";
const [root, manifest, output] = process.argv.slice(2);
if (!root || !manifest || !output)
  throw new Error(
    "Usage: npm run snapshot -- WORKSPACE_ROOT MANIFEST.json OUTPUT.json",
  );
const result = await snapshot(
  root,
  JSON.parse(await readFile(manifest, "utf8")),
);
await writeFile(output, JSON.stringify(result, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(
  `Snapshot created: ${result.pages.length} pages; source files unchanged.\n`,
);
