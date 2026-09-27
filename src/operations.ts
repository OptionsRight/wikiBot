import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  Store,
  id,
  hash,
  requireThat,
  type Domain,
  type Entity,
  type Grant,
} from "./core.js";
import { body, key, path, platform } from "./app.js";
import type { Answer } from "./answers.js";
import type { Revision } from "./revisions.js";
import { recoverEvaluations } from "./evaluations.js";
import { modelState, type ModelState, type Release } from "./publication.js";
import { stopAnswer, markModelImpact, type Notice } from "./governance.js";
export const recoveryProofSchema = z
  .object({
    domain: z.string(),
    nonce: z.string(),
    issuedAt: z.number(),
    evidenceId: z.string().min(10),
    active: z.object({ id: z.string(), descriptorHash: z.string() }).nullable(),
    grants: z.array(
      z.object({
        subject: z.string(),
        role: z.enum(["member", "admin"]),
        tags: z
          .array(z.enum(["business", "technical"]))
          .max(2)
          .optional(),
      }),
    ),
    models: z.array(
      z.object({
        model: z.string(),
        revision: z.string(),
        epoch: z.number().int().nonnegative(),
        qualified: z.boolean(),
      }),
    ),
  })
  .strict();
export type RecoveryAuthority = (
  domain: string,
  nonce: string,
) => Promise<z.infer<typeof recoveryProofSchema>>;
interface RecoveryRecord extends Entity {
  cycleId: string;
  quarantinedAt: number;
  baseline: { active: string | null; epoch: number };
  historicalDelivery: {
    answerId: string;
    deliveredThrough: number;
    exposedThrough: number;
  }[];
  openedAt?: number;
  evidenceId?: string;
  confirmedBy?: string;
  grantCount?: number;
  grantsHash?: string;
  active?: { id: string; descriptorHash: string } | null;
  models?: z.infer<typeof recoveryProofSchema>["models"];
}
export function quarantine(store: Store) {
  store.tx(() => {
    for (const d of store.list<Domain>("domain")) {
      const existing = store.get<RecoveryRecord>("recovery", d.id);
      if (existing?.openedAt)
        store.put<RecoveryRecord>("recovery-history", {
          ...existing,
          id: existing.cycleId,
        });
      if (!existing || existing.openedAt)
        store.put<RecoveryRecord>("recovery", {
          id: d.id,
          domain: d.id,
          version: (existing?.version ?? 0) + 1,
          cycleId: id(),
          quarantinedAt: Date.now(),
          baseline: { active: d.active, epoch: d.epoch },
          historicalDelivery: store.list<Answer>("answer", d.id).map((a) => ({
            answerId: a.id,
            deliveredThrough: a.deliveredThrough,
            exposedThrough: a.exposedThrough,
          })),
        });
      store.put("domain", { ...d, maintenance: true, version: d.version + 1 });
    }
    for (const a of store.list<Answer>("answer"))
      stopAnswer(
        store,
        { ...a, deliveredThrough: 0, exposedThrough: 0 },
        "RECOVERY_EXECUTION_UNCONFIRMED",
        a.review === "invalid" ? "invalid" : "pending",
      );
    for (const n of store.list<Notice>("notice"))
      if (["pending", "failed", "unknown"].includes(n.state))
        store.put("notice", {
          ...n,
          state: "unknown",
          retryable: false,
          code: "RECOVERY_EXECUTION_UNCONFIRMED",
          version: n.version + 1,
        });
  });
  recoverEvaluations(store, true);
}
export interface OperationalRetention {
  eventRetentionMs: number;
  policyId: string;
}
export function registerOperations(
  app: FastifyInstance,
  store: Store,
  authority?: RecoveryAuthority,
  retention?: OperationalRetention,
) {
  if (retention)
    z.object({
      eventRetentionMs: z.number().int().positive(),
      policyId: z.string().min(1).max(200),
    })
      .strict()
      .parse(retention);
  app.post("/api/operations/cleanup", async (request) => {
    platform(request.actor);
    body(z.object({}).strict(), request);
    requireThat(retention, 503, "RETENTION_POLICY_REQUIRED");
    return store.command(
      request.actor,
      "",
      "operational-cleanup",
      key(request),
      retention,
      () => platform(request.actor),
      () => {
        const now = Date.now();
        return {
          ...store.cleanupOperationalData(
            now - retention.eventRetentionMs,
            now,
          ),
          policyId: retention.policyId,
          eventCutoff: now - retention.eventRetentionMs,
        };
      },
    );
  });
  app.get("/api/operations/status", async (request) => {
    platform(request.actor);
    const answers = store.list<Answer>("answer");
    const now = Date.now();
    const stalled = answers.filter(
      (a) =>
        ["queued", "running"].includes(a.state) &&
        (a.deadline <= now ||
          (a.state === "running" && (!a.leaseUntil || a.leaseUntil <= now))),
    );
    const notices = store.list<Notice>("notice");
    const unknownDeliveries = [
      ...notices
        .filter((n) => n.state === "unknown")
        .map((n) => ({
          id: n.id,
          domain: n.domain,
          kind: "notice",
          code: n.code,
        })),
      ...store
        .list<Entity & { state: string; code?: string }>("inbox")
        .filter((r) => r.state === "unknown")
        .map((r) => ({
          id: r.id,
          domain: r.domain,
          kind: "inbox",
          code: r.code,
        })),
    ];
    const sourceIssues = store
      .list<Revision>("revision")
      .filter(
        (r) =>
          r.maintenance &&
          (["conflict", "recovery_required"].includes(r.maintenance.state) ||
            (r.maintenance.state === "writing" &&
              r.maintenance.expiresAt <= now)),
      )
      .map((r) => ({
        id: r.id,
        domain: r.domain,
        state: r.maintenance!.state,
        code:
          r.maintenance!.state === "conflict"
            ? "SOURCE_CONFLICT"
            : "SOURCE_RECOVERY_REQUIRED",
      }));
    const events = store.operationalEvents(now - 15 * 60 * 1000);
    const alerts = [
      ...["SOURCE_CONFLICT", "SOURCE_RECOVERY_REQUIRED"].flatMap((code) => {
        const count = sourceIssues.filter((r) => r.code === code).length;
        return count ? [{ code, count }] : [];
      }),
      ...(stalled.length
        ? [{ code: "JOBS_STALLED", count: stalled.length }]
        : []),
      ...(unknownDeliveries.length
        ? [
            {
              code: "DELIVERY_UNKNOWN",
              count: unknownDeliveries.length,
            },
          ]
        : []),
      ...(events.some((e) => e.status === 401 || e.status === 403)
        ? [
            {
              code: "ACCESS_REJECTED",
              count: events.filter((e) => e.status === 401 || e.status === 403)
                .length,
            },
          ]
        : []),
      ...(events.some((e) => e.code === "RELEASE_REVOKED")
        ? [
            {
              code: "REVOKED_CONTENT_SUPPRESSED",
              count: events.filter((e) => e.code === "RELEASE_REVOKED").length,
            },
          ]
        : []),
    ];
    return {
      observedAt: now,
      recoveries: store.list<RecoveryRecord>("recovery"),
      recoveryHistory: store.list<RecoveryRecord>("recovery-history"),
      unknownDeliveries,
      sourceIssues,
      eventWindow: { since: now - 15 * 60 * 1000, limit: 200 },
      alerts,
      stalledJobs: stalled.map((a) => ({
        id: a.id,
        domain: a.domain,
        state: a.state,
        deadline: a.deadline,
        leaseUntil: a.leaseUntil,
      })),
      domains: store.list<Domain>("domain").map((d) => ({
        id: d.id,
        maintenance: d.maintenance,
        active: d.active,
        epoch: d.epoch,
        readiness: domainReadiness(store, d),
      })),
      jobs: {
        queued: answers.filter((a) => a.state === "queued").length,
        running: answers.filter((a) => a.state === "running").length,
        unknown: answers.filter(
          (a) => a.code.includes("UNKNOWN") || a.code.includes("UNCONFIRMED"),
        ).length,
      },
      deliveryUnknown: unknownDeliveries.length,
    };
  });
  app.get("/api/operations/events", async (request) => {
    platform(request.actor);
    return store.operationalEvents();
  });
  app.post("/api/operations/recover/:domain", async (request) => {
    platform(request.actor);
    const domain = path(request, "domain"),
      nonce = id();
    requireThat(authority, 503, "INDEPENDENT_AUTHORITY_REQUIRED");
    const proof = recoveryProofSchema.parse(await authority(domain, nonce));
    requireThat(
      proof.domain === domain &&
        proof.nonce === nonce &&
        Math.abs(Date.now() - proof.issuedAt) < 60000,
      409,
      "STALE_RECOVERY_PROOF",
    );
    return store.command(
      request.actor,
      domain,
      "recover",
      key(request),
      { cycleId: store.get<RecoveryRecord>("recovery", domain)?.cycleId },
      () => platform(request.actor),
      () => {
        const d = store.get<Domain>("domain", domain);
        requireThat(d?.maintenance, 409, "NOT_IN_RECOVERY");
        const active = proof.active
          ? store.get<Release>("release", proof.active.id)
          : undefined;
        if (proof.active)
          requireThat(
            active?.domain === domain &&
              active.descriptorHash === proof.active.descriptorHash &&
              active.state !== "revoked",
            409,
            "TRUSTED_RELEASE_MISSING",
          );
        if (active)
          requireThat(
            hash(active.bundle) === active.descriptorHash &&
              hash(active.bundle.pages) === active.bundleHash,
            409,
            "RESTORED_BUNDLE_CORRUPT",
          );
        for (const g of store.list<Grant>("grant", domain))
          store.put("grant", { ...g, enabled: false, version: g.version + 1 });
        for (const g of proof.grants) {
          const old = store.get<Grant>("grant", `${domain}:${g.subject}`);
          store.put<Grant>("grant", {
            id: `${domain}:${g.subject}`,
            domain,
            subject: g.subject,
            role: g.role,
            tags: g.tags ?? [],
            enabled: true,
            version: (old?.version ?? 0) + 1,
          });
        }
        // A proof's model entries apply only to this domain's restored service. Never lower a known epoch.
        for (const m of proof.models) {
          const old = store.get<ModelState>(
            "model",
            hash([m.model, m.revision]),
          );
          requireThat(!old || old.epoch <= m.epoch, 409, "MODEL_PROOF_STALE");
          if (old && (old.epoch !== m.epoch || (old.qualified && !m.qualified)))
            markModelImpact(store, m.model, m.revision);
          store.put<ModelState>("model", {
            id: hash([m.model, m.revision]),
            domain: "",
            ...m,
            version: (old?.version ?? 0) + 1,
            evidence: proof.evidenceId,
          });
        }
        if (active) {
          const m = proof.models.find(
            (m) =>
              m.model === active.bundle.config.model &&
              m.revision === active.bundle.config.modelRevision,
          );
          requireThat(
            m?.qualified && m.epoch === active.modelEpoch,
            409,
            "MODEL_REVALIDATION_REQUIRED",
          );
        }
        for (const r of store.list<Release>("release", domain))
          store.put("release", {
            ...r,
            state: r.id === active?.id ? "active" : "revoked",
            version: r.version + 1,
          });
        store.put("domain", {
          ...d,
          active: active?.id ?? null,
          epoch: d.epoch + 1,
          maintenance: false,
          version: d.version + 1,
        });
        const record = store.get<RecoveryRecord>("recovery", domain);
        requireThat(record, 409, "RECOVERY_RECORD_MISSING");
        store.put<RecoveryRecord>("recovery", {
          ...record,
          version: record.version + 1,
          openedAt: Date.now(),
          evidenceId: proof.evidenceId,
          confirmedBy: request.actor.subject,
          grantCount: proof.grants.length,
          grantsHash: hash(proof.grants),
          active: proof.active,
          models: proof.models,
        });
        return {
          id: domain,
          evidenceId: proof.evidenceId,
          openedAt: Date.now(),
          active: active?.id ?? null,
          historicalDelivery: "unconfirmed",
        };
      },
    );
  });
}

function domainReadiness(store: Store, domain: Domain) {
  if (domain.maintenance) return "RECOVERY_VERIFICATION_REQUIRED";
  const release = domain.active
    ? store.get<Release>("release", domain.active)
    : undefined;
  if (!release || release.state !== "active") return "KNOWLEDGE_UNAVAILABLE";
  if (
    hash(release.bundle) !== release.descriptorHash ||
    hash(release.bundle.pages) !== release.bundleHash
  )
    return "RESTORED_BUNDLE_CORRUPT";
  const model = modelState(
    store,
    release.bundle.config.model,
    release.bundle.config.modelRevision,
  );
  return model.qualified && model.epoch === release.modelEpoch
    ? "ready"
    : "MODEL_REVALIDATION_REQUIRED";
}
