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
      members: { alice: "alice" },
      transport,
    },
  });
  try {
    await publish(t);
    const event: Inbound = {
      id: "message-1",
      botId: "test-bot",
      userId: "alice",
      chatType: "single",
      text: "示例流程\n对象：客户甲\n条件：scenario=new",
      replyContext: {},
    };
    await receive(event);
    const count = sent.length;
    assert.ok(count >= 1);
    assert.ok(sent.at(-1)!.finish);
    assert.match(sent.at(-1)!.text, /准备材料/);
    assert.match(sent.at(-1)!.text, /核对结果/);
    await receive(event);
    assert.equal(sent.length, count);
    await receive({ ...event, id: "group-1", chatType: "group" });
    assert.equal(sent.length, count);
    await receive({ ...event, id: "unknown-1", userId: "unmapped" });
    assert.equal(sent.length, count);
  } finally {
    await t.app.close();
  }
});
