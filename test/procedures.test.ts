import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sampleBundle } from "./helpers.js";

test("overlapping paths and gaps inside approved scope cannot be submitted for publication", async () => {
  const t = await setup();
  try {
    const overlap = sampleBundle();
    overlap.procedures[0]!.branches[1]!.when.value = "new";
    const rejected = await t.request(
      "POST",
      "/api/domains/ads/submissions",
      overlap,
      t.admin,
    );
    assert.equal(rejected.status, 400);
    assert.equal(rejected.value.error.code, "PROCEDURE_BRANCH_CONFLICT");
    const gap = sampleBundle();
    gap.procedures[0]!.branches.pop();
    const missing = await t.request(
      "POST",
      "/api/domains/ads/submissions",
      gap,
      t.admin,
    );
    assert.equal(missing.status, 400);
    assert.equal(missing.value.error.code, "PROCEDURE_BRANCH_GAP");
  } finally {
    await t.app.close();
  }
});
