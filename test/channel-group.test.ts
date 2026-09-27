import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, publish } from "./helpers.js";
import type { Inbound, WecomTransport } from "../src/adapters/wecom.js";
import type { WecomOptions } from "../src/channel.js";

const unavailableAudiences: [string, WecomOptions["groupAudience"]][] = [
  ["missing", async () => undefined],
  [
    "incomplete",
    async () => ({
      userIds: ["alice"],
      complete: false,
      expiresAt: Date.now() + 1000,
    }),
  ],
  [
    "expired",
    async () => ({
      userIds: ["alice"],
      complete: true,
      expiresAt: Date.now() - 1000,
    }),
  ],
  [
    "unauthorized member",
    async () => ({
      userIds: ["alice", "stranger"],
      complete: true,
      expiresAt: Date.now() + 1000,
    }),
  ],
  [
    "directory failure",
    async () => {
      throw new Error("private directory failure details");
    },
  ],
];

for (const [scenario, groupAudience] of unavailableAudiences)
  test(`an allowlisted group without a verified audience receives only single-chat guidance (${scenario})`, async () => {
    let receive!: (event: Inbound) => Promise<void>;
    let modelCalls = 0;
    const sent: { text: string; finish: boolean }[] = [];
    const transport: WecomTransport = {
      start(fn) {
        receive = fn;
      },
      close() {},
      async reply(_e, _s, text, finish) {
        sent.push({ text, finish });
      },
    };
    const t = await setup({
      model: {
        async generate() {
          modelCalls++;
          throw new Error("must not generate group knowledge");
        },
      },
      wecom: {
        botId: "test",
        domain: "ads",
        members: { alice: "alice" },
        groups: ["group"],
        groupAudience,
        transport,
      },
    });
    try {
      const event: Inbound = {
        id: "g1",
        botId: "test",
        userId: "alice",
        chatType: "group",
        chatId: "group",
        text: "@bot 示例流程怎么做",
        replyContext: {},
      };
      await receive(event);
      await receive(event);
      assert.equal(
        sent.length,
        1,
        "an addressed group request must not disappear silently",
      );
      assert.match(sent[0]!.text, /群成员.*核验.*单聊/);
      assert.doesNotMatch(
        sent[0]!.text,
        /示例流程|guide|答案|广告|private|alice|http/,
      );
      assert.equal(sent[0]!.finish, true);
      assert.equal(modelCalls, 0);
      const receipts = (
        await t.request(
          "GET",
          "/api/domains/ads/channel-receipts",
          undefined,
          t.alice,
        )
      ).value;
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].state, "acked");
      assert.equal(receipts[0].code, "GROUP_AUDIENCE_UNKNOWN");
      assert.equal(receipts[0].complete, false);
      assert.equal(receipts[0].answerId, undefined);
      // The public notice still requires an eligible sender, an allowed group,
      // and a mention. It must not become an unsolicited group message.
      await receive({ ...event, id: "other-group", chatId: "unknown" });
      await receive({ ...event, id: "not-addressed", text: "示例流程怎么做" });
      await receive({ ...event, id: "unknown-sender", userId: "unmapped" });
      const revoked = await t.request("PUT", "/api/domains/ads/members/alice", {
        role: "member",
        enabled: false,
        expectedVersion: 1,
      });
      assert.equal(revoked.status, 200);
      await receive({ ...event, id: "revoked-sender" });
      assert.equal(sent.length, 1);
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
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /单聊/);
    assert.doesNotMatch(sent[0]!, /测试模型|guide|答案|私人秘密/);
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

test("an allowlisted group answers @-mentions when no audience directory is wired", async () => {
  let receive!: (event: Inbound) => Promise<void>;
  let modelCalls = 0;
  const sent: { text: string; finish: boolean }[] = [];
  const transport: WecomTransport = {
    start(fn) {
      receive = fn;
    },
    close() {},
    async reply(_e, _s, text, finish) {
      sent.push({ text, finish });
    },
  };
  const t = await setup({
    model: {
      async generate(r) {
        modelCalls++;
        const prompt = JSON.parse(r.prompt);
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
      members: { alice: "alice" },
      groups: ["group"],
      transport,
    },
  });
  const event = (over: Partial<Inbound>): Inbound => ({
    id: `g-${sent.length}-${modelCalls}`,
    botId: "test",
    userId: "alice",
    chatType: "group",
    chatId: "group",
    text: "@bot 示例流程怎么做",
    replyContext: {},
    ...over,
  });
  try {
    await publish(t);
    const baseline = modelCalls; // publish() evaluates the golden QA cases.
    await receive(event({}));
    assert.equal(modelCalls - baseline, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /示例回答/);
    assert.match(sent[0]!.text, /依据：guide/);
    assert.equal(sent[0]!.finish, true);
    const receipts = (
      await t.request(
        "GET",
        "/api/domains/ads/channel-receipts",
        undefined,
        t.alice,
      )
    ).value;
    assert.equal(receipts.at(-1).state, "acked");
    assert.equal(receipts.at(-1).complete, true);
    assert.equal(receipts.at(-1).answerId !== undefined, true);
    // A trailing mention ("…？ @机器人") must answer the same way.
    await receive(
      event({ id: "trailing", text: "示例流程怎么做？ @bot" }),
    );
    assert.equal(modelCalls - baseline, 2);
    assert.equal(sent.length, 2);
    assert.match(sent[1]!.text, /示例回答/);
    // The structural gates still hold without a directory.
    await receive(event({ id: "unknown-group", chatId: "elsewhere" }));
    await receive(event({ id: "not-addressed", text: "示例流程怎么做" }));
    await receive(event({ id: "unknown-sender", userId: "unmapped" }));
    await receive(event({ id: "bare-mention", text: "@bot" }));
    assert.equal(modelCalls - baseline, 2);
    assert.equal(sent.length, 2);
    // Natural feedback closes the loop right in the group, referencing the
    // group answer; the tracking hint points at the bot single chat.
    await receive(
      event({ id: "group-feedback", text: "@bot 反馈 第二步描述不完整" }),
    );
    assert.equal(sent.length, 3);
    assert.match(sent[2]!.text, /反馈已登记/);
    assert.match(sent[2]!.text, /到机器人单聊发送 \/工单/);
    // Personal slash commands still bounce to the single chat.
    await receive(event({ id: "group-slash", text: "@bot /偏好 查看" }));
    assert.match(sent.at(-1)!.text, /单聊或认证网页/);
    assert.equal(modelCalls - baseline, 2);
  } finally {
    await t.app.close();
  }
});
