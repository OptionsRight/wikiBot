import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { PiGateway } from "../src/adapters/model.js";

function sseServer(
  events: unknown[],
  onRequest?: (body: Record<string, unknown>) => void,
): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        try {
          onRequest?.(JSON.parse(raw));
        } catch {}
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events)
        res.write(
          `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      res.end();
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("pi transport returns streamed explanation without forwarding reasoning as answer text", async () => {
  const server = await sseServer([
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "test-model",
        content: [],
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "private reasoning" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "已核对引用。" },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 6 },
    },
    { type: "message_stop" },
  ]);
  try {
    const address = server.address() as { port: number };
    const gateway = new PiGateway({
      baseURL: `http://127.0.0.1:${address.port}`,
      token: "test-only",
    });
    const result = await gateway.generate({
      model: "test-model",
      system: "Answer briefly.",
      prompt: "Check the reference.",
      signal: AbortSignal.timeout(2000),
      maxTokens: 50,
    });
    assert.equal(result.text, "已核对引用。");
    assert.equal(result.model, "test-model");
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.inputTokens, 5);
    assert.equal(result.outputTokens, 6);
    assert.ok(result.firstTextMs !== null);
  } finally {
    await close(server);
  }
});

test("pi transport reports an endpoint-swapped model id and maps length stops", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = await sseServer(
    [
    {
      type: "message_start",
      message: {
        id: "msg_swap",
        type: "message",
        role: "assistant",
        model: "other-model",
        content: [],
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "truncated" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "max_tokens", stop_sequence: null },
      usage: { output_tokens: 64 },
    },
    { type: "message_stop" },
    ],
    (body) => requests.push(body),
  );
  try {
    const address = server.address() as { port: number };
    const gateway = new PiGateway({
      baseURL: `http://127.0.0.1:${address.port}`,
      token: "test-only",
      disableThinking: true,
    });
    const result = await gateway.generate({
      model: "test-model",
      system: "Answer briefly.",
      prompt: "Check the reference.",
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(result.model, "other-model");
    assert.equal(result.stopReason, "max_tokens");
    assert.deepEqual(requests.at(-1)?.thinking, { type: "disabled" });
  } finally {
    await close(server);
  }
});

test("pi transport rejects when the request signal aborts", async () => {
  const never = new Promise<Server>((resolve) => {
    const server = createServer(() => {});
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  const server = await never;
  try {
    const address = server.address() as { port: number };
    const gateway = new PiGateway({
      baseURL: `http://127.0.0.1:${address.port}`,
      token: "test-only",
    });
    await assert.rejects(
      gateway.generate({
        model: "test-model",
        system: "Answer briefly.",
        prompt: "Hang until aborted.",
        signal: AbortSignal.timeout(150),
      }),
    );
  } finally {
    await close(server);
  }
});
