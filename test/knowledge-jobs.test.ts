import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/core.js";
import { AssetStore } from "../src/knowledge/assets.js";
import {
  profileSchema,
  wireHash,
  type NormalizedDocument,
} from "../src/knowledge/contracts.js";
import {
  enqueueNormalization,
  settleNormalization,
  recoverKnowledgeJobs,
  type KnowledgeJob,
  type SourceVersion,
} from "../src/knowledge/jobs.js";
import { setup } from "./helpers.js";
const profile = profileSchema.parse(
  JSON.parse(readFileSync("config/normalizer.native.json", "utf8")),
);

test("normalization cache, fenced worker, missing artifacts and revoked actor fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "wikibot-jobs-")),
    store = new Store(":memory:"),
    assets = new AssetStore(root),
    actor = { subject: "admin", platform: false };
  try {
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
    const source: SourceVersion = {
      id: "source-v1",
      domain: "ads",
      version: 1,
      sourceId: "s",
      format: "pdf",
      rawSha256: assets.put("ads", Buffer.from("%PDF-")),
      bytes: 5,
      createdAt: Date.now(),
      actor: "admin",
    };
    store.knowledgePut("source_versions", source);
    const queued = store.tx(() =>
      enqueueNormalization(store, actor, source, profile),
    );
    assert.equal(
      store.tx(() => enqueueNormalization(store, actor, source, profile)).id,
      queued.id,
    );
    const running: KnowledgeJob = {
      ...queued,
      state: "running",
      attempt: 1,
      fencingToken: "lease1",
      startedAt: Date.now() - 10,
      deadline: Date.now() + 10000,
    };
    store.knowledgePut("knowledge_jobs", running);
    const result: NormalizedDocument = {
      schemaVersion: 1,
      jobId: running.id,
      attempt: 1,
      fencingToken: "lease1",
      sourceVersionId: source.id,
      rawSha256: source.rawSha256,
      profileHash: wireHash(profile),
      doclingVersion: profile.doclingVersion,
      startedAt: Date.now() - 5,
      finishedAt: Date.now(),
      parseStatus: "complete",
      warnings: [],
      blocks: [],
      artifacts: [],
    };
    assert.throws(
      () => settleNormalization(store, assets, running, result, {}),
      /INCOMPLETE_ARTIFACTS/,
    );
    store.put("grant", {
      id: "ads:admin",
      domain: "ads",
      version: 2,
      enabled: false,
      role: "admin",
    });
    assert.throws(
      () =>
        settleNormalization(
          store,
          assets,
          running,
          { ...result, parseStatus: "failed" },
          {},
        ),
      /FORBIDDEN/,
    );
    recoverKnowledgeJobs(store, true);
    assert.throws(
      () => settleNormalization(store, assets, running, result, {}),
      /JOB_FENCED/,
    );
    assert.equal(
      store.knowledgeGet<KnowledgeJob>("knowledge_jobs", running.id)?.code,
      "EXECUTION_UNKNOWN",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("asset upload and parse enqueue enforce domain admin, version and idempotency boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "wikibot-source-api-"));
  const t = await setup({
    knowledge: { assetRoot: root, normalizerProfile: profile },
  });
  try {
    const url = "/api/domains/ads/sources";
    assert.equal(
      (await t.request("POST", url, { id: "policy", title: "Policy" }, t.alice))
        .status,
      403,
    );
    const source = (
      await t.request("POST", url, { id: "policy", title: "Policy" }, t.admin)
    ).value;
    const upload = {
      expectedVersion: 1,
      format: "pdf",
      content: Buffer.from("%PDF-1.4 synthetic-invalid").toString("base64"),
    };
    const first = await t.request(
      "POST",
      `${url}/${source.id}/files`,
      upload,
      t.admin,
      "upload",
    );
    assert.equal(first.status, 201);
    assert.deepEqual(
      (
        await t.request(
          "POST",
          `${url}/${source.id}/files`,
          upload,
          t.admin,
          "upload",
        )
      ).value,
      first.value,
    );
    assert.equal(
      (
        await t.request(
          "GET",
          `${url}/${source.id}/files/${first.value.id}`,
          undefined,
          t.alice,
        )
      ).status,
      403,
    );
    const original = await t.app.inject({
      url: `${url}/${source.id}/files/${first.value.id}`,
      headers: { authorization: `Bearer ${t.admin}` },
    });
    assert.equal(original.statusCode, 200);
    assert.equal(
      original.body,
      Buffer.from(upload.content, "base64").toString(),
    );
    const job = await t.request(
      "POST",
      `${url}/${source.id}/normalize`,
      { sourceVersionId: first.value.id },
      t.admin,
    );
    assert.equal(job.status, 202);
    assert.equal(job.value.state, "queued");
    assert.equal(
      (
        await t.request(
          "GET",
          `/api/domains/ads/knowledge-jobs/${job.value.id}`,
          undefined,
          t.alice,
        )
      ).status,
      403,
    );
  } finally {
    await t.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
