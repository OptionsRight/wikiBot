import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sampleBundle } from "./helpers.js";

test("a completed coverage gap cannot pass an answer case or the release review gate", async () => {
  const t = await setup();
  try {
    const bundle = sampleBundle();
    bundle.cases = [
      { id: "missing", question: "火星天气", expectedCitations: ["guide"] },
    ];
    const r = (
      await t.request("POST", "/api/domains/ads/submissions", bundle, t.admin)
    ).value;
    const run = (
      await t.request(
        "POST",
        `/api/domains/ads/releases/${r.id}/evaluations`,
        { caseId: "missing", descriptorHash: r.descriptorHash },
        t.admin,
      )
    ).value;
    assert.equal(run.state, "complete");
    assert.equal(run.verdict, "fail");
    assert.ok(run.failures.includes("EXPECTED_ANSWER"));
    const review = await t.request(
      "POST",
      `/api/domains/ads/releases/${r.id}/review`,
      {
        expectedVersion: r.version,
        descriptorHash: r.descriptorHash,
        approved: true,
        evidence: "人工复核不能绕过机器失败",
      },
      t.admin,
    );
    assert.equal(review.status, 409);
    assert.equal(review.value.error.code, "EVALUATION_REQUIRED");
  } finally {
    await t.app.close();
  }
});

test("evaluation checks expected citations and requires explicit expectations", async () => {
  const t = await setup();
  try {
    const bundle = sampleBundle();
    bundle.cases = [
      { id: "wrong", question: "示例流程", expectedCitations: ["billing"] },
      { id: "empty", question: "示例流程", expectedCitations: [] },
    ];
    const r = (
      await t.request("POST", "/api/domains/ads/submissions", bundle, t.admin)
    ).value;
    for (const [caseId, failure] of [
      ["wrong", "MISSING_EXPECTED_CITATION"],
      ["empty", "MISSING_EXPECTATIONS"],
    ]) {
      const run = (
        await t.request(
          "POST",
          `/api/domains/ads/releases/${r.id}/evaluations`,
          { caseId, descriptorHash: r.descriptorHash },
          t.admin,
        )
      ).value;
      assert.equal(run.verdict, "fail");
      assert.ok(run.failures.includes(failure));
      assert.equal(run.humanReview, "required");
    }
  } finally {
    await t.app.close();
  }
});

test("explicit no-answer cases pass only for a coverage gap", async () => {
  const t = await setup();
  try {
    const bundle = {
      ...sampleBundle(),
      cases: [
        {
          id: "gap",
          question: "火星天气",
          expectedOutcome: "knowledge_gap",
          expectedCitations: [],
        },
        {
          id: "wrong-gap",
          question: "示例流程",
          expectedOutcome: "knowledge_gap",
          expectedCitations: [],
        },
      ],
    };
    const submission = await t.request(
      "POST",
      "/api/domains/ads/submissions",
      bundle,
      t.admin,
    );
    assert.equal(submission.status, 201);
    const r = submission.value;
    for (const [caseId, verdict] of [
      ["gap", "pass"],
      ["wrong-gap", "fail"],
    ]) {
      const run = (
        await t.request(
          "POST",
          `/api/domains/ads/releases/${r.id}/evaluations`,
          { caseId, descriptorHash: r.descriptorHash },
          t.admin,
        )
      ).value;
      assert.equal(run.state, "complete");
      assert.equal(run.verdict, verdict);
      assert.equal(run.humanReview, "required");
    }
  } finally {
    await t.app.close();
  }
});

test("expired restored evaluations settle unknown without a quality verdict", async () => {
  const { Store } = await import("../src/core.js");
  const { registerEvaluations } = await import("../src/evaluations.js");
  const { default: Fastify } = await import("fastify");
  // Persisted interruption is an external boundary: seed a restored execution.
  const store = new Store(":memory:");
  store.put("evaluation", {
    id: "interrupted",
    domain: "ads",
    version: 1,
    state: "running",
    releaseId: "r",
    descriptorHash: "h",
    modelEpoch: 0,
    caseId: "c",
    humanReview: "required",
    deadline: Date.now() - 1,
  });
  const app = Fastify();
  registerEvaluations(app, store);
  const interrupted = store.get<any>("evaluation", "interrupted");
  assert.equal(interrupted.state, "failed");
  assert.equal(interrupted.code, "EXECUTION_UNKNOWN");
  assert.equal(interrupted.verdict, undefined);
  await app.close();
  store.close();
});

test("recovery fences late model results from an in-flight evaluation", async () => {
  const { Store } = await import("../src/core.js");
  const { recoverEvaluations } = await import("../src/evaluations.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "evaluation-fence-"));
  const database = join(dir, "state.sqlite");
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  const entered = new Promise<void>((r) => {
    started = r;
  });
  const t = await setup({
    database,
    model: {
      async generate(r) {
        started();
        await waiting;
        return {
          text: JSON.stringify({ text: "迟到答案", citations: ["guide"] }),
          model: r.model,
          stopReason: "end_turn",
          inputTokens: 1,
          outputTokens: 1,
          firstTextMs: 1,
          totalMs: 1,
        };
      },
    },
  });
  try {
    const r = (
      await t.request(
        "POST",
        "/api/domains/ads/submissions",
        sampleBundle(),
        t.admin,
      )
    ).value;
    const pending = t.request(
      "POST",
      `/api/domains/ads/releases/${r.id}/evaluations`,
      { caseId: "example", descriptorHash: r.descriptorHash },
      t.admin,
    );
    await entered;
    const recovery = new Store(database);
    recoverEvaluations(recovery, true);
    recovery.close();
    release();
    const result = (await pending).value;
    assert.equal(result.state, "failed");
    assert.equal(result.code, "EXECUTION_UNKNOWN");
    assert.equal(result.verdict, undefined);
  } finally {
    release();
    await t.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("clarification cases are evaluated as clarification rather than answer success", async () => {
  const t = await setup({
    model: {
      async generate(r) {
        return {
          text: JSON.stringify({
            text: "请确认咨询对象？",
            outcome: "clarification",
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
  });
  try {
    const bundle = {
      ...sampleBundle(),
      cases: [
        {
          id: "clarify",
          question: "示例流程",
          expectedOutcome: "clarification",
        },
        { id: "answer", question: "示例流程", expectedCitations: ["guide"] },
      ],
    };
    const submitted = await t.request(
      "POST",
      "/api/domains/ads/submissions",
      bundle,
      t.admin,
    );
    assert.equal(submitted.status, 201);
    for (const [caseId, verdict] of [
      ["clarify", "pass"],
      ["answer", "fail"],
    ]) {
      const run = await t.request(
        "POST",
        `/api/domains/ads/releases/${submitted.value.id}/evaluations`,
        { caseId, descriptorHash: submitted.value.descriptorHash },
        t.admin,
      );
      assert.equal(run.value.verdict, verdict);
    }
  } finally {
    await t.app.close();
  }
});

test("a failed rerun cannot reuse an older passing result for approval", async () => {
  let gap = false;
  const t = await setup({
    model: {
      async generate(r) {
        return {
          text: JSON.stringify(
            gap
              ? { text: "缺口", outcome: "knowledge_gap", citations: [] }
              : { text: "回答", citations: ["guide"] },
          ),
          model: r.model,
          stopReason: "end_turn",
          inputTokens: 1,
          outputTokens: 1,
          firstTextMs: 1,
          totalMs: 1,
        };
      },
    },
  });
  try {
    const bundle = sampleBundle();
    bundle.cases = [bundle.cases[0]!];
    const r = (
      await t.request("POST", "/api/domains/ads/submissions", bundle, t.admin)
    ).value;
    for (const fail of [false, true]) {
      gap = fail;
      const result = (
        await t.request(
          "POST",
          `/api/domains/ads/releases/${r.id}/evaluations`,
          { caseId: "example", descriptorHash: r.descriptorHash },
          t.admin,
        )
      ).value;
      assert.equal(result.verdict, fail ? "fail" : "pass");
    }
    const review = await t.request(
      "POST",
      `/api/domains/ads/releases/${r.id}/review`,
      {
        expectedVersion: r.version,
        descriptorHash: r.descriptorHash,
        approved: true,
        evidence: "当前复跑不通过不能使用旧成功结果",
      },
      t.admin,
    );
    assert.equal(review.status, 409);
  } finally {
    await t.app.close();
  }
});

test("evaluation timeout settles even when the model ignores cancellation", async () => {
  const previous = process.env.EVALUATION_TIMEOUT_MS;
  process.env.EVALUATION_TIMEOUT_MS = "20";
  const t = await setup({
    model: { generate: async () => new Promise(() => {}) },
  });
  try {
    const r = (
      await t.request(
        "POST",
        "/api/domains/ads/submissions",
        sampleBundle(),
        t.admin,
      )
    ).value;
    const run = (
      await t.request(
        "POST",
        `/api/domains/ads/releases/${r.id}/evaluations`,
        { caseId: "example", descriptorHash: r.descriptorHash },
        t.admin,
      )
    ).value;
    assert.equal(run.state, "failed");
    assert.equal(run.code, "EVALUATION_TIMEOUT");
    assert.equal(run.verdict, undefined);
  } finally {
    await t.app.close();
    if (previous === undefined) delete process.env.EVALUATION_TIMEOUT_MS;
    else process.env.EVALUATION_TIMEOUT_MS = previous;
  }
});

test("custom templates require passing answer cases for all four configured combinations", async () => {
  const seen = new Set<string>();
  const t = await setup({
    model: {
      async generate(r) {
        const pair = r.system.match(/视角=([^，]+)，深度=([^。]+)。/);
        if (pair) seen.add(`${pair[1]}-${pair[2]}`);
        const p = JSON.parse(r.prompt);
        return {
          text: JSON.stringify({
            text: "测试答案",
            citations: [p.pages[0].id],
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
  });
  try {
    const base = sampleBundle();
    const config = {
      ...base.config,
      answerTemplates: {
        business: "业务",
        technical: "技术",
        beginner: "入门",
        experienced: "熟练",
      },
    };
    const submitAndReview = async (cases: unknown[]) => {
      const r = (
        await t.request(
          "POST",
          "/api/domains/ads/submissions",
          { ...base, config, cases },
          t.admin,
        )
      ).value;
      for (const c of cases as { id: string }[])
        await t.request(
          "POST",
          `/api/domains/ads/releases/${r.id}/evaluations`,
          { caseId: c.id, descriptorHash: r.descriptorHash },
          t.admin,
        );
      return t.request(
        "POST",
        `/api/domains/ads/releases/${r.id}/review`,
        {
          expectedVersion: r.version,
          descriptorHash: r.descriptorHash,
          approved: true,
          evidence: "人工复核全部表达组合与知识依据",
        },
        t.admin,
      );
    };
    const missing = await submitAndReview(base.cases);
    assert.equal(missing.status, 409);
    assert.equal(
      missing.value.error.code,
      "TEMPLATE_EVALUATION_COVERAGE_REQUIRED",
    );
    const cases = ["business", "technical"].flatMap((style) =>
      ["beginner", "experienced"].map((depth) => ({
        ...base.cases[0],
        id: `${style}-${depth}`,
        style,
        depth,
      })),
    );
    assert.equal((await submitAndReview(cases)).status, 200);
    assert.equal(seen.size, 4);
  } finally {
    await t.app.close();
  }
});
