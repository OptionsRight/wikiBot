import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  Store,
  access,
  requireThat,
  id,
  hash,
  version,
  type Entity,
  type Identity,
} from "./core.js";
import { body, path, key } from "./app.js";
import { currentRelease, type Release } from "./publication.js";
import { ticketAccess } from "./tickets.js";
import {
  registerSourceMaintenance,
  type SourceMaintenance,
} from "./source-maintenance.js";
import { registerSourceArtifacts } from "./source-artifact-routes.js";
const change = z
  .object({
    pageId: z.string().min(1).max(100),
    baseHash: z.string().length(64),
    content: z.string().min(1).max(200000),
    source: z.string().min(10).max(10000),
  })
  .strict();
const draftSchema = z
  .object({
    title: z.string().min(1).max(200),
    reason: z.string().min(10).max(10000),
    scope: z.string().min(1).max(2000),
    changes: z.array(change).min(1).max(50),
    ticketId: z.string().optional(),
  })
  .strict();
export interface Revision extends Entity {
  owner: string;
  title: string;
  reason: string;
  scope: string;
  changes: z.infer<typeof change>[];
  ticketId?: string;
  baseReleaseId: string;
  baseDescriptorHash: string;
  state: "draft" | "sync_pending" | "snapshot_ready";
  candidateId?: string;
  sourceEvidence?: string;
  maintenance?: SourceMaintenance;
}
function read(store: Store, actor: Identity, domain: string, rid: string) {
  access(store, actor, domain, true);
  const r = store.get<Revision>("revision", rid);
  requireThat(r?.domain === domain, 404, "NOT_FOUND");
  return r;
}
function view(store: Store, r: Revision) {
  const candidate = r.candidateId
    ? store.get<Release>("release", r.candidateId)
    : undefined;
  const original = store.get<Release>("release", r.baseReleaseId);
  return {
    ...r,
    maintenance:
      r.maintenance?.state === "writing" &&
      r.maintenance.expiresAt <= Date.now()
        ? {
            ...r.maintenance,
            state: "recovery_required",
            reason: "SOURCE_LEASE_EXPIRED",
          }
        : r.maintenance,
    candidateState: candidate?.state,
    state: candidate?.state === "active" ? "released" : r.state,
    releaseId: candidate?.state === "active" ? candidate.id : undefined,
    originalPages: original?.bundle.pages.filter((p) =>
      r.changes.some((c) => c.pageId === p.id),
    ),
    blocker:
      r.state === "sync_pending"
        ? "等待受控来源维护与重新快照；原技能未验证时使用人工交接"
        : undefined,
  };
}
function validateChanges(release: Release, changes: Revision["changes"]) {
  requireThat(
    new Set(changes.map((c) => c.pageId)).size === changes.length,
    400,
    "DUPLICATE_PAGE",
  );
  for (const c of changes)
    requireThat(
      release.bundle.pages.some(
        (p) => p.id === c.pageId && p.hash === c.baseHash,
      ),
      409,
      "SOURCE_BASELINE_CONFLICT",
    );
}
export function registerRevisions(app: FastifyInstance, store: Store) {
  registerSourceMaintenance(app, store);
  registerSourceArtifacts(app, store);
  app.post("/api/domains/:domain/revisions", async (request, reply) => {
    const domain = path(request, "domain"),
      input = body(draftSchema, request);
    const result = store.command(
      request.actor,
      domain,
      "revision-create",
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        const release = currentRelease(store, request.actor, domain);
        validateChanges(release, input.changes);
        if (input.ticketId)
          ticketAccess(store, request.actor, domain, input.ticketId);
        return store.put<Revision>("revision", {
          ...input,
          id: id(),
          domain,
          version: 1,
          owner: request.actor.subject,
          baseReleaseId: release.id,
          baseDescriptorHash: release.descriptorHash,
          state: "draft",
        });
      },
    );
    return reply
      .code(201)
      .send(view(store, read(store, request.actor, domain, result.id)));
  });
  app.get("/api/domains/:domain/revisions", async (request) => {
    const domain = path(request, "domain");
    access(store, request.actor, domain, true);
    return store.list<Revision>("revision", domain).map((r) => view(store, r));
  });
  app.get("/api/domains/:domain/revisions/:id", async (request) =>
    view(
      store,
      read(store, request.actor, path(request, "domain"), path(request, "id")),
    ),
  );
  app.patch("/api/domains/:domain/revisions/:id", async (request) => {
    const domain = path(request, "domain"),
      rid = path(request, "id"),
      input = body(
        draftSchema.extend({ expectedVersion: z.number().int() }).strict(),
        request,
      );
    return store.command(
      request.actor,
      domain,
      `revision-edit:${rid}`,
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        const r = read(store, request.actor, domain, rid);
        version(r, input.expectedVersion);
        requireThat(r.state === "draft", 409, "INVALID_STATE");
        const release = currentRelease(store, request.actor, domain);
        requireThat(
          release.descriptorHash === r.baseDescriptorHash,
          409,
          "SOURCE_BASELINE_CONFLICT",
        );
        validateChanges(release, input.changes);
        if (input.ticketId)
          ticketAccess(store, request.actor, domain, input.ticketId);
        const { expectedVersion: _version, ...fields } = input;
        return store.put<Revision>("revision", {
          ...r,
          ...fields,
          version: r.version + 1,
        });
      },
    );
  });
  app.post("/api/domains/:domain/revisions/:id/submit", async (request) => {
    const domain = path(request, "domain"),
      rid = path(request, "id"),
      input = body(
        z.object({ expectedVersion: z.number().int() }).strict(),
        request,
      );
    return store.command(
      request.actor,
      domain,
      `revision-submit:${rid}`,
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        const r = read(store, request.actor, domain, rid);
        version(r, input.expectedVersion);
        requireThat(r.state === "draft", 409, "INVALID_STATE");
        const release = currentRelease(store, request.actor, domain);
        requireThat(
          release.descriptorHash === r.baseDescriptorHash,
          409,
          "SOURCE_BASELINE_CONFLICT",
        );
        validateChanges(release, r.changes);
        return store.put<Revision>("revision", {
          ...r,
          state: "sync_pending",
          version: r.version + 1,
        });
      },
    );
  });
  app.post("/api/domains/:domain/revisions/:id/snapshot", async (request) => {
    const domain = path(request, "domain"),
      rid = path(request, "id"),
      input = body(
        z
          .object({
            expectedVersion: z.number().int(),
            candidateId: z.string(),
            sourceEvidence: z.string().min(30).max(20000),
          })
          .strict(),
        request,
      );
    return store.command(
      request.actor,
      domain,
      `revision-snapshot:${rid}`,
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        const r = read(store, request.actor, domain, rid);
        version(r, input.expectedVersion);
        requireThat(r.state === "sync_pending", 409, "INVALID_STATE");
        requireThat(
          !r.maintenance || r.maintenance.state === "applied",
          409,
          "SOURCE_RECOVERY_REQUIRED",
        );
        const active = currentRelease(store, request.actor, domain);
        requireThat(
          active.id === r.baseReleaseId &&
            active.descriptorHash === r.baseDescriptorHash,
          409,
          "SOURCE_BASELINE_CONFLICT",
        );
        const candidate = store.get<Release>("release", input.candidateId);
        requireThat(
          candidate?.domain === domain &&
            candidate.state === "submitted" &&
            candidate.baseActive === r.baseReleaseId,
          409,
          "INVALID_CANDIDATE",
        );
        requireThat(
          r.changes.every((c) =>
            candidate.bundle.pages.some(
              (p) => p.id === c.pageId && p.hash === hash(c.content),
            ),
          ),
          409,
          "SNAPSHOT_MISMATCH",
        );
        return store.put<Revision>("revision", {
          ...r,
          ...input,
          state: "snapshot_ready",
          version: r.version + 1,
        });
      },
    );
  });
}
