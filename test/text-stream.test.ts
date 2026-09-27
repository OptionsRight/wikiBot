import { test } from "node:test";
import assert from "node:assert/strict";
import { generateAnswer } from "../src/explanation.js";
import { retrieve } from "../src/retrieval.js";
import { bundleSchema } from "../src/procedures.js";
import { sampleBundle } from "./helpers.js";

for (const scenario of [
  "bad-citation",
  "model-change",
  "truncated",
  "cancelled",
  "valid",
] as const) {
  test(`stream callback receives only final validated text: ${scenario}`, async () => {
    const exposed: string[] = [];
    const controller = new AbortController();
    const call = generateAnswer(
      {
        async generate(r) {
          r.onText?.('{"text":"未经校验');
          r.onText?.('正文","citations":["outside"]}');
          assert.deepEqual(exposed, []);
          if (scenario === "cancelled") controller.abort();
          return {
            text: JSON.stringify({
              text: "已验证正文",
              citations: [scenario === "bad-citation" ? "outside" : "guide"],
            }),
            model: scenario === "model-change" ? "other" : r.model,
            stopReason: scenario === "truncated" ? "max_tokens" : "end_turn",
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
        pages: retrieve(bundleSchema.parse(sampleBundle()), "示例流程"),
        style: "business",
        depth: "beginner",
      },
      controller.signal,
      (text) => exposed.push(text),
    );
    if (scenario === "valid") {
      await call;
      assert.deepEqual(exposed, ["已验证正文"]);
    } else {
      await assert.rejects(call);
      assert.deepEqual(exposed, []);
    }
  });
}

test("model-declared knowledge gaps need no fabricated citation", async () => {
  const { answer } = await generateAnswer(
    {
      async generate(r) {
        return {
          text: JSON.stringify({
            text: "当前资料未覆盖所问问题。",
            outcome: "knowledge_gap",
            citations: [],
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
      pages: retrieve(bundleSchema.parse(sampleBundle()), "示例流程"),
      style: "business",
      depth: "beginner",
    },
    new AbortController().signal,
  );
  assert.deepEqual(answer.citations, []);
});

test("published domain labels and each style/depth template reach the model", async () => {
  const config = {
    domainLabel: "设备支持",
    answerTemplates: {
      business: "面向业务讲解",
      technical: "面向技术讲解",
      beginner: "解释背景术语",
      experienced: "使用简洁专业术语",
    },
  };
  for (const style of ["business", "technical"] as const)
    for (const depth of ["beginner", "experienced"] as const) {
      await generateAnswer(
        {
          async generate(r) {
            assert.ok(r.system.includes("设备支持"));
            assert.ok(r.system.includes(config.answerTemplates[style]));
            assert.ok(r.system.includes(config.answerTemplates[depth]));
            return {
              text: JSON.stringify({ text: "说明", citations: ["guide"] }),
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
          pages: retrieve(bundleSchema.parse(sampleBundle()), "示例流程"),
          style,
          depth,
          config,
        },
        new AbortController().signal,
      );
    }
});
