import { Store, requireThat } from "../core.js";
import { isV2 } from "../procedures.js";
import type { Release } from "../publication.js";
import { AssetStore } from "./assets.js";
import { validateGroundingBundle } from "./sidecars.js";
import { verifyEvidence } from "./evidence.js";
import { verifyGeneration, type Generation } from "./generations.js";

export function verifyPublishedArtifacts(
  store: Store,
  release: Release,
  root?: string,
) {
  if (!isV2(release.bundle)) return;
  requireThat(root, 503, "KNOWLEDGE_ASSETS_REQUIRED");
  const assets = new AssetStore(root);
  validateGroundingBundle(release.bundle);
  // Frozen releases use immutable sources. Current draft rejection/recordedTo
  // changes cannot rewrite the historical release being recovered.
  for (const e of release.bundle.groundingManifest.evidence)
    verifyEvidence(store, assets, e);
  for (const gid of new Set(
    release.bundle.groundingManifest.sidecars.map((s) => s.generationId),
  )) {
    const g = store.knowledgeGet<Generation>("generations", gid);
    requireThat(g?.domain === release.domain, 409, "GENERATION_INCOMPLETE");
    verifyGeneration(assets, g);
  }
}
