import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { Store, id, hash, requireThat, type Entity } from "../core.js";
import type { Bundle, BundleV2 } from "../procedures.js";
import { wireHash, rawSha256, type EvidenceSnapshot } from "./contracts.js";
import { claimSnapshot, type ClaimVersion, type Evidence } from "./claims.js";
import { createSidecar, validateGroundingAuthority } from "./sidecars.js";
import { sourceManifestEntry, verifyEvidence } from "./evidence.js";
import { AssetStore } from "./assets.js";

export interface Generation extends Entity {
  state: "complete";
  descriptorHash: string;
  manifestHash: string;
  files: { name: string; hash: string }[];
  bundle: BundleV2;
  requestHash?: string;
}
export function buildGroundedBundle(
  store: Store,
  assets: AssetStore,
  domain: string,
  base: Bundle,
  mode: "page" | "mixed" | "claims",
  mapping: Record<string, string[]>,
  evalPolicy: BundleV2["evalPolicy"],
  cases: BundleV2["cases"],
) {
  const generationId = id();
  const claims = [...new Set(Object.values(mapping).flat())].map((cid) => {
    const c = store.knowledgeGet<ClaimVersion>("claim_versions", cid);
    requireThat(
      c?.domain === domain && c.status === "approved",
      409,
      "CLAIM_NOT_APPROVED",
    );
    return claimSnapshot(c);
  });
  const evidence: EvidenceSnapshot[] = [
    ...new Set(claims.flatMap((c) => c.evidenceIds)),
  ].map((eid) => {
    const e = store.knowledgeGet<Evidence>("evidence", eid);
    requireThat(e?.domain === domain, 409, "EVIDENCE_UNAVAILABLE");
    verifyEvidence(store, assets, e);
    const { id: _id, version: _version, ...snapshot } = e;
    return snapshot;
  });
  const entries = evidence.map((e) => sourceManifestEntry(store, e));
  // A source version cannot silently bind two parser profiles in one release.
  for (const e of entries)
    requireThat(
      entries
        .filter((s) => s.sourceVersionId === e.sourceVersionId)
        .every((s) => hash(s) === hash(e)),
      409,
      "SOURCE_PROFILE_AMBIGUOUS",
    );
  const bundle: BundleV2 = {
    ...base,
    schemaVersion: 2,
    config: { ...base.config, protocolVersion: "2" },
    cases,
    evalPolicy,
    sourceManifest: [
      ...new Map(entries.map((s) => [s.sourceVersionId, s])).values(),
    ],
    groundingManifest: {
      schemaVersion: 1,
      mode,
      policyVersion: "1",
      recordedCutoff: Math.max(
        Date.now(),
        ...claims.map((c) => c.recordedFrom),
      ),
      claims,
      evidence,
      sidecars: base.pages.map((p) =>
        createSidecar(
          domain,
          p,
          generationId,
          claims.filter((c) => mapping[p.id]?.includes(c.versionId)),
          mapping[p.id]?.length
            ? mode === "claims"
              ? "claims"
              : "mixed"
            : "legacy_page",
        ),
      ),
    },
    dependencyManifest: {
      schemaVersion: 1,
      resolverVersion: "1",
      extractorProfileHash: wireHash(
        claims.map((c) => c.extractionProfileHash).sort(),
      ),
      edges: [
        ...evidence.map((e) => ({
          from: e.sourceVersionId,
          to: e.evidenceId,
          kind: "evidence" as const,
        })),
        ...claims.flatMap((c) =>
          c.evidenceIds.map((e) => ({
            from: e,
            to: c.versionId,
            kind: "claim" as const,
          })),
        ),
        ...Object.entries(mapping).flatMap(([page, ids]) =>
          ids.map((cid) => ({ from: cid, to: page, kind: "page" as const })),
        ),
        ...cases.flatMap((c) =>
          (c.expectedCitations ?? []).map((p) => ({
            from: p,
            to: c.id,
            kind: "case" as const,
          })),
        ),
      ],
    },
  };
  validateGroundingAuthority(store, domain, bundle);
  return { generationId, bundle };
}
/** A single manifest commits the whole immutable directory, followed by one DB
 * transaction. An orphan directory is safe; a missing manifest is never complete. */
export function writeGeneration(
  assets: AssetStore,
  domain: string,
  generationId: string,
  bundle: BundleV2,
) {
  const root = join(assets.root, "generations", generationId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const files: { name: string; hash: string }[] = [];
  for (const page of bundle.pages) {
    const sidecar = bundle.groundingManifest.sidecars.find(
      (s) => s.pageId === page.id,
    )!;
    for (const [name, content] of [
      [`${page.id}.md`, page.content],
      [`${page.id}.json`, JSON.stringify(sidecar)],
    ]) {
      writeFileSync(join(root, name!), content!, {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      files.push({ name: name!, hash: rawSha256(content!) });
    }
  }
  const manifest = {
    schemaVersion: 1,
    domain,
    generationId,
    descriptorHash: hash(bundle),
    files,
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  writeFileSync(join(root, "complete.json"), bytes, {
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
  const manifestHash = assets.put(domain, bytes);
  return {
    id: generationId,
    domain,
    version: 1,
    state: "complete" as const,
    descriptorHash: hash(bundle),
    manifestHash,
    files,
    bundle,
  };
}
export function verifyGeneration(assets: AssetStore, g: Generation) {
  const root = join(assets.root, "generations", g.id),
    manifest = join(root, "complete.json");
  requireThat(
    existsSync(manifest) &&
      !lstatSync(root).isSymbolicLink() &&
      !lstatSync(manifest).isSymbolicLink(),
    409,
    "GENERATION_INCOMPLETE",
  );
  requireThat(
    rawSha256(readFileSync(manifest)) === g.manifestHash,
    409,
    "GENERATION_MANIFEST_MISMATCH",
  );
  assets.read(g.domain, g.manifestHash);
  for (const f of g.files) {
    requireThat(
      /^[a-zA-Z0-9_-]+\.(md|json)$/.test(f.name),
      409,
      "GENERATION_FILE_INVALID",
    );
    const path = join(root, f.name);
    requireThat(
      existsSync(path) &&
        !lstatSync(path).isSymbolicLink() &&
        rawSha256(readFileSync(path)) === f.hash,
      409,
      "GENERATION_INCOMPLETE",
    );
  }
}
