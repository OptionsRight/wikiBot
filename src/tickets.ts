import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  Store,
  access,
  requireThat,
  id,
  version,
  type Entity,
  type Identity,
} from "./core.js";
import { body, path, key, name } from "./app.js";
import { notice } from "./governance.js";
import type { AnswerService, Block, Answer } from "./answers.js";
import type { Release } from "./publication.js";

type State =
  | "submitted"
  | "triaged"
  | "in_progress"
  | "waiting_reporter"
  | "resolved"
  | "closed"
  | "withdrawn"
  | "duplicate"
  | "rejected";
interface Comment {
  author: string;
  text: string;
  internal: boolean;
  at: number;
}
export interface Ticket extends Entity {
  owner: string;
  title: string;
  description: string;
  category: "question" | "knowledge";
  state: State;
  comments: Comment[];
  assignee?: string;
  resolution?: string;
  releaseId?: string;
  duplicateOf?: string;
  answerId?: string;
  evidence?: { releaseId: string; descriptorHash: string; blocks: Block[] };
  createdAt: number;
  updatedAt: number;
  reopenCount: number;
}
export function ticketAccess(
  store: Store,
  actor: Identity,
  domain: string,
  tid: string,
): Ticket {
  const grant = access(store, actor, domain),
    ticket = store.get<Ticket>("ticket", tid);
  requireThat(
    ticket?.domain === domain &&
      (ticket.owner === actor.subject || grant.role === "admin"),
    404,
    "NOT_FOUND",
  );
  return ticket;
}
function view(store: Store, actor: Identity, ticket: Ticket) {
  const admin = access(store, actor, ticket.domain).role === "admin";
  const related = ticket.answerId
    ? store.get<Answer>("answer", ticket.answerId)
    : undefined;
  const release = ticket.evidence
    ? store.get<Release>("release", ticket.evidence.releaseId)
    : undefined;
  const evidence =
    related?.review === "invalid" || release?.state === "revoked"
      ? undefined
      : ticket.evidence;
  return {
    ...ticket,
    comments: ticket.comments.filter((c) => admin || !c.internal),
    duplicateOf: admin ? ticket.duplicateOf : undefined,
    evidence,
    evidenceWarning:
      related?.review === "pending"
        ? "模型验证待确认"
        : !evidence && ticket.evidence
          ? "原始依据已失效"
          : undefined,
  };
}
export function registerTickets(
  app: FastifyInstance,
  store: Store,
  answers: AnswerService,
) {
  app.post("/api/domains/:domain/tickets", async (request, reply) => {
    const domain = path(request, "domain"),
      input = body(
        z
          .object({
            title: z.string().min(1).max(200),
            description: z.string().min(5).max(12000),
            category: z.enum(["question", "knowledge"]),
            answerId: z.string().optional(),
          })
          .strict(),
        request,
      );
    const result = store.command(
      request.actor,
      domain,
      "ticket",
      key(request),
      input,
      () => {
        access(store, request.actor, domain);
        if (input.answerId)
          answers.read(request.actor, domain, input.answerId, false);
      },
      () => {
        const answer = input.answerId
          ? answers.read(request.actor, domain, input.answerId, false)
          : undefined;
        const ticket = store.put<Ticket>("ticket", {
          id: id(),
          domain,
          version: 1,
          owner: request.actor.subject,
          title: input.title,
          description: input.description,
          category: input.category,
          state: "submitted",
          comments: [],
          answerId: input.answerId,
          evidence: answer
            ? {
                releaseId: answer.releaseId,
                descriptorHash: answer.descriptorHash,
                blocks: answer.blocks.filter(
                  (b) => b.sequence <= answer.deliveredThrough,
                ),
              }
            : undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          reopenCount: 0,
        });
        notice(store, domain, ticket.owner, "TICKET_SUBMITTED", ticket.id);
        return { id: ticket.id };
      },
    );
    return reply
      .code(201)
      .send(
        view(
          store,
          request.actor,
          ticketAccess(store, request.actor, domain, result.id),
        ),
      );
  });
  app.get("/api/domains/:domain/tickets", async (request) => {
    const domain = path(request, "domain"),
      grant = access(store, request.actor, domain);
    return store
      .list<Ticket>("ticket", domain)
      .filter(
        (t) => t.owner === request.actor.subject || grant.role === "admin",
      )
      .map((t) => view(store, request.actor, t));
  });
  app.get("/api/domains/:domain/tickets/:id", async (request) =>
    view(
      store,
      request.actor,
      ticketAccess(
        store,
        request.actor,
        path(request, "domain"),
        path(request, "id"),
      ),
    ),
  );
  app.post("/api/domains/:domain/tickets/:id/actions", async (request) => {
    const domain = path(request, "domain"),
      tid = path(request, "id");
    const input = body(
      z
        .object({
          action: z.enum([
            "triage",
            "start",
            "request_info",
            "reply",
            "note",
            "assign",
            "resolve",
            "close",
            "withdraw",
            "reopen",
            "merge",
            "reject",
          ]),
          expectedVersion: z.number().int().positive(),
          text: z.string().min(1).max(12000).optional(),
          assignee: name.optional(),
          targetId: z.string().optional(),
          releaseId: z.string().optional(),
        })
        .strict(),
      request,
    );
    const result = store.command(
      request.actor,
      domain,
      `ticket-action:${tid}`,
      key(request),
      input,
      () => {
        ticketAccess(store, request.actor, domain, tid);
      },
      () => {
        const t = ticketAccess(store, request.actor, domain, tid);
        version(t, input.expectedVersion);
        const reporter = t.owner === request.actor.subject,
          admin = access(store, request.actor, domain).role === "admin";
        const reporterOnly = ["close", "withdraw", "reopen"].includes(
          input.action,
        );
        requireThat(
          reporterOnly
            ? reporter
            : input.action === "reply"
              ? reporter || admin
              : admin,
          403,
          "FORBIDDEN",
        );
        const allowed: Record<string, State[]> = {
          triage: ["submitted"],
          start: ["triaged", "waiting_reporter"],
          request_info: ["triaged", "in_progress"],
          resolve: ["triaged", "in_progress", "waiting_reporter"],
          close: ["resolved"],
          withdraw: [
            "submitted",
            "triaged",
            "in_progress",
            "waiting_reporter",
            "resolved",
          ],
          reopen: ["closed", "resolved", "withdrawn", "rejected", "duplicate"],
          merge: ["submitted", "triaged", "in_progress", "waiting_reporter"],
          reject: ["submitted", "triaged"],
        };
        if (allowed[input.action])
          requireThat(
            allowed[input.action]!.includes(t.state),
            409,
            "INVALID_STATE",
          );
        if (
          [
            "request_info",
            "resolve",
            "reject",
            "note",
            "reply",
            "reopen",
          ].includes(input.action)
        )
          requireThat(
            input.text && input.text.length >= 5,
            400,
            "REASON_REQUIRED",
          );
        if (input.action === "assign") {
          requireThat(input.assignee, 400, "ASSIGNEE_REQUIRED");
          access(
            store,
            { subject: input.assignee, platform: false },
            domain,
            true,
          );
          t.assignee = input.assignee;
        }
        if (input.action === "resolve") {
          if (t.category === "knowledge") {
            const release =
              input.releaseId && store.get<Release>("release", input.releaseId);
            requireThat(
              release &&
                release.domain === domain &&
                release.state === "active",
              409,
              "PUBLISHED_CORRECTION_REQUIRED",
            );
            t.releaseId = release.id;
          }
          t.resolution = input.text;
        }
        if (input.action === "merge") {
          const target =
            input.targetId &&
            ticketAccess(store, request.actor, domain, input.targetId);
          requireThat(
            target &&
              target.id !== tid &&
              !["duplicate", "rejected", "withdrawn"].includes(target.state),
            409,
            "INVALID_MERGE_TARGET",
          );
          t.duplicateOf = target.id;
        }
        const states: Partial<Record<typeof input.action, State>> = {
          triage: "triaged",
          start: "in_progress",
          request_info: "waiting_reporter",
          resolve: "resolved",
          close: "closed",
          withdraw: "withdrawn",
          reopen: "submitted",
          merge: "duplicate",
          reject: "rejected",
        };
        t.state = states[input.action] ?? t.state;
        if (input.action === "reopen") {
          t.reopenCount++;
          t.resolution = undefined;
          t.releaseId = undefined;
          t.duplicateOf = undefined;
        }
        if (
          input.action === "reply" &&
          reporter &&
          t.state === "waiting_reporter"
        )
          t.state = "in_progress";
        if (input.text)
          t.comments.push({
            author: request.actor.subject,
            text: input.text,
            internal: input.action === "note",
            at: Date.now(),
          });
        store.put("ticket", {
          ...t,
          version: t.version + 1,
          updatedAt: Date.now(),
        });
        if (input.action !== "note")
          notice(store, domain, t.owner, "TICKET_UPDATED", tid);
        return { id: tid };
      },
    );
    return view(
      store,
      request.actor,
      ticketAccess(store, request.actor, domain, result.id),
    );
  });
}
