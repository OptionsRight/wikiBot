import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeAcceptance } from "../tools/acceptance-report.js";

test("joint acceptance counts missing, late, and unknown deliveries in the frozen denominator", () => {
  const report = summarizeAcceptance({
    kind: "synthetic",
    approvalReference: "local-test-only",
    descriptorHash: "a".repeat(64),
    frozenAt: 1,
    startedAt: 2,
    ordinaryRequestIds: ["ok", "late", "unknown", "missing"],
    samples: [
      { id: "ok", usefulFirstMs: 2000, completeMs: 8000, outcome: "success" },
      { id: "late", usefulFirstMs: 4000, completeMs: 8000, outcome: "success" },
      {
        id: "unknown",
        usefulFirstMs: 2000,
        completeMs: 8000,
        outcome: "unknown",
      },
    ],
  });
  assert.equal(report.denominator, 4);
  assert.equal(report.jointSuccesses, 1);
  assert.equal(report.jointRate, 0.25);
  assert.equal(report.accepted, false);
  assert.deepEqual(
    report.failures.map((s) => s.id),
    ["late", "unknown", "missing"],
  );
  assert.equal(report.completeMs.p95, 8000);
});

test("synthetic success cannot qualify as real SLO acceptance", () => {
  const ordinaryRequestIds = Array.from({ length: 1000 }, (_, i) => String(i));
  const input = {
    kind: "synthetic",
    approvalReference: "synthetic",
    descriptorHash: "b".repeat(64),
    frozenAt: 1,
    startedAt: 2,
    ordinaryRequestIds,
    samples: ordinaryRequestIds.map((id) => ({
      id,
      usefulFirstMs: 1,
      completeMs: 2,
      outcome: "success",
    })),
  };
  assert.equal(summarizeAcceptance(input).accepted, false);
  assert.equal(
    summarizeAcceptance({
      ...input,
      kind: "real",
      approvalReference: "approved-run-record",
    }).accepted,
    true,
  );
});

test("acceptance refuses duplicate, unplanned, or retrospectively frozen samples", () => {
  const input = {
    kind: "real",
    approvalReference: "approved",
    descriptorHash: "c".repeat(64),
    frozenAt: 1,
    startedAt: 2,
    ordinaryRequestIds: ["one"],
    samples: [],
  };
  assert.throws(() => summarizeAcceptance({ ...input, frozenAt: 3 }));
  assert.throws(() =>
    summarizeAcceptance({ ...input, ordinaryRequestIds: ["one", "one"] }),
  );
  const sample = {
    id: "one",
    usefulFirstMs: 1,
    completeMs: 2,
    outcome: "success",
  };
  assert.throws(() =>
    summarizeAcceptance({ ...input, samples: [sample, sample] }),
  );
  assert.throws(() =>
    summarizeAcceptance({
      ...input,
      samples: [{ ...sample, id: "unplanned" }],
    }),
  );
});
