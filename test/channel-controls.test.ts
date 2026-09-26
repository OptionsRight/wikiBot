import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, publish } from "./helpers.js";
import { demoModel } from "../src/demo-model.js";
import type { Inbound, WecomTransport } from "../src/adapters/wecom.js";

test("single-chat clarification retains only the same object, and explicit preferences are shared with the web", async () => {
  let receive!: (event: Inbound) => Promise<void>,
    sequence = 0;
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
      transport,
    },
  });
  const send = (text: string) =>
    receive({
      id: `message-${++sequence}`,
      botId: "test",
      userId: "alice",
      chatType: "single",
      text,
      replyContext: {},
    });
  const lastAnswer = async () => {
    const receipts = (
      await t.request(
        "GET",
        "/api/domains/ads/channel-receipts",
        undefined,
        t.alice,
      )
    ).value;
    const latest = receipts
      .filter((r: { answerId?: string }) => r.answerId)
      .at(-1);
    return (
      await t.request(
        "GET",
        `/api/domains/ads/answers/${latest.answerId}`,
        undefined,
        t.alice,
      )
    ).value;
  };
  try {
    await publish(t);
    await send("/帮助");
    assert.match(sent.at(-1)!, /\/取消/);
    await send("怎么办\n对象：流程选择测试对象");
    assert.match(sent.at(-1)!, /请明确要咨询的流程.*示例流程/);
    await send("/继续\n流程：示例流程\n条件：scenario=new");
    assert.equal((await lastAnswer()).code, "GUIDANCE");
    await send("/偏好 技术 熟练");
    const preference = (
      await t.request("GET", "/api/domains/ads/preferences", undefined, t.alice)
    ).value;
    assert.equal(preference.style, "technical");
    assert.equal(preference.depth, "experienced");
    await send("示例\n对象：客户甲");
    assert.match(sent.at(-1)!, /scenario/);
    await send("/条件 scenario=new");
    let answer = await lastAnswer();
    assert.equal(answer.code, "GUIDANCE");
    assert.equal(answer.objectId, "客户甲");
    assert.equal(answer.style, "technical");
    assert.equal(answer.depth, "experienced");
    assert.ok(
      answer.blocks.some((b: { nodeId?: string }) => b.nodeId === "submit"),
    );
    await send("/继续\n对象：客户乙");
    answer = await lastAnswer();
    assert.equal(answer.objectId, "客户乙");
    assert.deepEqual(answer.inputs, {});
    assert.equal(answer.checklistComplete, false);
    await send("/清除偏好");
    const cleared = (
      await t.request("GET", "/api/domains/ads/preferences", undefined, t.alice)
    ).value;
    assert.equal(cleared.style, "business");
    assert.equal(cleared.depth, "beginner");
    await Promise.all([
      send("示例\n对象：客户丙"),
      send("/条件 scenario=existing"),
    ]);
    answer = await lastAnswer();
    assert.equal(answer.objectId, "客户丙");
    assert.equal(answer.inputs.scenario, "existing");
  } finally {
    await t.app.close();
  }
});

test("cancellation during an unacknowledged chunk stops further body delivery but preserves the real late ACK", async () => {
  let receive!: (event: Inbound) => Promise<void>,
    releaseAck!: () => void,
    sending!: () => void,
    slow = false;
  const entered = new Promise<void>((resolve) => {
    sending = resolve;
  });
  const ack = new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
  const sent: { message: string; text: string; finish: boolean }[] = [];
  const transport: WecomTransport = {
    start(fn) {
      receive = fn;
    },
    close() {
      releaseAck();
    },
    async reply(event, _s, text, finish) {
      sent.push({ message: event.id, text, finish });
      if (
        event.id === "ask" &&
        sent.filter((s) => s.message === "ask").length === 1
      ) {
        sending();
        await ack;
      }
    },
  };
  const t = await setup({
    model: {
      async generate(r) {
        if (slow)
          await new Promise((_resolve, reject) =>
            r.signal.addEventListener(
              "abort",
              () => reject(new Error("Aborted")),
              { once: true },
            ),
          );
        return demoModel.generate(r);
      },
    },
    wecom: {
      botId: "test",
      domain: "ads",
      members: { alice: "alice", bob: "bob" },
      transport,
    },
  });
  const event = (id: string, text: string, userId = "alice"): Inbound => ({
    id,
    text,
    userId,
    botId: "test",
    chatType: "single",
    replyContext: {},
  });
  try {
    await publish(t);
    slow = true;
    const work = receive(event("ask", "示例\n对象：甲\n条件：scenario=new"));
    await entered;
    const answerId = sent[0]!.text.match(/答案 ([a-z0-9-]+)/)![1]!;
    await receive(event("foreign-cancel", `/取消 ${answerId}`, "bob"));
    assert.match(sent.at(-1)!.text, /NOT_FOUND/);
    await receive(event("cancel", "/取消"));
    assert.match(sent.at(-1)!.text, /已取消/);
    releaseAck();
    await work;
    const original = sent.filter((s) => s.message === "ask");
    assert.equal(original.length, 2);
    assert.equal(original[1]!.finish, true);
    assert.match(original[1]!.text, /已取消/);
    assert.doesNotMatch(original[1]!.text, /准备材料/);
    const answer = (
      await t.request(
        "GET",
        `/api/domains/ads/answers/${answerId}`,
        undefined,
        t.alice,
      )
    ).value;
    assert.equal(answer.code, "CANCELLED");
    assert.equal(answer.state, "incomplete");
    assert.equal(answer.deliveredThrough, 3);
    await receive(event("status", `/答案 ${answerId}`));
    assert.match(sent.at(-1)!.text, /CANCELLED/);
  } finally {
    releaseAck();
    await t.app.close();
  }
});

test("cancelling a final frame in flight records its ACK without claiming uncancelled complete delivery", async () => {
  let receive!: (event: Inbound) => Promise<void>,
    entered!: () => void,
    release!: () => void;
  const sending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const ack = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport: WecomTransport = {
    start(fn) {
      receive = fn;
    },
    close() {
      release();
    },
    async reply(event, _stream, _text, finish) {
      if (event.id === "final-answer") {
        assert.equal(finish, true);
        entered();
        await ack;
      }
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
  const event = (id: string, text: string): Inbound => ({
    id,
    text,
    botId: "test",
    userId: "alice",
    chatType: "single",
    replyContext: {},
  });
  try {
    await publish(t);
    const work = receive(
      event("final-answer", "示例\n对象：甲\n条件：scenario=new"),
    );
    await sending;
    await receive(event("cancel-final", "/取消"));
    release();
    await work;
    const receipts = (
      await t.request(
        "GET",
        "/api/domains/ads/channel-receipts",
        undefined,
        t.alice,
      )
    ).value;
    const receipt = receipts.find(
      (r: { messageId: string }) => r.messageId === "final-answer",
    );
    assert.equal(receipt.state, "acked");
    assert.equal(receipt.through, 4);
    assert.equal(receipt.complete, false);
    const answer = (
      await t.request(
        "GET",
        `/api/domains/ads/answers/${receipt.answerId}`,
        undefined,
        t.alice,
      )
    ).value;
    assert.equal(answer.state, "complete");
    assert.equal(answer.deliveredThrough, 4);
  } finally {
    release();
    await t.app.close();
  }
});
