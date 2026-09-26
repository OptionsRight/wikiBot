import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { WecomSocket } from "../src/adapters/wecom.js";

test("the installed WeCom SDK sends proactive messages to the userid and distinguishes refusal from a lost ACK", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WecomSocket("test-bot", "synthetic-secret", {
    wsUrl: `ws://127.0.0.1:${address.port}`,
  });
  let mode: "ok" | "refuse" | "lose" = "ok";
  const outbound: {
    chatid: string;
    msgtype: string;
    markdown: { content: string };
  }[] = [];
  server.on("connection", (ws) =>
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.cmd === "aibot_subscribe") {
        ws.send(JSON.stringify({ headers: frame.headers, errcode: 0 }));
        return;
      }
      outbound.push(frame.body);
      if (mode === "lose") {
        ws.terminate();
        return;
      }
      ws.send(
        JSON.stringify({
          headers: frame.headers,
          errcode: mode === "ok" ? 0 : 45009,
          errmsg: "synthetic result",
        }),
      );
    }),
  );
  try {
    socket.start(async () => {});
    for (let i = 0; !socket.ready() && i < 50; i++) await delay(20);
    assert.equal(socket.ready(), true);
    assert.deepEqual(
      await socket.notify("test-user", "通知 stable-id\n测试状态"),
      { state: "acked" },
    );
    assert.equal(outbound[0]!.chatid, "test-user");
    assert.equal(outbound[0]!.msgtype, "markdown");
    mode = "refuse";
    assert.deepEqual(await socket.notify("test-user", "通知 refusal"), {
      state: "failed",
      code: "WECOM_REJECTED_45009",
    });
    await assert.rejects(
      socket.reply(
        {
          id: "incoming",
          botId: "test-bot",
          userId: "test-user",
          chatType: "single",
          text: "test",
          replyContext: { headers: { req_id: "reply-local-test" } },
        },
        "stable-stream",
        "回答状态",
        true,
      ),
      { code: "WECOM_REJECTED_45009" },
    );
    mode = "lose";
    assert.deepEqual(await socket.notify("test-user", "通知 unknown"), {
      state: "unknown",
    });
    assert.equal(socket.ready(), false);
  } finally {
    socket.close();
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
