import { createInterface } from "node:readline";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { WecomSocket, WecomRejection } from "../src/adapters/wecom.js";
import { demoModel } from "../src/demo-model.js";
import { hash } from "../src/core.js";
import { setup, publish } from "../test/helpers.js";

// Pipe credentials into stdin, or disable terminal echo (stty -echo) BEFORE
// launching. readline's terminal:false does not disable the terminal's echo.
// This bounded session uses an in-memory synthetic domain; it never reads the
// real Wiki or calls an external model.
const reader = createInterface({ input: process.stdin, terminal: false });
const config = z
  .object({
    botId: z.string().min(1),
    botSecret: z.string().min(1),
    // Exact trusted callback from.userid, not a guessed account/send address.
    userId: z.string().min(1),
    notifyUserId: z.string().min(1).optional(),
    minutes: z.number().int().min(1).max(30).default(20),
  })
  .strict()
  .parse(
    JSON.parse(
      await new Promise<string>((resolve) => reader.once("line", resolve)),
    ),
  );
const socket = new WecomSocket(config.botId, config.botSecret);
const evidencePath = `.scratch/wikibot-v0.4/evidence/wecom-dialogue-${Date.now()}.json`;
const events: Record<string, unknown>[] = [];
let phase = "starting",
  stopped = false;
let writes = Promise.resolve();
const commands = [
  "/帮助",
  "/偏好",
  "/偏好 技术 熟练",
  "/偏好 业务 入门",
  "/清除偏好",
  "/取消",
  "/答案",
  "/通知",
];
const commandKind = (text: string) =>
  commands.includes(text)
    ? text
    : (["/登记", "/工单", "/反馈"].find((command) =>
        text.startsWith(command),
      ) ?? "question");
function record(event: Record<string, unknown>) {
  const entry = { at: new Date().toISOString(), ...event };
  events.push(entry);
  process.stdout.write(JSON.stringify(entry) + "\n");
  const snapshot =
    JSON.stringify(
      {
        node: process.version,
        sdk: "@wecom/aibot-node-sdk@1.0.7",
        phase,
        recipientHash: hash(config.userId),
        scope:
          "Real single-chat transport with synthetic in-memory knowledge and model; no real Wiki or external model",
        events,
      },
      null,
      2,
    ) + "\n";
  writes = writes.then(async () => {
    await writeFile(`${evidencePath}.tmp`, snapshot);
    await rename(`${evidencePath}.tmp`, evidencePath);
  });
}
await mkdir(".scratch/wikibot-v0.4/evidence", { recursive: true });
const t = await setup({
  model: {
    async generate(request) {
      // Leave enough time to test /取消 against an active stream; retain the
      // application's original deadline and abort contract.
      if (phase === "ready")
        await delay(7000, undefined, { signal: request.signal });
      return demoModel.generate(request);
    },
  },
  wecom: {
    botId: config.botId,
    domain: "ads",
    members: { [config.userId]: "alice" },
    notificationRecipients: config.notifyUserId
      ? { alice: config.notifyUserId }
      : undefined,
    notifications: true,
    transport: {
      start(handler) {
        socket.start(async (event) => {
          if (
            phase !== "ready" ||
            event.userId !== config.userId ||
            event.chatType !== "single" ||
            event.botId !== config.botId
          ) {
            record({
              type: "ignored_event",
              observedUserIdHash: hash(event.userId),
              chatType: event.chatType,
              userMatches: event.userId === config.userId,
              botMatches: event.botId === config.botId,
              command: commandKind(event.text),
              reason:
                phase !== "ready" ? "SESSION_NOT_READY" : "OUTSIDE_TEST_SCOPE",
            });
            return;
          }
          record({
            type: "inbound",
            messageIdHash: hash(event.id),
            command: commandKind(event.text),
            bytes: Buffer.byteLength(event.text),
            textHash: hash(event.text),
          });
          await handler(event);
          const receipts = (
            await t.request(
              "GET",
              "/api/domains/ads/channel-receipts",
              undefined,
              t.alice,
            )
          ).value;
          const receipt = receipts.find(
            (r: { messageId: string }) => r.messageId === event.id,
          );
          record({
            type: "processed",
            messageIdHash: hash(event.id),
            state: receipt?.state,
            complete: receipt?.complete,
            streamFinished: receipt?.streamFinished,
            through: receipt?.through,
            answerId: receipt?.answerId,
            code: receipt?.code,
          });
          if (receipt?.answerId) {
            const answer = (
              await t.request(
                "GET",
                `/api/domains/ads/answers/${receipt.answerId}`,
                undefined,
                t.alice,
              )
            ).value;
            record({
              type: "answer_state",
              answerId: receipt.answerId,
              state: answer.state,
              code: answer.code,
              style: answer.style,
              depth: answer.depth,
              review: answer.review,
              deliveredThrough: answer.deliveredThrough,
            });
          }
        });
      },
      ready() {
        return socket.ready();
      },
      close() {
        socket.close();
      },
      async reply(event, stream, text, finish) {
        const started = Date.now();
        const wireText = `【wikiBot 双向联调·合成数据】\n${text}`;
        record({
          type: "reply_attempt",
          messageIdHash: hash(event.id),
          finish,
          wireBytes: Buffer.byteLength(wireText),
          wireBodyHash: hash(wireText),
          markers: [
            "这是本地演示使用的合成内容",
            "尚未覆盖",
            "生成完成",
            "已取消",
            "当前偏好",
            "问题已登记",
            "状态：",
          ].filter((marker) => text.includes(marker)),
        });
        try {
          await socket.reply(event, stream, wireText, finish);
          record({
            type: "reply_ack",
            messageIdHash: hash(event.id),
            state: "acked",
            finish,
            elapsedMs: Date.now() - started,
          });
        } catch (error) {
          record({
            type: "reply_ack",
            messageIdHash: hash(event.id),
            state: error instanceof WecomRejection ? "failed" : "unknown",
            code:
              error instanceof WecomRejection ? error.code : "ACK_UNCONFIRMED",
            elapsedMs: Date.now() - started,
          });
          throw error;
        }
      },
      async notify(user, text) {
        const delivery = await socket.notify(
          user,
          `【wikiBot 双向联调·合成数据】\n${text}`,
        );
        record({ type: "notice_ack", ...delivery });
        return delivery;
      },
    },
  },
});
let finish!: () => void;
const finished = new Promise<void>((resolve) => {
  finish = resolve;
});
async function stop(reason: string) {
  if (stopped) return;
  stopped = true;
  phase = "stopping";
  clearTimeout(timer);
  await t.app.close();
  phase = "closed";
  record({ type: "closed", reason });
  await writes;
  reader.close();
  finish();
}
const timer = setTimeout(() => {
  void stop("SESSION_TIMEOUT");
}, config.minutes * 60000);
reader.on("line", (line) => {
  if (line.trim() === "stop") void stop("OPERATOR_FINISHED");
  if (line.trim() === "status")
    record({ type: "status", connected: socket.ready() });
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void stop(signal);
  });
try {
  await publish(t);
  for (let i = 0; !socket.ready() && i < 150; i++) await delay(100);
  if (!socket.ready()) await stop("CONNECTION_UNCONFIRMED");
  else {
    phase = "ready";
    record({
      type: "ready",
      recipientHash: hash(config.userId),
      domain: "synthetic-only",
      expiresAt: new Date(Date.now() + config.minutes * 60000).toISOString(),
      evidencePath,
    });
    await finished;
  }
} catch {
  await stop("SESSION_FAILED");
}
