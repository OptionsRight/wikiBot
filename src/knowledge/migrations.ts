import type { DatabaseSync } from "node:sqlite";

export const databaseVersion = 4;
/** Runs on the owning Store connection, once, before serving traffic. */
export function migrateKnowledge(db: DatabaseSync) {
  const current = Number(db.prepare("PRAGMA user_version").get()?.user_version);
  if (current >= 4) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of knowledgeTables) {
      db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY, domain TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE INDEX ${table}_domain ON ${table}(domain);`);
    }
    db.exec(`CREATE UNIQUE INDEX claim_coordinate ON claims(domain,json_extract(data,'$.coordinate'));
      CREATE INDEX claim_version_history ON claim_versions(domain,json_extract(data,'$.claimId'),json_extract(data,'$.recordedFrom'));
      CREATE INDEX evidence_source ON evidence(domain,json_extract(data,'$.sourceVersionId'));
      CREATE UNIQUE INDEX job_cache ON knowledge_jobs(domain,json_extract(data,'$.cacheKey'));
      PRAGMA user_version=4; COMMIT;`);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export const knowledgeTables = [
  "source_assets",
  "source_versions",
  "knowledge_jobs",
  "claims",
  "claim_versions",
  "evidence",
  "claim_evidence",
  "conflicts",
  "page_claims",
  "release_claims",
  "claim_events",
  "generations",
  "dependency_edges",
  "semantic_reports",
] as const;
export type KnowledgeTable = (typeof knowledgeTables)[number];
