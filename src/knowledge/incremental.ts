import { Store, hash, type Entity } from "../core.js";
import type { BundleV2, Page } from "../procedures.js";
import type { AssetStore } from "./assets.js";
import { verifyEvidence } from "./evidence.js";
import type { TextSource } from "./evidence.js";
import type { Evidence } from "./claims.js";
import { wireHash } from "./contracts.js";

export interface Impact {
  state: "no_change" | "needs_review" | "blocked";
  changed: string[];
  added: string[];
  deleted: string[];
  renamed: { from: string; to: string }[];
  invalidEvidence: string[];
  affectedClaims: string[];
  affectedPages: string[];
  affectedCases: string[];
}
export function analyzeIncremental(
  store: Store,
  assets: AssetStore,
  domain: string,
  bundle: BundleV2,
  pages: Page[],
  currentSources: TextSource[],
): Impact {
  const prior = bundle.sourceManifest,
    changed: string[] = [],
    deleted: string[] = [],
    invalidEvidence: string[] = [],
    renamed: Impact["renamed"] = [];
  const currentById = new Map(currentSources.map((s) => [s.sourceId, s]));
  for (const old of prior) {
    const current = currentById.get(old.sourceId);
    if (!current) {
      deleted.push(old.sourceVersionId);
      const candidates = currentSources.filter(
        (s) =>
          s.rawSha256 === old.rawSha256 &&
          !prior.some((p) => p.sourceId === s.sourceId),
      );
      if (candidates.length === 1)
        renamed.push({ from: old.sourceVersionId, to: candidates[0]!.id });
    } else if (
      current.id !== old.sourceVersionId ||
      current.rawSha256 !== old.rawSha256 ||
      current.profileHash !== old.profileHash ||
      current.artifactHash !== old.artifactHash
    )
      changed.push(old.sourceVersionId);
  }
  const added = currentSources
    .filter((s) => !prior.some((p) => p.sourceId === s.sourceId))
    .map((s) => s.id);
  for (const e of bundle.groundingManifest.evidence) {
    try {
      verifyEvidence(store, assets, e);
      const authority = store.knowledgeGet<Evidence>("evidence", e.evidenceId);
      if (!authority || authority.state !== "fresh")
        invalidEvidence.push(e.evidenceId);
    } catch {
      invalidEvidence.push(e.evidenceId);
    }
    if (
      changed.includes(e.sourceVersionId) ||
      deleted.includes(e.sourceVersionId)
    )
      invalidEvidence.push(e.evidenceId);
  }
  const changedPages = bundle.pages
    .filter(
      (p) =>
        !pages.some(
          (n) =>
            n.id === p.id && n.hash === p.hash && hash(n.content) === n.hash,
        ),
    )
    .map((p) => p.id);
  let badSidecar = false;
  for (const sidecar of bundle.groundingManifest.sidecars) {
    const { projectionHash, ...body } = sidecar;
    if (wireHash(body) !== projectionHash) {
      badSidecar = true;
      changedPages.push(sidecar.pageId);
    }
    // Normal bundle validation checks projection hash; page changes always
    // invalidate it, even when no source was selected by the planner.
    if (
      !pages.some((p) => p.id === sidecar.pageId && p.hash === sidecar.pageHash)
    )
      changedPages.push(sidecar.pageId);
  }
  const reached = new Set([
    ...changed,
    ...deleted,
    ...invalidEvidence,
    ...changedPages,
  ]);
  let progress = true;
  while (progress) {
    progress = false;
    for (const edge of bundle.dependencyManifest.edges)
      if (reached.has(edge.from) && !reached.has(edge.to)) {
        reached.add(edge.to);
        progress = true;
      }
  }
  const affectedPages = bundle.pages
    .filter((p) => reached.has(p.id))
    .map((p) => p.id);
  // New/deleted files may alter overview semantics beyond recorded edges.
  if (added.length || deleted.length)
    for (const p of bundle.pages)
      if (!affectedPages.includes(p.id)) affectedPages.push(p.id);
  const affectedCases = bundle.cases
    .filter(
      (c) =>
        reached.has(c.id) ||
        (c.expectedCitations ?? []).some((p) => affectedPages.includes(p)),
    )
    .map((c) => c.id);
  return {
    state:
      badSidecar || invalidEvidence.length || deleted.length
        ? "blocked"
        : changed.length || added.length || changedPages.length
          ? "needs_review"
          : "no_change",
    changed,
    added,
    deleted,
    renamed,
    invalidEvidence: [...new Set(invalidEvidence)],
    affectedClaims: bundle.groundingManifest.claims
      .filter((c) => reached.has(c.versionId))
      .map((c) => c.versionId),
    affectedPages,
    affectedCases,
  };
}
