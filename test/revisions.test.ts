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
