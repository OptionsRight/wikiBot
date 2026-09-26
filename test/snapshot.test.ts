import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleBundle } from "./helpers.js";
import { snapshot } from "../src/snapshot.js";
test("snapshot reads only declared regular Markdown files and detects changed content or symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "wikibot-snapshot-"));
  try {
    const bundle = sampleBundle();
    await mkdir(join(root, "workflows"));
    await writeFile(
      join(root, bundle.pages[0]!.path),
      bundle.pages[0]!.content,
    );
    const result = await snapshot(root, bundle);
    assert.equal(result.pages[0]!.content, bundle.pages[0]!.content);
    await writeFile(join(root, bundle.pages[0]!.path), "changed");
    await assert.rejects(
      () => snapshot(root, bundle),
      /SOURCE_BASELINE_CONFLICT/,
    );
    await rm(join(root, bundle.pages[0]!.path));
    await symlink("/etc/passwd", join(root, bundle.pages[0]!.path));
    await assert.rejects(() => snapshot(root, bundle), /SYMLINK_FORBIDDEN/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
