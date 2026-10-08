import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { Store, hash } from "../src/core.js";
import { wireHash } from "../src/knowledge/contracts.js";
import {
  requireSemanticEvaluation,
  registerSemanticEvaluations,
  type SemanticRun,
} from "../src/knowledge/semantic-evaluation.js";
import type { Release } from "../src/publication.js";
import type { BundleV2 } from "../src/procedures.js";
import { sampleBundle } from "./helpers.js";

test("semantic gate rejects new answer attempts, expired reports, changed judge and uncalibrated blocking policy", async () => {
  const store = new Store(":memory:"),
    app = Fastify();
  store.put("domain", {
    id: "ads",
    domain: "ads",
    version: 1,
    maintenance: false,
  });
  store.put("grant", {
    id: "ads:admin",
    domain: "ads",
    version: 1,
    enabled: true,
    role: "admin",
  });
  app.decorateRequest("actor");
  app.addHook("preHandler", async (req) => {
    req.actor = { subject: "admin", platform: false };
  });
  registerSemanticEvaluations(app, store);
  try {
    const judge = {
      model: "test-model",
      revision: "r1",
      temperature: 0 as const,
      promptVersion: "1" as const,
      deepevalVersion: "4.2.8" as const,
    };
    const model = {
      id: hash([judge.model, judge.revision]),
      domain: "",
      version: 1,
      model: judge.model,
      revision: judge.revision,
      qualified: true,
      epoch: 1,
    };
    store.put("model", model);
    const cases = [
      {
        id: "a",
        question: "limit?",
        expectedFacts: ["80"],
        forbiddenFacts: ["100"],
        expectedClaimIds: [],
        expectedCitations: ["guide"],
      },
    ];
    const policy: BundleV2["evalPolicy"] = {
      version: "1",
      mode: "shadow",
      judgeProfileHash: wireHash(judge),
      suiteHash: wireHash(cases),
      calibrationId: null,
      maxAgeMs: 60000,
      metrics: ["faithfulness", "relevancy", "coverage", "forbidden"].map(
        (name) => ({
          name: name as "coverage",
          required: true,
          thresholdBps: 8000,
        }),
      ),
    };
    const bundle = {
      ...sampleBundle(),
      schemaVersion: 2,
      cases,
      evalPolicy: policy,
    } as unknown as BundleV2;
    const release: Release = {
      id: "r",
      domain: "ads",
      version: 1,
      bundle,
      descriptorHash: hash(bundle),
      bundleHash: hash(bundle),
      state: "submitted",
      modelEpoch: 1,
      baseEpoch: 0,
      baseActive: null,
    };
    const evaluation = {
      id: "det",
      domain: "ads",
      version: 1,
      releaseId: "r",
      caseId: "a",
      descriptorHash: release.descriptorHash,
      modelEpoch: 1,
      attempt: 1,
      state: "complete",
      verdict: "pass",
      output: { answer: { text: "80" }, context: ["80"] },
    };
    store.put("evaluation", evaluation);
    const value = {
      id: "a",
      evaluationId: "det",
      evaluationAttempt: 1,
      question: "limit?",
      answer: "80",
      context: ["80"],
      expectedFacts: ["80"],
      forbiddenFacts: ["100"],
    };
    const run: SemanticRun = {
      id: "sem",
      domain: "ads",
      version: 1,
      releaseId: "r",
      actor: "admin",
      judge,
      state: "complete",
      pass: true,
      createdAt: Date.now(),
      finishedAt: Date.now(),
      inputHashes: { a: wireHash(value) },
      binding: {
        releaseId: "r",
        descriptorHash: release.descriptorHash,
        modelEpoch: 1,
        judgeEpoch: 1,
        suiteHash: wireHash(cases),
        evalPolicyHash: wireHash(policy),
        judgeProfileHash: wireHash(judge),
        caseIds: ["a"],
        inputHash: wireHash([{ ...value, inputHash: wireHash(value) }]),
        jobId: "sem",
        attempt: 1,
        fencingToken: "f",
        deadline: Date.now() + 60000,
      },
    };
    run.report = {
      type: "report",
      binding: run.binding,
      runtime: { deepeval: "4.2.8", python: "3.12.10" },
      cases: [
        {
          caseId: "a",
          inputHash: wireHash(value),
          metrics: policy.metrics.map((m) => ({
            name: m.name,
            state: "complete",
            scoreBps: 9000,
            reason: "controlled gate fixture",
          })),
        },
      ],
    };
    store.knowledgePut("semantic_reports", run);
    requireSemanticEvaluation(store, release);
    store.put("evaluation", { ...evaluation, attempt: 2 });
    assert.throws(
      () => requireSemanticEvaluation(store, release),
      /INPUT_STALE/,
    );
    store.put("evaluation", evaluation);
    store.put("model", { ...model, epoch: 2 });
    assert.throws(
      () => requireSemanticEvaluation(store, release),
      /JUDGE_REVALIDATION/,
    );
    store.put("model", model);
    store.knowledgePut("semantic_reports", {
      ...run,
      finishedAt: Date.now() - 70000,
    });
    assert.throws(
      () => requireSemanticEvaluation(store, release),
      /SEMANTIC_EVALUATION_REQUIRED/,
    );
    policy.mode = "blocking";
    policy.calibrationId = "cal";
    run.binding.evalPolicyHash = wireHash(policy);
    store.knowledgePut("semantic_reports", run);
    assert.throws(
      () => requireSemanticEvaluation(store, release),
      /CALIBRATION_REQUIRED/,
    );
    const samples = [];
    for (let i = 0; i < 4; i++) {
      const fixture = structuredClone(run);
      fixture.id = `sample${i}`;
      fixture.report!.cases[0]!.metrics.forEach((m) => {
        m.scoreBps = i < 2 ? 9000 : 1000;
      });
      store.knowledgePut("semantic_reports", fixture);
      samples.push({
        runId: fixture.id,
        caseId: "a",
        humanPass: i < 2,
        rationale: "Human controlled positive/negative calibration fixture",
      });
    }
    const response = await app.inject({
      method: "POST",
      url: "/api/domains/ads/evaluation-calibrations",
      headers: { "idempotency-key": "cal" },
      payload: {
        id: "cal",
        policy,
        reason: "Human reviewed balanced examples and agreed thresholds.",
        samples,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    requireSemanticEvaluation(store, release);
    const bad = await app.inject({
      method: "POST",
      url: "/api/domains/ads/evaluation-calibrations",
      headers: { "idempotency-key": "bad" },
      payload: {
        id: "bad",
        policy: { ...policy, calibrationId: "bad" },
        reason: "Wrong positive label should not qualify this policy.",
        samples: samples.map((s) => ({ ...s, humanPass: !s.humanPass })),
      },
    });
    assert.equal(bad.statusCode, 409);
    assert.equal(bad.json().code, "CALIBRATION_THRESHOLD_DISAGREEMENT");
  } finally {
    await app.close();
    store.close();
  }
});
