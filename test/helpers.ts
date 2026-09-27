import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp, type AppOptions } from "../src/app.js";
import { hash } from "../src/core.js";
import type { Bundle } from "../src/procedures.js";

export async function setup(options: Partial<AppOptions> = {}) {
  const app = await buildApp({
    database: ":memory:",
    bootstrap: { token: "operator-test", subject: "operator" },
    model: {
      async generate(r) {
        const pages = (JSON.parse(r.prompt).pages ?? []) as { id: string }[];
        return {
          text: JSON.stringify({
            text: "这是测试模型的回答。",
            citations: pages.slice(0, 1).map((p) => p.id),
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
export const billingPage = {
  id: "billing",
  path: "workflows/billing.md",
  title: "结算流程",
  content: "结算按月执行。代理商提交对账单后，财务在五个工作日内复核并打款。",
};
export function sampleBundle() {
  return {
    pages: [
      { ...page, hash: hash(page.content) },
      { ...billingPage, hash: hash(billingPage.content) },
    ],
    cases: [
      {
        id: "example",
        question: "示例流程怎么走？",
        expectedCitations: ["guide"],
      },
      {
        id: "billing",
        question: "代理商结算后多久打款？",
        expectedCitations: ["billing"],
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
    } as const,
  };
}
export async function publish(
  t: Awaited<ReturnType<typeof setup>>,
  bundle: Bundle = sampleBundle(),
  domain = "ads",
  admin = t.admin,
) {
  const candidate = await t.request(
    "POST",
    `/api/domains/${domain}/submissions`,
    bundle,
    admin,
  );
  if (candidate.status !== 201)
    throw new Error(JSON.stringify(candidate.value));
  const r = candidate.value;
  for (const c of bundle.cases) {
    const run = await t.request(
      "POST",
      `/api/domains/${domain}/releases/${r.id}/evaluations`,
      { caseId: c.id, descriptorHash: r.descriptorHash },
      admin,
    );
    if (run.value.state !== "complete" || run.value.verdict !== "pass")
      throw new Error(JSON.stringify(run.value));
  }
  const review = await t.request(
    "POST",
    `/api/domains/${domain}/releases/${r.id}/review`,
    {
      expectedVersion: r.version,
      descriptorHash: r.descriptorHash,
      evidence: "人工核对测试流程和测试模型输出",
      approved: true,
    },
    admin,
  );
  const ready = review.value;
  const active = await t.request(
    "POST",
    `/api/domains/${domain}/releases/${r.id}/activate`,
    {
      expectedVersion: ready.version,
      expectedEpoch: r.baseEpoch,
      expectedActive: r.baseActive,
      descriptorHash: r.descriptorHash,
    },
    admin,
  );
  if (active.status !== 200) throw new Error(JSON.stringify(active.value));
  return active.value;
}
