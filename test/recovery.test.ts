import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, publish } from "./helpers.js";
import { buildApp } from "../src/app.js";
test("restored data stays closed until independent current authorization and revocation are reconciled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wikibot-recovery-"));
  let app;
  try {
    const first = await setup({ database: join(dir, "state.sqlite") });
    await publish(first);
    const alice = first.alice;
    await first.app.close();
    app = await buildApp({
      database: join(dir, "state.sqlite"),
      bootstrap: { token: "new-operator", subject: "operator" },
      recovery: true,
      recoveryAuthority: async (domain, nonce) => ({
        domain,
        nonce,
        issuedAt: Date.now(),
        active: null,
        grants: [],
        models: [],
        evidenceId: "independent-current-directory-and-revocation-log",
      }),
    });
    let response = await app.inject({
      method: "GET",
      url: "/api/domains/ads/knowledge",
      headers: { authorization: "Bearer new-operator" },
    });
    assert.equal(response.statusCode, 503);
    response = await app.inject({
      method: "POST",
      url: "/api/operations/recover/ads",
      headers: {
        authorization: "Bearer new-operator",
        "idempotency-key": "restore-once",
      },
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    response = await app.inject({
      method: "GET",
      url: "/api/domains/ads/knowledge",
      headers: { authorization: `Bearer ${alice}` },
    });
    assert.equal(response.statusCode, 401);
    const fresh = await app.inject({
      method: "POST",
      url: "/api/identities/alice/tokens",
      headers: { authorization: "Bearer new-operator" },
      payload: {},
    });
    response = await app.inject({
      method: "GET",
      url: "/api/domains/ads/capabilities",
      headers: { authorization: `Bearer ${fresh.json().token}` },
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
