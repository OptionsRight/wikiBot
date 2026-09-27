import { cp, mkdtemp, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { hash, requireThat } from "../src/core.js";
import { createPageManifest } from "../src/source-formats.js";
import { sourceInventory, readSourceText } from "../src/source-files.js";
import {
  ControlledSource,
  isolatedMarkdownAdapter,
} from "../src/controlled-source.js";

// Read-only source, disposable isolated copy. Outputs hashes/counts only; no
// source text, credentials or real business correctness claims are recorded.
const [workspace] = process.argv.slice(2);
requireThat(
  workspace,
  400,
  "Usage: tsx tools/source-roundtrip-probe.ts WIKI_ROOT",
);
const original = resolve(workspace, "knowledge"),
  before = hash(await sourceInventory(original));
const dir = await mkdtemp(join(tmpdir(), "wikibot-real-copy-"));
try {
  const root = join(dir, "knowledge");
  await cp(original, root, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await writeFile(
    join(root, ".wikibot-isolated-copy"),
    "isolated experiment\n",
  );
  const manifest = await createPageManifest(root);
  const chosen =
    manifest.find(
      (p) => p.path.startsWith("workflows/") && !p.path.includes("overview"),
    ) ?? manifest[0]!;
  const content = await readSourceText(root, chosen.path),
    corrected =
      content +
      "\n\n> 仅隔离副本的合成维护实验标记；不是专家结论或业务规则。\n";
  const pages = await Promise.all(
    manifest.map(async (p) => ({
      ...p,
      content: await readSourceText(root, p.path),
    })),
  );
  const source = new ControlledSource(
    join(dir, "corrections"),
    isolatedMarkdownAdapter(),
  );
  const journal = await source.apply(
    {
      id: "isolated-real-copy",
      domain: "probe",
      root,
      responsible: "synthetic-maintainer",
      reason: "隔离副本往返可执行实验",
      scope: "不改变真实来源，不用于业务验收",
      evidence:
        "现有广告 Wiki JSON frontmatter 维护契约；不是原 llm-wiki skill",
      pages,
      changes: [{ pageId: chosen.id, content: corrected }],
    },
    async () => {},
  );
  requireThat(journal.state === "applied", 409, "PROBE_APPLY_FAILED");
  const moved = chosen.path.replace(/\.md$/, "-isolated-renamed.md");
  await rename(join(root, chosen.path), join(root, moved));
  const renamed = await createPageManifest(root, manifest);
  requireThat(
    renamed.some((p) => p.id === chosen.id && p.path === moved),
    409,
    "PROBE_ID_CHANGED",
  );
  await source.verifyCorrections(root, renamed);
  await writeFile(join(root, moved), content); // simulate stale importer in this isolated copy only
  let overwriteRejected = false;
  try {
    await source.verifyCorrections(root, renamed);
  } catch {
    overwriteRejected = true;
  }
  requireThat(overwriteRejected, 409, "PROBE_CORRECTION_LOSS_NOT_DETECTED");
  await writeFile(join(root, moved), corrected);
  await source.verifyCorrections(root, renamed);
  const after = hash(await sourceInventory(original));
  requireThat(after === before, 409, "ORIGINAL_SOURCE_CHANGED_DURING_PROBE");
  process.stdout.write(
    JSON.stringify(
      {
        kind: "isolated-copy-of-real-wiki",
        pages: manifest.length,
        uniqueIds: new Set(manifest.map((p) => p.id)).size,
        originalInventoryHash: before,
        originalUnchanged: after === before,
        apply: journal.state,
        renameIdentityPreserved: true,
        staleReimportRejected: overwriteRejected,
        restoredCorrectionVerified: true,
        changedPageIdHash: hash(chosen.id),
        beforeHash: hash(content),
        afterHash: hash(corrected),
        contract: "advert-knowledge JSON frontmatter/manual adapter",
        originalLlmWikiSkillVerified: false,
        businessAcceptance: false,
        cleanup: "temporary source and correction records removed by finally",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
