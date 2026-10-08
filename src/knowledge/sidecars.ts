import { Store, hash, requireThat } from "../core.js";
import type { BundleV2, Page } from "../procedures.js";
import { wireHash, sidecarSchema, type ClaimSnapshot } from "./contracts.js";
import {
  claimSnapshot,
  type ClaimVersion,
  type Evidence,
  type Conflict,
} from "./claims.js";
import { verifyEvidence, sourceManifestEntry } from "./evidence.js";
import type { AssetStore } from "./assets.js";
import { verifyGeneration, type Generation } from "./generations.js";

export function createSidecar(
  domain: string,
  page: Page,
  generationId: string,
  claims: ClaimSnapshot[],
  coverageMode: "legacy_page" | "mixed" | "claims",
) {
  const body = {
    schemaVersion: 1 as const,
    domain,
    pageId: page.id,
    pageHash: page.hash,
    generationId,
    claimVersionIds: claims.map((c) => c.versionId).sort(),
    evidenceIds: [...new Set(claims.flatMap((c) => c.evidenceIds))].sort(),
    dependencies: [...new Set(claims.flatMap((c) => c.evidenceIds))].sort(),
    coverageMode,
  };
  return sidecarSchema.parse({ ...body, projectionHash: wireHash(body) });
}
export function validateGroundingBundle(bundle: BundleV2) {
  const g = bundle.groundingManifest;
  for (const list of [
    g.claims.map((c) => c.versionId),
    g.evidence.map((e) => e.evidenceId),
    g.sidecars.map((s) => s.pageId),
    bundle.sourceManifest.map((s) => s.sourceVersionId),
  ])
    requireThat(
      new Set(list).size === list.length,
      400,
      "DUPLICATE_GROUNDING_ID",
    );
  requireThat(
    g.sidecars.length === bundle.pages.length,
    400,
    "SIDECAR_COVERAGE_REQUIRED",
  );
  requireThat(
    wireHash(bundle.cases) === bundle.evalPolicy.suiteHash,
    400,
    "SUITE_HASH_MISMATCH",
  );
  requireThat(
    new Set(bundle.evalPolicy.metrics.map((m) => m.name)).size === 4,
    400,
    "EVAL_METRICS_INCOMPLETE",
  );
  if (bundle.evalPolicy.mode === "blocking")
    requireThat(bundle.evalPolicy.calibrationId, 400, "CALIBRATION_REQUIRED");
  for (const sidecar of g.sidecars) {
    const { projectionHash, ...body } = sidecar;
    requireThat(
      wireHash(body) === projectionHash,
      400,
      "SIDECAR_HASH_MISMATCH",
    );
    requireThat(
      bundle.pages.some(
        (p) => p.id === sidecar.pageId && p.hash === sidecar.pageHash,
      ),
      400,
      "SIDECAR_PAGE_MISMATCH",
    );
    requireThat(
      sidecar.claimVersionIds.every((id) =>
        g.claims.some((c) => c.versionId === id),
      ) &&
        sidecar.evidenceIds.every((id) =>
          g.evidence.some((e) => e.evidenceId === id),
        ),
      400,
      "SIDECAR_REFERENCE_MISSING",
    );
    if (g.mode === "claims")
      requireThat(
        sidecar.coverageMode === "claims" && sidecar.claimVersionIds.length > 0,
        400,
        "CLAIM_COVERAGE_REQUIRED",
      );
    for (const cid of sidecar.claimVersionIds)
      requireThat(
        g.claims
          .find((c) => c.versionId === cid)!
          .evidenceIds.every((e) => sidecar.evidenceIds.includes(e)),
        400,
        "SIDECAR_EVIDENCE_MISSING",
      );
  }
  for (const c of g.claims) {
    requireThat(
      c.status === "approved" && c.recordedFrom <= g.recordedCutoff,
      400,
      "CLAIM_NOT_APPROVED",
    );
    requireThat(
      c.evidenceIds.every((id) =>
        g.evidence.some(
          (e) =>
            e.evidenceId === id &&
            e.state === "fresh" &&
            e.visibility === "excerpt" &&
            e.domain === c.domain,
        ),
      ),
      400,
      "CLAIM_EVIDENCE_UNAVAILABLE",
    );
  }
  for (const e of g.evidence)
    requireThat(
      bundle.sourceManifest.some(
        (s) =>
          s.sourceVersionId === e.sourceVersionId &&
          s.rawSha256 === e.rawSha256,
      ),
      400,
      "SOURCE_MANIFEST_MISMATCH",
    );
  for (const c of bundle.cases)
    requireThat(
      c.expectedClaimIds.every((id) => g.claims.some((v) => v.claimId === id)),
      400,
      "EXPECTED_CLAIM_MISSING",
    );
}
/** Files cannot approve themselves. All projections must match authoritative DB
 * records at submission/review/activation. Already published bytes stay frozen. */
export function validateGroundingAuthority(
  store: Store,
  domain: string,
  bundle: BundleV2,
) {
  validateGroundingBundle(bundle);
  for (const c of bundle.groundingManifest.claims) {
    const stored = store.knowledgeGet<ClaimVersion>(
      "claim_versions",
      c.versionId,
    );
    requireThat(
      stored?.domain === domain &&
        hash(claimSnapshot(stored)) === hash(c) &&
        stored.status === "approved",
      409,
      "CLAIM_PROJECTION_MISMATCH",
    );
    requireThat(
      !store
        .knowledgeList<Conflict>("conflicts", domain)
        .some((f) => f.state === "open" && f.members.includes(c.versionId)),
      409,
      "CLAIM_CONFLICT_OPEN",
    );
  }
  for (const e of bundle.groundingManifest.evidence) {
    const stored = store.knowledgeGet<Evidence>("evidence", e.evidenceId);
    requireThat(stored?.domain === domain, 409, "EVIDENCE_UNAVAILABLE");
    const { id: _id, version: _version, ...snapshot } = stored;
    requireThat(
      hash(snapshot) === hash(e) && stored.state === "fresh",
      409,
      "EVIDENCE_PROJECTION_MISMATCH",
    );
  }
  for (const s of bundle.groundingManifest.sidecars)
    requireThat(s.domain === domain, 403, "GROUNDING_DOMAIN_MISMATCH");
}
export function requireGroundingRelease(
  store: Store,
  assets: AssetStore | undefined,
  domain: string,
  bundle: BundleV2,
) {
  requireThat(assets, 503, "KNOWLEDGE_WORKER_NOT_CONFIGURED");
  validateGroundingAuthority(store, domain, bundle);
  for (const evidence of bundle.groundingManifest.evidence) {
    verifyEvidence(store, assets, evidence);
    requireThat(
      bundle.sourceManifest.some(
        (s) => hash(s) === hash(sourceManifestEntry(store, evidence)),
      ),
      409,
      "SOURCE_MANIFEST_MISMATCH",
    );
  }
  for (const sid of new Set(
    bundle.groundingManifest.sidecars.map((s) => s.generationId),
  )) {
    const g = store.knowledgeGet<Generation>("generations", sid);
    requireThat(
      g?.domain === domain && g.state === "complete",
      409,
      "GENERATION_INCOMPLETE",
    );
    verifyGeneration(assets, g);
    for (const s of bundle.groundingManifest.sidecars.filter(
      (s) => s.generationId === sid,
    ))
      requireThat(
        g.bundle.groundingManifest.sidecars.some(
          (original) => hash(original) === hash(s),
        ),
        409,
        "SIDECAR_PROJECTION_MISMATCH",
      );
  }
}
