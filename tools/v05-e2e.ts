/** Synthetic end-to-end proof through real APIs, Docling and DeepEval.
 * The deterministic company-model stand-in is explicitly NOT company acceptance.
 * Artifacts/logs are retained so the real library results can be inspected. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { setup, publish, sampleBundle } from "../test/helpers.js";
import { profileSchema, wireHash } from "../src/knowledge/contracts.js";
import { hash } from "../src/core.js";
import type { JudgeProfile } from "../src/knowledge/semantic-evaluation.js";
import type { Inbound } from "../src/adapters/wecom.js";
import { buildApp } from "../src/app.js";

const normalizer = process.env.NORMALIZER_PYTHON,
  evaluator = process.env.EVALUATION_PYTHON;
assert.ok(
  normalizer && evaluator,
  "Set NORMALIZER_PYTHON and EVALUATION_PYTHON to isolated locked Python executables",
);
const root = resolve(
  process.env.V05_E2E_ROOT ?? `.local/v05/e2e-${Date.now()}`,
);
await mkdir(root, { recursive: true });
execFileSync(
  normalizer,
  ["python/normalizer/make_samples.py", join(root, "samples")],
  { stdio: "inherit" },
);
const profile = profileSchema.parse(
  JSON.parse(await readFile("config/normalizer.native.json", "utf8")),
);
const judge: JudgeProfile = {
  model: "test-model",
  revision: "r1",
  promptVersion: "1",
  temperature: 0,
  deepevalVersion: "4.2.8",
};
let judgeCalls = 0,
  invalidChannelAnswer = false;
let receive!: (event: Inbound) => Promise<void>;
const channelMessages: string[] = [];
const t = await setup({
  wecom: {
    botId: "synthetic-v05",
    domain: "ads",
    members: { "synthetic-member": "alice" },
    transport: {
      start(fn) {
        receive = fn;
      },
      close() {},
      async reply(_event, _stream, text) {
        channelMessages.push(text);
        if (text.includes("Travel reimbursement limit is 80")) {
          const receipts = (
            await t.request(
              "GET",
              "/api/domains/ads/channel-receipts",
              undefined,
              t.alice,
            )
          ).value;
          const receipt = receipts.filter((r: any) => r.answerId).at(-1);
          const persisted = (
            await t.request(
              "GET",
              `/api/domains/ads/answers/${receipt.answerId}`,
              undefined,
              t.alice,
            )
          ).value;
          assert.ok(
            persisted.blocks.some((b: any) => b.text.includes("80 USD")),
            "formal answer must be persisted before channel delivery",
          );
        }
      },
    },
  },
  database: join(root, "database.sqlite"),
  knowledge: {
    assetRoot: join(root, "assets"),
    normalizerPython: normalizer,
    normalizerProfile: profile,
    pollMs: 25,
  },
  semanticEvaluation: { python: evaluator, judge, timeoutMs: 120000 },
  model: {
    async generate(r) {
      let text: string;
      if (r.system.includes("schema=")) {
        judgeCalls++;
        const schema = JSON.parse(r.system.split("schema=")[1]!);
        // Schema-aware synthetic judge for exercising the real DeepEval algorithms.
        const value = (s: any): any => {
          if (s.$ref) return value(schema.$defs[s.$ref.split("/").pop()]);
          if (s.anyOf)
            return value(s.anyOf.find((x: any) => x.type !== "null"));
          if (s.enum) return s.enum.includes("yes") ? "yes" : s.enum[0];
          if (s.type === "object" || s.properties)
            return Object.fromEntries(
              Object.entries(s.properties ?? {}).map(([k, v]) => [
                k,
                k === "verdict"
                  ? "yes"
                  : k === "score"
                    ? 10
                    : k === "reason"
                      ? "Synthetic judge fixture: supported by the supplied 80 USD policy."
                      : value(v),
              ]),
            );
          if (s.type === "array") return [value(s.items)];
          if (s.type === "number" || s.type === "integer") return 10;
          if (s.type === "boolean") return true;
          return "Travel reimbursement limit is 80 USD per day.";
        };
        text = JSON.stringify(value(schema));
      } else {
        const p = JSON.parse(r.prompt);
        if (p.grounding) {
          const c = p.grounding.claims[0],
            page = p.grounding.pages[0];
          text =
            JSON.stringify({
              seq: 1,
              text: invalidChannelAnswer
                ? "UNTRUSTED_RAW_MUST_NOT_DELIVER"
                : "Travel reimbursement limit is 80 USD per day.",
              pageIds: [invalidChannelAnswer ? "wrong-page" : page.pageId],
              claimVersionIds: c ? [c.versionId] : [],
              evidenceIds: c ? c.evidenceIds : [],
              outcome: "answer",
            }) +
            "\n" +
            JSON.stringify({ type: "final", count: 1 });
          r.onText?.(text + "\n");
        } else
          text = JSON.stringify({
            text: "Synthetic V1 answer",
            citations: [p.pages[0].id],
          });
      }
      return {
        text,
        model: r.model,
        inputTokens: 1,
        outputTokens: 1,
        firstTextMs: 1,
        totalMs: 1,
        stopReason: "end_turn",
      };
    },
  },
});
const api = async (
  method: "GET" | "POST" | "PUT",
  url: string,
  data?: unknown,
) => {
  const response = await t.request(
    method,
    `/api/domains/ads/${url}`,
    data,
    t.admin,
  );
  assert.ok(
    response.status < 300,
    JSON.stringify({ url, status: response.status, value: response.value }),
  );
  return response.value;
};
try {
  const v1 = await publish(t);
  console.log("V1 published", v1.id);
  const source = await api("POST", "sources", {
    id: "policy",
    title: "Synthetic travel policy",
  });
  const bytes = await readFile(join(root, "samples/normal.docx"));
  const file = await api("POST", `sources/${source.id}/files`, {
    expectedVersion: 1,
    format: "docx",
    content: bytes.toString("base64"),
  });
  let job = await api("POST", `sources/${source.id}/normalize`, {
    sourceVersionId: file.id,
  });
  const deadline = Date.now() + 150000;
  while (["queued", "running"].includes(job.state) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    job = await api("GET", `knowledge-jobs/${job.id}`);
  }
  assert.equal(job.state, "succeeded", JSON.stringify(job));
  console.log("Real Docling complete", job.result.doclingVersion);
  const block = job.result.blocks.find((b: any) => b.text.includes("80 USD"));
  assert.ok(block);
  const evidence = await api("POST", "evidence/document", {
    jobId: job.id,
    blockId: block.blockId,
  });
  const claim = await api("POST", "claims", {
    expectedVersion: 0,
    subjectId: "travel",
    predicate: "daily_limit",
    qualifiers: { currency: "USD" },
    statement: "Travel reimbursement limit is 80 USD per day.",
    typedValue: 80,
    validityKind: "known",
    validFrom: 0,
    validTo: null,
    evidenceIds: [evidence.id],
    extractionProfileHash: wireHash(["manual", 1]),
    batchId: "synthetic",
    reason: "Synthetic policy checked against original DOCX text.",
  });
  await api("POST", "claims/review-batch", {
    versions: [{ id: claim.id, expectedVersion: 1 }],
    reason: "Synthetic owner approves the exact source and scope.",
  });
  const content =
    "# Travel policy\n\nTravel reimbursement limit is 80 USD per day.\n";
  const cases = [
    {
      id: "travel",
      question: "What is the travel reimbursement limit?",
      expectedOutcome: "answer",
      expectedCitations: ["travel"],
      expectedFacts: ["Travel reimbursement limit is 80 USD per day."],
      forbiddenFacts: ["The limit is 100 USD per day."],
      expectedClaimIds: [claim.claimId],
    },
  ];
  const input = {
    base: {
      ...sampleBundle(),
      pages: [
        {
          id: "travel",
          path: "travel.md",
          title: "Travel policy",
          content,
          hash: hash(content),
        },
      ],
      cases: [
        {
          id: "travel",
          question: cases[0]!.question,
          expectedCitations: ["travel"],
        },
      ],
    },
    mode: "claims",
    mapping: { travel: [claim.id] },
    cases,
    evalPolicy: {
      version: "shadow-1",
      mode: "shadow",
      judgeProfileHash: wireHash(judge),
      suiteHash: wireHash(cases),
      calibrationId: null,
      maxAgeMs: 86400000,
      metrics: ["faithfulness", "relevancy", "coverage", "forbidden"].map(
        (name) => ({ name, required: true, thresholdBps: 8000 }),
      ),
    },
  };
  await writeFile(
    join(root, "build-request.json"),
    JSON.stringify(input, null, 2),
  );
  const generation = await api("POST", "knowledge-builds", input);
  assert.equal(
    (await api("POST", "knowledge-builds", input)).id,
    generation.id,
    "no-change reuses validated generation",
  );
  const candidate = await api("POST", "submissions", generation.bundle);
  const evaluation = await api("POST", `releases/${candidate.id}/evaluations`, {
    caseId: "travel",
    descriptorHash: candidate.descriptorHash,
  });
  assert.equal(evaluation.verdict, "pass", JSON.stringify(evaluation));
  const premature = await t.request(
    "POST",
    `/api/domains/ads/releases/${candidate.id}/review`,
    {
      expectedVersion: 1,
      descriptorHash: candidate.descriptorHash,
      evidence: "Synthetic owner reviewed candidate.",
      approved: true,
    },
    t.admin,
  );
  assert.equal(premature.status, 409);
  const report = await api(
    "POST",
    `releases/${candidate.id}/semantic-evaluations`,
    { descriptorHash: candidate.descriptorHash },
  );
  assert.equal(report.state, "complete", JSON.stringify(report));
  assert.ok(judgeCalls > 0);
  console.log(
    "Real DeepEval complete",
    report.report.runtime,
    "synthetic judge calls",
    judgeCalls,
  );
  const ready = await api("POST", `releases/${candidate.id}/review`, {
    expectedVersion: 1,
    descriptorHash: candidate.descriptorHash,
    evidence: "Synthetic owner reviewed exact candidate and full report.",
    approved: true,
  });
  const active = await api("POST", `releases/${candidate.id}/activate`, {
    expectedVersion: ready.version,
    expectedEpoch: candidate.baseEpoch,
    expectedActive: candidate.baseActive,
    descriptorHash: candidate.descriptorHash,
  });
  const styleState = await api("GET", "answer-style");
  const styleDraft = await api("PUT", "answer-style/draft", {
    expectedVersion: 0,
    baseReleaseId: active.id,
    templates: styleState.recommendedTemplates,
    caseId: "travel",
  });
  const styleCandidate = await api("POST", "answer-style/submissions", {
    expectedVersion: styleDraft.version,
  });
  assert.deepEqual(
    styleCandidate.bundle.groundingManifest,
    active.bundle.groundingManifest,
  );
  assert.equal(styleCandidate.bundle.cases.length, 5);
  assert.equal(
    styleCandidate.bundle.evalPolicy.suiteHash,
    wireHash(styleCandidate.bundle.cases),
  );
  for (const c of styleCandidate.bundle.cases)
    assert.equal(
      (
        await api("POST", `releases/${styleCandidate.id}/evaluations`, {
          caseId: c.id,
          descriptorHash: styleCandidate.descriptorHash,
        })
      ).verdict,
      "pass",
    );
  console.log(
    "V2 four-style candidate retains frozen grounding and requires a new full semantic suite",
  );
  let answer = (
    await t.request(
      "POST",
      "/api/domains/ads/answers",
      { question: cases[0]!.question, sessionId: "v05-e2e" },
      t.alice,
    )
  ).value;
  for (
    let i = 0;
    i < 100 && ["queued", "running"].includes(answer.state);
    i++
  ) {
    await new Promise((r) => setTimeout(r, 20));
    answer = (
      await t.request(
        "GET",
        `/api/domains/ads/answers/${answer.id}`,
        undefined,
        t.alice,
      )
    ).value;
  }
  assert.equal(answer.state, "complete", JSON.stringify(answer));
  assert.deepEqual(answer.blocks[0].claimVersionIds, [claim.id]);
  assert.equal(
    (
      await t.request(
        "GET",
        `/api/domains/ads/releases/${active.id}/evidence/${evidence.id}`,
        undefined,
        t.alice,
      )
    ).status,
    200,
  );
  assert.equal(
    (await t.request("GET", "/api/domains/ads/claims", undefined, t.alice))
      .status,
    403,
  );
  const channelEvent: Inbound = {
    id: "v05-channel-good",
    botId: "synthetic-v05",
    userId: "synthetic-member",
    chatType: "single",
    text: cases[0]!.question,
    replyContext: {},
  };
  await receive(channelEvent);
  assert.ok(channelMessages.some((text) => text.includes("80 USD")));
  channelMessages.length = 0;
  invalidChannelAnswer = true;
  await receive({ ...channelEvent, id: "v05-channel-bad" });
  assert.ok(channelMessages.length > 0);
  assert.ok(
    channelMessages.every(
      (text) => !text.includes("UNTRUSTED_RAW_MUST_NOT_DELIVER"),
    ),
  );
  invalidChannelAnswer = false;
  console.log(
    "V2 controlled channel validates persistence before delivery and rejects invalid citations without raw preview leakage",
  );
  const rollback = await api("POST", `releases/${v1.id}/rollback-candidate`, {
    expectedEpoch: active.baseEpoch + 1,
    expectedActive: active.id,
    descriptorHash: v1.descriptorHash,
    reason: "Synthetic rollback compatibility check.",
  });
  assert.equal(rollback.descriptorHash, v1.descriptorHash);
  const backupRoot = join(root, "backup");
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "tools/knowledge-backup.ts",
      "backup",
      join(root, "database.sqlite"),
      join(root, "assets"),
      backupRoot,
    ],
    { stdio: "pipe" },
  );
  const generationFile = join(
      backupRoot,
      "assets",
      "generations",
      generation.id,
      "travel.json",
    ),
    saved = await readFile(generationFile);
  await unlink(generationFile);
  const restored = await buildApp({
    database: join(backupRoot, "database.sqlite"),
    bootstrap: { token: "restore-operator", subject: "operator" },
    recovery: true,
    knowledge: {
      assetRoot: join(backupRoot, "assets"),
      normalizerProfile: profile,
    },
    recoveryAuthority: async (domain, nonce) => ({
      domain,
      nonce,
      issuedAt: Date.now(),
      evidenceId: "synthetic-independent-current-authority",
      active: { id: active.id, descriptorHash: active.descriptorHash },
      grants: [
        { subject: "admin", role: "admin" },
        { subject: "alice", role: "member" },
      ],
      models: [
        {
          model: "test-model",
          revision: "r1",
          epoch: active.modelEpoch,
          qualified: true,
        },
      ],
    }),
  });
  try {
    const recover = () =>
      restored.inject({
        method: "POST",
        url: "/api/operations/recover/ads",
        headers: {
          authorization: "Bearer restore-operator",
          "idempotency-key": "recovery",
        },
        payload: {},
      });
    const missing = await recover();
    assert.equal(missing.statusCode, 409, missing.body);
    assert.equal(missing.json().error.code, "GENERATION_INCOMPLETE");
    await writeFile(generationFile, saved);
    const recovered = await recover();
    assert.equal(recovered.statusCode, 200, recovered.body);
    const token = await restored.inject({
      method: "POST",
      url: "/api/identities/alice/tokens",
      headers: { authorization: "Bearer restore-operator" },
      payload: {},
    });
    const knowledge = await restored.inject({
      url: "/api/domains/ads/knowledge",
      headers: { authorization: `Bearer ${token.json().token}` },
    });
    assert.equal(knowledge.statusCode, 200);
    assert.equal(knowledge.json().release.id, active.id);
    assert.equal(
      (
        await restored.inject({
          url: "/api/domains/ads/knowledge",
          headers: { authorization: `Bearer ${t.alice}` },
        })
      ).statusCode,
      401,
    );
    console.log(
      "Actual backup/restore verified; missing generation fenced before recovery",
    );
  } finally {
    await restored.close();
  }
  for (const c of rollback.bundle.cases)
    assert.equal(
      (
        await api("POST", `releases/${rollback.id}/evaluations`, {
          caseId: c.id,
          descriptorHash: rollback.descriptorHash,
        })
      ).verdict,
      "pass",
    );
  const rollbackReady = await api("POST", `releases/${rollback.id}/review`, {
    expectedVersion: rollback.version,
    descriptorHash: rollback.descriptorHash,
    evidence: "Synthetic owner reviewed V1 rollback with current evaluation.",
    approved: true,
  });
  const rollbackActive = await api("POST", `releases/${rollback.id}/activate`, {
    expectedVersion: rollbackReady.version,
    expectedEpoch: rollback.baseEpoch,
    expectedActive: rollback.baseActive,
    descriptorHash: rollback.descriptorHash,
  });
  assert.equal(rollbackActive.descriptorHash, v1.descriptorHash);
  assert.equal(
    (
      await t.request(
        "GET",
        `/api/domains/ads/releases/${active.id}/evidence/${evidence.id}`,
        undefined,
        t.alice,
      )
    ).status,
    200,
  );
  console.log(
    "V1 rollback activated through current evaluation and review; retired V2 evidence remains frozen",
  );
  await writeFile(
    join(root, "report.json"),
    JSON.stringify(
      {
        scope:
          "real Docling and DeepEval; synthetic company judge and business facts; controlled WeCom transport only, no real WeCom delivery",
        v1: v1.id,
        v2: active.id,
        job,
        semanticReport: report,
        answer,
        rollback: rollback.id,
        judgeCalls,
      },
      null,
      2,
    ),
  );
  console.log("END_TO_END_PASS", root);
} finally {
  await t.app.close();
}
