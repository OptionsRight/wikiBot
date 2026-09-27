import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hash } from "../src/core.js";
import {
  ControlledSource,
  isolatedMarkdownAdapter,
} from "../src/controlled-source.js";
import { sampleBundle } from "./helpers.js";

test("isolated corrections survive reimport checks and partial writes require explicit reconciliation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wikibot-source-"));
  try {
    const root = join(dir, "wiki"),
      state = join(dir, "records"),
      bundle = sampleBundle();
    await mkdir(join(root, "workflows"), { recursive: true });
    await writeFile(
      join(root, ".wikibot-isolated-copy"),
      "isolated experiment\n",
    );
    for (const p of bundle.pages)
      await writeFile(join(root, p.path), p.content);
    const plan = {
      id: "correction-1",
      domain: "ads",
      root,
      responsible: "test-admin",
      reason: "合成更正，不是业务验收",
      scope: "测试范围",
      evidence: "专家记录 TEST-001",
      pages: bundle.pages,
      changes: bundle.pages.map((p) => ({
        pageId: p.id,
        content: `${p.content}\n更正：需要人工复核。`,
      })),
    };
    let calls = 0;
    const adapter = isolatedMarkdownAdapter();
    const partial = new ControlledSource(state, {
      ...adapter,
      async apply(root, change) {
        if (++calls === 2) throw new Error("simulated process interruption");
        await adapter.apply(root, change);
      },
    });
    const online = async () => {};
    const result = await partial.apply(plan, online);
    assert.equal(result.state, "recovery_required");
    assert.equal(
      (await partial.inspect(plan.id)).files.filter(
        (p) => p.observedHash === p.afterHash,
      ).length,
      1,
    );
    assert.equal(
      (await partial.apply(plan, online)).state,
      "recovery_required",
    );
    assert.equal(calls, 2, "unknown outcomes never rerun automatically");
    // Human finishes the one remaining change, then explicitly reconciles.
    await writeFile(
      join(root, bundle.pages[1]!.path),
      plan.changes[1]!.content,
    );
    const done = await partial.reconcile(
      plan.id,
      "applied",
      "维护者逐文件确认更正已完整写入；合成实验。",
      online,
    );
    assert.equal(done.state, "applied");
    await partial.verifyCorrections(root);
    // A later importer overwrites corrected text with old material: fail closed.
    await writeFile(
      join(root, bundle.pages[0]!.path),
      bundle.pages[0]!.content,
    );
    await assert.rejects(
      () => partial.verifyCorrections(root),
      /CORRECTION_LOST/,
    );
    assert.equal(
      (await partial.inspect(plan.id)).files[0]!.beforeHash,
      hash(bundle.pages[0]!.content),
    );
    assert.ok(
      (await readFile(join(state, plan.id + ".json"), "utf8")).includes(
        "TEST-001",
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stable page identity preserves a correction after rename and correction records cannot be stored inside the source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wikibot-correction-rename-"));
  try {
    const root = join(dir, "wiki");
    await mkdir(root);
    await writeFile(
      join(root, ".wikibot-isolated-copy"),
      "isolated experiment\n",
    );
    const content = '---\n{"id":"rule"}\n---\n# Rule\nOriginal';
    await writeFile(join(root, "old.md"), content);
    const plan = {
      id: "rename-rule",
      domain: "ads",
      root,
      responsible: "synthetic-admin",
      reason: "合成实验",
      scope: "测试",
      evidence: "synthetic evidence",
      pages: [
        {
          id: "rule",
          path: "old.md",
          title: "Rule",
          content,
          hash: hash(content),
        },
      ],
      changes: [{ pageId: "rule", content: content + "\nCorrected" }],
    };
    const authorize = async () => {};
    const bad = new ControlledSource(
      join(root, "..records"),
      isolatedMarkdownAdapter(),
    );
    await assert.rejects(
      () => bad.apply(plan, authorize),
      /SEPARATE_CORRECTION_STORE_REQUIRED/,
    );
    const source = new ControlledSource(
      join(dir, "records"),
      isolatedMarkdownAdapter(),
    );
    assert.equal((await source.apply(plan, authorize)).state, "applied");
    const { rename } = await import("node:fs/promises");
    await rename(join(root, "old.md"), join(root, "new.md"));
    await source.verifyCorrections(root);
    const { createPageManifest } = await import("../src/source-formats.js");
    const manifest = await createPageManifest(root, plan.pages);
    assert.equal(manifest[0]!.id, "rule");
    assert.equal(manifest[0]!.path, "new.md");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("baseline conflicts do not write and a human-confirmed restoration permits exactly one new attempt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wikibot-baseline-"));
  try {
    const root = join(dir, "wiki");
    await mkdir(root);
    await writeFile(
      join(root, ".wikibot-isolated-copy"),
      "isolated experiment\n",
    );
    await writeFile(join(root, "rule.md"), "concurrent editor");
    const plan = {
      id: "baseline",
      domain: "ads",
      root,
      responsible: "test",
      reason: "test",
      scope: "test",
      evidence: "synthetic",
      pages: [
        {
          id: "rule",
          path: "rule.md",
          title: "Rule",
          content: "original",
          hash: hash("original"),
        },
      ],
      changes: [{ pageId: "rule", content: "corrected" }],
    };
    const source = new ControlledSource(
      join(dir, "records"),
      isolatedMarkdownAdapter(),
    );
    const auth = async () => {};
    assert.equal((await source.apply(plan, auth)).state, "conflict");
    assert.equal(
      await readFile(join(root, "rule.md"), "utf8"),
      "concurrent editor",
    );
    await writeFile(join(root, "rule.md"), "original");
    await source.reconcile(
      plan.id,
      "baseline_restored",
      "人工确认所有写入者已停，原始基线完整恢复。",
      auth,
    );
    assert.equal((await source.apply(plan, auth)).state, "applied");
    assert.equal(await readFile(join(root, "rule.md"), "utf8"), "corrected");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrected legacy page without frontmatter keeps its platform ID after rename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wikibot-legacy-id-"));
  try {
    const root = join(dir, "wiki");
    await mkdir(root);
    await writeFile(
      join(root, ".wikibot-isolated-copy"),
      "isolated experiment\n",
    );
    await writeFile(join(root, "old.md"), "Original text");
    const source = new ControlledSource(
      join(dir, "records"),
      isolatedMarkdownAdapter(),
    );
    await source.apply(
      {
        id: "legacy",
        domain: "ads",
        root,
        responsible: "test",
        reason: "test",
        scope: "test",
        evidence: "synthetic",
        pages: [
          {
            id: "platform-page-id",
            path: "old.md",
            title: "Rule",
            content: "Original text",
            hash: hash("Original text"),
          },
        ],
        changes: [{ pageId: "platform-page-id", content: "Corrected text" }],
      },
      async () => {},
    );
    const { rename } = await import("node:fs/promises");
    await rename(join(root, "old.md"), join(root, "new.md"));
    await source.verifyCorrections(root);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
