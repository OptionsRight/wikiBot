import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, publish } from "./helpers.js";
import type { Inbound, WecomTransport } from "../src/adapters/wecom.js";
test("verified single-chat requests deduplicate by real message id and deliver cumulative acknowledged blocks", async () => {
  let receive!: (event: Inbound) => Promise<void>;
  const sent: { text: string; finish: boolean }[] = [];
  const transport: WecomTransport = {
    start(handler) {
      receive = handler;
    },
    close() {},
    async reply(_e, _stream, text, finish) {
      sent.push({ text, finish });
    },
  };
  const t = await setup({
    wecom: {
      botId: "test-bot",
      domain: "ads",
      members: { "opaque-callback-member": "alice" },
      groups: ["group-1"],
      groupAudience: async () => ({
        complete: true,
        userIds: ["opaque-callback-member"],
        expiresAt: Date.now() + 1000,
      }),
      transport,
    },
  });
  try {
    await publish(t);
    const event: Inbound = {
      id: "message-1",
      botId: "test-bot",
      userId: "opaque-callback-member",
      chatType: "single",
      text: "示例流程怎么做",
      replyContext: {},
    };
    await receive(event);
    const count = sent.length;
    assert.ok(count >= 1);
    assert.ok(sent.at(-1)!.finish);
    assert.match(sent.at(-1)!.text, /这是测试模型的回答/);
    assert.match(sent.at(-1)!.text, /guide/);
    await receive(event);
    assert.equal(sent.length, count);
    await receive({ ...event, id: "group-1", chatType: "group" });
    assert.equal(sent.length, count);
    await receive({ ...event, id: "unknown-1", userId: "unmapped" });
    assert.equal(sent.length, count);
    // A company subject/send address is not automatically a trusted callback ID.
    await receive({ ...event, id: "unbound-subject", userId: "alice" });
    assert.equal(sent.length, count);
  } finally {
    await t.app.close();
  }
});

test("allowlisted groups answer @-mentions from mapped members and ignore everything else", async () => {
  let receive!: (event: Inbound) => Promise<void>;
  const sent: { text: string; finish: boolean }[] = [];
  const transport: WecomTransport = {
    start(handler) {
      receive = handler;
    },
    close() {},
    async reply(_e, _stream, text, finish) {
      sent.push({ text, finish });
    },
  };
  const t = await setup({
    wecom: {
      botId: "test-bot",
      domain: "ads",
      members: { "opaque-callback-member": "alice" },
      groups: ["group-1"],
      groupAudience: async () => ({
        complete: true,
        userIds: ["opaque-callback-member"],
        expiresAt: Date.now() + 1000,
      }),
      transport,
    },
  });
  try {
    await publish(t);
    const groupEvent = (
      id: string,
      text: string,
      userId = "opaque-callback-member",
    ): Inbound => ({
      id,
      botId: "test-bot",
      userId,
      chatType: "group",
      chatId: "group-1",
      text,
      replyContext: {},
    });
    // No @-mention: ignored.
    await receive(groupEvent("g-1", "示例流程怎么做"));
    assert.equal(sent.length, 0);
    // Not the allowlisted group: ignored.
    await receive({
      ...groupEvent("g-2", "@bot 示例流程怎么做"),
      chatId: "group-2",
    });
    assert.equal(sent.length, 0);
    // Unmapped sender even with @: ignored.
    await receive(groupEvent("g-3", "@bot 示例流程怎么做", "unmapped"));
    assert.equal(sent.length, 0);
    // @-mention from a mapped member in the allowlisted group: answered,
    // with the @ prefix stripped from the routed question.
    await receive(groupEvent("g-4", "@wikiBot 示例流程怎么做"));
    assert.equal(sent.length, 1);
    assert.ok(sent.at(-1)!.finish);
    assert.match(sent.at(-1)!.text, /这是测试模型的回答/);
  } finally {
    await t.app.close();
  }
});
