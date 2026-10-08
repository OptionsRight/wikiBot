import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  rename,
  unlink,
  mkdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store, hash } from "../src/core.js";
import {
  captureRepository,
  registerCodeSnapshot,
  deriveCodeWiki,
} from "../src/knowledge/git.js";
import { createTextEvidence } from "../src/knowledge/evidence.js";
import { proposeClaim, approveClaims } from "../src/knowledge/claims.js";
import { AssetStore } from "../src/knowledge/assets.js";
import {
  buildGroundedBundle,
  writeGeneration,
  verifyGeneration,
} from "../src/knowledge/generations.js";
import { requireGroundingRelease } from "../src/knowledge/sidecars.js";
import { analyzeIncremental } from "../src/knowledge/incremental.js";
import { sampleBundle } from "./helpers.js";
import { wireHash } from "../src/knowledge/contracts.js";
import type { BundleV2 } from "../src/procedures.js";

test("real Git snapshots detect no-op, line drift, rename and deletion without executing repository code", async () => {
  const root = await mkdtemp(join(tmpdir(), "wikibot-code-")),
    repo = join(root, "repo"),
    store = new Store(":memory:");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    await mkdir(repo);
    git("init");
    git("config", "user.email", "synthetic@example.invalid");
    git("config", "user.name", "Synthetic test");
    git("config", "core.autocrlf", "false");
    await writeFile(join(repo, "a.ts"), "export const limit = 80;\n");
    await writeFile(join(repo, "b.ts"), "export const unit = 'USD';\n");
    await writeFile(join(repo, ".env"), "NEVER_READ_SECRET=synthetic\n");
    await mkdir(join(repo, "generated"));
    await writeFile(
      join(repo, "generated", "loop.ts"),
      "export const circular = true;\n",
    );
    git("add", ".");
    git("commit", "-m", "initial synthetic source");
    const config = {
      root: repo,
      ref: "HEAD",
      allowedPaths: [""],
      extensions: [".ts"],
    };
    const first = await captureRepository("ads", "code", config);
    assert.equal(first.sources.length, 2);
    assert.equal(git("status", "--porcelain"), "");
    registerCodeSnapshot(store, first);
    store.put("domain", {
      id: "ads",
      domain: "ads",
      version: 1,
      maintenance: false,
    });
    store.put("grant", {
      id: "ads:admin",
      domain: "ads",
      version: 1,
      enabled: true,
      role: "admin",
    });
    const actor = { subject: "admin", platform: false },
      source = first.sources.find((s) => s.path === "a.ts")!,
      e = createTextEvidence(store, "ads", source.id, 1, 1);
    const c = store.tx(() =>
      proposeClaim(store, actor, "ads", {
        expectedVersion: 0,
        subjectId: "code",
        predicate: "limit",
        qualifiers: { unit: "USD" },
        statement: "The code sets limit to 80.",
        typedValue: 80,
        validityKind: "unknown",
        validFrom: null,
        validTo: null,
        evidenceIds: [e.id],
        extractionProfileHash: wireHash(["manual", 1]),
        batchId: "code",
        reason: "Synthetic reviewer inspected immutable code excerpt.",
      }),
    );
    store.tx(() =>
      approveClaims(
        store,
        actor,
        "ads",
        [{ id: c.id, expectedVersion: 1 }],
        "Synthetic code statement verified against the exact blob.",
      ),
    );
    const wiki = deriveCodeWiki(store, first);
    assert.equal(wiki.pages.length, 2);
    assert.ok(wiki.pages.some((p) => p.content.includes(first.commit)));
    const base = sampleBundle();
    base.pages = [
      {
        id: "guide",
        path: "guide.md",
        title: "code limit",
        content: "The code sets limit to 80.",
        hash: hash("The code sets limit to 80."),
      },
    ];
    base.cases = [
      { id: "example", question: "code limit", expectedCitations: ["guide"] },
    ];
    const cases = base.cases.map((c) => ({
      ...c,
      expectedFacts: ["80"],
      forbiddenFacts: ["100"],
      expectedClaimIds: [],
    }));
    const policy: BundleV2["evalPolicy"] = {
      version: "shadow",
      mode: "shadow",
      judgeProfileHash: wireHash([]),
      suiteHash: wireHash(cases),
      calibrationId: null,
      maxAgeMs: 10000,
      metrics: ["faithfulness", "relevancy", "coverage", "forbidden"].map(
        (name) => ({
          name: name as "faithfulness",
          required: true,
          thresholdBps: 8000,
        }),
      ),
    };
    const assets = new AssetStore(join(root, "assets")),
      built = buildGroundedBundle(
        store,
        assets,
        "ads",
        base,
        "claims",
        { guide: [c.id] },
        policy,
        cases,
      ),
      generation = writeGeneration(
        assets,
        "ads",
        built.generationId,
        built.bundle,
      );
    store.knowledgePut("generations", generation);
    requireGroundingRelease(store, assets, "ads", built.bundle);
    // Only first source participates in this published page; additions are explicit.
    assert.equal(
      analyzeIncremental(store, assets, "ads", built.bundle, base.pages, [
        source,
      ]).state,
      "no_change",
    );
    await writeFile(
      join(repo, "a.ts"),
      "// inserted heading\nexport const limit = 80;\n",
    );
    git("add", ".");
    git("commit", "-m", "line drift");
    const second = await captureRepository("ads", "code", config);
    registerCodeSnapshot(store, second);
    const changed = analyzeIncremental(
      store,
      assets,
      "ads",
      built.bundle,
      base.pages,
      second.sources,
    );
    assert.equal(changed.state, "blocked");
    assert.ok(changed.affectedPages.includes("guide"));
    assert.ok(changed.invalidEvidence.includes(e.id));
    await rename(join(repo, "a.ts"), join(repo, "renamed.ts"));
    git("add", "-A");
    git("commit", "-m", "rename");
    const third = await captureRepository("ads", "code", config);
    registerCodeSnapshot(store, third);
    const rebound = structuredClone(built.bundle);
    rebound.sourceManifest = [
      {
        sourceVersionId: second.sources.find((s) => s.path === "a.ts")!.id,
        sourceId: source.sourceId,
        rawSha256: second.sources.find((s) => s.path === "a.ts")!.rawSha256,
        kind: "repository",
        profileHash: source.profileHash,
        artifactHash: source.artifactHash,
      },
    ];
    const renamed = analyzeIncremental(
      store,
      assets,
      "ads",
      rebound,
      base.pages,
      third.sources,
    );
    assert.equal(renamed.renamed.length, 1);
    await unlink(join(repo, "renamed.ts"));
    git("add", "-A");
    git("commit", "-m", "delete");
    const fourth = await captureRepository("ads", "code", config);
    assert.ok(
      analyzeIncremental(
        store,
        assets,
        "ads",
        built.bundle,
        base.pages,
        fourth.sources,
      ).deleted.length,
    );
    const corrupted = structuredClone(built.bundle);
    corrupted.groundingManifest.sidecars[0]!.pageHash = "0".repeat(64);
    assert.throws(
      () => requireGroundingRelease(store, assets, "ads", corrupted),
      /SIDECAR_HASH_MISMATCH/,
    );
    await unlink(join(assets.root, "generations", generation.id, "guide.json"));
    assert.throws(
      () => verifyGeneration(assets, generation),
      /GENERATION_INCOMPLETE/,
    );
    assert.equal(
      source.content,
      "export const limit = 80;\n",
      "old source bytes survive later commits",
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
