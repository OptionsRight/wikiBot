import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, publish } from "./helpers.js";

test("member receives a complete selected path, and a duplicate request returns the original answer", async () => {
  const t = await setup({
    model: {
      async generate(request) {
        return {
          text: JSON.stringify({
            text: "按照资料准备和核验即可。",
            citations: ["guide"],
          }),
          model: request.model,
          inputTokens: 1,
          outputTokens: 2,
          firstTextMs: 1,
          totalMs: 2,
          stopReason: "end_turn",
        };
      },
    },
  });
  try {
    await publish(t);
    const payload = {
      question: "示例流程怎么做",
      procedureId: "example",
      sessionId: "session-1",
      objectId: "customer-a",
      inputs: { scenario: "new" },
    };
    const first = await t.request(
      "POST",
      "/api/domains/ads/answers",
      payload,
      t.alice,
      "same",
    );
    assert.equal(first.status, 202);
    const again = await t.request(
      "POST",
      "/api/domains/ads/answers",
      payload,
      t.alice,
      "same",
    );
    assert.equal(again.value.id, first.value.id);
    let answer;
    for (let i = 0; i < 30; i++) {
      answer = (
        await t.request(
          "GET",
          `/api/domains/ads/answers/${first.value.id}`,
          undefined,
          t.alice,
        )
      ).value;
      if (answer.state !== "queued" && answer.state !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(answer.state, "complete");
    assert.equal(answer.checklistComplete, true);
    assert.deepEqual(
      answer.blocks
        .filter((b: { type: string }) => b.type === "node")
        .map((b: { nodeId: string }) => b.nodeId),
      ["prepare", "submit", "check"],
    );
    assert.equal(
      (
        await t.request(
          "GET",
          `/api/domains/ads/answers/${first.value.id}`,
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
