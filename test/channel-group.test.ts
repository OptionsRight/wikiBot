import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, publish } from "./helpers.js";
import type { Inbound, WecomTransport } from "../src/adapters/wecom.js";

test("an allowlisted group without a verified current audience receives no answer", async () => {
  let receive!: (event: Inbound) => Promise<void>;
  const sent: string[] = [];
  const transport: WecomTransport = {
    start(fn) {
      receive = fn;
    },
    close() {},
    async reply(_e, _s, text) {
      sent.push(text);
    },
  };
  const t = await setup({
    wecom: {
      botId: "test",
      domain: "ads",
      members: { alice: "alice" },
      groups: ["group"],
      transport,
    },
  });
  try {
    await publish(t);
    await receive({
      id: "g1",
      botId: "test",
      userId: "alice",
      chatType: "group",
      chatId: "group",
      text: "@bot 示例流程怎么做",
      replyContext: {},
    });
    assert.deepEqual(sent, []);
  } finally {
    await t.app.close();
  }
});

test("audience changes stop delivery and group commands never reveal private tickets", async () => {
  let receive!: (event: Inbound) => Promise<void>,
    checks = 0;
  const sent: string[] = [];
  const transport: WecomTransport = {
    start(fn) {
      receive = fn;
    },
    close() {},
    async reply(_e, _s, text) {
      sent.push(text);
    },
  };
  let changing = true;
  const t = await setup({
    wecom: {
      botId: "test",
      domain: "ads",
      members: { alice: "alice" },
      groups: ["group"],
      groupAudience: async () => ({
        complete: true,
        expiresAt: Date.now() + 1000,
        userIds: changing && ++checks > 1 ? ["alice", "stranger"] : ["alice"],
      }),
      transport,
    },
  });
  const event = (id: string, text: string): Inbound => ({
    id,
    botId: "test",
    userId: "alice",
    chatType: "group",
    chatId: "group",
    text: `@bot ${text}`,
    replyContext: {},
  });
  try {
    await publish(t);
    await receive(event("changed", "示例流程怎么做"));
    assert.deepEqual(sent, []);
    changing = false;
    const ticket = (
      await t.request(
        "POST",
        "/api/domains/ads/tickets",
        {
          title: "私人秘密",
          description: "只有报告人可以查看",
          category: "question",
        },
        t.alice,
      )
    ).value;
    await receive(event("private", `/工单 ${ticket.id}`));
    assert.match(sent.at(-1)!, /单聊/);
    assert.doesNotMatch(sent.at(-1)!, /私人秘密/);
  } finally {
    await t.app.close();
  }
});

test("group follow-up history is isolated when a newly authorized member joins", async () => {
  let receive!: (event: Inbound) => Promise<void>;
  let audience = ["alice"];
  const prompts: { history?: unknown[] }[] = [];
  const transport: WecomTransport = {
    start(fn) {
      receive = fn;
    },
    close() {},
    async reply() {},
  };
  const t = await setup({
    model: {
      async generate(r) {
        const prompt = JSON.parse(r.prompt);
        prompts.push(prompt);
        return {
          text: JSON.stringify({
            text: "示例回答",
            citations: [prompt.pages[0].id],
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
    wecom: {
      botId: "test",
      domain: "ads",
      members: { alice: "alice", bob: "bob" },
      groups: ["group"],
      groupAudience: async () => ({
        complete: true,
        userIds: audience,
        expiresAt: Date.now() + 1000,
      }),
      transport,
    },
  });
  const send = (id: string) =>
    receive({
      id,
      botId: "test",
      userId: "alice",
      chatType: "group",
      chatId: "group",
      text: "@bot 示例流程怎么做",
      replyContext: {},
    });
  try {
    await publish(t);
    await send("first");
    await send("same-audience");
    assert.equal(prompts.at(-1)?.history?.length, 1);
    audience = ["alice", "bob"];
    await send("new-audience");
    assert.equal(prompts.at(-1)?.history, undefined);
  } finally {
    await t.app.close();
  }
});
