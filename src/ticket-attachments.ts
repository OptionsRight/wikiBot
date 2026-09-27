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
import { body, path, key } from "./app.js";
import { ticketAccess } from "./tickets.js";
interface Policy extends Entity {
  enabled: boolean;
  maxBytes: number;
  retentionDays: number;
}
interface Attachment extends Entity {
  ticketId: string;
  filename: string;
  mediaType: string;
  data: string;
  internal: boolean;
  createdAt: number;
  expiresAt: number;
  size: number;
}
export function registerTicketAttachments(app: FastifyInstance, store: Store) {
  const root = "/api/domains/:domain";
  function policy(domain: string) {
    return (
      store.get<Policy>("ticket-attachment-policy", domain) ?? {
        id: domain,
        domain,
        version: 0,
        enabled: false,
        maxBytes: 0,
        retentionDays: 0,
      }
    );
  }
  function enabled(domain: string) {
    const p = policy(domain);
    requireThat(p.enabled, 409, "TICKET_ATTACHMENTS_DISABLED");
    return p;
  }
  function visible(a: Attachment, ticketId: string, admin: boolean) {
    return (
      a.ticketId === ticketId &&
      a.expiresAt > Date.now() &&
      (admin || !a.internal)
    );
  }
  function read(
    actor: Identity,
    domain: string,
    ticketId: string,
    attachmentId: string,
  ) {
    ticketAccess(store, actor, domain, ticketId);
    enabled(domain);
    const a = store.get<Attachment>("ticket-attachment", attachmentId);
    requireThat(
      a?.domain === domain &&
        visible(a, ticketId, access(store, actor, domain).role === "admin"),
      404,
      "NOT_FOUND",
    );
    return a;
  }
  const metadata = ({ data: _data, ...a }: Attachment) => a;
  const sweep = () => {
    for (const a of store.list<Attachment>("ticket-attachment"))
      if (a.expiresAt <= Date.now()) store.remove("ticket-attachment", a.id);
  };
  let timer: NodeJS.Timeout;
  app.addHook("onReady", async () => {
    sweep();
    timer = setInterval(sweep, 60_000);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
  app.get(`${root}/ticket-attachment-policy`, async (request) => {
    const domain = path(request, "domain");
    access(store, request.actor, domain);
    return policy(domain);
  });
  app.put(`${root}/ticket-attachment-policy`, async (request) => {
    const domain = path(request, "domain"),
      input = body(
        z
          .object({
            enabled: z.boolean(),
            maxBytes: z
              .number()
              .int()
              .min(1)
              .max(1024 * 1024),
            retentionDays: z.number().int().min(1).max(365),
            expectedVersion: z.number().int().nonnegative(),
          })
          .strict(),
        request,
      );
    const authorize = () =>
      requireThat(request.actor.platform, 403, "FORBIDDEN");
    return store.command(
      request.actor,
      domain,
      "ticket-attachment-policy",
      key(request),
      input,
      authorize,
      () => {
        const p = policy(domain);
        version(p, input.expectedVersion);
        return store.put<Policy>("ticket-attachment-policy", {
          id: domain,
          domain,
          version: p.version + 1,
          enabled: input.enabled,
          maxBytes: input.maxBytes,
          retentionDays: input.retentionDays,
        });
      },
    );
  });
  const route = `${root}/tickets/:id/attachments`;
  app.post(route, async (request, reply) => {
    const domain = path(request, "domain"),
      ticketId = path(request, "id");
    const input = body(
      z
        .object({
          filename: z
            .string()
            .min(1)
            .max(180)
            .regex(/^[^/\\\x00-\x1f\x7f]+$/),
          mediaType: z.literal("text/plain"),
          data: z
            .string()
            .min(4)
            .max(1_398_104)
            .regex(
              /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
            ),
          internal: z.boolean().default(false),
          expectedVersion: z.number().int().positive(),
        })
        .strict(),
      request,
    );
    const authorize = () => {
      ticketAccess(store, request.actor, domain, ticketId);
      enabled(domain);
      requireThat(
        !input.internal ||
          access(store, request.actor, domain).role === "admin",
        403,
        "FORBIDDEN",
      );
    };
    const result = store.command(
      request.actor,
      domain,
      `ticket-attachment:${ticketId}`,
      key(request),
      input,
      authorize,
      () => {
        const ticket = ticketAccess(store, request.actor, domain, ticketId),
          p = enabled(domain);
        version(ticket, input.expectedVersion);
        const bytes = Buffer.from(input.data, "base64");
        requireThat(bytes.length <= p.maxBytes, 413, "ATTACHMENT_TOO_LARGE");
        requireThat(
          bytes.toString("base64") === input.data &&
            Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes) &&
            !bytes.includes(0),
          400,
          "UTF8_TEXT_REQUIRED",
        );
        const now = Date.now();
        const a = store.put<Attachment>("ticket-attachment", {
          id: id(),
          domain,
          version: 1,
          ticketId,
          filename: input.filename,
          mediaType: input.mediaType,
          data: input.data,
          internal: input.internal,
          size: bytes.length,
          createdAt: now,
          expiresAt: now + p.retentionDays * 86400000,
        });
        store.put("ticket", {
          ...ticket,
          version: ticket.version + 1,
          updatedAt: now,
        });
        return { id: a.id };
      },
    );
    return reply
      .code(201)
      .send(metadata(read(request.actor, domain, ticketId, result.id)));
  });
  app.get(route, async (request) => {
    const domain = path(request, "domain"),
      ticketId = path(request, "id");
    ticketAccess(store, request.actor, domain, ticketId);
    const admin = access(store, request.actor, domain).role === "admin";
    if (!policy(domain).enabled) return [];
    return store
      .list<Attachment>("ticket-attachment", domain)
      .filter((a) => visible(a, ticketId, admin))
      .map(metadata);
  });
  app.get(`${route}/:attachment`, async (request, reply) => {
    const a = read(
      request.actor,
      path(request, "domain"),
      path(request, "id"),
      path(request, "attachment"),
    );
    return reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "sandbox; default-src 'none'")
      .header(
        "Content-Disposition",
        `attachment; filename="attachment.txt"; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
      )
      .type("application/octet-stream")
      .send(Buffer.from(a.data, "base64"));
  });
}
