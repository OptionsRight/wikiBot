import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp, type AppOptions } from "../src/app.js";
import { hash } from "../src/core.js";

export async function setup(options: Partial<AppOptions> = {}) {
  const app = await buildApp({
    database: ":memory:",
    bootstrap: { token: "operator-test", subject: "operator" },
    model: {
      async generate(r) {
        return {
          text: JSON.stringify({
            text: "这是测试模型的解释。",
            citations: ["guide"],
          }),
          model: r.model,
          inputTokens: 1,
          outputTokens: 1,
          firstTextMs: 1,
          totalMs: 1,
          stopReason: "end_turn",
        };
      },
    },
    ...options,
  });
  const request = async (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    actor = "operator-test",
    idem: string = randomUUID(),
  ) => {
    const result = await app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${actor}`,
        "idempotency-key": idem,
        "content-type": "application/json",
      },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: result.statusCode, value: result.json(), raw: result };
  };
  await request("POST", "/api/domains", { id: "ads", name: "广告" });
  await request("POST", "/api/models/qualify", {
    model: "test-model",
    revision: "r1",
    expectedEpoch: 0,
    evidence: "仅用于自动化测试的固定模型和版本",
  });
  const tokens: Record<string, string> = {};
  for (const [subject, role] of [
    ["admin", "admin"],
    ["alice", "member"],
    ["bob", "member"],
  ] as const) {
    await request("PUT", `/api/domains/ads/members/${subject}`, {
      role,
      expectedVersion: 0,
    });
    tokens[subject] = (
      await request("POST", `/api/identities/${subject}/tokens`, {})
    ).value.token;
  }
  return {
    app,
    request,
    admin: tokens.admin!,
    alice: tokens.alice!,
    bob: tokens.bob!,
  };
}
export const page = {
  id: "guide",
  path: "workflows/example.md",
  title: "示例流程",
  content: "这是测试流程。先准备材料，再提交申请，最后核对结果。",
};
export function sampleBundle() {
  return {
    pages: [{ ...page, hash: hash(page.content) }],
    procedures: [
      {
        id: "example",
        title: "示例流程",
        aliases: ["示例"],
        version: "1",
        pageId: "guide",
        pageHash: hash(page.content),
        scope: "仅测试环境",
        owner: "knowledge-owner",
        inputs: [
          {
            id: "scenario",
            type: "enum",
            values: ["new", "existing"],
            required: true,
            semanticVersion: "1",
            question: "是新申请还是已有申请？",
          },
        ],
        supportedWhen: {
          field: "scenario",
          op: "in",
          values: ["new", "existing"],
        },
        nodes: [
          {
            id: "prepare",
            kind: "prerequisite",
            text: "准备材料",
            dependsOn: [],
            citations: ["guide"],
          },
          {
            id: "submit",
            kind: "step",
            text: "提交申请",
            dependsOn: ["prepare"],
            citations: ["guide"],
          },
          {
            id: "check",
            kind: "completion",
            text: "核对结果",
            dependsOn: ["prepare"],
            citations: ["guide"],
          },
        ],
        alwaysRequired: ["prepare"],
        branches: [
          {
            id: "new",
            when: { field: "scenario", op: "eq", value: "new" },
            requiredNodes: ["submit", "check"],
          },
          {
            id: "existing",
            when: { field: "scenario", op: "eq", value: "existing" },
            requiredNodes: ["check"],
          },
        ],
      },
    ],
    cases: [
      {
        id: "new",
        procedureId: "example",
        question: "示例新申请",
        inputs: { scenario: "new" },
        expectedCode: "GUIDANCE",
        expectedNodes: ["prepare", "submit", "check"],
      },
      {
        id: "existing",
        procedureId: "example",
        question: "示例已有申请",
        inputs: { scenario: "existing" },
        expectedCode: "GUIDANCE",
        expectedNodes: ["prepare", "check"],
      },
    ],
    config: {
      model: "test-model",
      modelRevision: "r1",
      promptVersion: "1",
      templateVersion: "1",
      retrievalVersion: "1",
      protocolVersion: "1",
      evaluationVersion: "1",
    },
  };
}
export async function publish(
  t: Awaited<ReturnType<typeof setup>>,
  bundle = sampleBundle(),
) {
  const candidate = await t.request(
    "POST",
    "/api/domains/ads/submissions",
    bundle,
    t.admin,
  );
  if (candidate.status !== 201)
    throw new Error(JSON.stringify(candidate.value));
  const r = candidate.value;
  for (const c of bundle.cases) {
    const run = await t.request(
      "POST",
      `/api/domains/ads/releases/${r.id}/evaluations`,
      { caseId: c.id, descriptorHash: r.descriptorHash },
      t.admin,
    );
    if (run.value.state !== "complete")
      throw new Error(JSON.stringify(run.value));
  }
  const review = await t.request(
    "POST",
    `/api/domains/ads/releases/${r.id}/review`,
    {
      expectedVersion: r.version,
      descriptorHash: r.descriptorHash,
      evidence: "人工核对测试流程和测试模型输出",
      approved: true,
    },
    t.admin,
  );
  const ready = review.value;
  const active = await t.request(
    "POST",
    `/api/domains/ads/releases/${r.id}/activate`,
    {
      expectedVersion: ready.version,
      expectedEpoch: r.baseEpoch,
      expectedActive: r.baseActive,
      descriptorHash: r.descriptorHash,
    },
    t.admin,
  );
  if (active.status !== 200) throw new Error(JSON.stringify(active.value));
  return active.value;
}
