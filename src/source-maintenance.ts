import type { FastifyInstance } from "fastify";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  access,
  hash,
  id,
  requireThat,
  version,
  type Store,
  type Entity,
  type Identity,
  type Domain,
} from "./core.js";
import { body, path, key, subjectName } from "./app.js";
import type { Revision } from "./revisions.js";
import type { Bundle } from "./procedures.js";
import type { Release } from "./publication.js";
import {
  validateSourceArtifacts,
  staticSourceTypes,
  type SourceArtifact,
} from "./source-artifacts.js";
import { validateSourceLinks } from "./source-formats.js";

export interface SourceWorkspace extends Entity {
  root: string;
  helperSubject: string;
  enabled: boolean;
  approvedAttachmentTypes: string[];
  administrator: string;
  adapter: { kind: "manual" | "isolated-markdown"; version: string };
  bindingHash: string;
  window?: { until: number; evidence: string; administrator: string };
}
export interface SourceMaintenance {
  state: "claimed" | "writing" | "applied" | "conflict" | "recovery_required";
  workspaceVersion: number;
  bindingHash: string;
  domainEpoch: number;
  helperSubject: string;
  leaseId: string;
  expiresAt: number;
  evidence?: string;
  journalHash?: string;
}
function workspace(store: Store, domain: string) {
  const w = store.get<SourceWorkspace>("source-workspace", domain);
  requireThat(w?.enabled, 403, "SOURCE_WORKSPACE_DISABLED");
  // Pairing does not survive revocation of the administrator who authorized it.
  access(store, { subject: w.administrator, platform: false }, domain, true);
  return w;
}
function helper(store: Store, actor: Identity, domain: string) {
  const w = workspace(store, domain);
  requireThat(
    w.helperSubject === actor.subject,
    403,
    "SOURCE_HELPER_FORBIDDEN",
  );
  return w;
}
function windowOpen(store: Store, w: SourceWorkspace) {
  requireThat(
    w.window && w.window.until > Date.now(),
    409,
    "MAINTENANCE_WINDOW_REQUIRED",
  );
  access(
    store,
    { subject: w.window.administrator, platform: false },
    w.domain,
    true,
  );
}
function revision(store: Store, domain: string, rid: string) {
  const r = store.get<Revision>("revision", rid);
  requireThat(r?.domain === domain, 404, "NOT_FOUND");
  return r;
}
function baseline(store: Store, r: Revision) {
  const d = store.get<Domain>("domain", r.domain);
  const active = d?.active && store.get<Release>("release", d.active);
  requireThat(
    active &&
      active.state === "active" &&
      active.id === r.baseReleaseId &&
      active.descriptorHash === r.baseDescriptorHash,
    409,
    "SOURCE_BASELINE_CONFLICT",
  );
}
export function sourceLease(
  store: Store,
  actor: Identity,
  domain: string,
  rid: string,
  leaseId: string,
) {
  const w = helper(store, actor, domain),
    r = revision(store, domain, rid),
    m = r.maintenance;
  windowOpen(store, w);
  requireThat(
    m &&
      m.leaseId === leaseId &&
      m.helperSubject === actor.subject &&
      m.bindingHash === w.bindingHash &&
      m.workspaceVersion === w.version,
    409,
    "SOURCE_LEASE_MISMATCH",
  );
  requireThat(m.expiresAt > Date.now(), 409, "SOURCE_LEASE_EXPIRED");
  requireThat(
    m.domainEpoch === store.get<Domain>("domain", domain)!.epoch,
    409,
    "SOURCE_RECOVERY_REQUIRED",
  );
  baseline(store, r);
  return { w, r, m };
}
// Publication should call this for helpers, keeping its existing candidate transaction.
// No member/admin grant is issued to a helper; evaluation/review/activation stay admin-only.
export function authorizeSourceUpload(
  store: Store,
  actor: Identity,
  domain: string,
  bundle: Bundle,
) {
  helper(store, actor, domain);
  const matches = store
    .list<Revision>("revision", domain)
    .filter(
      (r) =>
        r.state === "sync_pending" &&
        r.maintenance?.helperSubject === actor.subject &&
        r.maintenance.state === "applied",
    );
  requireThat(matches.length === 1, 409, "SOURCE_UPLOAD_NOT_READY");
  const r = matches[0]!;
  sourceLease(store, actor, domain, r.id, r.maintenance!.leaseId);
  requireThat(
    r.changes.every((c) =>
      bundle.pages.some((p) => p.id === c.pageId && p.hash === hash(c.content)),
    ),
    409,
    "SNAPSHOT_MISMATCH",
  );
  const original = store.get<Release>("release", r.baseReleaseId)!;
  requireThat(
    bundle.pages.length === original.bundle.pages.length &&
      original.bundle.pages.every((p) =>
        bundle.pages.some(
          (next) =>
            next.id === p.id &&
            next.hash ===
              hash(
                r.changes.find((c) => c.pageId === p.id)?.content ?? p.content,
              ),
        ),
      ),
    409,
    "SOURCE_UPLOAD_SCOPE_EXCEEDED",
  );
  requireThat(
    hash(bundle.config) === hash(original.bundle.config) &&
      hash(bundle.cases) === hash(original.bundle.cases) &&
      hash(bundle.sourceArtifacts ?? []) ===
        hash(original.bundle.sourceArtifacts ?? []),
    409,
    "SOURCE_UPLOAD_SCOPE_EXCEEDED",
  );
  return r;
}
export function validateSourceSubmission(
  store: Store,
  domain: string,
  bundle: Bundle & { sourceArtifacts?: SourceArtifact[] },
) {
  validateSourceLinks(
    bundle.pages,
    (bundle.sourceArtifacts ?? []).map((a) => a.path),
  );
  if (!bundle.sourceArtifacts) return;
  const w = store.get<SourceWorkspace>("source-workspace", domain);
  validateSourceArtifacts(
    bundle.sourceArtifacts,
    w?.enabled ? w.approvedAttachmentTypes : [],
  );
  requireThat(
    !bundle.sourceArtifacts.some((a) =>
      bundle.pages.some((p) => p.id === a.id || p.path === a.path),
    ),
    400,
    "DUPLICATE_SOURCE_ARTIFACT",
  );
  validateSourceLinks(
    bundle.pages,
    bundle.sourceArtifacts.map((a) => a.path),
  );
}
export function registerSourceMaintenance(app: FastifyInstance, store: Store) {
  app.get("/api/domains/:domain/source-tasks/:id", async (request) => {
    const domain = path(request, "domain"),
      w = helper(store, request.actor, domain);
    const r = revision(store, domain, path(request, "id"));
    requireThat(r.state === "sync_pending", 409, "INVALID_STATE");
    baseline(store, r);
    return {
      workspace: w,
      revision: r,
      baseline: store.get<Release>("release", r.baseReleaseId)!.bundle,
    };
  });
  app.get("/api/domains/:domain/source-workspace", async (request) => {
    const domain = path(request, "domain");
    access(store, request.actor, domain, true);
    return store.get<SourceWorkspace>("source-workspace", domain) ?? null;
  });
  app.put("/api/domains/:domain/source-workspace", async (request) => {
    const domain = path(request, "domain"),
      input = body(
        z
          .object({
            expectedVersion: z.number().int().nonnegative(),
            root: z.string().min(1).max(2000),
            helperSubject: subjectName,
            enabled: z.boolean(),
            approvedAttachmentTypes: z
              .array(z.enum(staticSourceTypes))
              .max(2)
              .default([]),
            adapter: z
              .object({
                kind: z.enum(["manual", "isolated-markdown"]),
                version: z.string().min(1).max(200),
              })
              .strict(),
          })
          .strict(),
        request,
      );
    return store.command(
      request.actor,
      domain,
      "source-pair",
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        const old = store.get<SourceWorkspace>("source-workspace", domain);
        requireThat(
          (old?.version ?? 0) === input.expectedVersion,
          409,
          "VERSION_CONFLICT",
        );
        requireThat(
          isAbsolute(input.root) && !input.root.includes("\0"),
          400,
          "INVALID_SOURCE_ROOT",
        );
        requireThat(
          !store
            .list<Revision>("revision", domain)
            .some(
              (r) =>
                r.state === "sync_pending" &&
                r.maintenance &&
                ["writing", "recovery_required", "applied"].includes(
                  r.maintenance.state,
                ),
            ),
          409,
          "SOURCE_RECOVERY_REQUIRED",
        );
        const root = resolve(input.root);
        return store.put<SourceWorkspace>("source-workspace", {
          id: domain,
          domain,
          version: input.expectedVersion + 1,
          root,
          helperSubject: input.helperSubject,
          enabled: input.enabled,
          adapter: input.adapter,
          approvedAttachmentTypes: input.approvedAttachmentTypes,
          administrator: request.actor.subject,
          bindingHash: hash([
            domain,
            root,
            input.adapter,
            input.helperSubject,
            input.approvedAttachmentTypes,
          ]),
        });
      },
    );
  });
  app.post("/api/domains/:domain/source-workspace/window", async (request) => {
    const domain = path(request, "domain"),
      input = body(
        z
          .object({
            expectedVersion: z.number().int(),
            durationSeconds: z.number().int().min(0).max(3600),
            evidence: z.string().min(20).max(2000),
          })
          .strict(),
        request,
      );
    return store.command(
      request.actor,
      domain,
      "source-window",
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        const w = workspace(store, domain);
        version(w, input.expectedVersion);
        // Changing the window fences every outstanding lease; unknown writes require reconciliation.
        for (const r of store.list<Revision>("revision", domain))
          if (r.state === "sync_pending" && r.maintenance?.state === "writing")
            store.put<Revision>("revision", {
              ...r,
              version: r.version + 1,
              maintenance: { ...r.maintenance, state: "recovery_required" },
            });
        return store.put<SourceWorkspace>("source-workspace", {
          ...w,
          version: w.version + 1,
          window: {
            until: Date.now() + input.durationSeconds * 1000,
            evidence: input.evidence,
            administrator: request.actor.subject,
          },
        });
      },
    );
  });
  app.post("/api/domains/:domain/revisions/:id/claim", async (request) => {
    const domain = path(request, "domain"),
      rid = path(request, "id"),
      input = body(
        z
          .object({
            expectedVersion: z.number().int(),
            workspaceVersion: z.number().int(),
          })
          .strict(),
        request,
      );
    return store.command(
      request.actor,
      domain,
      `source-claim:${rid}`,
      key(request),
      input,
      () => {
        const w = helper(store, request.actor, domain);
        windowOpen(store, w);
      },
      () => {
        const w = helper(store, request.actor, domain),
          r = revision(store, domain, rid);
        version(w, input.workspaceVersion);
        version(r, input.expectedVersion);
        baseline(store, r);
        requireThat(r.state === "sync_pending", 409, "INVALID_STATE");
        for (const other of store.list<Revision>("revision", domain)) {
          const m = other.maintenance;
          if (!m || other.state !== "sync_pending" || m.state === "conflict")
            continue;
          requireThat(
            m.state === "claimed" && m.expiresAt <= Date.now(),
            409,
            "SOURCE_RECOVERY_OR_LEASE_REQUIRED",
          );
        }
        return store.put<Revision>("revision", {
          ...r,
          version: r.version + 1,
          maintenance: {
            state: "claimed",
            domainEpoch: store.get<Domain>("domain", domain)!.epoch,
            workspaceVersion: w.version,
            bindingHash: w.bindingHash,
            helperSubject: request.actor.subject,
            leaseId: id(),
            expiresAt: Math.min(Date.now() + 300000, w.window!.until),
          },
        });
      },
    );
  });
  for (const operation of ["start", "lease"] as const)
    app.post(
      `/api/domains/:domain/revisions/:id/${operation}`,
      async (request) => {
        const domain = path(request, "domain"),
          rid = path(request, "id"),
          input = body(z.object({ leaseId: z.string() }).strict(), request);
        return store.command(
          request.actor,
          domain,
          `source-${operation}:${rid}`,
          key(request),
          input,
          () => {
            sourceLease(store, request.actor, domain, rid, input.leaseId);
          },
          () => {
            const { w, r, m } = sourceLease(
              store,
              request.actor,
              domain,
              rid,
              input.leaseId,
            );
            requireThat(
              ["claimed", "writing", "applied"].includes(m.state),
              409,
              "SOURCE_RECOVERY_REQUIRED",
            );
            if (operation === "start")
              requireThat(
                m.state === "claimed",
                409,
                "SOURCE_RECOVERY_REQUIRED",
              );
            return store.put<Revision>("revision", {
              ...r,
              version: r.version + 1,
              maintenance: {
                ...m,
                state: operation === "start" ? "writing" : m.state,
                expiresAt: Math.min(Date.now() + 300000, w.window!.until),
              },
            });
          },
        );
      },
    );
  app.post(
    "/api/domains/:domain/revisions/:id/source-result",
    async (request) => {
      const domain = path(request, "domain"),
        rid = path(request, "id"),
        input = body(
          z
            .object({
              leaseId: z.string(),
              state: z.enum(["applied", "conflict", "recovery_required"]),
              journalHash: z.string().regex(/^[a-f0-9]{64}$/),
              evidence: z.string().min(20).max(10000),
            })
            .strict(),
          request,
        );
      return store.command(
        request.actor,
        domain,
        `source-result:${rid}`,
        key(request),
        input,
        () => {
          const r = revision(store, domain, rid);
          requireThat(
            r.maintenance?.helperSubject === request.actor.subject &&
              r.maintenance.leaseId === input.leaseId,
            403,
            "SOURCE_HELPER_FORBIDDEN",
          );
          // Revoked/expired helpers may only record an uncertain outcome, never upload/continue.
          if (input.state !== "recovery_required")
            sourceLease(store, request.actor, domain, rid, input.leaseId);
        },
        () => {
          const r = revision(store, domain, rid),
            m = r.maintenance!;
          requireThat(
            r.state === "sync_pending" &&
              ["writing", "claimed"].includes(m.state),
            409,
            "INVALID_STATE",
          );
          requireThat(
            input.state !== "applied" || m.state === "writing",
            409,
            "INVALID_STATE",
          );
          return store.put<Revision>("revision", {
            ...r,
            version: r.version + 1,
            maintenance: {
              ...m,
              state: input.state,
              evidence: input.evidence,
              journalHash: input.journalHash,
            },
          });
        },
      );
    },
  );
  app.post("/api/domains/:domain/revisions/:id/reconcile", async (request) => {
    const domain = path(request, "domain"),
      rid = path(request, "id"),
      input = body(
        z
          .object({
            expectedVersion: z.number().int(),
            outcome: z.enum(["baseline_restored", "applied"]),
            journalHash: z.string().regex(/^[a-f0-9]{64}$/),
            evidence: z.string().min(30).max(10000),
          })
          .strict(),
        request,
      );
    return store.command(
      request.actor,
      domain,
      `source-reconcile:${rid}`,
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        const r = revision(store, domain, rid),
          w = workspace(store, domain);
        version(r, input.expectedVersion);
        windowOpen(store, w);
        baseline(store, r);
        requireThat(
          r.state === "sync_pending" && r.maintenance,
          409,
          "INVALID_STATE",
        );
        const m = r.maintenance;
        requireThat(
          m.state !== "writing" || m.expiresAt <= Date.now(),
          409,
          "SOURCE_LEASE_ACTIVE",
        );
        return store.put<Revision>("revision", {
          ...r,
          version: r.version + 1,
          maintenance: {
            ...m,
            state: input.outcome === "applied" ? "applied" : "conflict",
            evidence: input.evidence,
            journalHash: input.journalHash,
            domainEpoch: store.get<Domain>("domain", domain)!.epoch,
            workspaceVersion: w.version,
            bindingHash: w.bindingHash,
            helperSubject: w.helperSubject,
            expiresAt: Math.min(Date.now() + 300000, w.window!.until),
            leaseId: id(),
          },
        });
      },
    );
  });
}
