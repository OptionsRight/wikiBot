import { DatabaseSync, backup } from "node:sqlite";
import { access, cp, mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Store, hash } from "../src/core.js";
import type { Release } from "../src/publication.js";
import type { KnowledgeJob, SourceVersion } from "../src/knowledge/jobs.js";
import { AssetStore } from "../src/knowledge/assets.js";
import { verifyPublishedArtifacts } from "../src/knowledge/recovery.js";
import { rawSha256 } from "../src/knowledge/contracts.js";

const [mode, dbArg, assetArg, destinationArg] = process.argv.slice(2);
if (!["backup", "verify"].includes(mode ?? "") || !dbArg || !assetArg)
  throw Error(
    "Usage: knowledge-backup.ts backup DB ASSETS NEW_DIRECTORY | verify DB ASSETS",
  );
let database = resolve(dbArg),
  assets = resolve(assetArg);
if (mode === "backup") {
  if (!destinationArg) throw Error("Backup destination required");
  const destination = resolve(destinationArg);
  try {
    await access(destination);
    throw Error("Destination already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    await backup(db, join(destination, "database.sqlite"));
  } finally {
    db.close();
  }
  await cp(assets, join(destination, "assets"), {
    recursive: true,
    dereference: false,
  });
  database = join(destination, "database.sqlite");
  assets = join(destination, "assets");
}
const store = new Store(database),
  storage = new AssetStore(assets);
try {
  for (const s of store.knowledgeList<SourceVersion>("source_versions"))
    if (s.format) storage.read(s.domain, s.rawSha256);
  for (const j of store.knowledgeList<KnowledgeJob>("knowledge_jobs"))
    if (j.manifestHash) {
      storage.read(j.domain, j.manifestHash);
      for (const h of Object.values(j.artifacts ?? {}))
        storage.read(j.domain, h);
    }
  const releases = store
    .list<Release>("release")
    .filter((r) => ["active", "retired"].includes(r.state));
  for (const r of releases) {
    if (hash(r.bundle) !== r.descriptorHash)
      throw Error("BUNDLE_HASH_MISMATCH");
    verifyPublishedArtifacts(store, r, assets);
  }
  const report = {
    schemaVersion: 1,
    verifiedAt: Date.now(),
    releases: releases.map((r) => ({
      id: r.id,
      descriptorHash: r.descriptorHash,
    })),
    restoreRequiresIndependentAuthority: true,
  };
  if (mode === "backup")
    await writeFile(
      join(resolve(destinationArg!), "complete.json"),
      JSON.stringify(report, null, 2),
      { flag: "wx", mode: 0o600 },
    );
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
}
