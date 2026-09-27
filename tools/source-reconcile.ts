import { sourceConfiguration, sourceClient } from "./source-client.js";
import { readFile, realpath } from "node:fs/promises";
import {
  ControlledSource,
  manualMaintenanceAdapter,
} from "../src/controlled-source.js";
import { hash, requireThat } from "../src/core.js";

// Read-only source inspection plus explicit local/server recovery records.
// Stop the former helper and all other writers before running this command.
const [configuration, revisionId, outcome, evidenceFile] =
  process.argv.slice(2);
requireThat(
  configuration &&
    revisionId &&
    evidenceFile &&
    ["applied", "baseline_restored"].includes(outcome ?? ""),
  400,
  "Usage: tsx tools/source-reconcile.ts CONFIG.json REVISION_ID applied|baseline_restored EVIDENCE.txt",
);
const config = await sourceConfiguration(configuration);
const token = process.env.WIKIBOT_MAINTAINER_TOKEN;
requireThat(token, 401, "WIKIBOT_MAINTAINER_TOKEN_REQUIRED");
const api = sourceClient(config, token);
const prefix = `/api/domains/${config.domain}`;
const workspace = await api("GET", `${prefix}/source-workspace`);
requireThat(
  (await realpath(config.root)) === (await realpath(workspace.root)),
  409,
  "SOURCE_ROOT_BINDING_CONFLICT",
);
const evidence = await readFile(evidenceFile, "utf8");
requireThat(
  evidence.length >= 30 && evidence.length <= 10000,
  400,
  "RECOVERY_EVIDENCE_REQUIRED",
);
const source = new ControlledSource(config.records, manualMaintenanceAdapter());
const journal = await source.reconcile(
  revisionId,
  outcome as "applied" | "baseline_restored",
  evidence,
  async () => {
    const grant = await api("GET", `${prefix}/capabilities`);
    requireThat(grant.role === "admin", 403, "FORBIDDEN");
  },
);
const revision = await api("GET", `${prefix}/revisions/${revisionId}`);
const result = await api(
  "POST",
  `${prefix}/revisions/${revisionId}/reconcile`,
  {
    expectedVersion: revision.version,
    outcome,
    journalHash: hash(journal),
    evidence,
  },
);
process.stdout.write(
  JSON.stringify({
    revisionId,
    state: result.maintenance.state,
    journalHash: hash(journal),
  }) + "\n",
);
