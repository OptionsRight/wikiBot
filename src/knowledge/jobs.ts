import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Store,
  access,
  id,
  requireThat,
  type Entity,
  type Identity,
} from "../core.js";
import { AssetStore } from "./assets.js";
import {
  normalizedSchema,
  rawSha256,
  wireHash,
  type NormalizerProfile,
  type NormalizedDocument,
} from "./contracts.js";

export interface SourceVersion extends Entity {
  sourceId: string;
  format: "pdf" | "docx" | "pptx" | "xlsx";
  rawSha256: string;
  bytes: number;
  createdAt: number;
  actor: string;
}
export interface KnowledgeJob extends Entity {
  kind: "normalize";
  sourceVersionId: string;
  actor: string;
  cacheKey: string;
  profile: NormalizerProfile;
  profileHash: string;
  state:
    "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
  attempt: number;
  fencingToken?: string;
  deadline?: number;
  startedAt?: number;
  finishedAt?: number;
  manifestHash?: string;
  artifacts?: Record<string, string>;
  result?: NormalizedDocument;
  code?: string;
}
export interface KnowledgeOptions {
  repositories?: Record<string, import("./git.js").RepositoryConfig>;
  assetRoot: string;
  normalizerPython?: string;
  normalizerProfile: NormalizerProfile;
  pollMs?: number;
}

export function enqueueNormalization(
  store: Store,
  actor: Identity,
  source: SourceVersion,
  profile: NormalizerProfile,
): KnowledgeJob {
  const profileHash = wireHash(profile),
    cacheKey = wireHash([
      source.domain,
      source.id,
      source.rawSha256,
      profileHash,
    ]);
  const cached = store
    .knowledgeList<KnowledgeJob>("knowledge_jobs", source.domain)
    .find((j) => j.cacheKey === cacheKey);
  if (cached) return cached;
  return store.knowledgePut<KnowledgeJob>("knowledge_jobs", {
    id: id(),
    domain: source.domain,
    version: 1,
    kind: "normalize",
    sourceVersionId: source.id,
    actor: actor.subject,
    cacheKey,
    profile,
    profileHash,
    state: "queued",
    attempt: 0,
  });
}
export function recoverKnowledgeJobs(store: Store, force = false) {
  store.tx(() => {
    for (const j of store.knowledgeList<KnowledgeJob>("knowledge_jobs")) {
      if (
        j.state === "running" &&
        (force || !j.deadline || j.deadline <= Date.now())
      )
        store.knowledgePut("knowledge_jobs", {
          ...j,
          state: "failed",
          code: "EXECUTION_UNKNOWN",
          fencingToken: undefined,
          version: j.version + 1,
        });
    }
  });
}
export function settleNormalization(
  store: Store,
  assets: AssetStore,
  job: KnowledgeJob,
  result: NormalizedDocument,
  artifacts: Record<string, string>,
) {
  return store.tx(() => {
    const current = store.knowledgeGet<KnowledgeJob>("knowledge_jobs", job.id)!;
    requireThat(
      current.state === "running" &&
        current.fencingToken === job.fencingToken &&
        current.attempt === job.attempt &&
        current.deadline! > Date.now(),
      409,
      "JOB_FENCED",
    );
    access(store, { subject: job.actor, platform: false }, job.domain, true);
    const source = store.knowledgeGet<SourceVersion>(
      "source_versions",
      job.sourceVersionId,
    )!;
    requireThat(
      result.jobId === job.id &&
        result.attempt === job.attempt &&
        result.fencingToken === job.fencingToken &&
        result.sourceVersionId === source.id &&
        result.rawSha256 === source.rawSha256 &&
        result.profileHash === job.profileHash &&
        result.doclingVersion === job.profile.doclingVersion,
      409,
      "JOB_RESULT_MISMATCH",
    );
    requireThat(
      result.finishedAt >= result.startedAt &&
        result.finishedAt <= Date.now() &&
        result.startedAt >= job.startedAt!,
      409,
      "JOB_TIME_MISMATCH",
    );
    if (result.parseStatus !== "failed")
      requireThat(
        result.artifacts.length === 3 &&
          new Set(result.artifacts.map((a) => a.name)).size === 3,
        409,
        "INCOMPLETE_ARTIFACTS",
      );
    for (const artifact of result.artifacts) {
      requireThat(
        artifacts[artifact.name] === artifact.rawSha256 &&
          assets.read(job.domain, artifact.rawSha256).length === artifact.bytes,
        409,
        "ARTIFACT_MISMATCH",
      );
    }
    for (const block of result.blocks)
      requireThat(
        rawSha256(block.text) === block.contentHash,
        409,
        "BLOCK_HASH_MISMATCH",
      );
    if (result.artifacts.length)
      requireThat(
        wireHash(
          JSON.parse(
            assets.read(job.domain, artifacts["blocks.json"]!).toString("utf8"),
          ),
        ) === wireHash(result.blocks),
        409,
        "BLOCK_INDEX_MISMATCH",
      );
    if (result.parseStatus === "complete")
      requireThat(
        result.blocks.length > 0 && result.warnings.length === 0,
        409,
        "INCOMPLETE_PARSE",
      );
    const manifestHash = assets.put(
      job.domain,
      Buffer.from(JSON.stringify(result)),
    );
    return store.knowledgePut<KnowledgeJob>("knowledge_jobs", {
      ...current,
      state:
        result.parseStatus === "complete" ? "succeeded" : result.parseStatus,
      manifestHash,
      artifacts,
      result,
      finishedAt: Date.now(),
      fencingToken: undefined,
      version: current.version + 1,
    });
  });
}

export class KnowledgeWorker {
  private busy = false;
  private closing = false;
  private timer?: NodeJS.Timeout;
  private current?: Promise<void>;
  readonly assets: AssetStore;
  constructor(
    private store: Store,
    readonly options: KnowledgeOptions,
  ) {
    this.assets = new AssetStore(options.assetRoot);
  }
  start() {
    recoverKnowledgeJobs(this.store);
    this.timer = setInterval(() => {
      this.current = this.tick().catch(() => {});
    }, this.options.pollMs ?? 1000);
    this.timer.unref();
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await this.current;
  }
  async tick() {
    if (this.busy || this.closing || !this.options.normalizerPython) return;
    this.busy = true;
    let job: KnowledgeJob | undefined;
    try {
      // A crash after a complete manifest but before DB commit can be resumed
      // only while the original fencing lease is still valid.
      for (const running of this.store
        .knowledgeList<KnowledgeJob>("knowledge_jobs")
        .filter((j) => j.state === "running" && j.deadline! > Date.now())) {
        const root = join(
          resolve(this.options.assetRoot),
          "jobs",
          running.id,
          running.fencingToken!,
        );
        try {
          const result = normalizedSchema.parse(
              JSON.parse(await readFile(join(root, "complete.json"), "utf8")),
            ),
            artifacts: Record<string, string> = {};
          for (const a of result.artifacts) {
            const bytes = await readFile(join(root, a.name));
            requireThat(
              bytes.length === a.bytes && rawSha256(bytes) === a.rawSha256,
              409,
              "ARTIFACT_MISMATCH",
            );
            artifacts[a.name] = this.assets.put(running.domain, bytes);
          }
          settleNormalization(
            this.store,
            this.assets,
            running,
            result,
            artifacts,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            this.store.tx(() => {
              const current = this.store.knowledgeGet<KnowledgeJob>(
                "knowledge_jobs",
                running.id,
              )!;
              if (
                current.state === "running" &&
                current.fencingToken === running.fencingToken
              )
                this.store.knowledgePut("knowledge_jobs", {
                  ...current,
                  state: "failed",
                  code: "RECOVERY_RESULT_REJECTED",
                  fencingToken: undefined,
                  version: current.version + 1,
                });
            });
        }
      }
      recoverKnowledgeJobs(this.store);
      job = this.store.tx(() => {
        const next = this.store
          .knowledgeList<KnowledgeJob>("knowledge_jobs")
          .find((j) => j.state === "queued");
        if (!next) return;
        try {
          access(
            this.store,
            { subject: next.actor, platform: false },
            next.domain,
            true,
          );
        } catch {
          this.store.knowledgePut("knowledge_jobs", {
            ...next,
            state: "cancelled",
            code: "JOB_ACCESS_REVOKED",
            version: next.version + 1,
          });
          return;
        }
        return this.store.knowledgePut<KnowledgeJob>("knowledge_jobs", {
          ...next,
          state: "running",
          attempt: next.attempt + 1,
          fencingToken: id(),
          startedAt: Date.now(),
          deadline: Date.now() + next.profile.timeoutMs + 10000,
          version: next.version + 1,
        });
      });
      if (!job) return;
      const source = this.store.knowledgeGet<SourceVersion>(
        "source_versions",
        job.sourceVersionId,
      )!;
      const root = join(
        resolve(this.options.assetRoot),
        "jobs",
        job.id,
        job.fencingToken!,
      );
      await mkdir(root, { recursive: true, mode: 0o700 });
      await writeFile(
        join(root, `input.${source.format}`),
        this.assets.read(job.domain, source.rawSha256),
        { flag: "wx", mode: 0o600 },
      );
      await writeFile(
        join(root, "task.json"),
        JSON.stringify({
          schemaVersion: 1,
          jobId: job.id,
          domain: job.domain,
          actorRef: job.actor,
          inputManifestHash: wireHash([
            source.id,
            source.rawSha256,
            job.profileHash,
          ]),
          deadline: job.deadline,
          outputRootRef: `${job.id}/${job.fencingToken}`,
          attempt: job.attempt,
          fencingToken: job.fencingToken,
          sourceVersionId: source.id,
          rawSha256: source.rawSha256,
          profileHash: job.profileHash,
          profile: job.profile,
          format: source.format,
        }),
        { flag: "wx", mode: 0o600 },
      );
      const script = fileURLToPath(
        new URL("../../python/normalizer/worker.py", import.meta.url),
      );
      // Fixed executable and script; no shell, source paths, or model-supplied argv.
      await new Promise<void>((done, reject) => {
        const child = spawn(this.options.normalizerPython!, [script, root], {
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: "ignore",
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            PYTHONUTF8: "1",
            DOCLING_ARTIFACTS_PATH: process.env.DOCLING_ARTIFACTS_PATH,
          },
        });
        const timer = setTimeout(
          () => {
            if (child.pid) {
              if (process.platform === "win32")
                execFile(
                  "taskkill",
                  ["/PID", String(child.pid), "/T", "/F"],
                  { windowsHide: true },
                  () => {},
                );
              else
                try {
                  process.kill(-child.pid, "SIGKILL");
                } catch {}
            }
            reject(new Error("PARSER_TIMEOUT"));
          },
          Math.max(1, job!.deadline! - Date.now()),
        );
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          code === 0 ? done() : reject(new Error("PARSER_PROCESS_FAILED"));
        });
      });
      const result = normalizedSchema.parse(
        JSON.parse(await readFile(join(root, "complete.json"), "utf8")),
      );
      const artifacts: Record<string, string> = {};
      for (const artifact of result.artifacts) {
        const bytes = await readFile(join(root, artifact.name));
        requireThat(
          bytes.length === artifact.bytes &&
            rawSha256(bytes) === artifact.rawSha256,
          409,
          "ARTIFACT_MISMATCH",
        );
        artifacts[artifact.name] = this.assets.put(job.domain, bytes);
      }
      settleNormalization(this.store, this.assets, job, result, artifacts);
    } catch (error) {
      if (job)
        this.store.tx(() => {
          const current = this.store.knowledgeGet<KnowledgeJob>(
            "knowledge_jobs",
            job!.id,
          )!;
          if (
            current.fencingToken === job!.fencingToken &&
            current.state === "running"
          )
            this.store.knowledgePut("knowledge_jobs", {
              ...current,
              state: "failed",
              code:
                error instanceof Error && /^[A-Z_]+$/.test(error.message)
                  ? error.message
                  : "NORMALIZATION_FAILED",
              fencingToken: undefined,
              version: current.version + 1,
            });
        });
    } finally {
      this.busy = false;
    }
  }
}
