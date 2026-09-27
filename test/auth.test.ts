import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { jwtIdentity } from "../src/auth.js";
import { buildApp } from "../src/app.js";
test("company bearer verification rejects an untrusted issuer and ignores self-asserted platform roles", async () => {
  const pair = await generateKeyPair("ES256"),
    jwk = await exportJWK(pair.publicKey);
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [{ ...jwk, kid: "test" }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const app = await buildApp({
    database: ":memory:",
    identity: jwtIdentity({
      issuer: "https://company.example",
      audience: "wikibot",
      jwksURL: `http://127.0.0.1:${port}`,
      operators: ["operator"],
    }),
  });
  const sign = (issuer: string) =>
    new SignJWT({ platform: true })
      .setProtectedHeader({ alg: "ES256", kid: "test" })
      .setIssuer(issuer)
      .setAudience("wikibot")
      .setSubject("member")
      .setExpirationTime("2m")
      .sign(pair.privateKey);
  try {
    const token = await sign("https://company.example");
    const good = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(good.statusCode, 200);
    assert.equal(good.json().platform, false);
    const bad = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        authorization: `Bearer ${await sign("https://attacker.example")}`,
      },
    });
    assert.equal(bad.statusCode, 401);
  } finally {
    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("persisted cookie sessions cannot mutate when the trusted public origin is unconfigured", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Store } = await import("../src/core.js");
  const dir = await mkdtemp(join(tmpdir(), "wikibot-session-origin-"));
  let app;
  try {
    const database = join(dir, "state.sqlite");
    const store = new Store(database);
    store.token(
      "persisted-session",
      { subject: "operator", platform: true },
      Date.now() + 60000,
      "session",
    );
    store.close();
    app = await buildApp({ database });
    const response = await app.inject({
      method: "POST",
      url: "/api/domains",
      headers: {
        cookie: "wikibot_session=persisted-session",
        "idempotency-key": "origin-missing",
      },
      payload: { id: "untrusted", name: "untrusted" },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "ORIGIN_NOT_ALLOWED");
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
