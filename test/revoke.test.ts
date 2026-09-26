import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, publish, sampleBundle } from "./helpers.js";
test("revocation invalidates stale candidates and permits a freshly reviewed repair from an empty baseline", async () => {
  const t = await setup();
  try {
    const live = await publish(t);
    const old = (
      await t.request(
        "POST",
        "/api/domains/ads/submissions",
        sampleBundle(),
        t.admin,
      )
    ).value;
    const revoke = await t.request(
      "POST",
      `/api/domains/ads/releases/${live.id}/revoke`,
      {
        expectedVersion: live.version,
        expectedEpoch: 1,
        expectedActive: live.id,
        descriptorHash: live.descriptorHash,
        reason: "专家确认流程存在错误，需要紧急更正",
      },
      t.admin,
    );
    assert.equal(revoke.status, 200);
    assert.equal(
      (await t.request("GET", "/api/domains/ads/knowledge", undefined, t.alice))
        .status,
      503,
    );
    assert.equal(
      (
        await t.request(
          "POST",
          `/api/domains/ads/releases/${old.id}/review`,
          {
            expectedVersion: old.version,
            descriptorHash: old.descriptorHash,
            evidence: "旧复核记录不能绕过当前发布基线",
            approved: true,
          },
          t.admin,
        )
      ).status,
      409,
    );
    const repair = await publish(t);
    assert.notEqual(repair.id, live.id);
    assert.equal(
      (await t.request("GET", "/api/domains/ads/knowledge", undefined, t.alice))
        .value.release.id,
      repair.id,
    );
  } finally {
    await t.app.close();
  }
});
