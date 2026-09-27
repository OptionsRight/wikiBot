import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  Store,
  access,
  defaultStyle,
  id,
  requireThat,
  Fault,
  type Entity,
  type Identity,
} from "./core.js";
import { body, path, key } from "./app.js";
import {
  allowedRelease,
  currentRelease,
  modelState,
  type Release,
} from "./publication.js";
import { retrieve } from "./retrieval.js";
import type { ModelGateway } from "./adapters/model.js";
import { generateAnswer } from "./explanation.js";

export interface Block {
  sequence: number;
  type: "explanation" | "status";
  text: string;
  citations: string[];
}
export interface Answer extends Entity {
  owner: string;
  question: string;
  releaseId: string;
  descriptorHash: string;
  session: string;
  style: "business" | "technical";
  depth: "beginner" | "experienced";
  state: "queued" | "running" | "complete" | "failed" | "incomplete";
  code: string;
  blocks: Block[];
  createdAt: number;
  deadline: number;
  finishedAt?: number;
  modelEpoch: number;
  lease?: string;
  leaseUntil?: number;
  callStarted?: boolean;
  review: "clear" | "pending" | "invalid";
  reviewReason?: string;
  exposedThrough: number;
  deliveredThrough: number;
  deliveryCancelledAt?: number;
  modelMetrics?: unknown;
  history?: { question: string; answer: string }[];
}
export interface Preference extends Entity {
  cleared?: boolean;
  owner: string;
  style: "business" | "technical";
  depth: "beginner" | "experienced";
}
const answerSchema = z
  .object({
    question: z.string().min(1).max(4000),
    sessionId: z.string().min(1).max(100),
    style: z.enum(["business", "technical"]).optional(),
    depth: z.enum(["beginner", "experienced"]).optional(),
  })
  .strict();

export class AnswerService {
  private working = new Set<Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private timer: NodeJS.Timeout;
  private readonly deadlineMs: number;
  constructor(
    private store: Store,
    private model?: ModelGateway,
  ) {
    this.deadlineMs = Number(process.env.ANSWER_DEADLINE_MS ?? 15000);
    requireThat(
      Number.isFinite(this.deadlineMs) && this.deadlineMs > 0,
      400,
      "INVALID_ANSWER_DEADLINE",
    );
    this.timer = setInterval(() => this.tick(), 100);
    this.timer.unref();
  }
  async close() {
    clearInterval(this.timer);
    for (const c of this.controllers.values()) c.abort();
    await Promise.allSettled(this.working);
  }
  tick() {
    for (const a of this.store.list<Answer>("answer")) {
      if (a.state === "running" && a.leaseUntil! < Date.now())
        this.store.tx(() => {
          const latest = this.store.get<Answer>("answer", a.id)!;
          if (latest.state === "running" && latest.leaseUntil! < Date.now())
            this.store.put("answer", {
              ...latest,
              state: latest.blocks.length ? "incomplete" : "failed",
              code: "EXECUTION_UNKNOWN",
              version: latest.version + 1,
              lease: undefined,
              finishedAt: Date.now(),
            });
        });
      if (a.state === "queued" && this.working.size < 8) {
        const work = this.run(a.id);
        this.working.add(work);
        void work.finally(() => this.working.delete(work));
      }
    }
  }
  create(
    actor: Identity,
    domain: string,
    input: z.infer<typeof answerSchema>,
    idem: string,
  ): Answer {
    const answer = this.store.command(
      actor,
      domain,
      "ask",
      idem,
      input,
      () => access(this.store, actor, domain),
      () => {
        const release = currentRelease(this.store, actor, domain),
          m = modelState(
            this.store,
            release.bundle.config.model,
            release.bundle.config.modelRevision,
          );
        requireThat(
          m.qualified && m.epoch === release.modelEpoch,
          503,
          "MODEL_REVALIDATION_REQUIRED",
        );
        const pref = this.store.get<Preference>(
          "preference",
          `${domain}:${actor.subject}`,
        );
        return this.store.put<Answer>("answer", {
          id: id(),
          domain,
          version: 1,
          owner: actor.subject,
          question: input.question,
          releaseId: release.id,
          descriptorHash: release.descriptorHash,
          session: input.sessionId,
          style:
            input.style ??
            (pref?.cleared ? undefined : pref?.style) ??
            defaultStyle(access(this.store, actor, domain)),
          depth:
            input.depth ??
            (pref?.cleared ? undefined : pref?.depth) ??
            "beginner",
          state: "queued",
          code: "QUEUED",
          blocks: [],
          createdAt: Date.now(),
          deadline: Date.now() + this.deadlineMs,
          modelEpoch: m.epoch,
          review: "clear",
          exposedThrough: 0,
          deliveredThrough: 0,
        });
      },
    );
    this.tick();
    return { ...answer, history: undefined };
  }
  read(
    actor: Identity,
    domain: string,
    answerId: string,
    expose = true,
  ): Answer {
    access(this.store, actor, domain);
    const answer = this.store.get<Answer>("answer", answerId);
    requireThat(
      answer?.domain === domain && answer.owner === actor.subject,
      404,
      "NOT_FOUND",
    );
    const release = this.store.get<Release>("release", answer.releaseId)!;
    allowedRelease(this.store, actor, release);
    requireThat(answer.review !== "invalid", 410, "ANSWER_INVALIDATED");
    const visible =
      answer.review === "pending"
        ? answer.blocks.filter((b) => b.sequence <= answer.deliveredThrough)
        : answer.blocks;
    if (
      expose &&
      answer.review === "clear" &&
      visible.length > answer.exposedThrough
    ) {
      answer.exposedThrough = visible.length;
      this.store.put("answer", answer);
    }
    return {
      ...answer,
      lease: undefined,
      leaseUntil: undefined,
      callStarted: undefined,
      modelMetrics: undefined,
      history: undefined,
      blocks: visible,
      reviewReason:
        answer.review === "pending" ? "模型验证待确认" : answer.reviewReason,
    };
  }
  cancel(actor: Identity, domain: string, answerId: string, idem: string) {
    return this.stop(actor, domain, answerId, idem, "CANCELLED");
  }
  expire(actor: Identity, domain: string, answerId: string, idem: string) {
    return this.stop(actor, domain, answerId, idem, "DEADLINE_EXCEEDED");
  }
  private stop(
    actor: Identity,
    domain: string,
    answerId: string,
    idem: string,
    code: "CANCELLED" | "DEADLINE_EXCEEDED",
  ) {
    const result = this.store.command(
      actor,
      domain,
      `${code}:${answerId}`,
      idem,
      {},
      () => {
        this.read(actor, domain, answerId, false);
      },
      () => {
        const a = this.store.get<Answer>("answer", answerId)!;
        const running = ["queued", "running"].includes(a.state);
        if (!running && code !== "CANCELLED") return a;
        return this.store.put<Answer>("answer", {
          ...a,
          state: running
            ? a.blocks.length
              ? "incomplete"
              : "failed"
            : a.state,
          code: running ? code : a.code,
          deliveryCancelledAt:
            code === "CANCELLED"
              ? (a.deliveryCancelledAt ?? Date.now())
              : a.deliveryCancelledAt,
          lease: undefined,
          finishedAt: a.finishedAt ?? Date.now(),
          version: a.version + 1,
        });
      },
    );
    this.controllers.get(answerId)?.abort();
    return this.read(actor, domain, result.id, false);
  }
  private historyFor(current: Answer, actor: Identity) {
    return this.store
      .list<Answer>("answer", current.domain)
      .filter((a) => {
        if (
          a.id === current.id ||
          a.createdAt > current.createdAt ||
          a.owner !== current.owner ||
          a.session !== current.session ||
          a.releaseId !== current.releaseId ||
          a.state !== "complete" ||
          !["ANSWER", "CLARIFICATION_REQUIRED"].includes(a.code) ||
          a.review !== "clear" ||
          a.deliveryCancelledAt ||
          a.deliveredThrough < 1
        )
          return false;
        const release = this.store.get<Release>("release", a.releaseId);
        if (!release) return false;
        try {
          allowedRelease(this.store, actor, release);
        } catch {
          return false;
        }
        const m = modelState(
          this.store,
          release.bundle.config.model,
          release.bundle.config.modelRevision,
        );
        return m.qualified && m.epoch === a.modelEpoch;
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 3)
      .reverse()
      .map((a) => ({
        question: a.question,
        answer: a.blocks
          .filter(
            (b) =>
              (b.type === "explanation" ||
                a.code === "CLARIFICATION_REQUIRED") &&
              b.sequence <= a.deliveredThrough,
          )
          .map((b) => b.text)
          .join("\n")
          .slice(0, 600),
      }))
      .filter((h) => h.answer.length > 0);
  }
  private async run(answerId: string) {
    let token: string | undefined;
    try {
      const a = this.store.tx(() => {
        const a = this.store.get<Answer>("answer", answerId);
        if (!a || a.state !== "queued") return;
        if (
          this.store
            .list<Answer>("answer", a.domain)
            .some(
              (other) =>
                other.id !== a.id &&
                other.owner === a.owner &&
                other.session === a.session &&
                other.state === "running",
            )
        )
          return;
        token = id();
        return this.store.put<Answer>("answer", {
          ...a,
          state: "running",
          lease: token,
          // The lease must cover the whole deadline window; the deadline itself
          // is enforced by the abort timer and commit-time checks.
          leaseUntil: Date.now() + this.deadlineMs + 5000,
          version: a.version + 1,
        });
      });
      if (!a) return;
      const release = this.store.get<Release>("release", a.releaseId)!;
      const actor = { subject: a.owner, platform: false };
      allowedRelease(this.store, actor, release);
      requireThat(Date.now() < a.deadline, 503, "DEADLINE_EXCEEDED");
      // The current question drives retrieval; history questions join only
      // when it alone retrieves nothing (elliptical follow-ups like "那第7步
      // 呢"), so prior turns never skew the ranking of a self-sufficient one.
      const history = this.historyFor(a, actor);
      let pages = retrieve(release.bundle, a.question);
      if (!pages.length && history.length)
        pages = retrieve(
          release.bundle,
          [a.question, ...history.map((h) => h.question)].join("\n"),
        );
      if (!pages.length) {
        this.commit(a.id, token!, (answer) => ({
          ...answer,
          code: "KNOWLEDGE_COVERAGE_GAP",
          blocks: [
            {
              sequence: 1,
              type: "status",
              text: "未能检索到与该问题相关的已发布页面；可通过 /登记 提交问题，由知识负责人处理。",
              citations: [],
            },
          ],
        }));
      } else {
        requireThat(this.model, 503, "MODEL_UNAVAILABLE");
        const controller = new AbortController();
        this.controllers.set(a.id, controller);
        const timeout = setTimeout(
          () => controller.abort(),
          Math.max(1, a.deadline - Date.now()),
        );
        try {
          this.commit(a.id, token!, (answer) => {
            const m = modelState(
              this.store,
              release.bundle.config.model,
              release.bundle.config.modelRevision,
            );
            requireThat(
              m.qualified && m.epoch === answer.modelEpoch,
              503,
              "MODEL_REVALIDATION_REQUIRED",
            );
            return { ...answer, callStarted: true };
          });
          // The final validated block is authoritative for delivery and
          // acks; the partial stream below only feeds running-state display.
          let lastPartial = 0;
          const { answer: generated, metrics } = await generateAnswer(
            this.model!,
            {
              modelId: release.bundle.config.model,
              config: release.bundle.config,
              question: a.question,
              pages,
              style: a.style,
              depth: a.depth,
              ...(history.length ? { history } : {}),
            },
            controller.signal,
            undefined,
            (textSoFar) => {
              if (Date.now() - lastPartial < 800) return;
              lastPartial = Date.now();
              try {
                this.commit(a.id, token!, (answer) => ({
                  ...answer,
                  code: "ANSWER",
                  blocks: [
                    {
                      sequence: 1,
                      type: "explanation",
                      text: textSoFar,
                      citations: [],
                    },
                  ],
                }));
              } catch {
                // Lease/deadline lost mid-stream: stop generating.
                controller.abort();
              }
            },
          );
          this.commit(a.id, token!, (answer) => ({
            ...answer,
            blocks: [
              {
                sequence: 1,
                type:
                  generated.outcome && generated.outcome !== "answer"
                    ? "status"
                    : "explanation",
                text: generated.text,
                citations: generated.citations,
              },
            ],
            modelMetrics: metrics,
            code:
              generated.outcome === "knowledge_gap"
                ? "KNOWLEDGE_COVERAGE_GAP"
                : generated.outcome === "clarification"
                  ? "CLARIFICATION_REQUIRED"
                  : "ANSWER",
          }));
        } finally {
          clearTimeout(timeout);
          this.controllers.delete(a.id);
        }
      }
      this.commit(a.id, token!, (answer) => ({
        ...answer,
        state: "complete",
        finishedAt: Date.now(),
        lease: undefined,
      }));
    } catch (error) {
      this.store.tx(() => {
        const a = this.store.get<Answer>("answer", answerId);
        if (!a || a.lease !== token || a.state !== "running") return;
        this.store.put("answer", {
          ...a,
          state: a.blocks.length ? "incomplete" : "failed",
          code:
            Date.now() >= a.deadline
              ? "DEADLINE_EXCEEDED"
              : error instanceof Fault
                ? error.code
                : "MODEL_FAILED",
          finishedAt: Date.now(),
          lease: undefined,
          version: a.version + 1,
        });
      });
    }
  }
  private commit(
    answerId: string,
    token: string,
    update: (answer: Answer) => Answer,
  ) {
    return this.store.tx(() => {
      const answer = this.store.get<Answer>("answer", answerId)!;
      requireThat(
        answer.state === "running" &&
          answer.lease === token &&
          answer.leaseUntil! > Date.now(),
        409,
        "LEASE_LOST",
      );
      const release = this.store.get<Release>("release", answer.releaseId)!;
      allowedRelease(
        this.store,
        { subject: answer.owner, platform: false },
        release,
      );
      requireThat(
        answer.review === "clear",
        503,
        "MODEL_REVALIDATION_REQUIRED",
      );
      const m = modelState(
        this.store,
        release.bundle.config.model,
        release.bundle.config.modelRevision,
      );
      requireThat(
        m.qualified && m.epoch === answer.modelEpoch,
        503,
        "MODEL_REVALIDATION_REQUIRED",
      );
      requireThat(Date.now() < answer.deadline, 503, "DEADLINE_EXCEEDED");
      return this.store.put<Answer>("answer", {
        ...update(answer),
        version: answer.version + 1,
      });
    });
  }
}

export function registerAnswers(
  app: FastifyInstance,
  store: Store,
  service: AnswerService,
) {
  app.post("/api/domains/:domain/answers", async (request, reply) =>
    reply
      .code(202)
      .send(
        service.create(
          request.actor,
          path(request, "domain"),
          body(answerSchema, request),
          key(request),
        ),
      ),
  );
  app.get("/api/domains/:domain/answers/:id", async (request) =>
    service.read(request.actor, path(request, "domain"), path(request, "id")),
  );
  app.get("/api/domains/:domain/answers/:id/events", async (request, reply) => {
    const answer = service.read(
      request.actor,
      path(request, "domain"),
      path(request, "id"),
    );
    const after = Number(request.headers["last-event-id"] ?? 0);
    requireThat(Number.isInteger(after) && after >= 0, 400, "INVALID_CURSOR");
    reply.header("Cache-Control", "no-store").type("text/event-stream");
    return (
      `event: status\ndata: ${JSON.stringify({ state: answer.state, code: answer.code, review: answer.review, reviewReason: answer.reviewReason })}\n\n` +
      answer.blocks
        .filter((b) => b.sequence > after)
        .map(
          (b) =>
            `id: ${b.sequence}\nevent: block\ndata: ${JSON.stringify(b)}\n\n`,
        )
        .join("")
    );
  });
  app.post("/api/domains/:domain/answers/:id/cancel", async (request) =>
    service.cancel(
      request.actor,
      path(request, "domain"),
      path(request, "id"),
      key(request),
    ),
  );
  app.post("/api/domains/:domain/answers/:id/ack", async (request) => {
    const domain = path(request, "domain"),
      answerId = path(request, "id"),
      input = body(
        z.object({ through: z.number().int().nonnegative() }).strict(),
        request,
      );
    return store.command(
      request.actor,
      domain,
      `ack:${answerId}`,
      key(request),
      input,
      () => {
        service.read(request.actor, domain, answerId, false);
      },
      () => {
        const a = store.get<Answer>("answer", answerId)!;
        requireThat(input.through <= a.exposedThrough, 400, "UNEXPOSED_BLOCK");
        requireThat(
          a.review === "clear" || input.through <= a.deliveredThrough,
          409,
          "DELIVERY_PAUSED",
        );
        store.put("answer", {
          ...a,
          deliveredThrough: Math.max(a.deliveredThrough, input.through),
          version: a.version + 1,
        });
        return { through: Math.max(a.deliveredThrough, input.through) };
      },
    );
  });
  app.get("/api/domains/:domain/preferences", async (request) => {
    const domain = path(request, "domain");
    const grant = access(store, request.actor, domain);
    const pref = store.get<Preference>(
      "preference",
      `${domain}:${request.actor.subject}`,
    );
    return pref && !pref.cleared
      ? pref
      : {
          style: defaultStyle(grant),
          depth: "beginner",
          version: pref?.version ?? 0,
        };
  });
  app.patch("/api/domains/:domain/preferences", async (request) => {
    const domain = path(request, "domain"),
      input = body(
        z
          .object({
            style: z.enum(["business", "technical"]),
            depth: z.enum(["beginner", "experienced"]),
            expectedVersion: z.number().int().nonnegative(),
          })
          .strict(),
        request,
      );
    return store.command(
      request.actor,
      domain,
      "preference",
      key(request),
      input,
      () => access(store, request.actor, domain),
      () => {
        const old = store.get<Preference>(
          "preference",
          `${domain}:${request.actor.subject}`,
        );
        requireThat(
          (old?.version ?? 0) === input.expectedVersion,
          409,
          "VERSION_CONFLICT",
        );
        return store.put<Preference>("preference", {
          id: `${domain}:${request.actor.subject}`,
          domain,
          owner: request.actor.subject,
          style: input.style,
          depth: input.depth,
          version: input.expectedVersion + 1,
        });
      },
    );
  });
  app.delete("/api/domains/:domain/preferences", async (request) => {
    const domain = path(request, "domain"),
      input = body(
        z.object({ expectedVersion: z.number().int().nonnegative() }).strict(),
        request,
      );
    return store.command(
      request.actor,
      domain,
      "delete-preference",
      key(request),
      input,
      () => access(store, request.actor, domain),
      () => {
        const old = store.get<Preference>(
          "preference",
          `${domain}:${request.actor.subject}`,
        );
        requireThat(
          (old?.version ?? 0) === input.expectedVersion,
          409,
          "VERSION_CONFLICT",
        );
        store.put<Preference>("preference", {
          id: `${domain}:${request.actor.subject}`,
          domain,
          owner: request.actor.subject,
          cleared: true,
          style: "business",
          depth: "beginner",
          version: input.expectedVersion + 1,
        });
        return { deleted: true, version: input.expectedVersion + 1 };
      },
    );
  });
}
