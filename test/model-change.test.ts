import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, publish } from "./helpers.js";

test("model change pauses new work and exposes only previously acknowledged history", async () => {
  const t = await setup();
  try {
    await publish(t);
    const answer = (
      await t.request(
        "POST",
        "/api/domains/ads/answers",
        { question: "示例流程怎么做", sessionId: "s" },
        t.alice,
      )
    ).value;
    const before = await t.request(
      "GET",
      `/api/domains/ads/answers/${answer.id}`,
      undefined,
      t.alice,
    );
    assert.ok(before.value.blocks.length >= 1);
    await t.request(
      "POST",
      `/api/domains/ads/answers/${answer.id}/ack`,
      { through: 1 },
      t.alice,
    );
    const change = await t.request("POST", "/api/models/change", {
      model: "test-model",
      revision: "r1",
      expectedEpoch: 0,
      reason: "供应方确认模型部署发生变化",
    });
    assert.equal(change.status, 200);
    const history = await t.request(
      "GET",
      `/api/domains/ads/answers/${answer.id}`,
      undefined,
      t.alice,
    );
    assert.equal(history.value.review, "pending");
    assert.equal(history.value.blocks.length, 1);
    assert.equal(history.value.modelMetrics, undefined);
    assert.equal(
      (
        await t.request(
          "POST",
          "/api/domains/ads/answers",
          { question: "示例", sessionId: "s2" },
          t.alice,
        )
      ).status,
      503,
    );
    assert.equal(
      (await t.request("GET", "/api/domains/ads/knowledge", undefined, t.alice))
        .status,
      200,
    );
    assert.equal(
      (
        await t.request(
          "GET",
          `/api/domains/ads/answers/${answer.id}`,
          undefined,
          t.bob,
        )
      ).status,
      404,
    );
  } finally {
    await t.app.close();
  }
});
