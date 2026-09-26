import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, publish } from "./helpers.js";
test("members can inspect a retired answer citation until that exact release is revoked", async () => {
  const t = await setup();
  try {
    const first = await publish(t),
      second = await publish(t);
    const url = `/api/domains/ads/releases/${first.id}/pages/guide`;
    assert.equal(
      (await t.request("GET", url, undefined, t.alice)).value.content,
      "这是测试流程。先准备材料，再提交申请，最后核对结果。",
    );
    const releases = (
      await t.request("GET", "/api/domains/ads/releases", undefined, t.admin)
    ).value;
    const retired = releases.find((r: { id: string }) => r.id === first.id);
    const revocation = await t.request(
      "POST",
      `/api/domains/ads/releases/${first.id}/revoke`,
      {
        expectedVersion: retired.version,
        expectedEpoch: 2,
        expectedActive: second.id,
        descriptorHash: first.descriptorHash,
        reason: "历史知识存在错误，明确撤回该版本",
      },
      t.admin,
    );
    assert.equal(revocation.status, 200);
    assert.equal((await t.request("GET", url, undefined, t.alice)).status, 410);
  } finally {
    await t.app.close();
  }
});
