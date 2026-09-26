import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  Store,
  access,
  id,
  hash,
  requireThat,
  Fault,
  type Entity,
  type Identity,
  type Domain,
} from "./core.js";
import { body, path, key } from "./app.js";
import {
  allowedRelease,
  currentRelease,
  modelState,
  type Release,
} from "./publication.js";
import { guidance, type Procedure, type InputValue } from "./procedures.js";
import type { ModelGateway } from "./adapters/model.js";
import { explain } from "./explanation.js";

export interface Block {
  sequence: number;
  type: "node" | "explanation" | "status";
  text: string;
  citations: string[];
  nodeId?: string;
}
export interface Answer extends Entity {
  owner: string;
  question: string;
  releaseId: string;
  descriptorHash: string;
  procedureId: string | null;
  session: string;
  objectId: string | null;
  inputs: Record<string, InputValue>;
  mode: "guidance" | "explanation";
  style: "business" | "technical";
  depth: "beginner" | "experienced";
  state: "queued" | "running" | "complete" | "failed" | "incomplete";
  code: string;
  blocks: Block[];
  checklistComplete: boolean;
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
}
interface Context extends Entity {
  owner: string;
  session: string;
  objectId: string;
  procedureId: string;
  confirmed: Record<string, { value: InputValue; semanticVersion: string }>;
}
export interface Preference extends Entity {
  owner: string;
  style: "business" | "technical";
  depth: "beginner" | "experienced";
}
const explanationSchema = z
  .object({
    text: z.string().min(1).max(12000),
    citations: z.array(z.string()).min(1).max(20),
  })
  .strict();
const answerSchema = z
  .object({
    question: z.string().min(1).max(4000),
    procedureId: z.string().max(100).optional(),
    sessionId: z.string().min(1).max(100),
    objectId: z.string().min(1).max(200).optional(),
    inputs: z
      .record(z.string(), z.union([z.string().max(200), z.boolean()]))
      .default({}),
    mode: z.enum(["guidance", "explanation"]).default("guidance"),
    style: z.enum(["business", "technical"]).optional(),
    depth: z.enum(["beginner", "experienced"]).optional(),
  })
  .strict();

export class AnswerService {
  private working = new Set<Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private timer: NodeJS.Timeout;
  constructor(
    private store: Store,
    private model?: ModelGateway,
  ) {
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
        const matches = release.bundle.procedures.filter((p) =>
          input.procedureId
            ? p.id === input.procedureId
            : [p.title, ...p.aliases].some((alias) =>
                input.question.includes(alias),
              ),
        );
        const procedure = matches.length === 1 ? matches[0] : undefined;
        const contextKey = hash([domain, actor.subject, input.sessionId]);
        const previous = this.store.get<Context>("context", contextKey),
          inputs: Record<string, InputValue> = {};
        if (
          procedure &&
          input.objectId &&
          previous?.procedureId === procedure.id &&
          previous.objectId === input.objectId
        ) {
          for (const field of procedure.inputs) {
            const v = previous.confirmed[field.id];
            if (v?.semanticVersion === field.semanticVersion)
              inputs[field.id] = v.value;
          }
        }
        if (procedure) {
          for (const [k, v] of Object.entries(input.inputs)) {
            const field = procedure.inputs.find((f) => f.id === k);
            requireThat(
              field && field.values.includes(v),
              400,
              "INVALID_INPUT_VALUE",
            );
            inputs[k] = v;
          }
        }
        if (procedure && input.objectId)
          this.store.put<Context>("context", {
            id: contextKey,
            domain,
            version: (previous?.version ?? 0) + 1,
            owner: actor.subject,
            session: input.sessionId,
            objectId: input.objectId,
            procedureId: procedure.id,
            confirmed: Object.fromEntries(
              Object.entries(inputs).map(([k, v]) => [
                k,
                {
                  value: v,
                  semanticVersion: procedure.inputs.find((f) => f.id === k)!
                    .semanticVersion,
                },
              ]),
            ),
          });
        else if (previous) this.store.remove("context", contextKey);
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
          procedureId: procedure?.id ?? null,
          session: input.sessionId,
          objectId: input.objectId ?? null,
          inputs,
          mode: input.mode,
          style: input.style ?? pref?.style ?? "business",
          depth: input.depth ?? pref?.depth ?? "beginner",
          state: "queued",
          code: "QUEUED",
          blocks: [],
          checklistComplete: false,
          createdAt: Date.now(),
          deadline: Date.now() + 10000,
          modelEpoch: m.epoch,
          review: "clear",
          exposedThrough: 0,
          deliveredThrough: 0,
        });
      },
    );
    this.tick();
    return answer;
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
          leaseUntil: Date.now() + 15000,
          version: a.version + 1,
        });
      });
      if (!a) return;
      const release = this.store.get<Release>("release", a.releaseId)!;
      const actor = { subject: a.owner, platform: false };
      allowedRelease(this.store, actor, release);
      requireThat(Date.now() < a.deadline, 503, "DEADLINE_EXCEEDED");
      const procedure = release.bundle.procedures.find(
        (p) => p.id === a.procedureId,
      );
      let code = "GUIDANCE",
        blocks: Block[] = [],
        complete = false;
      if (!procedure) {
        code = "PROCEDURE_SELECTION_REQUIRED";
        blocks = [
          {
            sequence: 1,
            type: "status",
            text:
              "请明确要咨询的流程：" +
              release.bundle.procedures
                .map((p) => `${p.title}（流程：${p.id}）`)
                .join("、"),
            citations: [],
          },
        ];
      } else if (a.mode === "guidance" && !a.objectId) {
        code = "OBJECT_REQUIRED";
        blocks = [
          {
            sequence: 1,
            type: "status",
            text: "请明确本次咨询对象，避免沿用其他客户或策略的条件。",
            citations: [],
          },
        ];
      } else if (a.mode === "guidance") {
        const selected = guidance(procedure, a.inputs);
        code = selected.code;
        if (selected.code === "GUIDANCE") {
          blocks = selected.nodes.map((n, index) => ({
            sequence: index + 1,
            type: "node",
            nodeId: n.id,
            text: n.text,
            citations: n.citations,
          }));
          complete = true;
        } else
          blocks = [
            {
              sequence: 1,
              type: "status",
              text: selected.questions.length
                ? selected.questions
                    .map(
                      (q) =>
                        `${q.question}（${q.options.join(" / ")}）；可补充：${q.id}=所选值`,
                    )
                    .join("\n")
                : ({
                    PROCEDURE_NOT_APPLICABLE: "根据已审核条件，本场景不适用。",
                    PROCEDURE_COVERAGE_GAP: "当前知识尚未覆盖该场景。",
                    PROCEDURE_BRANCH_GAP:
                      "流程配置存在缺口，暂不能给出操作清单。",
                    PROCEDURE_BRANCH_CONFLICT: "流程条件冲突，已停止清单。",
                  }[selected.code] ?? "请补充流程条件。"),
              citations: [],
            },
          ];
      }
      this.commit(a.id, token!, (answer) => ({
        ...answer,
        blocks,
        checklistComplete: complete,
        code,
      }));
      if (procedure && (complete || a.mode === "explanation")) {
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
          const { explanation, metrics } = await explain(
            this.model,
            release.bundle,
            {
              question: a.question,
              pageId: procedure.pageId,
              checklist: blocks,
              style: a.style,
              depth: a.depth,
            },
            controller.signal,
          );
          this.commit(a.id, token!, (answer) => ({
            ...answer,
            blocks: [
              ...answer.blocks,
              {
                sequence: answer.blocks.length + 1,
                type: "explanation",
                ...explanation,
              },
            ],
            modelMetrics: metrics,
            code: a.mode === "explanation" ? "EXPLANATION" : "GUIDANCE",
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
        this.store.put<Answer>("answer", {
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
    access(store, request.actor, domain);
    return (
      store.get<Preference>(
        "preference",
        `${domain}:${request.actor.subject}`,
      ) ?? { style: "business", depth: "beginner", version: 0 }
    );
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
          style: "business",
          depth: "beginner",
          version: input.expectedVersion + 1,
        });
        return { deleted: true, version: input.expectedVersion + 1 };
      },
    );
  });
}
