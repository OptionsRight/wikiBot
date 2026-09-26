import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { buildApp } from "./app.js";
import { AnthropicGateway } from "./adapters/model.js";
import { WecomSocket } from "./adapters/wecom.js";
import { jwtIdentity } from "./auth.js";
import { recoveryProofSchema, type RecoveryAuthority } from "./operations.js";
import { requireThat } from "./core.js";
import { demoModel } from "./demo-model.js";
const env = process.env,
  host = env.HOST ?? "127.0.0.1",
  port = Number(env.PORT ?? 3000),
  origin = env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
const database = resolve(env.DATABASE_PATH ?? ".local/wikibot.sqlite");
await mkdir(dirname(database), { recursive: true, mode: 0o700 });
const demo = env.WIKIBOT_DEMO === "1";
requireThat(
  !demo || ["127.0.0.1", "localhost", "::1"].includes(host),
  400,
  "DEMO_MUST_BIND_LOOPBACK",
);
const identity =
  env.OIDC_ISSUER && env.OIDC_AUDIENCE && env.OIDC_JWKS_URL
    ? jwtIdentity({
        issuer: env.OIDC_ISSUER,
        audience: env.OIDC_AUDIENCE,
        jwksURL: env.OIDC_JWKS_URL,
        operators: (env.PLATFORM_SUBJECTS ?? "").split(",").filter(Boolean),
      })
    : undefined;
requireThat(
  ["127.0.0.1", "localhost", "::1"].includes(host) ||
    Boolean(identity && origin.startsWith("https:")),
  400,
  "PUBLIC_SERVER_REQUIRES_SSO_AND_HTTPS",
);
let recoveryAuthority: RecoveryAuthority | undefined;
if (env.RECOVERY_PROOF_URL && env.RECOVERY_ISSUER && env.RECOVERY_JWKS_URL) {
  const keys = createRemoteJWKSet(new URL(env.RECOVERY_JWKS_URL));
  recoveryAuthority = async (domain, nonce) => {
    const response = await fetch(env.RECOVERY_PROOF_URL!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain, nonce }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    requireThat(response.ok, 503, "RECOVERY_AUTHORITY_UNAVAILABLE");
    const { payload } = await jwtVerify(await response.text(), keys, {
      issuer: env.RECOVERY_ISSUER,
      audience: "wikibot-recovery",
      algorithms: ["RS256", "ES256"],
    });
    return recoveryProofSchema.parse(payload.proof);
  };
}
let bootstrap = env.BOOTSTRAP_TOKEN
  ? { token: env.BOOTSTRAP_TOKEN, subject: env.BOOTSTRAP_SUBJECT ?? "operator" }
  : undefined;
if (demo) {
  const access = JSON.parse(
    await readFile(resolve(".local/demo-access.json"), "utf8"),
  ) as { operator: string };
  bootstrap = { token: access.operator, subject: "demo-operator" };
}
const members = env.WECOM_MEMBERS_JSON
  ? (JSON.parse(env.WECOM_MEMBERS_JSON) as Record<string, string>)
  : {};
const app = await buildApp({
  database,
  bootstrap,
  identity,
  publicOrigin: origin,
  recovery: env.RECOVERY_MODE === "1",
  recoveryAuthority,
  model: demo
    ? demoModel
    : env.ANTHROPIC_AUTH_TOKEN
      ? new AnthropicGateway({
          baseURL:
            env.ANTHROPIC_BASE_URL ?? "https://open.bigmodel.cn/api/anthropic",
          token: env.ANTHROPIC_AUTH_TOKEN,
        })
      : undefined,
  sso:
    identity &&
    env.OIDC_AUTHORIZATION_URL &&
    env.OIDC_TOKEN_URL &&
    env.OIDC_CLIENT_ID
      ? {
          authorizationURL: env.OIDC_AUTHORIZATION_URL,
          tokenURL: env.OIDC_TOKEN_URL,
          clientId: env.OIDC_CLIENT_ID,
          clientSecret: env.OIDC_CLIENT_SECRET,
          scope: env.OIDC_SCOPE ?? "openid profile",
        }
      : undefined,
  wecom:
    !demo &&
    env.WECOM_ENABLED === "1" &&
    env.WECOM_BOT_ID &&
    env.WECOM_SECRET &&
    env.WECOM_DOMAIN
      ? {
          botId: env.WECOM_BOT_ID,
          domain: env.WECOM_DOMAIN,
          members,
          notifications: env.WECOM_NOTIFICATIONS_ENABLED === "1",
          transport: new WecomSocket(env.WECOM_BOT_ID, env.WECOM_SECRET),
        }
      : undefined,
});
await app.listen({ host, port });
process.stdout.write(
  `wikiBot listening on ${origin}${demo ? " (synthetic demo only)" : ""}\n`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
