import { test } from "node:test";
import assert from "node:assert/strict";
import { FormalBlockParser } from "../src/knowledge/answer-protocol.js";
import type { EvidenceContext } from "../src/knowledge/context.js";
import {
  reportVerdict,
  type SemanticRun,
  type SemanticReport,
} from "../src/knowledge/semantic-evaluation.js";
import { wireHash } from "../src/knowledge/contracts.js";
import type { BundleV2 } from "../src/procedures.js";

test("formal blocks must close, have contiguous sequence and bind all IDs before persistence", () => {
  const context: EvidenceContext = {
    mode: "page",
    claims: [],
    evidence: [],
    pages: [{ pageId: "p", claimVersionIds: [], evidenceIds: [] }],
  };
  const stored: unknown[] = [];
  const p = new FormalBlockParser(context, (b) => stored.push(b));
  const line = JSON.stringify({
    seq: 1,
    text: "answer",
    pageIds: ["p"],
    claimVersionIds: [],
    evidenceIds: [],
    outcome: "answer",
  });
  p.push(line);
  assert.equal(stored.length, 0);
  p.push("\n");
  assert.equal(stored.length, 1);
  p.push('{"type":"final","count":1}\n');
  p.finish();
  assert.throws(() => p.push(line + "\n"), /BLOCK_AFTER_FINAL/);
  for (const update of [
    { pageIds: ["missing"] },
    { claimVersionIds: ["draft"] },
    { evidenceIds: ["private"] },
    { seq: 2 },
  ]) {
    const invalid = new FormalBlockParser(context, () =>
      assert.fail("invalid block persisted"),
    );
    assert.throws(() =>
      invalid.push(JSON.stringify({ ...JSON.parse(line), ...update }) + "\n"),
    );
  }
  assert.throws(
    () =>
      new FormalBlockParser({ ...context, mode: "claims" }).push(line + "\n"),
    /CLAIM_SUPPORT_REQUIRED/,
  );
});
test("semantic report binds the complete suite, descriptor, epoch, judge, input and deadline", () => {
  const d = wireHash([]),
    policy: BundleV2["evalPolicy"] = {
      version: "1",
      mode: "shadow",
      judgeProfileHash: d,
      suiteHash: d,
      calibrationId: null,
      maxAgeMs: 100000,
      metrics: ["faithfulness", "relevancy", "coverage", "forbidden"].map(
        (name) => ({
          name: name as "faithfulness",
          required: true,
          thresholdBps: 8000,
        }),
      ),
    };
  const run: SemanticRun = {
    id: "job",
    domain: "ads",
    version: 1,
    releaseId: "r",
    judge: {
      model: "test",
      revision: "1",
      promptVersion: "1",
      temperature: 0,
      deepevalVersion: "4.2.8",
    },
    actor: "admin",
    state: "running",
    pass: false,
    createdAt: 1,
    inputHashes: { a: d, b: d },
    binding: {
      releaseId: "r",
      descriptorHash: d,
      modelEpoch: 1,
      judgeEpoch: 1,
      suiteHash: d,
      evalPolicyHash: wireHash(policy),
      judgeProfileHash: d,
      caseIds: ["a", "b"],
      inputHash: d,
      jobId: "job",
      attempt: 1,
      fencingToken: "fence",
      deadline: 1000,
    },
  };
  const report: SemanticReport = {
    type: "report",
    binding: run.binding,
    runtime: { deepeval: "4.2.8", python: "3.12.10" },
    cases: ["a", "b"].map((caseId) => ({
      caseId,
      inputHash: d,
      metrics: policy.metrics.map((m) => ({
        name: m.name,
        scoreBps: 9000,
        reason: "synthetic",
        state: "complete",
      })),
    })),
  };
  assert.equal(reportVerdict(report, run, policy, 900), true);
  assert.throws(
    () =>
      reportVerdict(
        { ...report, cases: report.cases.slice(0, 1) },
        run,
        policy,
        900,
      ),
    /CASES_INCOMPLETE/,
  );
  assert.throws(() => reportVerdict(report, run, policy, 1000), /EXPIRED/);
  for (const binding of [
    { descriptorHash: "0".repeat(64) },
    { modelEpoch: 0 },
    { judgeProfileHash: "0".repeat(64) },
    { fencingToken: "old" },
  ])
    assert.throws(
      () =>
        reportVerdict(
          { ...report, binding: { ...report.binding, ...binding } },
          run,
          policy,
          900,
        ),
      /BINDING_MISMATCH/,
    );
  const failed = structuredClone(report);
  failed.cases[0]!.metrics[0]!.state = "failed";
  assert.throws(() => reportVerdict(failed, run, policy, 900), /METRIC_FAILED/);
  const low = structuredClone(report);
  low.cases[0]!.metrics[0]!.scoreBps = 0;
  assert.equal(reportVerdict(low, run, policy, 900), false);
});
