import { z } from "zod";
import { createHash } from "node:crypto";

export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const knowledgeId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const instant = z.number().int().safe().nonnegative();
export function rawSha256(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
/** New contracts use UTF-8 JSON with ASCII keys, codepoint ordering and integer
 * numbers only. Legacy core.hash is intentionally unchanged. */
export function wireCanonical(value: unknown): string {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") {
    if (!value.isWellFormed()) throw new Error("INVALID_UNICODE");
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(wireCanonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => {
        if (!/^[\x20-\x7e]+$/.test(k)) throw new Error("INVALID_CONTRACT_KEY");
        return `${JSON.stringify(k)}:${wireCanonical(v)}`;
      })
      .join(",")}}`;
  throw new Error("INVALID_CONTRACT_VALUE");
}
export function wireHash(value: unknown) {
  return rawSha256(wireCanonical(value));
}

export const locatorSchema = z
  .object({
    precision: z.enum(["document", "block", "page", "slide", "cells", "lines"]),
    pointer: z.string().max(500),
    page: z.number().int().positive().optional(),
    sheet: z.string().max(300).optional(),
    range: z.string().max(100).optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    // Coordinates are strings to avoid cross-language floating point hashing.
    bbox: z.array(z.string()).length(4).optional(),
  })
  .strict();
export const blockSchema = z
  .object({
    blockId: knowledgeId,
    kind: z.string().max(100),
    text: z.string().max(200000),
    contentHash: digest,
    locator: locatorSchema,
    extractionAllowed: z.boolean(),
  })
  .strict();
export const profileSchema = z
  .object({
    schemaVersion: z.literal(1),
    doclingVersion: z.string().min(1).max(80),
    pipeline: z.enum(["native", "standard"]),
    ocr: z.boolean(),
    modelArtifactsHash: digest,
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(100 * 1024 * 1024),
    maxExpandedBytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
    maxPages: z.number().int().positive().max(2000),
    timeoutMs: z.number().int().min(1000).max(3600000),
    memoryMb: z.number().int().min(256).max(32768),
    cpuSeconds: z.number().int().positive().max(3600),
  })
  .strict();
export const normalizedSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: knowledgeId,
    attempt: z.number().int().positive(),
    fencingToken: knowledgeId,
    sourceVersionId: knowledgeId,
    rawSha256: digest,
    profileHash: digest,
    doclingVersion: z.string(),
    startedAt: instant,
    finishedAt: instant,
    parseStatus: z.enum(["complete", "partial", "failed"]),
    warnings: z.array(z.string().max(2000)).max(10000),
    blocks: z.array(blockSchema).max(50000),
    artifacts: z
      .array(
        z
          .object({
            name: z.enum(["document.json", "document.md", "blocks.json"]),
            rawSha256: digest,
            bytes: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();
export const evidenceSchema = z
  .object({
    evidenceId: knowledgeId,
    domain: knowledgeId,
    sourceVersionId: knowledgeId,
    resolverKind: z.enum(["wiki", "document", "repository"]),
    locator: locatorSchema,
    rawSha256: digest,
    contentHash: digest,
    excerpt: z.string().max(20000),
    visibility: z.enum(["excerpt", "admin"]),
    state: z.enum(["fresh", "stale", "unresolved"]),
  })
  .strict();
export const claimSnapshotSchema = z
  .object({
    claimId: knowledgeId,
    versionId: knowledgeId,
    domain: knowledgeId,
    subjectId: z.string().min(1).max(300),
    predicate: z.string().min(1).max(300),
    qualifiers: z.record(
      z.string().regex(/^[a-zA-Z0-9_-]+$/),
      z.string().max(500),
    ),
    statement: z.string().min(1).max(10000),
    typedValue: z.union([z.string(), z.number().int().safe(), z.boolean()]),
    validityKind: z.enum(["known", "unknown", "reviewer_asserted"]),
    validFrom: instant.nullable(),
    validTo: instant.nullable(),
    recordedFrom: instant,
    recordedTo: instant.nullable(),
    status: z.enum(["proposed", "approved", "rejected", "retracted"]),
    supersedesVersionId: knowledgeId.nullable(),
    extractionProfileHash: digest,
    evidenceIds: z.array(knowledgeId).min(1).max(100),
  })
  .strict();
export const sidecarSchema = z
  .object({
    schemaVersion: z.literal(1),
    domain: knowledgeId,
    pageId: knowledgeId,
    pageHash: digest,
    generationId: knowledgeId,
    claimVersionIds: z.array(knowledgeId).max(1000),
    evidenceIds: z.array(knowledgeId).max(1000),
    dependencies: z.array(knowledgeId).max(1000),
    coverageMode: z.enum(["legacy_page", "mixed", "claims"]),
    projectionHash: digest,
  })
  .strict();
export const sourceManifestSchema = z
  .array(
    z
      .object({
        sourceVersionId: knowledgeId,
        sourceId: knowledgeId,
        rawSha256: digest,
        kind: z.enum(["wiki", "document", "repository"]),
        profileHash: digest,
        artifactHash: digest,
      })
      .strict(),
  )
  .max(2000);
export const groundingManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["page", "mixed", "claims"]),
    policyVersion: z.string().min(1).max(100),
    recordedCutoff: instant,
    claims: z.array(claimSnapshotSchema).max(10000),
    evidence: z.array(evidenceSchema).max(10000),
    sidecars: z.array(sidecarSchema).max(500),
  })
  .strict();
export const dependencyManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    resolverVersion: z.literal("1"),
    extractorProfileHash: digest,
    edges: z
      .array(
        z
          .object({
            from: knowledgeId,
            to: knowledgeId,
            kind: z.enum(["evidence", "claim", "page", "case"]),
          })
          .strict(),
      )
      .max(30000),
  })
  .strict();
export type NormalizerProfile = z.infer<typeof profileSchema>;
export const normalizationTaskSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: knowledgeId,
    domain: knowledgeId,
    actorRef: z.string().min(1).max(200),
    inputManifestHash: digest,
    deadline: instant,
    outputRootRef: z.string().regex(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/),
    attempt: z.number().int().positive(),
    fencingToken: knowledgeId,
    sourceVersionId: knowledgeId,
    rawSha256: digest,
    profileHash: digest,
    profile: profileSchema,
    format: z.enum(["pdf", "docx", "pptx", "xlsx"]),
  })
  .strict();
export type NormalizedDocument = z.infer<typeof normalizedSchema>;
export type EvidenceSnapshot = z.infer<typeof evidenceSchema>;
export type ClaimSnapshot = z.infer<typeof claimSnapshotSchema>;
export const evalPolicySchema = z
  .object({
    version: z.string().min(1).max(100),
    mode: z.enum(["shadow", "blocking"]),
    judgeProfileHash: digest,
    suiteHash: digest,
    metrics: z
      .array(
        z
          .object({
            name: z.enum([
              "faithfulness",
              "relevancy",
              "coverage",
              "forbidden",
            ]),
            required: z.boolean(),
            thresholdBps: z.number().int().min(0).max(10000),
          })
          .strict(),
      )
      .length(4),
    calibrationId: knowledgeId.nullable(),
    maxAgeMs: z
      .number()
      .int()
      .min(1000)
      .max(30 * 86400000),
  })
  .strict();
