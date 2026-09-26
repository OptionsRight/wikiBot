import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sampleBundle } from "./helpers.js";
test("manual approval cannot activate a candidate without its exact regression results", async () => {
  const t = await setup();
  try {
    const r = (
      await t.request(
        "POST",
        "/api/domains/ads/submissions",
        sampleBundle(),
        t.admin,
      )
    ).value;
    const review = await t.request(
      "POST",
      `/api/domains/ads/releases/${r.id}/review`,
      {
        expectedVersion: r.version,
        descriptorHash: r.descriptorHash,
        evidence: "人工签字也不能替代没有运行的回归评估",
        approved: true,
      },
      t.admin,
    );
    assert.equal(review.status, 409);
    assert.equal(review.value.error.code, "EVALUATION_REQUIRED");
  } finally {
    await t.app.close();
  }
});
