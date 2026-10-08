import { z } from "zod";
import {
  Store,
  access,
  id,
  version,
  requireThat,
  type Entity,
  type Identity,
} from "../core.js";
import {
  claimSnapshotSchema,
  knowledgeId,
  instant,
  digest,
  wireHash,
  type ClaimSnapshot,
  type EvidenceSnapshot,
} from "./contracts.js";

export interface Claim extends Entity {
  coordinate: string;
  subjectId: string;
  predicate: string;
  qualifiers: Record<string, string>;
  owner: string;
  latestVersionId: string;
  relatedClaimId?: string;
}
export type ClaimVersion = ClaimSnapshot &
  Entity & { batchId: string; reviewer?: string; reviewReason?: string };
export type Evidence = EvidenceSnapshot & Entity;
export interface Conflict extends Entity {
  conflictKey: string;
  members: string[];
  evidenceIds?: string[];
  reason: string;
  state: "open" | "resolved";
  decision?: string;
  reviewer?: string;
}
export const proposalSchema = z
  .object({
    claimId: knowledgeId.optional(),
    expectedVersion: z.number().int().nonnegative(),
    relatedClaimId: knowledgeId.optional(),
    subjectId: z.string().trim().min(1).max(300),
    predicate: z.string().trim().min(1).max(300),
    qualifiers: claimSnapshotSchema.shape.qualifiers,
    statement: claimSnapshotSchema.shape.statement,
    typedValue: claimSnapshotSchema.shape.typedValue,
    validityKind: claimSnapshotSchema.shape.validityKind,
    validFrom: instant.nullable(),
    validTo: instant.nullable(),
    evidenceIds: z.array(knowledgeId).min(1).max(100),
    additionalEvidence: z
      .array(
        z
          .object({
            evidenceId: knowledgeId,
            relation: z.enum(["context", "contradicts"]),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    extractionProfileHash: digest,
    batchId: knowledgeId,
    reason: z.string().min(10).max(2000),
  })
  .strict();

export function temporalMatch(
  c: ClaimSnapshot,
  validAt?: number,
  knownAt?: number,
) {
  return (
    (knownAt === undefined ||
      (c.recordedFrom <= knownAt &&
        (c.recordedTo === null || knownAt < c.recordedTo))) &&
    (validAt === undefined ||
      (c.validityKind !== "unknown" &&
        (c.validFrom === null || c.validFrom <= validAt) &&
        (c.validTo === null || validAt < c.validTo)))
  );
}
function overlap(a: ClaimSnapshot, b: ClaimSnapshot) {
  return (
    (a.validTo ?? Infinity) > (b.validFrom ?? -Infinity) &&
    (b.validTo ?? Infinity) > (a.validFrom ?? -Infinity)
  );
}
function event(
  store: Store,
  actor: Identity,
  domain: string,
  action: string,
  data: Record<string, unknown>,
) {
  const events = store.knowledgeList<Entity & { sequence: number; at: number }>(
    "claim_events",
    domain,
  );
  const sequence =
      1 + Math.max(0, ...events.map((e) => e.sequence).filter(Number.isFinite)),
    at = Math.max(
      Date.now(),
      ...events.map((e) => e.at + 1).filter(Number.isFinite),
    );
  store.knowledgePut("claim_events", {
    id: id(),
    domain,
    version: 1,
    sequence,
    at,
    actor: actor.subject,
    action,
    ...data,
  });
  return at;
}
export function proposeClaim(
  store: Store,
  actor: Identity,
  domain: string,
  input: z.infer<typeof proposalSchema>,
): ClaimVersion {
  access(store, actor, domain, true);
  requireThat(
    input.validFrom === null ||
      input.validTo === null ||
      input.validFrom < input.validTo,
    400,
    "INVALID_VALID_INTERVAL",
  );
  requireThat(
    input.validityKind !== "unknown" ||
      (input.validFrom === null && input.validTo === null),
    400,
    "UNKNOWN_VALIDITY_HAS_DATES",
  );
  for (const eid of [
    ...input.evidenceIds,
    ...(input.additionalEvidence ?? []).map((e) => e.evidenceId),
  ]) {
    const e = store.knowledgeGet<Evidence>("evidence", eid);
    requireThat(
      e?.domain === domain && e.state === "fresh",
      409,
      "EVIDENCE_UNAVAILABLE",
    );
  }
  const coordinate = wireHash([
    domain,
    input.subjectId.normalize("NFC"),
    input.predicate.normalize("NFC"),
    input.qualifiers,
  ]);
  if (input.relatedClaimId)
    requireThat(
      store.knowledgeGet<Claim>("claims", input.relatedClaimId)?.domain ===
        domain,
      404,
      "RELATED_CLAIM_NOT_FOUND",
    );
  let claim = input.claimId
    ? store.knowledgeGet<Claim>("claims", input.claimId)
    : store
        .knowledgeList<Claim>("claims", domain)
        .find((c) => c.coordinate === coordinate);
  if (input.claimId) requireThat(claim?.domain === domain, 404, "NOT_FOUND");
  if (claim) {
    version(claim, input.expectedVersion);
    requireThat(
      claim.coordinate === coordinate,
      409,
      "CLAIM_COORDINATE_CHANGED",
    );
  } else requireThat(input.expectedVersion === 0, 409, "VERSION_CONFLICT");
  const cid = claim?.id ?? id(),
    vid = id(),
    old = claim
      ? store.knowledgeGet<ClaimVersion>(
          "claim_versions",
          claim.latestVersionId,
        )
      : undefined;
  const recordedFrom = event(store, actor, domain, "propose", {
    claimId: cid,
    versionId: vid,
    supersedes: old?.id ?? null,
    reason: input.reason,
    batchId: input.batchId,
  });
  if (old)
    store.knowledgePut("claim_versions", {
      ...old,
      recordedTo: recordedFrom,
      version: old.version + 1,
    });
  const next: ClaimVersion = {
    id: vid,
    versionId: vid,
    domain,
    version: 1,
    claimId: cid,
    subjectId: input.subjectId,
    predicate: input.predicate,
    qualifiers: input.qualifiers,
    statement: input.statement,
    typedValue: input.typedValue,
    validityKind: input.validityKind,
    validFrom: input.validFrom,
    validTo: input.validTo,
    recordedFrom,
    recordedTo: null,
    status: "proposed",
    supersedesVersionId: old?.id ?? null,
    extractionProfileHash: input.extractionProfileHash,
    evidenceIds: input.evidenceIds,
    batchId: input.batchId,
  };
  store.knowledgePut<Claim>("claims", {
    id: cid,
    domain,
    version: (claim?.version ?? 0) + 1,
    coordinate,
    subjectId: input.subjectId,
    predicate: input.predicate,
    qualifiers: input.qualifiers,
    owner: actor.subject,
    latestVersionId: vid,
    ...(input.relatedClaimId ? { relatedClaimId: input.relatedClaimId } : {}),
  });
  store.knowledgePut("claim_versions", next);
  store.put("claim-projection", {
    id: vid,
    domain,
    version: 1,
    state: "queued",
    claimVersionId: vid,
    batchId: input.batchId,
  });
  for (const eid of input.evidenceIds)
    store.knowledgePut("claim_evidence", {
      id: wireHash([vid, eid]),
      domain,
      version: 1,
      claimVersionId: vid,
      evidenceId: eid,
      relation: "supports",
      reviewed: false,
    });
  requireThat(
    new Set([
      ...input.evidenceIds,
      ...(input.additionalEvidence ?? []).map((e) => e.evidenceId),
    ]).size ===
      input.evidenceIds.length + (input.additionalEvidence?.length ?? 0),
    400,
    "DUPLICATE_EVIDENCE_RELATION",
  );
  for (const link of input.additionalEvidence ?? [])
    store.knowledgePut("claim_evidence", {
      id: wireHash([vid, link.evidenceId]),
      domain,
      version: 1,
      claimVersionId: vid,
      ...link,
      reviewed: false,
    });
  const contradictions = (input.additionalEvidence ?? [])
    .filter((e) => e.relation === "contradicts")
    .map((e) => e.evidenceId);
  if (contradictions.length)
    store.knowledgePut<Conflict>("conflicts", {
      id: id(),
      domain,
      version: 1,
      conflictKey: coordinate,
      members: [vid],
      evidenceIds: contradictions,
      reason: "CONTRADICTING_EVIDENCE",
      state: "open",
    });
  if (
    old &&
    old.status !== "rejected" &&
    old.status !== "retracted" &&
    overlap(old, next) &&
    wireHash(old.typedValue) !== wireHash(next.typedValue)
  ) {
    store.knowledgePut<Conflict>("conflicts", {
      id: id(),
      domain,
      version: 1,
      conflictKey: coordinate,
      members: [old.id, vid],
      reason:
        old.validityKind === "unknown" || next.validityKind === "unknown"
          ? "UNKNOWN_TIME_REQUIRES_REVIEW"
          : "OVERLAPPING_EXCLUSIVE_VALUES",
      state: "open",
    });
  }
  return next;
}
export function approveClaims(
  store: Store,
  actor: Identity,
  domain: string,
  versions: { id: string; expectedVersion: number }[],
  reason: string,
) {
  access(store, actor, domain, true);
  requireThat(
    new Set(versions.map((v) => v.id)).size === versions.length,
    400,
    "DUPLICATE_CLAIM_VERSION",
  );
  return versions.map((input) => {
    const c = store.knowledgeGet<ClaimVersion>("claim_versions", input.id);
    requireThat(c?.domain === domain, 404, "NOT_FOUND");
    version(c, input.expectedVersion);
    requireThat(
      c.status === "proposed" && c.recordedTo === null,
      409,
      "CLAIM_NOT_CURRENT",
    );
    requireThat(
      !store
        .knowledgeList<Conflict>("conflicts", domain)
        .some((f) => f.state === "open" && f.members.includes(c.id)),
      409,
      "CLAIM_CONFLICT_OPEN",
    );
    for (const eid of c.evidenceIds) {
      const e = store.knowledgeGet<Evidence>("evidence", eid);
      requireThat(
        e?.domain === domain && e.state === "fresh",
        409,
        "EVIDENCE_UNAVAILABLE",
      );
    }
    event(store, actor, domain, "approve", {
      versionId: c.id,
      reason,
      batchId: c.batchId,
    });
    for (const link of store
      .knowledgeList<Entity & { claimVersionId: string }>(
        "claim_evidence",
        domain,
      )
      .filter((e) => e.claimVersionId === c.id))
      store.knowledgePut("claim_evidence", {
        ...link,
        reviewed: true,
        version: link.version + 1,
      });
    return store.knowledgePut<ClaimVersion>("claim_versions", {
      ...c,
      status: "approved",
      reviewer: actor.subject,
      reviewReason: reason,
      version: c.version + 1,
    });
  });
}
export function resolveConflict(
  store: Store,
  actor: Identity,
  domain: string,
  cid: string,
  input: {
    expectedVersion: number;
    members: string[];
    rejectVersionIds: string[];
    dismissEvidenceIds?: string[];
    reason: string;
  },
) {
  access(store, actor, domain, true);
  const c = store.knowledgeGet<Conflict>("conflicts", cid);
  requireThat(c?.domain === domain, 404, "NOT_FOUND");
  version(c, input.expectedVersion);
  requireThat(
    c.state === "open" &&
      wireHash([...c.members].sort()) === wireHash([...input.members].sort()),
    409,
    "CONFLICT_MEMBERS_CHANGED",
  );
  requireThat(
    (input.rejectVersionIds.length > 0 ||
      (!!c.evidenceIds?.length &&
        wireHash([...(input.dismissEvidenceIds ?? [])].sort()) ===
          wireHash([...c.evidenceIds].sort()))) &&
      input.rejectVersionIds.every((v) => c.members.includes(v)),
    400,
    "CONFLICT_DECISION_REQUIRED",
  );
  for (const vid of input.rejectVersionIds) {
    const v = store.knowledgeGet<ClaimVersion>("claim_versions", vid)!;
    store.knowledgePut("claim_versions", {
      ...v,
      status: "rejected",
      version: v.version + 1,
    });
  }
  for (const eid of input.dismissEvidenceIds ?? [])
    for (const vid of c.members) {
      const link = store.knowledgeGet<Entity>(
        "claim_evidence",
        wireHash([vid, eid]),
      );
      requireThat(
        link?.domain === domain && c.evidenceIds?.includes(eid),
        400,
        "CONFLICT_EVIDENCE_MISMATCH",
      );
      store.knowledgePut("claim_evidence", {
        ...link,
        disposition: "dismissed",
        reviewer: actor.subject,
        reason: input.reason,
        version: link.version + 1,
      });
    }
  event(store, actor, domain, "resolve_conflict", {
    conflictId: cid,
    ...input,
  });
  return store.knowledgePut<Conflict>("conflicts", {
    ...c,
    state: "resolved",
    decision: input.reason,
    reviewer: actor.subject,
    version: c.version + 1,
  });
}
export function claimSnapshot(c: ClaimVersion): ClaimSnapshot {
  const {
    id: _id,
    version: _version,
    batchId: _batch,
    reviewer: _reviewer,
    reviewReason: _reason,
    ...snapshot
  } = c;
  return claimSnapshotSchema.parse(snapshot);
}
