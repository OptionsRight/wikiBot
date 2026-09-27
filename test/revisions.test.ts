import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, publish } from "./helpers.js";
test("an explicit administrator revision waits for source synchronization and cannot claim publication", async () => {
  const t = await setup();
  try {
    const release = await publish(t);
    const payload = {
      title: "更正准备步骤",
      reason: "专家指出还需要准备审批材料",
      scope: "仅新申请",
      changes: [
        {
          pageId: "guide",
          baseHash: release.bundle.pages[0].hash,
          content: "先准备审批材料，再提交申请，最后核对。",
          source: "专家更正记录 TEST-001；测试用合成材料",
        },
      ],
    };
    assert.equal(
      (await t.request("POST", "/api/domains/ads/revisions", payload, t.alice))
        .status,
      403,
    );
    const draft = await t.request(
      "POST",
      "/api/domains/ads/revisions",
      payload,
      t.admin,
    );
    assert.equal(draft.status, 201);
    const submitted = await t.request(
      "POST",
      `/api/domains/ads/revisions/${draft.value.id}/submit`,
      { expectedVersion: 1 },
      t.admin,
    );
    assert.equal(submitted.value.state, "sync_pending");
    assert.equal(
      (await t.request("GET", "/api/domains/ads/knowledge", undefined, t.alice))
        .value.release.id,
      release.id,
    );
    assert.equal(
      (
        await t.request(
          "GET",
          `/api/domains/ads/revisions/${draft.value.id}`,
          undefined,
          t.alice,
        )
      ).status,
      403,
    );
  } finally {
    await t.app.close();
  }
});

test("a corrected snapshot uses the existing evaluation, review and activation gates", async () => {
  const t = await setup();
  try {
    const original = await publish(t);
    const payload = {
      title: "更正准备步骤",
      reason: "合成专家要求提交前准备审批材料",
      scope: "仅测试",
      changes: [
        {
          pageId: "guide",
          baseHash: original.bundle.pages[0].hash,
          content:
            original.bundle.pages[0].content + " 更正：测试场景需要审批材料。",
          source: "合成专家依据 TEST-002，不作为真实业务依据",
        },
      ],
    };
    const draft = (
      await t.request("POST", "/api/domains/ads/revisions", payload, t.admin)
    ).value;
    const queued = (
      await t.request(
        "POST",
        `/api/domains/ads/revisions/${draft.id}/submit`,
        { expectedVersion: 1 },
        t.admin,
      )
    ).value;
    const { hash } = await import("../src/core.js");
    const bundle = structuredClone(original.bundle);
    bundle.pages[0].content = payload.changes[0]!.content;
    bundle.pages[0].hash = hash(bundle.pages[0].content);
    const candidate = (
      await t.request("POST", "/api/domains/ads/submissions", bundle, t.admin)
    ).value;
    const linked = await t.request(
      "POST",
      `/api/domains/ads/revisions/${draft.id}/snapshot`,
      {
        expectedVersion: queued.version,
        candidateId: candidate.id,
        sourceEvidence:
          "隔离实验：已核对独立更正记录、来源最终哈希和快照；此处为合成测试。",
      },
      t.admin,
    );
    assert.equal(linked.status, 200);
    assert.equal(linked.value.state, "snapshot_ready");
    assert.equal(
      (await t.request("GET", "/api/domains/ads/knowledge", undefined, t.alice))
        .value.release.id,
      original.id,
    );
    const review = {
      expectedVersion: candidate.version,
      descriptorHash: candidate.descriptorHash,
      evidence: "测试管理员核对更正与相邻问题",
      approved: true,
    };
    assert.equal(
      (
        await t.request(
          "POST",
          `/api/domains/ads/releases/${candidate.id}/review`,
          review,
          t.admin,
        )
      ).status,
      409,
    );
    for (const c of bundle.cases)
      assert.equal(
        (
          await t.request(
            "POST",
            `/api/domains/ads/releases/${candidate.id}/evaluations`,
            { caseId: c.id, descriptorHash: candidate.descriptorHash },
            t.admin,
          )
        ).value.state,
        "complete",
      );
    const ready = (
      await t.request(
        "POST",
        `/api/domains/ads/releases/${candidate.id}/review`,
        review,
        t.admin,
      )
    ).value;
    assert.equal(
      (
        await t.request(
          "POST",
          `/api/domains/ads/releases/${candidate.id}/activate`,
          {
            expectedVersion: ready.version,
            expectedEpoch: candidate.baseEpoch,
            expectedActive: original.id,
            descriptorHash: candidate.descriptorHash,
          },
          t.admin,
        )
      ).status,
      200,
    );
    const final = (
      await t.request(
        "GET",
        `/api/domains/ads/revisions/${draft.id}`,
        undefined,
        t.admin,
      )
    ).value;
    assert.equal(final.state, "released");
    assert.equal(final.releaseId, candidate.id);
  } finally {
    await t.app.close();
  }
});
