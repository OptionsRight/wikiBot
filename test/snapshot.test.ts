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
    for (const page of bundle.pages)
      await writeFile(join(root, page.path), page.content);
    const { pages, ...rest } = bundle;
    const manifest = {
      ...rest,
      pages: pages.map(({ content: _content, ...page }) => page),
    };
    const result = await snapshot(root, manifest);
    assert.equal(result.pages[0]!.content, bundle.pages[0]!.content);
    await writeFile(join(root, bundle.pages[0]!.path), "changed");
    await assert.rejects(
      () => snapshot(root, manifest),
      /SOURCE_BASELINE_CONFLICT/,
    );
    await rm(join(root, bundle.pages[0]!.path));
    await symlink("/etc/passwd", join(root, bundle.pages[0]!.path));
    await assert.rejects(() => snapshot(root, manifest), /SYMLINK_FORBIDDEN/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot rejects parent traversal before opening files outside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "wikibot-snapshot-traversal-"));
  try {
    const bundle = sampleBundle();
    const manifest = {
      ...bundle,
      pages: bundle.pages.map(({ content: _c, ...p }) => ({
        ...p,
        path: "../outside.md",
      })),
    };
    await assert.rejects(() => snapshot(root, manifest), /INVALID_SOURCE_PATH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
