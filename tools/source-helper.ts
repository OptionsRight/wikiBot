import { sourceConfiguration, sourceClient } from "./source-client.js";
import { realpath } from "node:fs/promises";
import {
  ControlledSource,
  isolatedMarkdownAdapter,
  manualMaintenanceAdapter,
} from "../src/controlled-source.js";
import { createPageManifest, bundleManifest } from "../src/source-formats.js";
import { snapshot } from "../src/snapshot.js";
import { hash, requireThat } from "../src/core.js";
import type { Revision } from "../src/revisions.js";
import type { SourceWorkspace } from "../src/source-maintenance.js";
import type { Bundle } from "../src/procedures.js";

// Operator-only CLI: token is read from the environment, never printed/stored in
// correction records. API paths/body never carry arbitrary shell commands.
const [configuration, revisionId, action = "apply"] = process.argv.slice(2);
requireThat(
  configuration && revisionId && ["apply", "snapshot"].includes(action),
  400,
  "Usage: tsx tools/source-helper.ts CONFIG.json REVISION_ID [apply|snapshot]",
);
const config = await sourceConfiguration(configuration);
const token = process.env.WIKIBOT_SOURCE_TOKEN;
requireThat(token, 401, "WIKIBOT_SOURCE_TOKEN_REQUIRED");
const api = sourceClient(config, token);
const prefix = `/api/domains/${config.domain}`;
const task = (await api(
  "GET",
  `${prefix}/source-tasks/${encodeURIComponent(revisionId)}`,
)) as { workspace: SourceWorkspace; revision: Revision; baseline: Bundle };
requireThat(
  (await realpath(config.root)) === (await realpath(task.workspace.root)),
  409,
  "SOURCE_ROOT_BINDING_CONFLICT",
);
const adapter =
  task.workspace.adapter.kind === "isolated-markdown"
    ? isolatedMarkdownAdapter()
    : manualMaintenanceAdapter();
requireThat(
  adapter.version === task.workspace.adapter.version,
  409,
  "SOURCE_ADAPTER_VERSION_UNSUPPORTED",
);
const source = new ControlledSource(config.records, adapter);
let revision = task.revision;
if (action === "apply") {
  revision = await api("POST", `${prefix}/revisions/${revisionId}/claim`, {
    expectedVersion: revision.version,
    workspaceVersion: task.workspace.version,
  });
  revision = await api("POST", `${prefix}/revisions/${revisionId}/start`, {
    leaseId: revision.maintenance!.leaseId,
  });
  const authorize = async () => {
    const checked = (await api(
      "POST",
      `${prefix}/revisions/${revisionId}/lease`,
      { leaseId: revision.maintenance!.leaseId },
    )) as Revision;
    requireThat(
      checked.maintenance!.bindingHash === task.workspace.bindingHash,
      409,
      "SOURCE_ROOT_BINDING_CONFLICT",
    );
  };
  const journal = await source.apply(
    {
      id: revisionId,
      domain: config.domain,
      root: config.root,
      responsible: revision.owner,
      reason: revision.reason,
      scope: revision.scope,
      evidence: revision.changes.map((c) => c.source).join("\n"),
      pages: task.baseline.pages,
      changes: revision.changes.map((c) => ({
        pageId: c.pageId,
        content: c.content,
      })),
    },
    authorize,
  );
  await api("POST", `${prefix}/revisions/${revisionId}/source-result`, {
    leaseId: revision.maintenance!.leaseId,
    state:
      journal.state === "applied"
        ? "applied"
        : journal.state === "conflict"
          ? "conflict"
          : "recovery_required",
    journalHash: hash(journal),
    evidence: `来源助手 ${adapter.kind}/${adapter.version}；更正记录 ${journal.id}；结果 ${journal.state}；需管理员核对具体更正与范围。`,
  });
  process.stdout.write(
    JSON.stringify({
      revisionId,
      state: journal.state,
      journalHash: hash(journal),
    }) + "\n",
  );
} else {
  requireThat(
    revision.maintenance?.state === "applied",
    409,
    "SOURCE_RECOVERY_REQUIRED",
  );
  await api("POST", `${prefix}/revisions/${revisionId}/lease`, {
    leaseId: revision.maintenance.leaseId,
  });
  await source.verifyCorrections(config.root);
  const correctedBaseline = task.baseline.pages.map((p) => ({
    ...p,
    hash: hash(
      revision.changes.find((c) => c.pageId === p.id)?.content ?? p.content,
    ),
  }));
  const pages = await createPageManifest(
    config.root,
    correctedBaseline,
    {},
    (task.baseline.sourceArtifacts ?? []).map((a) => a.path),
  );
  const bundle = await snapshot(
    config.root,
    { ...bundleManifest(task.baseline), pages },
    {
      correctionStore: config.records,
      approvedAttachmentTypes: task.workspace.approvedAttachmentTypes,
    },
  );
  const candidate = await api(
    "POST",
    `${prefix}/submissions`,
    bundle,
    `source-snapshot:${revisionId}:${hash(bundle)}`,
  );
  process.stdout.write(
    JSON.stringify({
      revisionId,
      candidateId: candidate.id,
      descriptorHash: candidate.descriptorHash,
      state: candidate.state,
      next: "管理员关联修订 snapshot，运行金样例评估、复核最终差异并显式激活。",
    }) + "\n",
  );
}
