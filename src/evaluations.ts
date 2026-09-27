import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Store, requireThat, access, id, Fault, type Entity } from "./core.js";
import { body, key, path } from "./app.js";
import { modelState, type Release } from "./publication.js";
import { retrieve } from "./retrieval.js";
import { generateAnswer } from "./explanation.js";
import type { ModelGateway } from "./adapters/model.js";
export interface Evaluation extends Entity {
  releaseId: string;
  descriptorHash: string;
  modelEpoch: number;
  caseId: string;
  state: "running" | "complete" | "failed";
  verdict?: "pass" | "fail";
  failures?: string[];
  humanReview: "required";
  output?: unknown;
  code?: string;
  attempt?: number;
  deadline?: number;
  lease?: string;
}
export function requireEvaluation(store: Store, r: Release) {
  const runs = store.list<Evaluation>("evaluation", r.domain);
  if (r.bundle.config.answerTemplates) {
    requireThat(
      ["business", "technical"].every((style) =>
        ["beginner", "experienced"].every((depth) =>
          r.bundle.cases.some(
            (c) =>
              (c.style ?? "business") === style &&
              (c.depth ?? "beginner") === depth &&
              (c.expectedOutcome ?? "answer") === "answer",
          ),
        ),
      ),
      409,
      "TEMPLATE_EVALUATION_COVERAGE_REQUIRED",
    );
  }
  requireThat(
    r.bundle.cases.every((c) => {
      const latest = runs
        .filter(
          (e) =>
            e.releaseId === r.id &&
            e.descriptorHash === r.descriptorHash &&
            e.modelEpoch === r.modelEpoch &&
            e.caseId === c.id,
        )
        .sort((a, b) => (b.attempt ?? 0) - (a.attempt ?? 0))[0];
      return latest?.state === "complete" && latest.verdict === "pass";
    }),
    409,
    "EVALUATION_REQUIRED",
  );
}
/** Recovery fence: force=true is for an independently verified restore boundary. */
export function recoverEvaluations(store: Store, force = false) {
  store.tx(() => {
    for (const run of store.list<Evaluation>("evaluation")) {
      if (
        run.state !== "running" ||
        (!force && run.deadline && run.deadline > Date.now())
      )
        continue;
      store.put<Evaluation>("evaluation", {
        ...run,
        state: "failed",
        code: "EXECUTION_UNKNOWN",
        verdict: undefined,
        lease: undefined,
        version: run.version + 1,
      });
    }
  });
}
export function registerEvaluations(
  app: FastifyInstance,
  store: Store,
  model?: ModelGateway,
) {
  recoverEvaluations(store);
  const timer = setInterval(() => recoverEvaluations(store), 1000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
  app.get("/api/domains/:domain/releases/:id/evaluations", async (request) => {
    const domain = path(request, "domain");
    access(store, request.actor, domain, true);
    return store
      .list<Evaluation>("evaluation", domain)
      .filter((e) => e.releaseId === path(request, "id"));
  });
  app.post("/api/domains/:domain/releases/:id/evaluations", async (request) => {
    const domain = path(request, "domain"),
      rid = path(request, "id"),
      input = body(
        z.object({ caseId: z.string(), descriptorHash: z.string() }).strict(),
        request,
      );
    let execute = false;
    const run = store.command(
      request.actor,
      domain,
      `evaluate:${rid}`,
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        const r = store.get<Release>("release", rid);
        requireThat(r?.domain === domain, 404, "NOT_FOUND");
        requireThat(
          r.state === "submitted" && r.descriptorHash === input.descriptorHash,
          409,
          "INVALID_STATE",
        );
        const m = modelState(
          store,
          r.bundle.config.model,
          r.bundle.config.modelRevision,
        );
        requireThat(
          m.qualified && m.epoch === r.modelEpoch,
          503,
          "MODEL_REVALIDATION_REQUIRED",
        );
        requireThat(
          r.bundle.cases.some((c) => c.id === input.caseId),
          404,
          "NOT_FOUND",
        );
        const timeoutMs = Number(process.env.EVALUATION_TIMEOUT_MS ?? 60000);
        requireThat(
          Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000,
          400,
          "INVALID_EVALUATION_TIMEOUT",
        );
        execute = true;
        return store.put<Evaluation>("evaluation", {
          id: id(),
          domain,
          version: 1,
          releaseId: rid,
          descriptorHash: r.descriptorHash,
          modelEpoch: r.modelEpoch,
          caseId: input.caseId,
          state: "running",
          attempt:
            1 +
            Math.max(
              0,
              ...store
                .list<Evaluation>("evaluation", domain)
                .filter((e) => e.releaseId === rid && e.caseId === input.caseId)
                .map((e) => e.attempt ?? 0),
            ),
          deadline: Date.now() + timeoutMs,
          lease: id(),
          humanReview: "required",
        });
      },
    );
    if (!execute) return store.get<Evaluation>("evaluation", run.id)!;
    let output: unknown, code: string | undefined;
    const failures: string[] = [];
    try {
      const r = store.get<Release>("release", rid)!,
        c = r.bundle.cases.find((c) => c.id === input.caseId)!;
      const pages = retrieve(r.bundle, c.question);
      if (pages.length) {
        requireThat(model, 503, "MODEL_UNAVAILABLE");
        const controller = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(new Fault(504, "EVALUATION_TIMEOUT"));
            },
            Math.max(1, run.deadline! - Date.now()),
          );
        });
        let generated;
        try {
          generated = await Promise.race([
            generateAnswer(
              model,
              {
                modelId: r.bundle.config.model,
                config: r.bundle.config,
                question: c.question,
                pages,
                style: c.style ?? "business",
                depth: c.depth ?? "beginner",
              },
              controller.signal,
            ),
            deadline,
          ]);
        } finally {
          clearTimeout(timer);
        }
        const { answer, metrics } = generated;
        const expected = c.expectedCitations;
        const outcome = answer.outcome ?? "answer";
        if ((c.expectedOutcome ?? "answer") !== outcome)
          failures.push(
            c.expectedOutcome === "knowledge_gap"
              ? "EXPECTED_KNOWLEDGE_GAP"
              : "EXPECTED_ANSWER",
          );
        if ((c.expectedOutcome ?? "answer") === "answer") {
          if (!expected?.length) failures.push("MISSING_EXPECTATIONS");
          else if (!expected.every((id) => answer.citations.includes(id)))
            failures.push("MISSING_EXPECTED_CITATION");
        }
        output = {
          answer,
          metrics,
          retrieved: pages.map(({ page }) => page.id),
          expectedCitations: c.expectedCitations ?? null,
        };
      } else {
        if (c.expectedOutcome !== "knowledge_gap")
          failures.push("EXPECTED_ANSWER");
        output = {
          code: "KNOWLEDGE_COVERAGE_GAP",
          expectedCitations: c.expectedCitations ?? null,
        };
      }
    } catch (error) {
      code = error instanceof Fault ? error.code : "EVALUATION_FAILED";
    }
    const settled = store.tx(() => {
      const latest = store.get<Evaluation>("evaluation", run.id)!;
      if (
        latest.state !== "running" ||
        latest.version !== run.version ||
        latest.lease !== run.lease
      )
        return latest;
      try {
        access(store, request.actor, domain, true);
      } catch {
        code = "EVALUATION_ACCESS_REVOKED";
      }
      if (Date.now() >= run.deadline!) code = "EVALUATION_TIMEOUT";
      const r = store.get<Release>("release", rid)!;
      const m = modelState(
        store,
        r.bundle.config.model,
        r.bundle.config.modelRevision,
      );
      if (r.state !== "submitted" || !m.qualified || m.epoch !== run.modelEpoch)
        code = "EVALUATION_STALE";
      return store.put<Evaluation>("evaluation", {
        ...run,
        state: code ? "failed" : "complete",
        code,
        verdict: code ? undefined : failures.length ? "fail" : "pass",
        failures,
        output,
        lease: undefined,
        version: run.version + 1,
      });
    });
    access(store, request.actor, domain, true);
    return settled;
  });
}
