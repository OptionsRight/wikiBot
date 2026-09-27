import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, publish } from "./helpers.js";
import type { Inbound, WecomTransport } from "../src/adapters/wecom.js";
test("a verified late successful channel receipt preserves the actually delivered history after model change", async () => {
  let receive!: (e: Inbound) => Promise<void>,
    releaseAck!: () => void,
    entered!: () => void;
  const sending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const ack = new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
  const transport: WecomTransport = {
    start(fn) {
      receive = fn;
    },
    close() {},
    async reply() {
      entered();
      await ack;
    },
  };
  const t = await setup({
    wecom: {
      botId: "test",
      domain: "ads",
      members: { alice: "alice" },
      transport,
    },
  });
  try {
    await publish(t);
    const work = receive({
      id: "late-ack",
      botId: "test",
      userId: "alice",
      chatType: "single",
      text: "示例流程怎么做",
      replyContext: {},
    });
    await sending;
    await t.request("POST", "/api/models/change", {
      model: "test-model",
      revision: "r1",
      expectedEpoch: 0,
      reason: "发送已开始之后收到模型变更通知",
    });
    releaseAck();
    await work;
    const receipts = (
      await t.request(
        "GET",
        "/api/domains/ads/channel-receipts",
        undefined,
        t.alice,
      )
    ).value;
    assert.equal(receipts[0].state, "acked");
    const answer = (
      await t.request(
        "GET",
        `/api/domains/ads/answers/${receipts[0].answerId}`,
        undefined,
        t.alice,
      )
    ).value;
    assert.equal(answer.review, "pending");
    assert.ok(answer.blocks.length >= 1);
  } finally {
    releaseAck();
    await t.app.close();
  }
});
