import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { randomBytes } from "node:crypto";
import {
  Store,
  Fault,
  requireThat,
  access,
  defaultStyle,
  type Identity,
  type Domain,
  type Grant,
} from "./core.js";
import type { ModelGateway } from "./adapters/model.js";
import { registerPublication } from "./publication.js";
import { AnswerService, registerAnswers } from "./answers.js";
import { registerGovernance } from "./governance.js";
import { registerEvaluations } from "./evaluations.js";
import { registerTickets } from "./tickets.js";
import { registerRevisions } from "./revisions.js";
import {
  quarantine,
  registerOperations,
  type RecoveryAuthority,
  type OperationalRetention,
} from "./operations.js";
import { registerChannel, type WecomOptions } from "./channel.js";
import { registerAnswerStyle } from "./answer-style-routes.js";
import { cookieValue, registerAuth, type SsoOptions } from "./auth.js";
import { readFile } from "node:fs/promises";

export interface AppOptions {
  database: string;
  bootstrap?: { token: string; subject: string };
  model?: ModelGateway;
  identity?: (bearer: string) => Promise<Identity | undefined>;
  publicOrigin?: string;
  recovery?: boolean;
  recoveryAuthority?: RecoveryAuthority;
  operationalRetention?: OperationalRetention;
  wecom?: WecomOptions | WecomOptions[];
  sso?: SsoOptions;
}
declare module "fastify" {
  interface FastifyRequest {
    actor: Identity;
  }
}
export const name = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const subjectName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\x00-\x1f]+$/);
export function body<T>(schema: z.ZodType<T>, request: FastifyRequest): T {
  return schema.parse(request.body);
}
export function key(request: FastifyRequest): string {
  return String(request.headers["idempotency-key"] ?? "");
}
export function path(request: FastifyRequest, field: string): string {
  return (request.params as Record<string, string>)[field]!;
}
export function platform(actor: Identity) {
  requireThat(actor.platform, 403, "FORBIDDEN");
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const channels = options.wecom
    ? Array.isArray(options.wecom)
      ? options.wecom
      : [options.wecom]
    : [];
  requireThat(
    new Set(channels.map((channel) => channel.botId)).size === channels.length,
    400,
    "DUPLICATE_BOT_CONFIGURATION",
  );
  const store = new Store(options.database),
    app = Fastify({
      logger: false,
      bodyLimit: 4 * 1024 * 1024,
      requestTimeout: 15000,
    });
  const channelCredentials = new Map<string, Identity>();
  if (options.recovery) {
    quarantine(store);
    store.clearTokens();
  }
  if (options.bootstrap)
    store.token(options.bootstrap.token, {
      subject: options.bootstrap.subject,
      platform: true,
    });
  app.decorateRequest("actor");
  app.addHook("preValidation", async (request) => {
    const pending: { value: unknown; depth: number }[] = [
      { value: request.body, depth: 0 },
    ];
    let count = 0;
    while (pending.length) {
      const item = pending.pop()!;
      requireThat(
        item.depth <= 32 && ++count <= 100000,
        400,
        "INPUT_COMPLEXITY_EXCEEDED",
      );
      if (item.value && typeof item.value === "object")
        for (const value of Object.values(item.value))
          pending.push({ value, depth: item.depth + 1 });
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Fault) {
      // Only stable codes and route templates cross the observability boundary.
      // A failed diagnostic write must not replace the original access denial.
      try {
        store.operationalEvent(
          request.id,
          request.routeOptions.url ?? "unmatched",
          /^[A-Z0-9_]+$/.test(error.code) ? error.code : "REQUEST_REJECTED",
          error.status,
        );
      } catch {
        /* Database failure is reported by the original response. */
      }
      return reply.status(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          retryable: error.status === 503,
          requestId: request.id,
        },
      });
    }
    if (
      error instanceof ZodError ||
      ("statusCode" in (error as object) &&
        Number((error as { statusCode: number }).statusCode) < 500)
    )
      return reply.status(400).send({
        error: {
          code: "INVALID_INPUT",
          message: "输入格式不符合契约",
          retryable: false,
          requestId: request.id,
        },
      });
    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "请求未完成",
        retryable: false,
        requestId: request.id,
      },
    });
  });
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/api/")) return;
    if (request.headers.origin)
      requireThat(
        request.headers.origin === options.publicOrigin,
        403,
        "ORIGIN_NOT_ALLOWED",
      );
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1],
      session = cookieValue(request.headers.cookie, "wikibot_session");
    if (!bearer && session && !["GET", "HEAD"].includes(request.method))
      requireThat(
        options.publicOrigin && request.headers.origin === options.publicOrigin,
        403,
        "ORIGIN_NOT_ALLOWED",
      );
    const token = bearer ?? session;
    requireThat(token, 401, "UNAUTHENTICATED");
    const actor = !bearer
      ? store.identify(token, "session")
      : (channelCredentials.get(token) ??
        (options.identity
          ? await options.identity(token)
          : store.identify(token)));
    requireThat(actor, 401, "UNAUTHENTICATED");
    request.actor = actor;
  });
  app.get("/health", async () => ({
    status: "alive",
    wecom: channels.map((channel) => ({
      botId: channel.botId,
      connected: channel.transport.ready?.() ?? null,
    })),
  }));
  app.addHook("onSend", async (_request, reply, payload) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    return payload;
  });
  for (const [url, file, type] of [
    ["/", "index.html", "text/html"],
    ["/app.js", "app.js", "text/javascript"],
    ["/answer-style.js", "answer-style.js", "text/javascript"],
    ["/app.css", "app.css", "text/css"],
  ])
    app.get(url!, async (_request, reply) =>
      reply
        .type(type!)
        .send(await readFile(new URL(`../web/${file}`, import.meta.url))),
    );
  registerAuth(app, store, options.publicOrigin, options.sso, options.identity);
  app.get("/api/me", async (request) => request.actor);
  app.get("/api/domains", async (request) =>
    store
      .list<Domain>("domain")
      .filter(
        (d) =>
          request.actor.platform ||
          store.get<Grant>("grant", `${d.id}:${request.actor.subject}`)
            ?.enabled,
      ),
  );
  app.post("/api/domains", async (request, reply) => {
    const input = body(
      z.object({ id: name, name: z.string().min(1).max(100) }).strict(),
      request,
    );
    const result = store.command(
      request.actor,
      input.id,
      "create-domain",
      key(request),
      input,
      () => platform(request.actor),
      () => {
        requireThat(!store.get("domain", input.id), 409, "ALREADY_EXISTS");
        return store.put<Domain>("domain", {
          ...input,
          domain: input.id,
          version: 1,
          active: null,
          epoch: 0,
          maintenance: false,
        });
      },
    );
    return reply.code(201).send(result);
  });
  app.put("/api/domains/:domain/members/:subject", async (request) => {
    const domain = path(request, "domain"),
      subject = subjectName.parse(path(request, "subject"));
    const input = body(
      z
        .object({
          role: z.enum(["member", "admin"]),
          tags: z
            .array(z.enum(["business", "technical"]))
            .max(2)
            .optional(),
          enabled: z.boolean().default(true),
          expectedVersion: z.number().int().nonnegative(),
        })
        .strict(),
      request,
    );
    return store.command(
      request.actor,
      domain,
      `grant:${subject}`,
      key(request),
      input,
      () => platform(request.actor),
      () => {
        requireThat(store.get("domain", domain), 404, "NOT_FOUND");
        const old = store.get<Grant>("grant", `${domain}:${subject}`);
        requireThat(
          (old?.version ?? 0) === input.expectedVersion,
          409,
          "VERSION_CONFLICT",
        );
        return store.put<Grant>("grant", {
          id: `${domain}:${subject}`,
          domain,
          subject,
          role: input.role,
          enabled: input.enabled,
          tags: input.tags ? [...new Set(input.tags)] : (old?.tags ?? []),
          version: input.expectedVersion + 1,
        });
      },
    );
  });
  app.post("/api/identities/:subject/tokens", async (request) => {
    platform(request.actor);
    const subject = subjectName.parse(path(request, "subject"));
    // Provisioning is a local integration facility. Enterprise users use the configured JWT identity provider.
    requireThat(!options.identity, 403, "EXTERNAL_IDENTITY_REQUIRED");
    const token = randomBytes(32).toString("base64url");
    store.token(token, { subject, platform: false });
    store.audit(request.actor, "", "issue-local-token", subject);
    return { token, expiresInSeconds: 86400 };
  });
  app.get("/api/domains/:domain/capabilities", async (request) => {
    const grant = access(store, request.actor, path(request, "domain"));
    return {
      ...grant,
      tags: grant.tags ?? [],
      defaultStyle: defaultStyle(grant),
    };
  });
  app.get("/api/domains/:domain/members", async (request) => {
    platform(request.actor);
    const domain = path(request, "domain");
    requireThat(store.get("domain", domain), 404, "NOT_FOUND");
    return store.list<Grant>("grant", domain).map((grant) => ({
      ...grant,
      tags: grant.tags ?? [],
      defaultStyle: defaultStyle(grant),
    }));
  });
  app.get("/api/domains/:domain/audit", async (request) => {
    access(store, request.actor, path(request, "domain"), true);
    return store.auditLog(path(request, "domain"));
  });
  registerPublication(app, store);
  registerAnswerStyle(app, store);
  registerGovernance(app, store);
  registerEvaluations(app, store, options.model);
  const answers = new AnswerService(store, options.model);
  registerAnswers(app, store, answers);
  registerTickets(app, store, answers);
  registerRevisions(app, store);
  registerOperations(
    app,
    store,
    options.recoveryAuthority,
    options.operationalRetention,
  );
  for (const channel of channels)
    registerChannel(
      app,
      store,
      answers,
      channel,
      channelCredentials,
      options.publicOrigin,
    );
  app.addHook("onClose", async () => {
    await answers.close();
    store.close();
  });
  return app;
}
