import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, publish } from "./helpers.js";

test("unacknowledged or cancelled answers do not become follow-up history", async () => {
  const prompts: any[] = [];
  const t = await setup({
    model: {
      async generate(r) {
        const p = JSON.parse(r.prompt);
        prompts.push(p);
        return {
          text: JSON.stringify({ text: "回答", citations: [p.pages[0].id] }),
          model: r.model,
          inputTokens: 1,
          outputTokens: 1,
          firstTextMs: 1,
          totalMs: 1,
          stopReason: "end_turn",
        };
      },
    },
  });
  try {
    await publish(t);
    async function ask() {
      const created = (
        await t.request(
          "POST",
          "/api/domains/ads/answers",
          { question: "示例流程", sessionId: "same" },
          t.alice,
        )
      ).value;
      for (let i = 0; i < 30; i++) {
        const a = (
          await t.request(
            "GET",
            `/api/domains/ads/answers/${created.id}`,
            undefined,
            t.alice,
          )
        ).value;
        if (a.state === "complete") return a;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("not complete");
    }
    const first = await ask();
    await ask();
    assert.equal(prompts.at(-1).history, undefined);
    await t.request(
      "POST",
      `/api/domains/ads/answers/${first.id}/ack`,
      { through: 1 },
      t.alice,
    );
    await ask();
    assert.equal(prompts.at(-1).history.length, 1);
    await t.request(
      "POST",
      `/api/domains/ads/answers/${first.id}/cancel`,
      {},
      t.alice,
    );
    await ask();
    assert.equal(prompts.at(-1).history, undefined);
  } finally {
    await t.app.close();
  }
});

test("an acknowledged clarification supplies context for an elliptical reply", async () => {
  let clarify = false;
  const t = await setup({
    model: {
      async generate(r) {
        const p = JSON.parse(r.prompt);
        const text = clarify
          ? p.history?.length
            ? { text: "依据原问题回答", citations: [p.pages[0].id] }
            : {
                text: "请选择前者还是后者？",
                citations: [],
                outcome: "clarification",
              }
          : { text: "评估答案", citations: [p.pages[0].id] };
        return {
          text: JSON.stringify(text),
          model: r.model,
          stopReason: "end_turn",
          inputTokens: 1,
          outputTokens: 1,
          firstTextMs: 1,
          totalMs: 1,
        };
      },
    },
  });
  try {
    await publish(t);
    clarify = true;
    const first = (
      await t.request(
        "POST",
        "/api/domains/ads/answers",
        { question: "示例流程", sessionId: "clarify" },
        t.alice,
      )
    ).value;
    const read = (
      await t.request(
        "GET",
        `/api/domains/ads/answers/${first.id}`,
        undefined,
        t.alice,
      )
    ).value;
    assert.equal(read.code, "CLARIFICATION_REQUIRED");
    await t.request(
      "POST",
      `/api/domains/ads/answers/${first.id}/ack`,
      { through: 1 },
      t.alice,
    );
    const reply = (
      await t.request(
        "POST",
        "/api/domains/ads/answers",
        { question: "前者", sessionId: "clarify" },
        t.alice,
      )
    ).value;
    const final = (
      await t.request(
        "GET",
        `/api/domains/ads/answers/${reply.id}`,
        undefined,
        t.alice,
      )
    ).value;
    assert.equal(final.code, "ANSWER");
    assert.match(final.blocks[0].text, /依据原问题/);
  } finally {
    await t.app.close();
  }
});

test("a new knowledge version excludes previously delivered history", async () => {
  let seenHistory: unknown;
  const t = await setup({
    model: {
      async generate(r) {
        const p = JSON.parse(r.prompt);
        seenHistory = p.history;
        return {
          text: JSON.stringify({ text: "说明", citations: [p.pages[0].id] }),
          model: r.model,
          stopReason: "end_turn",
          inputTokens: 1,
          outputTokens: 1,
          firstTextMs: 1,
          totalMs: 1,
        };
      },
    },
  });
  try {
    await publish(t);
    const a = (
      await t.request(
        "POST",
        "/api/domains/ads/answers",
        { question: "示例流程", sessionId: "version" },
        t.alice,
      )
    ).value;
    await t.request(
      "GET",
      `/api/domains/ads/answers/${a.id}`,
      undefined,
      t.alice,
    );
    await t.request(
      "POST",
      `/api/domains/ads/answers/${a.id}/ack`,
      { through: 1 },
      t.alice,
    );
    await publish(t);
    await t.request(
      "POST",
      "/api/domains/ads/answers",
      { question: "示例流程", sessionId: "version" },
      t.alice,
    );
    assert.equal(seenHistory, undefined);
  } finally {
    await t.app.close();
  }
});
