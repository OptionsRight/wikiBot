import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, publish } from "./helpers.js";
import { demoModel } from "../src/demo-model.js";
import type { Inbound, WecomTransport } from "../src/adapters/wecom.js";
test("a channel timeout finishes the cumulative stream with an explicit incomplete status", async () => {
  let receive!: (e: Inbound) => Promise<void>,
    slow = false;
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
      members: { alice: "alice" },
      transport,
    },
  });
  try {
    await publish(t);
    slow = true;
    await receive({
      id: "timeout",
      botId: "test",
      userId: "alice",
      chatType: "single",
      text: "示例\n对象：客户甲\n条件：scenario=new",
      replyContext: {},
    });
    assert.ok(sent.length >= 2);
    assert.equal(sent.at(-1)!.finish, true);
    assert.match(sent.at(-1)!.text, /未完整完成/);
  } finally {
    await t.app.close();
  }
});
