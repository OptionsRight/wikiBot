import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  Store,
  access,
  hash,
  id,
  version,
  requireThat,
  type Entity,
  type Domain,
  type Identity,
} from "./core.js";
import { body, path, key } from "./app.js";
import {
  bundleSchema,
  validateBundle,
  isV2,
  type Bundle,
} from "./procedures.js";
import { AssetStore } from "./knowledge/assets.js";
import { requireGroundingRelease } from "./knowledge/sidecars.js";
import { invalidateCandidates, stopAnswer } from "./governance.js";
import type { Answer } from "./answers.js";
import { requireEvaluation } from "./evaluations.js";
import {
  authorizeSourceUpload,
  validateSourceSubmission,
} from "./source-maintenance.js";

export interface Release extends Entity {
  publishedAt?: number;
  bundle: Bundle;
  descriptorHash: string;
  bundleHash: string;
  state:
    | "submitted"
    | "ready"
    | "active"
    | "retired"
    | "revoked"
    | "stale"
    | "rejected";
  baseEpoch: number;
  baseActive: string | null;
  reviewer?: string;
  reviewEvidence?: string;
  modelEpoch: number;
  answerStyle?: {
    sourceReleaseId: string;
    draftVersion: number;
    caseIds: string[];
  };
}
export function freezeReleaseClaims(store: Store, release: Release) {
  const { bundle, domain } = release;
  if (isV2(bundle))
    for (const claim of bundle.groundingManifest.claims)
      store.knowledgePut("release_claims", {
        id: hash([release.id, claim.versionId]),
        domain,
        version: 1,
        releaseId: release.id,
        claimVersionId: claim.versionId,
        snapshot: claim,
        evidence: bundle.groundingManifest.evidence.filter((e) =>
          claim.evidenceIds.includes(e.evidenceId),
        ),
        snapshotHash: hash(claim),
      });
}
export interface ModelState extends Entity {
  model: string;
  revision: string;
  qualified: boolean;
  epoch: number;
  evidence?: string;
}
export function modelState(
  store: Store,
  model: string,
  revision: string,
): ModelState {
  return (
    store.get<ModelState>("model", hash([model, revision])) ?? {
      id: hash([model, revision]),
      domain: "",
      version: 0,
      model,
      revision,
      qualified: false,
      epoch: 0,
    }
  );
}
export function currentRelease(
  store: Store,
  actor: Identity,
  domain: string,
): Release {
  access(store, actor, domain);
  const d = store.get<Domain>("domain", domain)!;
  requireThat(!d.maintenance, 503, "RECOVERY_VERIFICATION_REQUIRED");
  const release = d.active && store.get<Release>("release", d.active);
  requireThat(
    release && release.state === "active",
    503,
    "KNOWLEDGE_UNAVAILABLE",
  );
  return release;
}
export function allowedRelease(
  store: Store,
  actor: Identity,
  release: Release,
) {
  access(store, actor, release.domain);
  requireThat(
    !store.get<Domain>("domain", release.domain)!.maintenance,
    503,
    "RECOVERY_VERIFICATION_REQUIRED",
  );
  requireThat(
    ["active", "retired"].includes(
      store.get<Release>("release", release.id)?.state ?? "",
    ),
    410,
    "RELEASE_REVOKED",
  );
}
export function registerPublication(
  app: FastifyInstance,
  store: Store,
  assetRoot?: string,
) {
  const assets = assetRoot ? new AssetStore(assetRoot) : undefined;
  for (const kind of ["claims", "evidence"] as const)
    app.get(
      `/api/domains/:domain/releases/:id/${kind}/:itemId`,
      async (request) => {
        const domain = path(request, "domain");
        access(store, request.actor, domain);
        const r = store.get<Release>("release", path(request, "id"));
        requireThat(r?.domain === domain, 404, "NOT_FOUND");
        allowedRelease(store, request.actor, r);
        requireThat(isV2(r.bundle), 404, "NOT_FOUND");
        const itemId = path(request, "itemId");
        const item =
          kind === "claims"
            ? r.bundle.groundingManifest.claims.find(
                (c) => c.claimId === itemId || c.versionId === itemId,
              )
            : r.bundle.groundingManifest.evidence.find(
                (e) => e.evidenceId === itemId && e.visibility === "excerpt",
              );
        requireThat(item, 404, "NOT_FOUND");
        return item;
      },
    );
  app.get(
    "/api/domains/:domain/releases/:id/pages/:pageId",
    async (request) => {
      const domain = path(request, "domain");
      access(store, request.actor, domain);
      const release = store.get<Release>("release", path(request, "id"));
      requireThat(release?.domain === domain, 404, "NOT_FOUND");
      allowedRelease(store, request.actor, release);
      const page = release.bundle.pages.find(
        (p) => p.id === path(request, "pageId"),
      );
      requireThat(page, 404, "NOT_FOUND");
      return page;
    },
  );
  app.post("/api/domains/:domain/submissions", async (request, reply) => {
    const domain = path(request, "domain"),
      bundle = body(bundleSchema, request);
    const result = store.command(
      request.actor,
      domain,
      "submit",
      key(request),
      bundle,
      () => {
        if (store.get("grant", `${domain}:${request.actor.subject}`))
          access(store, request.actor, domain, true);
        else authorizeSourceUpload(store, request.actor, domain, bundle);
      },
      () => {
        validateBundle(bundle);
        if (isV2(bundle))
          requireGroundingRelease(store, assets, domain, bundle);
        validateSourceSubmission(store, domain, bundle);
        const d = store.get<Domain>("domain", domain)!;
        requireThat(!d.maintenance, 503, "RECOVERY_VERIFICATION_REQUIRED");
        const release = store.put<Release>("release", {
          id: id(),
          domain,
          version: 1,
          bundle,
          descriptorHash: hash(bundle),
          bundleHash: hash(bundle.pages),
          state: "submitted",
          baseEpoch: d.epoch,
          baseActive: d.active,
          modelEpoch: modelState(
            store,
            bundle.config.model,
            bundle.config.modelRevision,
          ).epoch,
        });
        freezeReleaseClaims(store, release);
        return release;
      },
    );
    return reply.code(201).send(result);
  });
  app.get("/api/domains/:domain/releases", async (request) => {
    const domain = path(request, "domain");
    access(store, request.actor, domain, true);
    return store.list<Release>("release", domain);
  });
  app.post("/api/domains/:domain/releases/:id/review", async (request) => {
    const domain = path(request, "domain"),
      rid = path(request, "id");
    const input = body(
      z
        .object({
          expectedVersion: z.number().int(),
          descriptorHash: z.string(),
          evidence: z.string().min(10).max(10000),
          approved: z.boolean(),
        })
        .strict(),
      request,
    );
    return store.command(
      request.actor,
      domain,
      `review:${rid}`,
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        const r = store.get<Release>("release", rid);
        requireThat(r?.domain === domain, 404, "NOT_FOUND");
        version(r, input.expectedVersion);
        requireThat(r.state === "submitted", 409, "INVALID_STATE");
        requireThat(
          r.descriptorHash === input.descriptorHash,
          409,
          "CONTENT_CHANGED",
        );
        const d = store.get<Domain>("domain", domain)!;
        requireThat(
          r.baseEpoch === d.epoch && r.baseActive === d.active,
          409,
          "BASELINE_STALE",
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
        if (input.approved) {
          if (isV2(r.bundle))
            requireGroundingRelease(store, assets, domain, r.bundle);
          requireEvaluation(store, r);
        }
        return store.put<Release>("release", {
          ...r,
          state: input.approved ? "ready" : "rejected",
          reviewer: request.actor.subject,
          reviewEvidence: input.evidence,
          version: r.version + 1,
        });
      },
    );
  });
  app.post("/api/domains/:domain/releases/:id/activate", async (request) => {
    const domain = path(request, "domain"),
      rid = path(request, "id");
    const input = body(
      z
        .object({
          expectedVersion: z.number().int(),
          expectedEpoch: z.number().int(),
          expectedActive: z.string().nullable(),
          descriptorHash: z.string(),
        })
        .strict(),
      request,
    );
    return store.command(
      request.actor,
      domain,
      `activate:${rid}`,
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        const r = store.get<Release>("release", rid);
        requireThat(r?.domain === domain, 404, "NOT_FOUND");
        version(r, input.expectedVersion);
        const d = store.get<Domain>("domain", domain)!;
        requireThat(!d.maintenance, 503, "RECOVERY_VERIFICATION_REQUIRED");
        requireThat(
          r.state === "ready" && r.descriptorHash === input.descriptorHash,
          409,
          "INVALID_STATE",
        );
        requireThat(
          d.epoch === input.expectedEpoch &&
            d.active === input.expectedActive &&
            r.baseEpoch === d.epoch &&
            r.baseActive === d.active,
          409,
          "BASELINE_STALE",
        );
        access(store, { subject: r.reviewer!, platform: false }, domain, true);
        if (isV2(r.bundle))
          requireGroundingRelease(store, assets, domain, r.bundle);
        requireEvaluation(store, r);
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
        if (d.active) {
          const previous = store.get<Release>("release", d.active)!;
          store.put("release", {
            ...previous,
            state: "retired",
            version: previous.version + 1,
          });
        }
        store.put("domain", {
          ...d,
          active: r.id,
          epoch: d.epoch + 1,
          version: d.version + 1,
        });
        for (const old of store.list<Release>("release", domain))
          if (old.id !== rid && ["submitted", "ready"].includes(old.state))
            store.put("release", {
              ...old,
              state: "stale",
              version: old.version + 1,
            });
        return store.put<Release>("release", {
          ...r,
          state: "active",
          publishedAt: Date.now(),
          version: r.version + 1,
        });
      },
    );
  });
  app.get("/api/domains/:domain/knowledge", async (request) => {
    const release = currentRelease(
      store,
      request.actor,
      path(request, "domain"),
    );
    return {
      release: { id: release.id, descriptorHash: release.descriptorHash },
      pages: release.bundle.pages,
    };
  });
  app.post("/api/domains/:domain/releases/:id/revoke", async (request) => {
    const domain = path(request, "domain"),
      rid = path(request, "id");
    const input = body(
      z
        .object({
          expectedVersion: z.number().int(),
          expectedEpoch: z.number().int(),
          expectedActive: z.string().nullable(),
          descriptorHash: z.string(),
          reason: z.string().min(10).max(2000),
        })
        .strict(),
      request,
    );
    return store.command(
      request.actor,
      domain,
      `revoke:${rid}`,
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        const r = store.get<Release>("release", rid),
          d = store.get<Domain>("domain", domain)!;
        requireThat(r?.domain === domain, 404, "NOT_FOUND");
        version(r, input.expectedVersion);
        requireThat(
          r.descriptorHash === input.descriptorHash &&
            ["active", "retired"].includes(r.state),
          409,
          "INVALID_STATE",
        );
        requireThat(
          d.epoch === input.expectedEpoch && d.active === input.expectedActive,
          409,
          "BASELINE_STALE",
        );
        store.put("domain", {
          ...d,
          active: d.active === rid ? null : d.active,
          epoch: d.epoch + 1,
          version: d.version + 1,
        });
        invalidateCandidates(store, domain);
        for (const a of store
          .list<Answer>("answer", domain)
          .filter((a) => a.releaseId === rid))
          stopAnswer(store, a, "RELEASE_REVOKED", "invalid");
        return store.put<Release>("release", {
          ...r,
          state: "revoked",
          version: r.version + 1,
        });
      },
    );
  });
  // Rollback is a new candidate: it must go through current evaluation and approval.
  app.post(
    "/api/domains/:domain/releases/:id/rollback-candidate",
    async (request, reply) => {
      const domain = path(request, "domain"),
        rid = path(request, "id");
      const input = body(
        z
          .object({
            expectedEpoch: z.number().int(),
            expectedActive: z.string().nullable(),
            descriptorHash: z.string(),
            reason: z.string().min(10).max(2000),
          })
          .strict(),
        request,
      );
      const result = store.command(
        request.actor,
        domain,
        `rollback:${rid}`,
        key(request),
        input,
        () => access(store, request.actor, domain, true),
        () => {
          const r = store.get<Release>("release", rid),
            d = store.get<Domain>("domain", domain)!;
          requireThat(r?.domain === domain, 404, "NOT_FOUND");
          requireThat(
            r.state === "retired" && r.descriptorHash === input.descriptorHash,
            409,
            "INVALID_ROLLBACK_TARGET",
          );
          requireThat(!d.maintenance, 503, "RECOVERY_VERIFICATION_REQUIRED");
          requireThat(
            d.epoch === input.expectedEpoch &&
              d.active === input.expectedActive,
            409,
            "BASELINE_STALE",
          );
          const m = modelState(
            store,
            r.bundle.config.model,
            r.bundle.config.modelRevision,
          );
          requireThat(m.qualified, 503, "MODEL_REVALIDATION_REQUIRED");
          const candidate = store.put<Release>("release", {
            id: id(),
            domain,
            version: 1,
            bundle: r.bundle,
            descriptorHash: r.descriptorHash,
            bundleHash: r.bundleHash,
            state: "submitted",
            baseEpoch: d.epoch,
            baseActive: d.active,
            modelEpoch: m.epoch,
          });
          freezeReleaseClaims(store, candidate);
          return candidate;
        },
      );
      return reply.code(201).send(result);
    },
  );
}
