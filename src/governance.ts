import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  Store,
  hash,
  id,
  access,
  requireThat,
  type Entity,
  type Identity,
  type Domain,
} from "./core.js";
import { body, key, path, platform } from "./app.js";
import { modelState, type ModelState, type Release } from "./publication.js";
import type { Answer } from "./answers.js";

export interface Notice extends Entity {
  owner: string;
  objectId: string;
  kind: string;
  state: "pending" | "acked" | "failed" | "unknown";
  createdAt: number;
}
export function notice(
  store: Store,
  domain: string,
  owner: string,
  kind: string,
  objectId: string,
) {
  return store.put<Notice>("notice", {
    id: id(),
    domain,
    owner,
    kind,
    objectId,
    state: "pending",
    createdAt: Date.now(),
    version: 1,
  });
}
export function stopAnswer(
  store: Store,
  a: Answer,
  code: string,
  review: Answer["review"],
) {
  store.put<Answer>("answer", {
    ...a,
    review,
    reviewReason: code,
    code: ["queued", "running"].includes(a.state) ? code : a.code,
    state: ["queued", "running"].includes(a.state)
      ? a.blocks.length
        ? "incomplete"
        : "failed"
      : a.state,
    lease: undefined,
    finishedAt: a.finishedAt ?? Date.now(),
    version: a.version + 1,
  });
  notice(store, a.domain, a.owner, code, a.id);
}
export function invalidateCandidates(store: Store, domain: string) {
  for (const r of store.list<Release>("release", domain))
    if (["submitted", "ready"].includes(r.state))
      store.put("release", { ...r, state: "stale", version: r.version + 1 });
}
export function markModelImpact(store: Store, model: string, revision: string) {
  const impacted = store
    .list<Release>("release")
    .filter(
      (r) =>
        r.bundle.config.model === model &&
        r.bundle.config.modelRevision === revision,
    );
  for (const r of impacted) {
    if (["submitted", "ready"].includes(r.state))
      store.put("release", { ...r, state: "stale", version: r.version + 1 });
    for (const a of store
      .list<Answer>("answer", r.domain)
      .filter((a) => a.releaseId === r.id && a.review !== "invalid"))
      stopAnswer(store, a, "MODEL_REVALIDATION_REQUIRED", "pending");
  }
}
export function registerGovernance(app: FastifyInstance, store: Store) {
  app.post("/api/models/change", async (request) => {
    const input = body(
      z
        .object({
          model: z.string().min(1).max(200),
          revision: z.string().min(1).max(200),
          expectedEpoch: z.number().int().nonnegative(),
          reason: z.string().min(10).max(2000),
        })
        .strict(),
      request,
    );
    return store.command(
      request.actor,
      "",
      "model-change",
      key(request),
      input,
      () => platform(request.actor),
      () => {
        const m = modelState(store, input.model, input.revision);
        requireThat(m.epoch === input.expectedEpoch, 409, "VERSION_CONFLICT");
        const result = store.put<ModelState>("model", {
          ...m,
          qualified: false,
          epoch: m.epoch + 1,
          version: m.version + 1,
          evidence: input.reason,
        });
        // No time cutoff is inferred: all answers from this deployment are conservatively affected.
        markModelImpact(store, m.model, m.revision);
        return result;
      },
    );
  });
  app.post("/api/models/qualify", async (request) => {
    const input = body(
      z
        .object({
          model: z.string().min(1).max(200),
          revision: z.string().min(1).max(200),
          expectedEpoch: z.number().int().nonnegative(),
          evidence: z.string().min(10).max(10000),
        })
        .strict(),
      request,
    );
    return store.command(
      request.actor,
      "",
      "model-qualify",
      key(request),
      input,
      () => platform(request.actor),
      () => {
        const m = modelState(store, input.model, input.revision);
        requireThat(m.epoch === input.expectedEpoch, 409, "VERSION_CONFLICT");
        return store.put<ModelState>("model", {
          ...m,
          qualified: true,
          version: m.version + 1,
          evidence: input.evidence,
        });
      },
    );
  });
  app.get("/api/domains/:domain/notices", async (request) => {
    const domain = path(request, "domain");
    access(store, request.actor, domain);
    return store
      .list<Notice>("notice", domain)
      .filter((n) => n.owner === request.actor.subject);
  });
  app.post("/api/domains/:domain/answers/:id/invalidate", async (request) => {
    const domain = path(request, "domain"),
      aid = path(request, "id");
    const input = body(
      z
        .object({
          expectedVersion: z.number().int(),
          reason: z.string().min(10).max(2000),
        })
        .strict(),
      request,
    );
    return store.command(
      request.actor,
      domain,
      `invalidate:${aid}`,
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        const a = store.get<Answer>("answer", aid);
        requireThat(a?.domain === domain, 404, "NOT_FOUND");
        requireThat(
          a.version === input.expectedVersion,
          409,
          "VERSION_CONFLICT",
        );
        stopAnswer(store, a, input.reason, "invalid");
        return { id: aid, review: "invalid" };
      },
    );
  });
}
