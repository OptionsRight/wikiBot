import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Store, requireThat, access, id, Fault, type Entity } from "./core.js";
import { body, key, path } from "./app.js";
import { modelState, type Release } from "./publication.js";
import { guidance } from "./procedures.js";
import { explain } from "./explanation.js";
import type { ModelGateway } from "./adapters/model.js";
export interface Evaluation extends Entity {
  releaseId: string;
  descriptorHash: string;
  modelEpoch: number;
  caseId: string;
  state: "running" | "complete" | "failed";
  output?: unknown;
  code?: string;
}
export function requireEvaluation(store: Store, r: Release) {
  const runs = store.list<Evaluation>("evaluation", r.domain);
  requireThat(
    r.bundle.cases.every((c) =>
      runs.some(
        (e) =>
          e.releaseId === r.id &&
          e.descriptorHash === r.descriptorHash &&
          e.modelEpoch === r.modelEpoch &&
          e.caseId === c.id &&
          e.state === "complete",
      ),
    ),
    409,
    "EVALUATION_REQUIRED",
  );
}
export function registerEvaluations(
  app: FastifyInstance,
  store: Store,
  model?: ModelGateway,
) {
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
        });
      },
    );
    if (!execute) return store.get<Evaluation>("evaluation", run.id)!;
    let output: unknown, code: string | undefined;
    try {
      const r = store.get<Release>("release", rid)!,
        c = r.bundle.cases.find((c) => c.id === input.caseId)!,
        p = r.bundle.procedures.find((p) => p.id === c.procedureId)!;
      const selected = guidance(p, c.inputs);
      if (selected.code === "GUIDANCE") {
        requireThat(model, 503, "MODEL_UNAVAILABLE");
        output = await explain(
          model,
          r.bundle,
          {
            question: c.question,
            pageId: p.pageId,
            checklist: selected.nodes,
            style: "business",
            depth: "beginner",
          },
          AbortSignal.timeout(10000),
        );
      } else output = selected;
    } catch (error) {
      code = error instanceof Fault ? error.code : "EVALUATION_FAILED";
    }
    return store.tx(() => {
      access(store, request.actor, domain, true);
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
        output,
        version: 2,
      });
    });
  });
}
