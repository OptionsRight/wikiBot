import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import AiBot from "@wecom/aibot-node-sdk";
import { AnthropicGateway } from "../src/adapters/model.js";

// Credentials are provided in one stdin JSON line. No credentials or raw provider errors are persisted.
const reader = createInterface({ input: process.stdin, terminal: false });
const line = await new Promise<string>((resolve) =>
  reader.once("line", resolve),
);
reader.close();
const config = JSON.parse(line) as {
  modelToken?: string;
  botId?: string;
  botSecret?: string;
  baseURL?: string;
};
const results: Record<string, unknown>[] = [];
if (config.modelToken) {
  const gateway = new AnthropicGateway({
    baseURL: config.baseURL ?? "https://open.bigmodel.cn/api/anthropic",
    token: config.modelToken,
  });
  for (const model of ["glm-5.3", "glm-5.3-flash"]) {
    try {
      const result = await gateway.generate({
        model,
        system: "This is a connectivity test. No tools. Reply exactly OK.",
        prompt: "Reply OK.",
        signal: AbortSignal.timeout(20000),
        maxTokens: 64,
      });
      results.push({
        kind: "model",
        requestedModel: model,
        status: "connected",
        ...result,
      });
    } catch (error) {
      const e = error as { name?: string; status?: number };
      results.push({
        kind: "model",
        requestedModel: model,
        status: "failed",
        errorType: e.name,
        httpStatus: e.status ?? null,
      });
    }
    process.stdout.write(JSON.stringify(results.at(-1)) + "\n");
  }
}
if (config.botId && config.botSecret) {
  const client = new AiBot.WSClient({
    botId: config.botId,
    secret: config.botSecret,
    maxReconnectAttempts: 0,
    maxAuthFailureAttempts: 0,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const result = await new Promise<Record<string, unknown>>((resolve) => {
    let done = false;
    const finish = (status: string, errorCode?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.disconnect();
      resolve({
        kind: "wecom",
        status,
        errorCode: errorCode ?? null,
        messagesSent: 0,
      });
    };
    const timer = setTimeout(() => finish("timeout"), 15000);
    client.on("authenticated", () => finish("authenticated"));
    client.on("error", (error) =>
      finish(
        "failed",
        error.message.match(/\b\d{4,8}\b/)?.[0] ?? "CONNECTION_OR_AUTH_ERROR",
      ),
    );
    client.connect();
  });
  results.push(result);
  process.stdout.write(JSON.stringify(result) + "\n");
}
await mkdir(".scratch/wikibot-v0.4/evidence", { recursive: true });
const target = ".scratch/wikibot-v0.4/evidence/connectivity.json";
let history: unknown[] = [];
try {
  const previous = JSON.parse(await readFile(target, "utf8"));
  history = previous.attempts ?? [previous];
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
history.push({
  date: new Date().toISOString(),
  node: process.version,
  scope:
    "Synthetic model prompt and bot authentication only. No business messages sent.",
  results,
});
await writeFile(target, JSON.stringify({ attempts: history }, null, 2) + "\n");
