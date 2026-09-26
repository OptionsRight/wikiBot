import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AnthropicGateway } from "../src/adapters/model.js";

test("model transport returns streamed explanation without forwarding reasoning as answer text", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const data of [
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
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "private reasoning" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "已核对引用。" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 6 },
      },
      { type: "message_stop" },
    ])
      res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const gateway = new AnthropicGateway({
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
    assert.equal(result.outputTokens, 6);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
