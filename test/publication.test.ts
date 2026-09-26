import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sampleBundle, publish } from "./helpers.js";

test("an approved immutable flow becomes readable to granted members only", async () => {
  const t = await setup();
  try {
    const release = await publish(t);
    const view = await t.request(
      "GET",
      "/api/domains/ads/knowledge",
      undefined,
      t.alice,
    );
    assert.equal(view.status, 200);
    assert.equal(view.value.release.id, release.id);
    assert.equal(view.value.pages[0].title, "示例流程");
    const forbidden = await t.request(
      "POST",
      "/api/domains/ads/submissions",
      sampleBundle(),
      t.alice,
    );
    assert.equal(forbidden.status, 403);
  } finally {
    await t.app.close();
  }
});
