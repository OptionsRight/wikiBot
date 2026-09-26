import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { buildApp } from "../src/app.js";
import { WecomSocket, type NoticeReceipt } from "../src/adapters/wecom.js";

// Explicitly opt in to ONE synthetic proactive notice. Secrets enter through
// stdin, never command arguments, disk, SDK logs or the evidence record.
const input = createInterface({ input: process.stdin, terminal: false });
const line = await new Promise<string>((resolve) =>
  input.once("line", resolve),
);
input.close();
const config = z
  .object({
    botId: z.string().min(1),
    botSecret: z.string().min(1),
    userId: z.string().min(1),
    sendOneSyntheticNotice: z.literal(true),
  })
  .strict()
  .parse(JSON.parse(line));
const socket = new WecomSocket(config.botId, config.botSecret);
let delivery: NoticeReceipt | undefined,
  attempts = 0;
const operator = randomUUID();
const app = await buildApp({
  database: ":memory:",
  bootstrap: { token: operator, subject: "smoke-operator" },
  wecom: {
    botId: config.botId,
    domain: "smoke",
    members: { [config.userId]: "smoke-member" },
    notifications: true,
    transport: {
      // This bounded probe does not consume or reply to unrelated inbound work.
      start() {
        socket.start(async () => {});
      },
      close() {
        socket.close();
      },
      ready() {
        return socket.ready();
      },
      async reply() {
        throw new Error("SMOKE_DOES_NOT_REPLY");
      },
      async notify(user, text) {
        if (++attempts > 1) return { state: "unknown" };
        delivery = await socket.notify(
          user,
          `【wikiBot 合成联调】\n${text}\n这是通知通道测试，不涉及真实业务，无需处理。`,
        );
        return delivery;
      },
    },
  },
});
async function post(
  url: string,
  payload: unknown,
  token = operator,
  method: "POST" | "PUT" = "POST",
) {
  const response = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": randomUUID(),
      "content-type": "application/json",
    },
    payload: JSON.stringify(payload),
  });
  if (response.statusCode >= 400) throw new Error("SMOKE_SETUP_FAILED");
  return response.json();
}
let status = "not_started";
try {
  await app.ready();
  for (let i = 0; !socket.ready() && i < 150; i++) await delay(100);
  if (!socket.ready()) status = "connection_unconfirmed";
  else {
    await post("/api/domains", { id: "smoke", name: "仅合成联调" });
    await post(
      "/api/domains/smoke/members/smoke-member",
      { role: "member", expectedVersion: 0 },
      operator,
      "PUT",
    );
    const member = await post("/api/identities/smoke-member/tokens", {});
    await post(
      "/api/domains/smoke/tickets",
      {
        title: "合成通知测试",
        description: "仅用于测试主动状态通知，不涉及真实业务。",
        category: "question",
      },
      member.token,
    );
    for (let i = 0; !delivery && i < 100; i++) await delay(100);
    status = delivery?.state ?? "unconfirmed";
  }
} catch {
  status = "probe_failed";
} finally {
  await app.close();
}
const evidence = {
  date: new Date().toISOString(),
  node: process.version,
  sdk: "@wecom/aibot-node-sdk@1.0.7",
  scope:
    "One synthetic notice through the real dispatcher; no Wiki/model/production database or inbound processing",
  status,
  attempts,
  delivery,
};
await mkdir(".scratch/wikibot-v0.4/evidence", { recursive: true });
await writeFile(
  `.scratch/wikibot-v0.4/evidence/wecom-notice-${Date.now()}.json`,
  JSON.stringify(evidence, null, 2) + "\n",
);
process.stdout.write(JSON.stringify(evidence) + "\n");
