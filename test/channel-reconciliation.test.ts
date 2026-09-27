import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setup } from "./helpers.js";
import type { Inbound } from "../src/adapters/wecom.js";

test("restart reconciles a committed channel command after a crash without replaying business work or claiming delivery", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "wikibot-channel-crash-"));
  const database = join(directory, "state.sqlite");
  let reopened: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { setup } from ${JSON.stringify(new URL("./helpers.ts", import.meta.url).href)};
      import { buildApp } from ${JSON.stringify(new URL("../src/app.ts", import.meta.url).href)};
      let receive;
      const t = await setup({ database: process.env.TEST_DATABASE });
      await t.app.close();
      const app = await buildApp({ database: process.env.TEST_DATABASE,
        wecom: { botId: "crash-bot", domain: "ads", members: { callback: "alice" },
          transport: { start(handler) { receive=handler; }, close() {}, async reply() {} } } });
      app.addHook("onResponse", (request, reply, done) => {
        if (request.url.endsWith("/tickets") && request.method === "POST" && reply.statusCode === 201) process.exit(77);
        done();
      });
      await app.ready();
      await receive({id:"crash-command",botId:"crash-bot",userId:"callback",chatType:"single",text:"/登记 合成崩溃对账问题",replyContext:{}});
      process.exit(1);
    `,
      ],
      {
        env: { ...process.env, TEST_DATABASE: database },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(child.status, 77, child.stderr);
    // Advance the restart clock past the dead owner's lease without touching
    // stored business data. The old process is already dead.
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() + 16000 });
    let receive!: (event: Inbound) => Promise<void>;
    let sends = 0;
    reopened = await setup({
      database,
      wecom: {
        botId: "crash-bot",
        domain: "ads",
        members: { callback: "alice" },
        transport: {
          start(handler) {
            receive = handler;
          },
          close() {},
          async reply() {
            sends++;
          },
        },
      },
    });
    const tickets = (
      await reopened.request(
        "GET",
        "/api/domains/ads/tickets",
        undefined,
        reopened.alice,
      )
    ).value;
    assert.equal(tickets.length, 1);
    const receipts = (
      await reopened.request(
        "GET",
        "/api/domains/ads/channel-receipts",
        undefined,
        reopened.alice,
      )
    ).value;
    const receipt = receipts.find(
      (r: { messageId: string }) => r.messageId === "crash-command",
    );
    assert.equal(receipt.state, "unknown");
    assert.equal(receipt.complete, false);
    assert.deepEqual(
      receipt.commands.map((c: { state: string; objectId: string }) => [
        c.state,
        c.objectId,
      ]),
      [["committed", tickets[0].id]],
    );
    await receive({
      id: "crash-command",
      botId: "crash-bot",
      userId: "callback",
      chatType: "single",
      text: "/登记 合成崩溃对账问题",
      replyContext: {},
    });
    assert.equal(
      (
        await reopened.request(
          "GET",
          "/api/domains/ads/tickets",
          undefined,
          reopened.alice,
        )
      ).value.length,
      1,
    );
    assert.equal(sends, 0);
  } finally {
    await reopened?.app.close();
    context.mock.timers.reset();
    await rm(directory, { recursive: true, force: true });
  }
});
