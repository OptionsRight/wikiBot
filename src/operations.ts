import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  Store,
  id,
  hash,
  requireThat,
  type Domain,
  type Grant,
} from "./core.js";
import { key, path, platform } from "./app.js";
import type { Answer } from "./answers.js";
import type { ModelState, Release } from "./publication.js";
import { stopAnswer, markModelImpact, type Notice } from "./governance.js";
export const recoveryProofSchema = z
  .object({
    domain: z.string(),
    nonce: z.string(),
    issuedAt: z.number(),
    evidenceId: z.string().min(10),
    active: z.object({ id: z.string(), descriptorHash: z.string() }).nullable(),
    grants: z.array(
      z.object({ subject: z.string(), role: z.enum(["member", "admin"]) }),
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
export function quarantine(store: Store) {
  store.tx(() => {
    for (const d of store.list<Domain>("domain"))
      store.put("domain", { ...d, maintenance: true, version: d.version + 1 });
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
}
export function registerOperations(
  app: FastifyInstance,
  store: Store,
  authority?: RecoveryAuthority,
) {
  app.get("/api/operations/status", async (request) => {
    platform(request.actor);
    const answers = store.list<Answer>("answer");
    return {
      domains: store.list<Domain>("domain").map((d) => ({
        id: d.id,
        maintenance: d.maintenance,
        active: d.active,
        epoch: d.epoch,
      })),
      jobs: {
        queued: answers.filter((a) => a.state === "queued").length,
        running: answers.filter((a) => a.state === "running").length,
        unknown: answers.filter(
          (a) => a.code.includes("UNKNOWN") || a.code.includes("UNCONFIRMED"),
        ).length,
      },
      deliveryUnknown: store
        .list<Notice>("notice")
        .filter((n) => n.state === "unknown").length,
    };
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
      {},
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
        for (const g of store.list<Grant>("grant", domain))
          store.put("grant", { ...g, enabled: false, version: g.version + 1 });
        for (const g of proof.grants) {
          const old = store.get<Grant>("grant", `${domain}:${g.subject}`);
          store.put<Grant>("grant", {
            id: `${domain}:${g.subject}`,
            domain,
            subject: g.subject,
            role: g.role,
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
