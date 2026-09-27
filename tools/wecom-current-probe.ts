// Run with: npx tsx --env-file=.env tools/wecom-current-probe.ts
// Reads credentials only from the local environment; copies the database into
// an isolated temporary directory. No company administrator is provisioned.
import { DatabaseSync, backup } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildApp } from "../src/app.js";
import { PiGateway } from "../src/adapters/model.js";
import { WecomSocket } from "../src/adapters/wecom.js";
import { hash } from "../src/core.js";
const env = process.env;
const mapping = JSON.parse(
  await readFile(".local/wecom-test-member.json", "utf8"),
);
const members = JSON.parse(env.WECOM_MEMBERS_JSON ?? "{}");
const subject = members[mapping.callbackUserId];
if (
  !subject ||
  !mapping.account ||
  !env.WECOM_BOT_ID ||
  !env.WECOM_SECRET ||
  !env.ANTHROPIC_AUTH_TOKEN ||
  !env.WECOM_DOMAIN
)
  throw new Error("LOCAL_PROBE_CONFIGURATION_REQUIRED");
const duration = Number(env.WECOM_PROBE_SECONDS ?? 60);
if (!Number.isInteger(duration) || duration < 10 || duration > 300)
  throw new Error("INVALID_PROBE_DURATION");
const directory = await mkdtemp(join(tmpdir(), "wikibot-current-probe-"));
const database = join(directory, "state.sqlite");
const source = new DatabaseSync(
  resolve(env.DATABASE_PATH ?? ".local/wikibot.sqlite"),
  { readOnly: true },
);
await backup(source, database);
source.close();
const events: Record<string, unknown>[] = [];
const socket = new WecomSocket(env.WECOM_BOT_ID, env.WECOM_SECRET);
const path = `.scratch/wikibot-v0.4/evidence/wecom-current-${Date.now()}.json`;
const record = (value: Record<string, unknown>) =>
  events.push({ at: new Date().toISOString(), ...value });
const app = await buildApp({
  database,
  model: new PiGateway({
    baseURL: env.ANTHROPIC_BASE_URL!,
    token: env.ANTHROPIC_AUTH_TOKEN,
    disableThinking: env.MODEL_THINKING === "disabled",
  }),
  wecom: {
    botId: env.WECOM_BOT_ID,
    domain: env.WECOM_DOMAIN,
    members: { [mapping.callbackUserId]: subject },
    notificationRecipients: { [subject]: mapping.account },
    notifications: false,
    transport: {
      start(handler) {
        socket.start(async (event) => {
          if (
            event.userId !== mapping.callbackUserId ||
            event.chatType !== "single"
          )
            return;
          record({
            type: "inbound",
            messageHash: hash(event.id),
            textHash: hash(event.text),
          });
          await handler(event);
        });
      },
      async reply(event, stream, text, finish) {
        const outgoing = `[wikiBot 联调测试]\n${text}`;
        await socket.reply(event, stream, outgoing, finish);
        record({
          type: "reply_acked",
          messageHash: hash(event.id),
          bytes: Buffer.byteLength(outgoing),
          textHash: hash(outgoing),
          finish,
        });
      },
      close() {
        socket.close();
      },
      ready() {
        return socket.ready();
      },
    },
  },
});
try {
  await app.ready();
  for (let i = 0; i < 100 && !socket.ready(); i++) await delay(100);
  record({ type: "connection", authenticated: socket.ready() });
  if (socket.ready()) {
    record({
      type: "invitation",
      ...(await socket.notify(
        mapping.account,
        `[wikiBot 联调测试] 当前自由文本检索链路测试窗口 ${duration} 秒。可直接提问，再追问；生成中可发 /取消；也可发送 /偏好、反馈 问题说明、登记 问题说明。仅用于测试，不代表业务验收。`,
      )),
    });
    process.stdout.write(
      "Authenticated test window started; no identifiers or credentials logged.\n",
    );
    await delay(duration * 1000);
  }
} finally {
  await app.close();
  record({ type: "closed" });
  await writeFile(
    path,
    JSON.stringify(
      {
        scope:
          "Real WeCom with current production code, isolated read-only-source database copy and real model; inbound depends on tester participation; no business acceptance inferred",
        recipientHash: hash(mapping.callbackUserId),
        events,
      },
      null,
      2,
    ) + "\n",
  );
  await rm(directory, { recursive: true, force: true });
  process.stdout.write(`${path}\n`);
}
