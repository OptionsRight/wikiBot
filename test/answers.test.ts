import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, publish } from "./helpers.js";

test("member receives a retrieved grounded answer, and a duplicate request returns the original answer", async () => {
  const t = await setup({
    model: {
      async generate(request) {
        const pages = (JSON.parse(request.prompt).pages ?? []) as {
          id: string;
        }[];
        return {
          text: JSON.stringify({
            text: "先准备材料，再提交申请，最后核对结果。",
            citations: pages.slice(0, 1).map((p) => p.id),
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
    const payload = { question: "示例流程怎么做", sessionId: "session-1" };
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
    assert.equal(answer.code, "ANSWER");
    assert.equal(answer.blocks.length, 1);
    assert.equal(answer.blocks[0].type, "explanation");
    assert.deepEqual(answer.blocks[0].citations, ["guide"]);
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

test("follow-up questions carry recent session history into generation", async () => {
  const prompts: string[] = [];
  const t = await setup({
    model: {
      async generate(r) {
        prompts.push(r.prompt);
        const parsed = JSON.parse(r.prompt) as {
          pages: { id: string }[];
          history?: unknown[];
        };
        return {
          text: JSON.stringify({
            text: `回答（${parsed.history?.length ?? 0} 轮历史）`,
            citations: parsed.pages.slice(0, 1).map((p) => p.id),
          }),
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
    const ask = async (question: string, sessionId: string) => {
      const created = await t.request(
        "POST",
        "/api/domains/ads/answers",
        { question, sessionId },
        t.alice,
      );
      for (let i = 0; i < 30; i++) {
        const a = (
          await t.request(
            "GET",
            `/api/domains/ads/answers/${created.value.id}`,
            undefined,
            t.alice,
          )
        ).value;
        if (a.state !== "queued" && a.state !== "running") return a;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("answer never settled");
    };
    const first = await ask("示例流程怎么做", "multi");
    await t.request(
      "POST",
      `/api/domains/ads/answers/${first.id}/ack`,
      { through: 1 },
      t.alice,
    );
    const followUp = await ask("那结算的呢", "multi");
    assert.equal(followUp.code, "ANSWER");
    const second = JSON.parse(prompts.at(-1)!) as {
      history?: { question: string; answer: string }[];
    };
    assert.equal(second.history?.length, 1);
    assert.equal(second.history?.[0]?.question, "示例流程怎么做");
    assert.match(second.history?.[0]?.answer ?? "", /0 轮历史/);
    assert.match(followUp.blocks[0].text, /1 轮历史/);
    await ask("示例流程怎么做", "fresh-session");
    const third = JSON.parse(prompts.at(-1)!) as { history?: unknown };
    assert.equal(third.history, undefined);
  } finally {
    await t.app.close();
  }
});

test("streamed partials are display-only and the final validated block is authoritative", async () => {
  const full = "第一段内容。\n第二段内容。\n可继续追问：还有什么？";
  const chunks = ["第一段内容。", "\n第二段内容。", "\n可继续追问：还有什么？"];
  const t = await setup({
    model: {
      async generate(r) {
        const pages = (JSON.parse(r.prompt).pages ?? []) as { id: string }[];
        for (const chunk of chunks) {
          r.onText?.(chunk);
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        return {
          text: JSON.stringify({
            text: full,
            citations: pages.slice(0, 1).map((p) => p.id),
          }),
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
    const created = await t.request(
      "POST",
      "/api/domains/ads/answers",
      { question: "示例流程怎么做", sessionId: "streaming" },
      t.alice,
    );
    const observed: string[] = [];
    let answer = created.value;
    for (let i = 0; i < 100; i++) {
      answer = (
        await t.request(
          "GET",
          `/api/domains/ads/answers/${created.value.id}`,
          undefined,
          t.alice,
        )
      ).value;
      if (answer.state === "running" && answer.blocks[0]?.text)
        observed.push(answer.blocks[0].text);
      if (answer.state !== "queued" && answer.state !== "running") break;
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.equal(answer.state, "complete");
    assert.equal(answer.blocks[0].text, full);
    assert.deepEqual(answer.blocks[0].citations, ["guide"]);
    // Partials are visible while running so chat clients render progress;
    // they never carry citations and are replaced by the validated block.
    assert.ok(
      observed.some((text) => text.length > 0 && text.length < full.length),
      `expected a partial read, got ${JSON.stringify(observed)}`,
    );
    assert.ok(observed.every((text) => text.length <= full.length));
  } finally {
    await t.app.close();
  }
});

test("bare-markdown output degrades to the top retrieved page instead of failing", async () => {
  let malformed = false;
  const t = await setup({
    model: {
      async generate(r) {
        const pages = JSON.parse(r.prompt).pages;
        return {
          // Model drops the JSON protocol entirely (seen with multi-turn
          // history on the real endpoint).
          text: malformed
            ? `## 直接是 Markdown 正文\n没有任何 JSON 包裹。`
            : JSON.stringify({ text: "测试回答", citations: [pages[0].id] }),
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
    malformed = true;
    const created = await t.request(
      "POST",
      "/api/domains/ads/answers",
      { question: "示例流程怎么做", sessionId: "protocol-fallback" },
      t.alice,
    );
    let answer = created.value;
    for (let i = 0; i < 30; i++) {
      answer = (
        await t.request(
          "GET",
          `/api/domains/ads/answers/${created.value.id}`,
          undefined,
          t.alice,
        )
      ).value;
      if (answer.state !== "queued" && answer.state !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(answer.state, "complete");
    assert.equal(answer.code, "ANSWER");
    assert.match(answer.blocks[0].text, /直接是 Markdown 正文/);
    assert.ok(answer.blocks[0].citations.length >= 1);
  } finally {
    await t.app.close();
  }
});

test("questions outside published knowledge get an explicit coverage gap instead of a model answer", async () => {
  const t = await setup();
  try {
    await publish(t);
    const created = await t.request(
      "POST",
      "/api/domains/ads/answers",
      { question: "工牌补办在哪里办", sessionId: "session-2" },
      t.alice,
    );
    let answer = created.value;
    for (let i = 0; i < 30; i++) {
      answer = (
        await t.request(
          "GET",
          `/api/domains/ads/answers/${created.value.id}`,
          undefined,
          t.alice,
        )
      ).value;
      if (answer.state !== "queued" && answer.state !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(answer.state, "complete");
    assert.equal(answer.code, "KNOWLEDGE_COVERAGE_GAP");
    assert.equal(answer.blocks.length, 1);
    assert.equal(answer.blocks[0].type, "status");
  } finally {
    await t.app.close();
  }
});

test("technical tags win the default while explicit preferences and request style take priority", async () => {
  const t = await setup();
  try {
    await publish(t);
    const updated = await t.request("PUT", "/api/domains/ads/members/alice", {
      role: "member",
      expectedVersion: 1,
      tags: ["business", "technical"],
    });
    assert.equal(updated.status, 200);
    const defaults = await t.request(
      "GET",
      "/api/domains/ads/preferences",
      undefined,
      t.alice,
    );
    assert.equal(defaults.value.style, "technical");
    const first = await t.request(
      "POST",
      "/api/domains/ads/answers",
      { question: "示例流程", sessionId: "tags1" },
      t.alice,
    );
    assert.equal(first.value.style, "technical");
    await t.request(
      "PATCH",
      "/api/domains/ads/preferences",
      { style: "business", depth: "experienced", expectedVersion: 0 },
      t.alice,
    );
    const second = await t.request(
      "POST",
      "/api/domains/ads/answers",
      { question: "示例流程", sessionId: "tags2" },
      t.alice,
    );
    assert.equal(second.value.style, "business");
    const third = await t.request(
      "POST",
      "/api/domains/ads/answers",
      { question: "示例流程", sessionId: "tags3", style: "technical" },
      t.alice,
    );
    assert.equal(third.value.style, "technical");
  } finally {
    await t.app.close();
  }
});

test("deleting a saved preference restores the current tag default", async () => {
  const t = await setup();
  try {
    await t.request("PUT", "/api/domains/ads/members/alice", {
      role: "member",
      expectedVersion: 1,
      tags: ["business", "technical"],
    });
    await t.request(
      "PATCH",
      "/api/domains/ads/preferences",
      { style: "business", depth: "experienced", expectedVersion: 0 },
      t.alice,
    );
    await t.request(
      "DELETE",
      "/api/domains/ads/preferences",
      { expectedVersion: 1 },
      t.alice,
    );
    const p = await t.request(
      "GET",
      "/api/domains/ads/preferences",
      undefined,
      t.alice,
    );
    assert.equal(p.value.style, "technical");
    assert.equal(p.value.version, 2);
  } finally {
    await t.app.close();
  }
});
