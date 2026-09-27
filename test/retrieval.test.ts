import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleSchema } from "../src/procedures.js";
import { retrieve } from "../src/retrieval.js";
import { generateAnswer } from "../src/explanation.js";
import { sampleBundle } from "./helpers.js";

test("retrieved context obeys its serialized UTF-8 budget including escaped text and metadata", async () => {
  const bundle = bundleSchema.parse(sampleBundle());
  bundle.pages[0]!.content = '示例流程😀\\"\n'.repeat(10000);
  bundle.pages[1]!.content = "示例流程".repeat(10000);
  const pages = retrieve(bundle, "示例流程", { maxContextBytes: 500 });
  assert.ok(pages.length > 0);
  let bytes = 0;
  await generateAnswer(
    {
      async generate(r) {
        const payload = JSON.parse(r.prompt);
        bytes = Buffer.byteLength(JSON.stringify(payload.pages));
        assert.ok(
          !payload.pages.some((p: { content: string }) =>
            p.content.includes("\ufffd"),
          ),
        );
        return {
          text: JSON.stringify({
            text: "测试",
            citations: [pages[0]!.page.id],
          }),
          model: r.model,
          stopReason: "end_turn",
          inputTokens: 1,
          outputTokens: 1,
          firstTextMs: 1,
          totalMs: 1,
        };
      },
    },
    {
      modelId: "test",
      question: "示例流程",
      pages,
      style: "business",
      depth: "beginner",
    },
    new AbortController().signal,
  );
  assert.ok(bytes <= 500, `actual bytes ${bytes}`);
});
