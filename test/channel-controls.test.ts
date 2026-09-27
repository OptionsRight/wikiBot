import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, publish } from "./helpers.js";
import { demoModel } from "../src/demo-model.js";
import type { Inbound, WecomTransport } from "../src/adapters/wecom.js";

test("single-chat free-form questions are answered, and explicit preferences are shared with the web", async () => {
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
    assert.match(sent.at(-1)!, /直接发送问题/);
    await send("示例流程怎么做");
    const answer = await lastAnswer();
    assert.equal(answer.code, "ANSWER");
    assert.equal(answer.style, "business");
    assert.equal(answer.depth, "beginner");
    assert.match(sent.at(-1)!, /这是测试模型的回答/);
    await send("/偏好 技术 熟练");
    const preference = (
      await t.request("GET", "/api/domains/ads/preferences", undefined, t.alice)
    ).value;
    assert.equal(preference.style, "technical");
    assert.equal(preference.depth, "experienced");
    await send("结算什么时候打款");
    const styled = await lastAnswer();
    assert.equal(styled.code, "ANSWER");
    assert.equal(styled.style, "technical");
    assert.equal(styled.depth, "experienced");
    assert.deepEqual(styled.blocks[0].citations, ["billing"]);
    await send("/清除偏好");
    const cleared = (
      await t.request("GET", "/api/domains/ads/preferences", undefined, t.alice)
    ).value;
    assert.equal(cleared.style, "business");
    assert.equal(cleared.depth, "beginner");
    await send("/条件 scenario=new");
    assert.match(sent.at(-1)!, /UNKNOWN_COMMAND_USE_HELP/);
  } finally {
    await t.app.close();
  }
});

test("cancellation during generation stops further body delivery but preserves the real late ACK", async () => {
  let receive!: (event: Inbound) => Promise<void>,
    slow = false;
  const sent: { message: string; text: string; finish: boolean }[] = [];
  const transport: WecomTransport = {
    start(fn) {
      receive = fn;
    },
    close() {},
    async reply(event, _s, text, finish) {
      sent.push({ message: event.id, text, finish });
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
  const answerOfMessage = async (messageId: string) => {
    for (let i = 0; i < 100; i++) {
      const receipts = (
        await t.request(
          "GET",
          "/api/domains/ads/channel-receipts",
          undefined,
          t.alice,
        )
      ).value;
      const receipt = receipts.find(
        (r: { messageId: string; answerId?: string }) =>
          r.messageId === messageId && r.answerId,
      );
      if (receipt) return receipt.answerId as string;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("answer was never created");
  };
  try {
    await publish(t);
    slow = true;
    const work = receive(event("ask", "示例流程怎么做"));
    const answerId = await answerOfMessage("ask");
    await receive(event("foreign-cancel", `/取消 ${answerId}`, "bob"));
    assert.match(sent.at(-1)!.text, /NOT_FOUND/);
    await receive(event("cancel", "/取消"));
    assert.match(sent.at(-1)!.text, /已取消/);
    await work;
    const original = sent.filter((s) => s.message === "ask");
    assert.equal(original.length, 1);
    assert.equal(original[0]!.finish, true);
    assert.match(original[0]!.text, /已取消/);
    const answer = (
      await t.request(
        "GET",
        `/api/domains/ads/answers/${answerId}`,
        undefined,
        t.alice,
      )
    ).value;
    assert.equal(answer.code, "CANCELLED");
    assert.equal(answer.state, "failed");
    assert.equal(answer.blocks.length, 0);
    assert.equal(answer.deliveredThrough, 0);
    await receive(event("status", `/答案 ${answerId}`));
    assert.match(sent.at(-1)!.text, /CANCELLED/);
  } finally {
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
    const work = receive(event("final-answer", "示例流程怎么做"));
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
    assert.equal(receipt.through, 1);
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
    assert.equal(answer.deliveredThrough, 1);
  } finally {
    release();
    await t.app.close();
  }
});

test("free-text feedback can be answered without a knowledge release and queried, confirmed and reopened across channels", async () => {
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
      members: { callback: "alice" },
      transport,
    },
  });
  const send = (text: string) =>
    receive({
      id: `flow-${++sequence}`,
      text,
      botId: "test",
      userId: "callback",
      chatType: "single",
      replyContext: {},
    });
  try {
    await publish(t);
    await send("示例流程怎么做");
    await send("反馈 请解释为什么需要准备这些材料");
    let ticket = (
      await t.request("GET", "/api/domains/ads/tickets", undefined, t.alice)
    ).value[0];
    assert.equal(ticket.category, "question");
    assert.ok(ticket.answerId);
    assert.ok(ticket.evidence.blocks.length);
    for (const [action, text] of [
      ["triage", undefined],
      ["request_info", "请补充具体材料名称"],
      ["note", "不向用户公开的内部研判"],
    ]) {
      const result = await t.request(
        "POST",
        `/api/domains/ads/tickets/${ticket.id}/actions`,
        { action, text, expectedVersion: ticket.version },
        t.admin,
      );
      assert.equal(result.status, 200);
      ticket = result.value;
    }
    await send(`/工单 ${ticket.id}`);
    assert.match(sent.at(-1)!, /请补充具体材料名称/);
    assert.doesNotMatch(sent.at(-1)!, /内部研判/);
    await send(`/补充 ${ticket.id}@${ticket.version} 需要说明营业执照的作用`);
    ticket = (
      await t.request(
        "GET",
        `/api/domains/ads/tickets/${ticket.id}`,
        undefined,
        t.alice,
      )
    ).value;
    assert.equal(ticket.state, "in_progress");
    ticket = (
      await t.request(
        "POST",
        `/api/domains/ads/tickets/${ticket.id}/actions`,
        {
          action: "resolve",
          text: "已依据发布知识解释准备材料的作用",
          expectedVersion: ticket.version,
        },
        t.admin,
      )
    ).value;
    await send(`/确认 ${ticket.id}@${ticket.version}`);
    ticket = (
      await t.request(
        "GET",
        `/api/domains/ads/tickets/${ticket.id}`,
        undefined,
        t.alice,
      )
    ).value;
    assert.equal(ticket.state, "closed");
    await send(`/重开 ${ticket.id}@${ticket.version} 还有一个材料问题需要解释`);
    assert.equal(
      (
        await t.request(
          "GET",
          `/api/domains/ads/tickets/${ticket.id}`,
          undefined,
          t.alice,
        )
      ).value.state,
      "submitted",
    );
  } finally {
    await t.app.close();
  }
});

test("preference command near-misses reply with usage instead of a raw fault code", async () => {
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
      transport,
    },
  });
  const send = (text: string) =>
    receive({
      id: `msg-${sent.length}`,
      botId: "test",
      userId: "alice",
      chatType: "single",
      text,
      replyContext: {},
    });
  try {
    await send("/帮助");
    assert.match(sent.at(-1)!, /\/偏好 业务 入门/);
    // The documented view form must not fall into the setter branch.
    await send("/偏好 查看");
    assert.match(sent.at(-1)!, /当前偏好/);
    assert.doesNotMatch(sent.at(-1)!, /PREFERENCE_FORMAT_REQUIRED/);
    // A half-filled setting gets the correct format back, not a bare code.
    await send("/偏好 业务");
    assert.match(sent.at(-1)!, /偏好格式/);
    assert.match(sent.at(-1)!, /\/偏好 业务 入门/);
    assert.doesNotMatch(sent.at(-1)!, /PREFERENCE_FORMAT_REQUIRED/);
    await send("/偏好 技术 熟练");
    assert.match(sent.at(-1)!, /当前偏好：技术 \/ 熟练/);
  } finally {
    await t.app.close();
  }
});
