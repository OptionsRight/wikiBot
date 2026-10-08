import { Store, id, hash, requireThat, type Entity } from "../core.js";
import { rawSha256, wireHash, type EvidenceSnapshot } from "./contracts.js";
import type { Evidence } from "./claims.js";
import type { KnowledgeJob, SourceVersion } from "./jobs.js";
import type { AssetStore } from "./assets.js";
import type { Page } from "../procedures.js";

export interface TextSource extends Entity {
  kind: "wiki" | "repository";
  sourceId: string;
  rawSha256: string;
  profileHash: string;
  artifactHash: string;
  content: string;
  pageId?: string;
  pageHash?: string;
  repoId?: string;
  commit?: string;
  blob?: string;
  path?: string;
}
export function registerWikiSource(store: Store, domain: string, page: Page) {
  requireThat(hash(page.content) === page.hash, 400, "CONTENT_HASH_MISMATCH");
  const sid = wireHash([domain, "wiki", page.id, page.hash]);
  const previous = store.knowledgeGet<TextSource>("source_versions", sid);
  if (previous) return previous;
  return store.knowledgePut<TextSource>("source_versions", {
    id: sid,
    domain,
    version: 1,
    kind: "wiki",
    sourceId: page.id,
    rawSha256: rawSha256(page.content),
    profileHash: wireHash(["wiki", 1]),
    artifactHash: page.hash,
    content: page.content,
    pageId: page.id,
    pageHash: page.hash,
  });
}
export function createTextEvidence(
  store: Store,
  domain: string,
  sourceVersionId: string,
  startLine: number,
  endLine: number,
): Evidence {
  const source = store.knowledgeGet<TextSource>(
    "source_versions",
    sourceVersionId,
  );
  requireThat(
    source?.domain === domain && ["wiki", "repository"].includes(source.kind),
    404,
    "NOT_FOUND",
  );
  requireThat(
    rawSha256(source.content) === source.rawSha256,
    409,
    "SOURCE_HASH_MISMATCH",
  );
  const lines = source.content.split("\n");
  requireThat(
    Number.isInteger(startLine) &&
      startLine > 0 &&
      Number.isInteger(endLine) &&
      endLine >= startLine &&
      endLine <= lines.length,
    400,
    "INVALID_LINE_RANGE",
  );
  const excerpt = lines.slice(startLine - 1, endLine).join("\n");
  requireThat(
    excerpt.length > 0 && excerpt.length <= 20000,
    400,
    "EVIDENCE_SIZE_LIMIT",
  );
  const eid = wireHash([domain, sourceVersionId, startLine, endLine]);
  const previous = store.knowledgeGet<Evidence>("evidence", eid);
  if (previous) return previous;
  return store.knowledgePut<Evidence>("evidence", {
    id: eid,
    evidenceId: eid,
    domain,
    version: 1,
    sourceVersionId,
    resolverKind: source.kind,
    locator: {
      precision: "lines",
      pointer:
        source.kind === "wiki"
          ? source.pageId!
          : `${source.repoId}@${source.commit}:${source.path}#${source.blob}`,
      startLine,
      endLine,
    },
    rawSha256: source.rawSha256,
    contentHash: rawSha256(excerpt),
    excerpt,
    visibility: "excerpt",
    state: "fresh",
  });
}
export function createDocumentEvidence(
  store: Store,
  assets: AssetStore,
  domain: string,
  jobId: string,
  blockId: string,
  partialReviewReason?: string,
) {
  const job = store.knowledgeGet<KnowledgeJob>("knowledge_jobs", jobId);
  requireThat(
    job?.domain === domain && ["succeeded", "partial"].includes(job.state),
    409,
    "NORMALIZATION_NOT_USABLE",
  );
  requireThat(
    job.manifestHash && job.artifacts?.["blocks.json"],
    409,
    "INCOMPLETE_ARTIFACTS",
  );
  assets.read(domain, job.manifestHash);
  assets.read(domain, job.artifacts["blocks.json"]);
  const block = job.result?.blocks.find((b) => b.blockId === blockId);
  requireThat(block, 404, "NOT_FOUND");
  if (job.state === "partial" || !block.extractionAllowed)
    requireThat(
      partialReviewReason && partialReviewReason.trim().length >= 10,
      409,
      "PARTIAL_FRAGMENT_REVIEW_REQUIRED",
    );
  requireThat(block.text.length <= 20000, 400, "EVIDENCE_SIZE_LIMIT");
  const source = store.knowledgeGet<SourceVersion>(
    "source_versions",
    job.sourceVersionId,
  )!;
  const eid = wireHash([domain, job.id, job.profileHash, blockId]);
  const previous = store.knowledgeGet<Evidence>("evidence", eid);
  if (previous) return previous;
  const evidence = store.knowledgePut<Evidence>("evidence", {
    id: eid,
    evidenceId: eid,
    domain,
    version: 1,
    sourceVersionId: source.id,
    resolverKind: "document",
    locator: { ...block.locator, pointer: `${job.id}/${blockId}` },
    rawSha256: source.rawSha256,
    contentHash: block.contentHash,
    excerpt: block.text,
    visibility: "excerpt",
    state: "fresh",
  });
  store.knowledgePut("claim_events", {
    id: id(),
    domain,
    version: 1,
    action: "fragment_review",
    at: Date.now(),
    evidenceId: eid,
    reason: partialReviewReason ?? "complete text block",
    jobId,
  });
  return evidence;
}
export function verifyEvidence(
  store: Store,
  assets: AssetStore | undefined,
  e: EvidenceSnapshot,
) {
  const source = store.knowledgeGet<TextSource | SourceVersion>(
    "source_versions",
    e.sourceVersionId,
  );
  requireThat(
    source?.domain === e.domain &&
      source.rawSha256 === e.rawSha256 &&
      rawSha256(e.excerpt) === e.contentHash,
    409,
    "EVIDENCE_UNRESOLVED",
  );
  if (e.resolverKind === "document") {
    requireThat(assets, 503, "KNOWLEDGE_WORKER_NOT_CONFIGURED");
    assets.read(e.domain, e.rawSha256);
    const [jobId, blockId] = e.locator.pointer.split("/");
    const job = store.knowledgeGet<KnowledgeJob>("knowledge_jobs", jobId!);
    requireThat(
      job?.domain === e.domain &&
        job.sourceVersionId === source.id &&
        job.manifestHash &&
        job.result?.blocks.some(
          (b) => b.blockId === blockId && b.contentHash === e.contentHash,
        ),
      409,
      "EVIDENCE_UNRESOLVED",
    );
    assets.read(e.domain, job.manifestHash);
    for (const digest of Object.values(job.artifacts ?? {}))
      assets.read(e.domain, digest);
  } else {
    requireThat(
      "content" in source && rawSha256(source.content) === source.rawSha256,
      409,
      "EVIDENCE_UNRESOLVED",
    );
    const excerpt = source.content
      .split("\n")
      .slice(e.locator.startLine! - 1, e.locator.endLine)
      .join("\n");
    requireThat(rawSha256(excerpt) === e.contentHash, 409, "EVIDENCE_STALE");
  }
}
export function sourceManifestEntry(store: Store, e: EvidenceSnapshot) {
  const s = store.knowledgeGet<TextSource | SourceVersion>(
    "source_versions",
    e.sourceVersionId,
  )!;
  if (e.resolverKind === "document") {
    const j = store.knowledgeGet<KnowledgeJob>(
      "knowledge_jobs",
      e.locator.pointer.split("/")[0]!,
    )!;
    return {
      sourceVersionId: s.id,
      sourceId: s.sourceId,
      kind: e.resolverKind,
      rawSha256: s.rawSha256,
      profileHash: j.profileHash,
      artifactHash: j.manifestHash!,
    };
  }
  const text = s as TextSource;
  return {
    sourceVersionId: s.id,
    sourceId: s.sourceId,
    kind: e.resolverKind,
    rawSha256: s.rawSha256,
    profileHash: text.profileHash,
    artifactHash: text.artifactHash,
  };
}
