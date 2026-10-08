import { isV2, type Bundle } from "../procedures.js";
import type { RetrievedPage } from "../retrieval.js";
import { temporalMatch } from "./claims.js";
import type { ClaimSnapshot, EvidenceSnapshot } from "./contracts.js";

export interface EvidenceContext {
  mode: "page" | "mixed" | "claims";
  claims: ClaimSnapshot[];
  evidence: EvidenceSnapshot[];
  pages: { pageId: string; claimVersionIds: string[]; evidenceIds: string[] }[];
}
/** Release-local data only. No reads from draft Claim tables or live sources. */
export function evidenceContext(
  bundle: Bundle,
  retrieved: RetrievedPage[],
  validAt?: number,
) {
  if (!isV2(bundle)) return { pages: retrieved, grounding: undefined };
  const g = bundle.groundingManifest,
    pages: RetrievedPage[] = [],
    claims: ClaimSnapshot[] = [],
    evidence: EvidenceSnapshot[] = [],
    maps: EvidenceContext["pages"] = [];
  let budget = 60000;
  for (const r of retrieved) {
    const sidecar = g.sidecars.find(
      (s) => s.pageId === r.page.id && s.pageHash === r.page.hash,
    );
    if (!sidecar) continue;
    const all = sidecar.claimVersionIds.map((id) =>
      g.claims.find((c) => c.versionId === id),
    );
    if (
      all.some(
        (c) =>
          !c ||
          c.status !== "approved" ||
          c.evidenceIds.some(
            (eid) =>
              !g.evidence.some(
                (e) =>
                  e.evidenceId === eid &&
                  e.state === "fresh" &&
                  e.visibility === "excerpt",
              ),
          ),
      )
    )
      continue;
    const usable = (all as ClaimSnapshot[]).filter((c) =>
      validAt === undefined
        ? c.validityKind === "unknown" || temporalMatch(c, Date.now())
        : temporalMatch(c, validAt),
    );
    // Do not expose the full page as a way around a non-applicable fact.
    if (usable.length !== all.length) continue;
    const es = g.evidence.filter((e) =>
      usable.some((c) => c.evidenceIds.includes(e.evidenceId)),
    );
    if (g.mode === "claims" && !usable.length) continue;
    const content =
      g.mode === "claims"
        ? usable.map((c) => c.statement).join("\n")
        : r.content;
    const size = Buffer.byteLength(JSON.stringify([content, usable, es]));
    if (size > budget) continue;
    budget -= size;
    pages.push({ ...r, content });
    claims.push(...usable);
    evidence.push(...es);
    maps.push({
      pageId: r.page.id,
      claimVersionIds: usable.map((c) => c.versionId),
      evidenceIds: es.map((e) => e.evidenceId),
    });
  }
  return {
    pages,
    grounding: {
      mode: g.mode,
      claims: [...new Map(claims.map((c) => [c.versionId, c])).values()],
      evidence: [...new Map(evidence.map((e) => [e.evidenceId, e])).values()],
      pages: maps,
    } satisfies EvidenceContext,
  };
}
