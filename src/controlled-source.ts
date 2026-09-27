import {
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { join, resolve, relative, dirname, sep } from "node:path";
import { hash, requireThat, id } from "./core.js";
import {
  readSourceText,
  sourceTarget,
  sourceInventory,
  sourcePath,
} from "./source-files.js";
import type { Page } from "./procedures.js";
import { createPageManifest, type PageManifest } from "./source-formats.js";

export interface CorrectionPlan {
  id: string;
  domain: string;
  root: string;
  responsible: string;
  reason: string;
  scope: string;
  evidence: string;
  pages: Page[];
  changes: { pageId: string; content: string }[];
}
export interface SourceEdit {
  pageId: string;
  path: string;
  beforeHash: string;
  afterHash: string;
  before: string;
  after: string;
}
export interface MaintenanceAdapter {
  kind: "manual" | "isolated-markdown";
  version: string;
  // Must be a pinned, operator-configured entry, never a command supplied by a page/model.
  apply(root: string, change: SourceEdit): Promise<void>;
}
export interface CorrectionJournal {
  id: string;
  domain: string;
  root: string;
  responsible: string;
  reason: string;
  scope: string;
  evidence: string;
  adapter: { kind: string; version: string };
  state: "prepared" | "writing" | "applied" | "conflict" | "recovery_required";
  sequence: number;
  planHash: string;
  createdAt: number;
  files: SourceEdit[];
  completed: string[];
  recoveryEvidence?: string;
  retryApproved?: boolean;
}
// Deliberately limited to marked isolated copies. Real-source maintenance remains
// a manual handoff until an actual skill/version is validated by its maintainer.
export function isolatedMarkdownAdapter(): MaintenanceAdapter {
  return {
    kind: "isolated-markdown",
    version: "1",
    async apply(root, change) {
      const marker = await readFile(
        join(root, ".wikibot-isolated-copy"),
        "utf8",
      );
      requireThat(
        marker.trim() === "isolated experiment",
        403,
        "ISOLATED_COPY_REQUIRED",
      );
      const target = await sourceTarget(root, change.path);
      requireThat(
        hash(await readSourceText(root, change.path)) === change.beforeHash,
        409,
        "SOURCE_BASELINE_CONFLICT",
      );
      const temp = join(dirname(target), `.wikibot-${id()}.tmp`);
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(change.after, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        requireThat(
          hash(await readSourceText(root, change.path)) === change.beforeHash,
          409,
          "SOURCE_BASELINE_CONFLICT",
        );
        await rename(temp, target);
      } finally {
        await rm(temp, { force: true });
      }
    },
  };
}
export function manualMaintenanceAdapter(): MaintenanceAdapter {
  return {
    kind: "manual",
    version: "contract-1",
    async apply() {
      throw new Error("MANUAL_HANDOFF_REQUIRED");
    },
  };
}
export class ControlledSource {
  constructor(
    private readonly records: string,
    private readonly adapter: MaintenanceAdapter,
  ) {}
  private path(rid: string) {
    requireThat(
      /^[a-zA-Z0-9_-]{1,100}$/.test(rid),
      400,
      "INVALID_CORRECTION_ID",
    );
    return join(this.records, `${rid}.json`);
  }
  private async save(journal: CorrectionJournal) {
    const target = this.path(journal.id),
      temp = `${target}.${id()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(journal, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    const history = await open(`${target}.events`, "a", 0o600);
    try {
      await history.writeFile(JSON.stringify(journal) + "\n");
      await history.sync();
    } finally {
      await history.close();
    }
    await rename(temp, target);
    const dir = await open(this.records, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  private async load(rid: string): Promise<CorrectionJournal | undefined> {
    try {
      return JSON.parse(
        await readFile(this.path(rid), "utf8"),
      ) as CorrectionJournal;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }
  async inspect(rid: string) {
    const journal = await this.load(rid);
    requireThat(journal, 404, "CORRECTION_NOT_FOUND");
    const files = await Promise.all(
      journal.files.map(async (f) => ({
        ...f,
        observedHash: hash(await readSourceText(journal.root, f.path)),
      })),
    );
    return { ...journal, files };
  }
  async apply(
    plan: CorrectionPlan,
    authorize: () => Promise<void>,
  ): Promise<CorrectionJournal> {
    await authorize();
    await mkdir(this.records, { recursive: true, mode: 0o700 });
    const root = await realpath(plan.root),
      records = await realpath(this.records);
    requireThat(
      (relative(root, records) === ".." ||
        relative(root, records).startsWith(`..${sep}`)) &&
        (relative(records, root) === ".." ||
          relative(records, root).startsWith(`..${sep}`)),
      400,
      "SEPARATE_CORRECTION_STORE_REQUIRED",
    );
    // A local lock only excludes this helper. The online authorization callback
    // must also verify a human window, paired root, current authority and lease.
    const lock = join(this.records, ".source-lock");
    try {
      await mkdir(lock);
    } catch {
      throw new Error("SOURCE_HELPER_LOCKED_OR_RECOVERY_REQUIRED");
    }
    try {
      const old = await this.load(plan.id);
      if (old) {
        requireThat(old.planHash === hash(plan), 409, "CORRECTION_ID_CONFLICT");
        if (!old.retryApproved) return old;
      }
      requireThat(
        plan.changes.length > 0 &&
          plan.changes.length <= 50 &&
          new Set(plan.changes.map((c) => c.pageId)).size ===
            plan.changes.length,
        400,
        "INVALID_CORRECTION",
      );
      const files: SourceEdit[] = [];
      for (const c of plan.changes) {
        const page = plan.pages.find((p) => p.id === c.pageId);
        requireThat(page, 400, "UNKNOWN_CORRECTION_PAGE");
        sourcePath(page.path);
        requireThat(
          page.path.endsWith(".md") &&
            !page.path.split("/").includes("source-docs"),
          403,
          "RAW_SOURCE_READ_ONLY",
        );
        requireThat(
          Buffer.byteLength(c.content) <= 200000 && c.content.length > 0,
          400,
          "INVALID_CORRECTION",
        );
        files.push({
          pageId: page.id,
          path: page.path,
          before: page.content,
          beforeHash: page.hash,
          after: c.content,
          afterHash: hash(c.content),
        });
      }
      const journal: CorrectionJournal = {
        id: plan.id,
        domain: plan.domain,
        root,
        responsible: plan.responsible,
        reason: plan.reason,
        scope: plan.scope,
        evidence: plan.evidence,
        adapter: { kind: this.adapter.kind, version: this.adapter.version },
        planHash: hash(plan),
        sequence: old ? old.sequence + 1 : 0,
        createdAt: old?.createdAt ?? Date.now(),
        state: "prepared",
        files,
        completed: [],
      };
      await this.save(journal); // preserve independent correction material before any source mutation
      try {
        await this.verifyCorrections(root);
        const inventory = await sourceInventory(root);
        for (const p of plan.pages)
          requireThat(
            hash(await readSourceText(root, p.path)) === p.hash &&
              hash(p.content) === p.hash,
            409,
            "SOURCE_BASELINE_CONFLICT",
          );
        for (const edit of files) {
          await authorize();
          requireThat(
            hash(await sourceInventory(root)) === hash(inventory),
            409,
            "SOURCE_DIRECTORY_CHANGED",
          );
          journal.state = "writing";
          journal.sequence++;
          await this.save(journal);
          await this.adapter.apply(root, edit);
          requireThat(
            hash(await readSourceText(root, edit.path)) === edit.afterHash,
            409,
            "SOURCE_WRITE_UNCONFIRMED",
          );
          const entry = inventory.find((p) => p.path === edit.path)!;
          entry.hash = hash(Buffer.from(edit.after).toString("base64"));
          journal.completed.push(edit.pageId);
          journal.sequence++;
          await this.save(journal);
        }
        await authorize();
        requireThat(
          hash(await sourceInventory(root)) === hash(inventory),
          409,
          "SOURCE_DIRECTORY_CHANGED",
        );
        journal.state = "applied";
      } catch {
        journal.state =
          journal.state === "prepared" ? "conflict" : "recovery_required";
      }
      journal.sequence++;
      await this.save(journal);
      return journal;
    } finally {
      await rm(lock, { recursive: true });
    }
  }
  async reconcile(
    rid: string,
    outcome: "applied" | "baseline_restored",
    evidence: string,
    authorize: () => Promise<void>,
  ) {
    await authorize();
    requireThat(evidence.length >= 20, 400, "RECOVERY_EVIDENCE_REQUIRED");
    const lock = join(this.records, ".source-lock");
    try {
      await mkdir(lock);
    } catch {
      throw new Error("SOURCE_HELPER_LOCKED_OR_RECOVERY_REQUIRED");
    }
    try {
      const observed = await this.inspect(rid);
      requireThat(
        observed.files.every(
          (f) =>
            f.observedHash ===
            (outcome === "applied" ? f.afterHash : f.beforeHash),
        ),
        409,
        "SOURCE_RECOVERY_MISMATCH",
      );
      const journal = (await this.load(rid))!;
      journal.state = outcome === "applied" ? "applied" : "conflict";
      journal.retryApproved = outcome === "baseline_restored";
      journal.recoveryEvidence = evidence;
      journal.sequence++;
      await this.save(journal);
      return journal;
    } finally {
      await rm(lock, { recursive: true });
    }
  }

  async verifyCorrections(root: string, manifest?: PageManifest[]) {
    const base = await realpath(root),
      expected = new Map<string, { path: string; hash: string }>();
    const journals: CorrectionJournal[] = [];
    try {
      for (const file of await readdir(this.records))
        if (file.endsWith(".json"))
          journals.push(
            JSON.parse(await readFile(join(this.records, file), "utf8")),
          );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    for (const j of journals
      .filter((j) => j.root === base)
      .sort((a, b) => a.createdAt - b.createdAt)) {
      requireThat(
        !["writing", "recovery_required"].includes(j.state),
        409,
        "SOURCE_RECOVERY_REQUIRED",
      );
      if (j.state === "applied")
        for (const f of j.files)
          expected.set(f.pageId, { path: f.path, hash: f.afterHash });
    }
    const current =
      manifest ??
      (expected.size
        ? await createPageManifest(
            base,
            [...expected].map(([id, prior]) => ({
              id,
              path: prior.path,
              hash: prior.hash,
              title: id,
            })),
          )
        : []);
    for (const [pageId, prior] of expected) {
      const path = current.find((p) => p.id === pageId)?.path ?? prior.path;
      requireThat(
        hash(await readSourceText(base, path)) === prior.hash,
        409,
        "CORRECTION_LOST",
      );
    }
  }
}
