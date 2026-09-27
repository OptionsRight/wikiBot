/** Opt-in real model contract probe; synthetic knowledge only, no raw error logging. */
import { PiGateway } from "../src/adapters/model.js";
import { generateAnswer } from "../src/explanation.js";
import { retrieve } from "../src/retrieval.js";
import { bundleSchema } from "../src/procedures.js";
import { hash, Fault } from "../src/core.js";
const token = process.env.ANTHROPIC_AUTH_TOKEN;
const baseURL = process.env.ANTHROPIC_BASE_URL;
if (!token || !baseURL)
  throw new Error("CONTROLLED_MODEL_CONFIGURATION_REQUIRED");
const modelId = process.env.QUALITY_PROBE_MODEL ?? "glm-5.3";
const content =
  "合成测试指南：先准备测试材料，再提交测试申请，最后核对测试结果。此页不是实际业务流程。";
const bundle = bundleSchema.parse({
  pages: [
    {
      id: "synthetic",
      path: "synthetic.md",
      title: "合成测试指南",
      content,
      hash: hash(content),
    },
  ],
  cases: [
    {
      id: "synthetic",
      question: "合成测试指南有哪些步骤？",
      expectedCitations: ["synthetic"],
    },
  ],
  config: {
    model: modelId,
    modelRevision: "probe-unqualified",
    promptVersion: "1",
    templateVersion: "1",
    retrievalVersion: "1",
    protocolVersion: "1",
    evaluationVersion: "probe-only",
  },
});
const started = Date.now();
try {
  const result = await generateAnswer(
    new PiGateway({
      token,
      baseURL,
      disableThinking: process.env.MODEL_THINKING === "disabled",
    }),
    {
      modelId,
      question: bundle.cases[0]!.question,
      pages: retrieve(bundle, bundle.cases[0]!.question),
      style: "business",
      depth: "beginner",
    },
    AbortSignal.timeout(15000),
  );
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      kind: "real-model-synthetic-knowledge",
      state: "complete",
      model: modelId,
      metrics: result.metrics,
      citations: result.answer.citations,
      outcome: result.answer.outcome ?? "answer",
      stepMentions: ["准备", "提交", "核对"].map((s) =>
        result.answer.text.includes(s),
      ),
      humanReview: "required",
      elapsedMs: Date.now() - started,
    }),
  );
} catch (error) {
  // Upstream messages can include request details. Persist only a bounded category.
  const category =
    error instanceof Fault
      ? error.code
      : error instanceof Error &&
          /quota|余额|额度|余额不足|insufficient/i.test(error.message)
        ? "PROVIDER_QUOTA"
        : error instanceof Error &&
            /abort|timeout/i.test(error.name + error.message)
          ? "TIMEOUT_OR_ABORT"
          : "PROVIDER_FAILURE";
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      kind: "real-model-synthetic-knowledge",
      state: "failed",
      category,
      elapsedMs: Date.now() - started,
      humanReview: "not-performed",
    }),
  );
  process.exitCode = 1;
}
