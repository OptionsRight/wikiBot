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

test("independent release identity cannot reopen a corrupted restored bundle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wikibot-corrupt-"));
  let app;
  try {
    const database = join(dir, "state.sqlite");
    const first = await setup({ database });
    const release = await publish(first);
    await first.app.close();
    // Inject corruption at the persisted backup boundary, preserving its claimed hash.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(database);
    release.bundle.pages[0].content = "corrupted restored knowledge";
    db.prepare("UPDATE objects SET data=? WHERE kind='release' AND id=?").run(
      JSON.stringify(release),
      release.id,
    );
    db.close();
    app = await buildApp({
      database,
      recovery: true,
      bootstrap: { token: "recovery-operator", subject: "operator" },
      recoveryAuthority: async (domain, nonce) => ({
        domain,
        nonce,
        issuedAt: Date.now(),
        evidenceId: "independent-live-authority",
        active: { id: release.id, descriptorHash: release.descriptorHash },
        grants: [],
        models: [
          { model: "test-model", revision: "r1", epoch: 0, qualified: true },
        ],
      }),
    });
    const recovered = await app.inject({
      method: "POST",
      url: "/api/operations/recover/ads",
      headers: {
        authorization: "Bearer recovery-operator",
        "idempotency-key": "corrupt",
      },
      payload: {},
    });
    assert.equal(recovered.statusCode, 409);
    assert.equal(recovered.json().error.code, "RESTORED_BUNDLE_CORRUPT");
    const status = await app.inject({
      url: "/api/operations/status",
      headers: { authorization: "Bearer recovery-operator" },
    });
    assert.equal(status.json().domains[0].maintenance, true);
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("recovery records the restored baseline and independent proof scope for operators", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wikibot-recovery-record-"));
  let app;
  try {
    const database = join(dir, "state.sqlite");
    const t = await setup({ database });
    const release = await publish(t);
    await t.app.close();
    app = await buildApp({
      database,
      recovery: true,
      bootstrap: { token: "operator-new", subject: "operator" },
      recoveryAuthority: async (domain, nonce) => ({
        domain,
        nonce,
        issuedAt: Date.now(),
        evidenceId: "independent-state-record",
        active: { id: release.id, descriptorHash: release.descriptorHash },
        grants: [{ subject: "admin", role: "admin", tags: ["technical"] }],
        models: [
          { model: "test-model", revision: "r1", epoch: 0, qualified: true },
        ],
      }),
    });
    const headers = {
      authorization: "Bearer operator-new",
      "idempotency-key": "restore",
    };
    const recovered = await app.inject({
      method: "POST",
      url: "/api/operations/recover/ads",
      headers,
      payload: {},
    });
    assert.equal(recovered.statusCode, 200);
    const status = await app.inject({ url: "/api/operations/status", headers });
    const record = status.json().recoveries[0];
    assert.equal(record.baseline.active, release.id);
    assert.equal(record.evidenceId, "independent-state-record");
    assert.equal(record.confirmedBy, "operator");
    assert.equal(record.grantCount, 1);
    assert.equal(record.active.descriptorHash, release.descriptorHash);
    assert.ok(record.openedAt >= record.quarantinedAt);
    assert.equal(status.json().domains[0].readiness, "ready");
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an actual SQLite backup cannot restore revoked service or removed membership from its own audit", async () => {
  const { DatabaseSync, backup } = await import("node:sqlite");
  const dir = await mkdtemp(join(tmpdir(), "wikibot-backup-drill-"));
  let restored;
  try {
    const source = join(dir, "source.sqlite"),
      target = join(dir, "backup.sqlite");
    const t = await setup({ database: source });
    try {
      const release = await publish(t);
      const db = new DatabaseSync(source, { readOnly: true });
      try {
        await backup(db, target);
      } finally {
        db.close();
      }
      assert.equal(
        (
          await t.request("PUT", "/api/domains/ads/members/alice", {
            role: "member",
            enabled: false,
            expectedVersion: 1,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await t.request(
            "POST",
            `/api/domains/ads/releases/${release.id}/revoke`,
            {
              expectedVersion: release.version,
              expectedEpoch: 1,
              expectedActive: release.id,
              descriptorHash: release.descriptorHash,
              reason: "synthetic post-backup revocation",
            },
            t.admin,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await t.request("POST", "/api/models/change", {
            model: "test-model",
            revision: "r1",
            expectedEpoch: 0,
            reason: "synthetic post-backup model change",
          })
        ).status,
        200,
      );
      restored = await buildApp({
        database: target,
        recovery: true,
        bootstrap: { token: "new-recovery", subject: "operator" },
        recoveryAuthority: async (domain, nonce) => ({
          domain,
          nonce,
          issuedAt: Date.now(),
          evidenceId: "synthetic-independent-current-state",
          active: null,
          grants: [],
          models: [
            { model: "test-model", revision: "r1", epoch: 1, qualified: false },
          ],
        }),
      });
      const headers = {
        authorization: "Bearer new-recovery",
        "idempotency-key": "recover-backup",
      };
      const opened = await restored.inject({
        method: "POST",
        url: "/api/operations/recover/ads",
        headers,
        payload: {},
      });
      assert.equal(opened.statusCode, 200);
      const status = await restored.inject({
        url: "/api/operations/status",
        headers,
      });
      assert.equal(status.json().domains[0].active, null);
      assert.equal(status.json().domains[0].readiness, "KNOWLEDGE_UNAVAILABLE");
      assert.equal(
        (
          await restored.inject({
            url: "/api/domains",
            headers: { authorization: `Bearer ${t.alice}` },
          })
        ).statusCode,
        401,
      );
    } finally {
      await t.app.close();
    }
  } finally {
    await restored?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a previous recovery command cannot falsely acknowledge a later restore cycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wikibot-recovery-cycle-"));
  let app;
  try {
    const database = join(dir, "state.sqlite");
    const t = await setup({ database });
    await publish(t);
    const answer = (
      await t.request(
        "POST",
        "/api/domains/ads/answers",
        { question: "示例流程怎么做", sessionId: "delivered-before-restore" },
        t.alice,
      )
    ).value;
    await t.request(
      "GET",
      `/api/domains/ads/answers/${answer.id}`,
      undefined,
      t.alice,
    );
    await t.request(
      "POST",
      `/api/domains/ads/answers/${answer.id}/ack`,
      { through: 1 },
      t.alice,
    );
    await t.app.close();
    const options = {
      database,
      recovery: true,
      bootstrap: { token: "recovery", subject: "operator" },
      recoveryAuthority: async (domain: string, nonce: string) => ({
        domain,
        nonce,
        issuedAt: Date.now(),
        evidenceId: "synthetic-current-state",
        active: null,
        grants: [],
        models: [],
      }),
    };
    const headers = {
      authorization: "Bearer recovery",
      "idempotency-key": "same-recovery-key",
    };
    app = await buildApp(options);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/operations/recover/ads",
          headers,
          payload: {},
        })
      ).statusCode,
      200,
    );
    await app.close();
    app = await buildApp(options);
    const stale = await app.inject({
      method: "POST",
      url: "/api/operations/recover/ads",
      headers,
      payload: {},
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "IDEMPOTENCY_CONFLICT");
    const status = await app.inject({ url: "/api/operations/status", headers });
    assert.equal(status.json().domains[0].maintenance, true);
    const archived = status.json().recoveryHistory[0];
    assert.equal(archived.evidenceId, "synthetic-current-state");
    assert.equal(archived.confirmedBy, "operator");
    assert.equal(
      archived.historicalDelivery.find(
        (a: { answerId: string }) => a.answerId === answer.id,
      ).deliveredThrough,
      1,
    );
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
