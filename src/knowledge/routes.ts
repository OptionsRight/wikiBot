import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  Store,
  access,
  id,
  hash,
  requireThat,
  version,
  type Entity,
} from "../core.js";
import { body, key, path } from "../app.js";
import { knowledgeId, profileSchema } from "./contracts.js";
import {
  KnowledgeWorker,
  enqueueNormalization,
  type KnowledgeJob,
  type KnowledgeOptions,
  type SourceVersion,
} from "./jobs.js";
import {
  proposeClaim,
  proposalSchema,
  approveClaims,
  resolveConflict,
  temporalMatch,
  type ClaimVersion,
} from "./claims.js";
import {
  registerWikiSource,
  createTextEvidence,
  createDocumentEvidence,
} from "./evidence.js";
import { bundleSchema, bundleV2Schema, bundleV1Schema } from "../procedures.js";
import {
  buildGroundedBundle,
  writeGeneration,
  type Generation,
} from "./generations.js";
import { requireGroundingRelease } from "./sidecars.js";
import {
  captureRepository,
  registerCodeSnapshot,
  deriveCodeWiki,
  type CodeSnapshot,
} from "./git.js";
import { analyzeIncremental } from "./incremental.js";
import type { TextSource } from "./evidence.js";
import type { Evidence } from "./claims.js";

export function registerKnowledge(
  app: FastifyInstance,
  store: Store,
  options?: KnowledgeOptions,
) {
  const worker = options
    ? new KnowledgeWorker(store, {
        ...options,
        normalizerProfile: profileSchema.parse(options.normalizerProfile),
      })
    : undefined;
  worker?.start();
  app.addHook("onClose", async () => {
    await worker?.close();
  });
  app.get("/api/domains/:domain/code-sources", async (request) => {
    const domain = path(request, "domain");
    access(store, request.actor, domain, true);
    return {
      repositories: Object.keys(options?.repositories ?? {}).filter((key) =>
        key.startsWith(domain + ":"),
      ),
      snapshots: store
        .list<CodeSnapshot>("code-snapshot", domain)
        .map(({ sources, ...s }) => ({ ...s, fileCount: sources.length })),
      drafts: store.list("code-wiki", domain),
    };
  });
  app.post(
    "/api/domains/:domain/code-sources/:id/snapshots",
    async (request) => {
      const domain = path(request, "domain"),
        repoId = path(request, "id");
      body(z.object({}).strict(), request);
      access(store, request.actor, domain, true);
      const config = options?.repositories?.[`${domain}:${repoId}`];
      requireThat(config, 404, "REPOSITORY_NOT_CONFIGURED");
      const snapshot = await captureRepository(domain, repoId, config);
      return store.command(
        request.actor,
        domain,
        `code:snapshot:${repoId}`,
        key(request),
        {
          commit: snapshot.commit,
          configurationHash: snapshot.configurationHash,
        },
        () => access(store, request.actor, domain, true),
        () => {
          registerCodeSnapshot(store, snapshot);
          return store.put("code-wiki", deriveCodeWiki(store, snapshot));
        },
      );
    },
  );
  app.post("/api/domains/:domain/knowledge-builds/impact", async (request) => {
    const domain = path(request, "domain"),
      input = body(
        z
          .object({
            bundle: bundleV2Schema,
            pages: bundleV1Schema.shape.pages,
            sourceVersionIds: z.array(knowledgeId).max(2000),
          })
          .strict(),
        request,
      );
    requireThat(worker, 503, "KNOWLEDGE_WORKER_NOT_CONFIGURED");
    return store.command(
      request.actor,
      domain,
      "knowledge:impact",
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        const sources = input.sourceVersionIds.map((sid) => {
          const s = store.knowledgeGet<TextSource>("source_versions", sid);
          requireThat(s?.domain === domain, 404, "NOT_FOUND");
          return s;
        });
        const result = analyzeIncremental(
          store,
          worker.assets,
          domain,
          input.bundle,
          input.pages,
          sources,
        );
        for (const eid of result.invalidEvidence) {
          const e = store.knowledgeGet<Evidence>("evidence", eid);
          if (e?.domain === domain && e.state === "fresh")
            store.knowledgePut("evidence", {
              ...e,
              state: "stale",
              version: e.version + 1,
            });
        }
        return store.put("knowledge-impact", {
          id: id(),
          domain,
          version: 1,
          createdAt: Date.now(),
          ...result,
        });
      },
    );
  });
  app.get("/api/domains/:domain/knowledge-builds", async (request) => {
    const domain = path(request, "domain");
    access(store, request.actor, domain, true);
    return {
      generations: store.knowledgeList("generations", domain),
      impacts: store.list("knowledge-impact", domain),
    };
  });
  app.get("/api/domains/:domain/claims", async (request) => {
    const domain = path(request, "domain");
    access(store, request.actor, domain, true);
    const q = z
      .object({
        validAt: z.coerce.number().int().nonnegative().optional(),
        knownAt: z.coerce.number().int().nonnegative().optional(),
      })
      .parse(request.query);
    return {
      claims: store.knowledgeList("claims", domain),
      versions: store
        .knowledgeList<ClaimVersion>("claim_versions", domain)
        .filter((c) => temporalMatch(c, q.validAt, q.knownAt)),
      evidence: store.knowledgeList("evidence", domain),
      conflicts: store.knowledgeList("conflicts", domain),
      events: store.knowledgeList("claim_events", domain),
    };
  });
  app.post("/api/domains/:domain/claims", async (request) => {
    const domain = path(request, "domain"),
      input = body(proposalSchema, request);
    return store.command(
      request.actor,
      domain,
      "claim:propose",
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => proposeClaim(store, request.actor, domain, input),
    );
  });
  app.post("/api/domains/:domain/claims/review-batch", async (request) => {
    const domain = path(request, "domain"),
      input = body(
        z
          .object({
            versions: z
              .array(
                z
                  .object({
                    id: knowledgeId,
                    expectedVersion: z.number().int().positive(),
                  })
                  .strict(),
              )
              .min(1)
              .max(1000),
            reason: z.string().min(10).max(2000),
          })
          .strict(),
        request,
      );
    return store.command(
      request.actor,
      domain,
      "claim:review-batch",
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () =>
        approveClaims(
          store,
          request.actor,
          domain,
          input.versions,
          input.reason,
        ),
    );
  });
  app.post("/api/domains/:domain/conflicts/:id/resolve", async (request) => {
    const domain = path(request, "domain"),
      cid = path(request, "id"),
      input = body(
        z
          .object({
            expectedVersion: z.number().int().positive(),
            members: z.array(knowledgeId).min(1),
            rejectVersionIds: z.array(knowledgeId),
            dismissEvidenceIds: z.array(knowledgeId).optional(),
            reason: z.string().min(10).max(2000),
          })
          .strict(),
        request,
      );
    return store.command(
      request.actor,
      domain,
      `conflict:resolve:${cid}`,
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => resolveConflict(store, request.actor, domain, cid, input),
    );
  });
  app.post("/api/domains/:domain/evidence/wiki", async (request) => {
    const domain = path(request, "domain"),
      input = body(
        z
          .object({
            page: bundleV1Schema.shape.pages.element,
            startLine: z.number().int().positive(),
            endLine: z.number().int().positive(),
          })
          .strict(),
        request,
      );
    return store.command(
      request.actor,
      domain,
      "evidence:wiki",
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        const source = registerWikiSource(store, domain, input.page);
        return createTextEvidence(
          store,
          domain,
          source.id,
          input.startLine,
          input.endLine,
        );
      },
    );
  });
  app.post("/api/domains/:domain/evidence/document", async (request) => {
    const domain = path(request, "domain"),
      input = body(
        z
          .object({
            jobId: knowledgeId,
            blockId: knowledgeId,
            partialReviewReason: z.string().min(10).max(2000).optional(),
          })
          .strict(),
        request,
      );
    requireThat(worker, 503, "KNOWLEDGE_WORKER_NOT_CONFIGURED");
    return store.command(
      request.actor,
      domain,
      "evidence:document",
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () =>
        createDocumentEvidence(
          store,
          worker.assets,
          domain,
          input.jobId,
          input.blockId,
          input.partialReviewReason,
        ),
    );
  });
  app.post("/api/domains/:domain/knowledge-builds", async (request) => {
    const domain = path(request, "domain"),
      input = body(
        z
          .object({
            base: bundleSchema,
            mode: z.enum(["page", "mixed", "claims"]),
            mapping: z.record(knowledgeId, z.array(knowledgeId)),
            evalPolicy: bundleV2Schema.shape.evalPolicy,
            cases: bundleV2Schema.shape.cases,
          })
          .strict(),
        request,
      );
    access(store, request.actor, domain, true);
    requireThat(worker, 503, "KNOWLEDGE_WORKER_NOT_CONFIGURED");
    const previous = store
      .knowledgeList<Generation>("generations", domain)
      .find((g) => g.requestHash === hash(input));
    if (previous) {
      requireGroundingRelease(store, worker.assets, domain, previous.bundle);
      return store.command(
        request.actor,
        domain,
        "knowledge:build",
        key(request),
        input,
        () => access(store, request.actor, domain, true),
        () => previous,
      );
    }
    // Files are materialized before the short business transaction. A repeated
    // command may leave an orphan generation but never a partial DB reference.
    const built = buildGroundedBundle(
      store,
      worker.assets,
      domain,
      input.base,
      input.mode,
      input.mapping,
      input.evalPolicy,
      input.cases,
    );
    const generation = writeGeneration(
      worker.assets,
      domain,
      built.generationId,
      built.bundle,
    );
    return store.command(
      request.actor,
      domain,
      "knowledge:build",
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        for (const s of generation.bundle.groundingManifest.sidecars)
          for (const cid of s.claimVersionIds) {
            store.knowledgePut("page_claims", {
              id: hash([generation.id, s.pageId, cid]),
              domain,
              version: 1,
              generationId: generation.id,
              pageId: s.pageId,
              pageVersionHash: s.pageHash,
              claimVersionId: cid,
            });
            const task = store.get<Entity>("claim-projection", cid);
            if (task)
              store.put("claim-projection", {
                ...task,
                state: "complete",
                generationId: generation.id,
                version: task.version + 1,
              });
          }
        for (const edge of generation.bundle.dependencyManifest.edges)
          store.knowledgePut("dependency_edges", {
            id: hash([generation.id, edge]),
            domain,
            version: 1,
            generationId: generation.id,
            ...edge,
          });
        return store.knowledgePut("generations", {
          ...generation,
          requestHash: hash(input),
        });
      },
    );
  });
  app.get("/api/domains/:domain/sources", async (request) => {
    const domain = path(request, "domain");
    access(store, request.actor, domain, true);
    return {
      sources: store.knowledgeList("source_assets", domain),
      versions: store.knowledgeList("source_versions", domain),
      jobs: store.knowledgeList("knowledge_jobs", domain),
      configured: !!worker,
    };
  });
  app.post("/api/domains/:domain/sources", async (request) => {
    const domain = path(request, "domain"),
      input = body(
        z
          .object({ id: knowledgeId, title: z.string().min(1).max(300) })
          .strict(),
        request,
      );
    return store.command(
      request.actor,
      domain,
      "source:create",
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        requireThat(
          !store.knowledgeGet("source_assets", `${domain}_${input.id}`),
          409,
          "SOURCE_EXISTS",
        );
        return store.knowledgePut("source_assets", {
          id: `${domain}_${input.id}`,
          domain,
          version: 1,
          title: input.title,
          createdAt: Date.now(),
        });
      },
    );
  });
  app.post(
    "/api/domains/:domain/sources/:id/files",
    { bodyLimit: 140 * 1024 * 1024 },
    async (request, reply) => {
      const domain = path(request, "domain"),
        sid = path(request, "id");
      access(store, request.actor, domain, true);
      requireThat(worker, 503, "KNOWLEDGE_WORKER_NOT_CONFIGURED");
      const input = body(
        z
          .object({
            expectedVersion: z.number().int().positive(),
            format: z.enum(["pdf", "docx", "pptx", "xlsx"]),
            content: z
              .string()
              .min(1)
              .max(140 * 1024 * 1024),
          })
          .strict(),
        request,
      );
      requireThat(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          input.content,
        ),
        400,
        "INVALID_BASE64",
      );
      const bytes = Buffer.from(input.content, "base64");
      requireThat(
        bytes.length > 0 &&
          bytes.length <= worker.options.normalizerProfile.maxBytes,
        413,
        "SOURCE_TOO_LARGE",
      );
      requireThat(
        input.format === "pdf"
          ? bytes.subarray(0, 5).toString() === "%PDF-"
          : bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])),
        400,
        "MIME_MISMATCH",
      );
      const rawSha256 = worker.assets.put(domain, bytes);
      const result = store.command(
        request.actor,
        domain,
        `source:upload:${sid}`,
        key(request),
        {
          expectedVersion: input.expectedVersion,
          format: input.format,
          rawSha256,
        },
        () => access(store, request.actor, domain, true),
        () => {
          const source = store.knowledgeGet<Entity>("source_assets", sid);
          requireThat(source?.domain === domain, 404, "NOT_FOUND");
          version(source, input.expectedVersion);
          const previous = store
            .knowledgeList<SourceVersion>("source_versions", domain)
            .find(
              (s) =>
                s.sourceId === sid &&
                s.rawSha256 === rawSha256 &&
                s.format === input.format,
            );
          if (previous) return previous;
          const v = store.knowledgePut<SourceVersion>("source_versions", {
            id: id(),
            domain,
            version: 1,
            sourceId: sid,
            format: input.format,
            rawSha256,
            bytes: bytes.length,
            createdAt: Date.now(),
            actor: request.actor.subject,
          });
          store.knowledgePut("source_assets", {
            ...source,
            version: source.version + 1,
            latestVersionId: v.id,
          });
          return v;
        },
      );
      return reply.code(201).send(result);
    },
  );
  app.get(
    "/api/domains/:domain/sources/:id/files/:versionId",
    async (request, reply) => {
      const domain = path(request, "domain");
      access(store, request.actor, domain, true);
      requireThat(worker, 503, "KNOWLEDGE_WORKER_NOT_CONFIGURED");
      const source = store.knowledgeGet<SourceVersion>(
        "source_versions",
        path(request, "versionId"),
      );
      requireThat(
        source?.domain === domain &&
          source.sourceId === path(request, "id") &&
          source.format,
        404,
        "NOT_FOUND",
      );
      return reply
        .type("application/octet-stream")
        .header(
          "content-disposition",
          `attachment; filename="${source.id}.${source.format}"`,
        )
        .send(worker.assets.read(domain, source.rawSha256));
    },
  );
  app.post(
    "/api/domains/:domain/sources/:id/normalize",
    async (request, reply) => {
      const domain = path(request, "domain"),
        sid = path(request, "id"),
        input = body(
          z.object({ sourceVersionId: knowledgeId }).strict(),
          request,
        );
      requireThat(worker, 503, "KNOWLEDGE_WORKER_NOT_CONFIGURED");
      const job = store.command(
        request.actor,
        domain,
        `source:normalize:${sid}`,
        key(request),
        input,
        () => access(store, request.actor, domain, true),
        () => {
          const source = store.knowledgeGet<SourceVersion>(
            "source_versions",
            input.sourceVersionId,
          );
          requireThat(
            source?.domain === domain && source.sourceId === sid,
            404,
            "NOT_FOUND",
          );
          return enqueueNormalization(
            store,
            request.actor,
            source,
            worker.options.normalizerProfile,
          );
        },
      );
      return reply.code(202).send(job);
    },
  );
  app.get("/api/domains/:domain/knowledge-jobs/:id", async (request) => {
    const domain = path(request, "domain");
    access(store, request.actor, domain, true);
    const job = store.knowledgeGet<KnowledgeJob>(
      "knowledge_jobs",
      path(request, "id"),
    );
    requireThat(job?.domain === domain, 404, "NOT_FOUND");
    return job;
  });
  app.post("/api/domains/:domain/knowledge-jobs/:id/retry", async (request) => {
    const domain = path(request, "domain"),
      jid = path(request, "id"),
      input = body(
        z.object({ expectedVersion: z.number().int().positive() }).strict(),
        request,
      );
    return store.command(
      request.actor,
      domain,
      `job:retry:${jid}`,
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        const j = store.knowledgeGet<KnowledgeJob>("knowledge_jobs", jid);
        requireThat(j?.domain === domain, 404, "NOT_FOUND");
        version(j, input.expectedVersion);
        requireThat(
          ["failed", "cancelled"].includes(j.state),
          409,
          "INVALID_STATE",
        );
        return store.knowledgePut<KnowledgeJob>("knowledge_jobs", {
          ...j,
          state: "queued",
          actor: request.actor.subject,
          fencingToken: undefined,
          code: undefined,
          version: j.version + 1,
        });
      },
    );
  });
  app.get(
    "/api/domains/:domain/knowledge-jobs/:id/artifacts/:name",
    async (request, reply) => {
      const domain = path(request, "domain");
      access(store, request.actor, domain, true);
      requireThat(worker, 503, "KNOWLEDGE_WORKER_NOT_CONFIGURED");
      const j = store.knowledgeGet<KnowledgeJob>(
        "knowledge_jobs",
        path(request, "id"),
      );
      requireThat(j?.domain === domain, 404, "NOT_FOUND");
      const name = path(request, "name"),
        hash = j.artifacts?.[name];
      requireThat(hash, 404, "NOT_FOUND");
      return reply
        .type(
          name.endsWith(".json")
            ? "application/json; charset=utf-8"
            : "text/plain; charset=utf-8",
        )
        .send(worker.assets.read(domain, hash));
    },
  );
}
