import type { FastifyInstance } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  Store,
  hash,
  requireThat,
  type Entity,
  type Identity,
} from "./core.js";
export function jwtIdentity(config: {
  issuer: string;
  audience: string;
  jwksURL: string;
  operators: string[];
}) {
  const keys = createRemoteJWKSet(new URL(config.jwksURL));
  return async (token: string): Promise<Identity | undefined> => {
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ["RS256", "ES256"],
      });
      if (!payload.sub || !payload.exp) return;
      return {
        subject: payload.sub,
        platform: config.operators.includes(payload.sub),
      };
    } catch {
      return;
    }
  };
}
export interface SsoOptions {
  authorizationURL: string;
  tokenURL: string;
  clientId: string;
  clientSecret?: string;
  scope: string;
}
interface Login extends Entity {
  verifier: string;
  expires: number;
}
export function cookieValue(header: string | undefined, key: string) {
  return header
    ?.split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${key}=`))
    ?.slice(key.length + 1);
}
export function registerAuth(
  app: FastifyInstance,
  store: Store,
  origin: string | undefined,
  sso: SsoOptions | undefined,
  verify: ((token: string) => Promise<Identity | undefined>) | undefined,
) {
  const flags = `HttpOnly; SameSite=Lax; Path=/${origin?.startsWith("https:") ? "; Secure" : ""}`;
  app.get("/auth/config", async () => ({
    sso: Boolean(sso && verify && origin),
  }));
  app.get("/auth/login", async (_request, reply) => {
    requireThat(sso && verify && origin, 503, "SSO_NOT_CONFIGURED");
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url");
    store.put<Login>("login", {
      id: hash(state),
      domain: "",
      version: 1,
      verifier,
      expires: Date.now() + 300000,
    });
    const url = new URL(sso.authorizationURL);
    url.search = new URLSearchParams({
      client_id: sso.clientId,
      response_type: "code",
      redirect_uri: `${origin}/auth/callback`,
      scope: sso.scope,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return reply
      .header("Set-Cookie", `wikibot_state=${state}; ${flags}; Max-Age=300`)
      .redirect(url.href);
  });
  app.get("/auth/callback", async (request, reply) => {
    requireThat(sso && verify && origin, 503, "SSO_NOT_CONFIGURED");
    const query = request.query as Record<string, string>,
      state = cookieValue(request.headers.cookie, "wikibot_state");
    requireThat(
      state && query.state === state && query.code,
      401,
      "LOGIN_STATE_INVALID",
    );
    const login = store.get<Login>("login", hash(state));
    requireThat(login && login.expires > Date.now(), 401, "LOGIN_EXPIRED");
    store.remove("login", login.id);
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: query.code,
      client_id: sso.clientId,
      redirect_uri: `${origin}/auth/callback`,
      code_verifier: login.verifier,
    });
    if (sso.clientSecret) form.set("client_secret", sso.clientSecret);
    const response = await fetch(sso.tokenURL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    requireThat(response.ok, 401, "IDENTITY_EXCHANGE_FAILED");
    const tokens = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    requireThat(tokens.access_token, 401, "IDENTITY_EXCHANGE_FAILED");
    const actor = await verify(tokens.access_token);
    requireThat(actor, 401, "IDENTITY_INVALID");
    const session = randomBytes(32).toString("base64url"),
      ttl = Math.max(1, Math.min(900, Number(tokens.expires_in) || 900));
    store.token(session, actor, Date.now() + ttl * 1000, "session");
    return reply
      .header("Set-Cookie", [
        `wikibot_session=${session}; ${flags}; Max-Age=${ttl}`,
        `wikibot_state=; ${flags}; Max-Age=0`,
      ])
      .redirect("/");
  });
  app.post("/auth/logout", async (request, reply) => {
    requireThat(
      origin && request.headers.origin === origin,
      403,
      "ORIGIN_NOT_ALLOWED",
    );
    const token = cookieValue(request.headers.cookie, "wikibot_session");
    if (token) store.revokeToken(token);
    return reply
      .header("Set-Cookie", `wikibot_session=; ${flags}; Max-Age=0`)
      .send({ loggedOut: true });
  });
}
