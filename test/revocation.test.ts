import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, publish } from "./helpers.js";

test("revoked knowledge cannot be read or rolled back; a newly reviewed candidate can reopen an empty pointer", async () => {
  const t = await setup();
  try {
    const release = await publish(t);
    const input = {
      expectedVersion: release.version,
      expectedEpoch: 1,
      expectedActive: release.id,
      descriptorHash: release.descriptorHash,
      reason: "synthetic emergency knowledge withdrawal",
    };
    const revoked = await t.request(
      "POST",
      `/api/domains/ads/releases/${release.id}/revoke`,
      input,
      t.admin,
      "revoke-once",
    );
    assert.equal(revoked.status, 200);
    assert.deepEqual(
      (
        await t.request(
          "POST",
          `/api/domains/ads/releases/${release.id}/revoke`,
          input,
          t.admin,
          "revoke-once",
        )
      ).value,
      revoked.value,
    );
    assert.equal(
      (await t.request("GET", "/api/domains/ads/knowledge", undefined, t.alice))
        .status,
      503,
    );
    assert.equal(
      (
        await t.request(
          "GET",
          `/api/domains/ads/releases/${release.id}/pages/guide`,
          undefined,
          t.alice,
        )
      ).status,
      410,
    );
    assert.equal(
      (
        await t.request(
          "POST",
          `/api/domains/ads/releases/${release.id}/rollback-candidate`,
          {
            expectedEpoch: 2,
            expectedActive: null,
            descriptorHash: release.descriptorHash,
            reason: "must not resurrect a revoked release",
          },
          t.admin,
        )
      ).status,
      409,
    );
    const repaired = await publish(t);
    const knowledge = await t.request(
      "GET",
      "/api/domains/ads/knowledge",
      undefined,
      t.alice,
    );
    assert.equal(knowledge.value.release.id, repaired.id);
    assert.notEqual(repaired.id, release.id);
    const releases = await t.request(
      "GET",
      "/api/domains/ads/releases",
      undefined,
      t.admin,
    );
    assert.equal(
      releases.value.find((r: { id: string }) => r.id === release.id).state,
      "revoked",
    );
  } finally {
    await t.app.close();
  }
});
