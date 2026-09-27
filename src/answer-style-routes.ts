import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { body, key, path } from "./app.js";
import {
  Store,
  access,
  requireThat,
  hash,
  id,
  type Entity,
  type Domain,
} from "./core.js";
import { currentRelease, modelState, type Release } from "./publication.js";
import { bundleSchema } from "./procedures.js";
import {
  answerTemplatesSchema,
  recommendedAnswerTemplates,
  type AnswerTemplates,
} from "./answer-style.js";

interface StyleDraft extends Entity {
  baseReleaseId: string;
  templates: AnswerTemplates;
  caseId: string;
  candidateId?: string;
}

export function registerAnswerStyle(app: FastifyInstance, store: Store) {
  const route = "/api/domains/:domain/answer-style";
  app.get(route, async (request) => {
    const domain = path(request, "domain");
    access(store, request.actor, domain, true);
    const active = currentRelease(store, request.actor, domain);
    const draft = store.get<StyleDraft>("answer-style-draft", domain);
    const candidate = draft?.candidateId
      ? store.get<Release>("release", draft.candidateId)
      : undefined;
    return {
      active: { id: active.id, descriptorHash: active.descriptorHash },
      publishedTemplates: active.bundle.config.answerTemplates ?? null,
      recommendedTemplates: recommendedAnswerTemplates,
      cases: active.bundle.cases.filter(
        (c) =>
          !active.answerStyle?.caseIds.includes(c.id) &&
          (c.expectedOutcome ?? "answer") === "answer" &&
          c.expectedCitations?.length,
      ),
      draft: draft ?? null,
      candidate:
        candidate?.domain === domain
          ? {
              id: candidate.id,
              version: candidate.version,
              state: candidate.state,
              descriptorHash: candidate.descriptorHash,
              baseEpoch: candidate.baseEpoch,
              baseActive: candidate.baseActive,
              cases: candidate.bundle.cases,
              caseIds: candidate.answerStyle?.caseIds ?? [],
            }
          : null,
    };
  });
  app.put(`${route}/draft`, async (request) => {
    const domain = path(request, "domain");
    const input = body(
      z
        .object({
          expectedVersion: z.number().int().nonnegative(),
          baseReleaseId: z.string(),
          templates: answerTemplatesSchema,
          caseId: z.string(),
        })
        .strict(),
      request,
    );
    return store.command(
      request.actor,
      domain,
      "answer-style-draft",
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        const active = currentRelease(store, request.actor, domain);
        requireThat(active.id === input.baseReleaseId, 409, "BASELINE_STALE");
        const old = store.get<StyleDraft>("answer-style-draft", domain);
        requireThat(
          (old?.version ?? 0) === input.expectedVersion,
          409,
          "VERSION_CONFLICT",
        );
        requireThat(
          active.bundle.cases.some(
            (c) =>
              c.id === input.caseId &&
              (c.expectedOutcome ?? "answer") === "answer" &&
              c.expectedCitations?.length,
          ),
          400,
          "STYLE_ANSWER_CASE_REQUIRED",
        );
        return store.put<StyleDraft>("answer-style-draft", {
          id: domain,
          domain,
          version: input.expectedVersion + 1,
          baseReleaseId: active.id,
          templates: input.templates,
          caseId: input.caseId,
        });
      },
    );
  });
  app.post(`${route}/submissions`, async (request, reply) => {
    const domain = path(request, "domain");
    const input = body(
      z.object({ expectedVersion: z.number().int().positive() }).strict(),
      request,
    );
    const candidate = store.command(
      request.actor,
      domain,
      "submit-answer-style",
      key(request),
      input,
      () => access(store, request.actor, domain, true),
      () => {
        const draft = store.get<StyleDraft>("answer-style-draft", domain);
        requireThat(
          draft && draft.version === input.expectedVersion,
          409,
          "VERSION_CONFLICT",
        );
        const active = currentRelease(store, request.actor, domain);
        requireThat(draft.baseReleaseId === active.id, 409, "BASELINE_STALE");
        requireThat(
          active.descriptorHash === hash(active.bundle) &&
            active.bundleHash === hash(active.bundle.pages),
          409,
          "CONTENT_CHANGED",
        );
        const m = modelState(
          store,
          active.bundle.config.model,
          active.bundle.config.modelRevision,
        );
        requireThat(
          m.qualified && m.epoch === active.modelEpoch,
          503,
          "MODEL_REVALIDATION_REQUIRED",
        );
        const seed = active.bundle.cases.find((c) => c.id === draft.caseId);
        requireThat(
          seed &&
            (seed.expectedOutcome ?? "answer") === "answer" &&
            seed.expectedCitations?.length,
          400,
          "STYLE_ANSWER_CASE_REQUIRED",
        );
        // Replace only previews created by this feature. Preserve the original
        // golden cases and avoid accumulating four extra cases per publication.
        const cases = active.bundle.cases.filter(
          (c) => !active.answerStyle?.caseIds.includes(c.id),
        );
        const caseIds: string[] = [];
        for (const style of ["business", "technical"] as const)
          for (const depth of ["beginner", "experienced"] as const) {
            let caseId = `expression_${style}_${depth}`;
            while (cases.some((c) => c.id === caseId))
              caseId = `expression_${id()}`;
            caseIds.push(caseId);
            cases.push({ ...seed, id: caseId, style, depth });
          }
        requireThat(cases.length <= 100, 400, "STYLE_CASE_LIMIT_EXCEEDED");
        // This route accepts expression text only. Reuse the exact, hashed
        // active pages and source artifacts, including older approved packages;
        // new or edited knowledge still uses the full submission validator.
        const bundle = bundleSchema.parse({
          ...active.bundle,
          cases,
          config: { ...active.bundle.config, answerTemplates: draft.templates },
        });
        const domainState = store.get<Domain>("domain", domain)!;
        const r = store.put<Release>("release", {
          id: id(),
          domain,
          version: 1,
          bundle,
          descriptorHash: hash(bundle),
          bundleHash: active.bundleHash,
          state: "submitted",
          baseEpoch: domainState.epoch,
          baseActive: active.id,
          modelEpoch: m.epoch,
          answerStyle: {
            sourceReleaseId: active.id,
            draftVersion: draft.version,
            caseIds,
          },
        });
        store.put<StyleDraft>("answer-style-draft", {
          ...draft,
          version: draft.version + 1,
          candidateId: r.id,
        });
        return r;
      },
    );
    return reply.code(201).send(candidate);
  });
}
