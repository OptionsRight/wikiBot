import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";

test("operator can locate access rejection alerts without retaining request content or tokens", async () => {
  const t = await setup();
  try {
    const denied = await t.request(
      "POST",
      "/api/domains",
      { id: "secret_body", name: "private content" },
      t.alice,
    );
    assert.equal(denied.status, 403);
    const status = await t.request("GET", "/api/operations/status");
    assert.ok(
      status.value.alerts.some(
        (a: { code: string }) => a.code === "ACCESS_REJECTED",
      ),
    );
    const events = await t.request("GET", "/api/operations/events");
    assert.equal(events.status, 200);
    assert.ok(
      events.value.some(
        (e: { requestId: string; code: string }) =>
          e.requestId === denied.value.error.requestId &&
          e.code === "FORBIDDEN",
      ),
    );
    assert.ok(!JSON.stringify(events.value).includes("private content"));
    assert.ok(!JSON.stringify(events.value).includes(t.alice));
    assert.equal(
      (await t.request("GET", "/api/operations/events", undefined, t.alice))
        .status,
      403,
    );
  } finally {
    await t.app.close();
  }
});

test("cleanup requires an explicit metadata policy and preserves business idempotency", async () => {
  const unconfigured = await setup();
  try {
    assert.equal(
      (await unconfigured.request("POST", "/api/operations/cleanup", {})).value
        .error.code,
      "RETENTION_POLICY_REQUIRED",
    );
  } finally {
    await unconfigured.app.close();
  }
  const t = await setup({
    operationalRetention: {
      eventRetentionMs: 1,
      policyId: "synthetic-test-policy",
    },
  });
  try {
    await t.request(
      "POST",
      "/api/domains",
      { id: "denied", name: "denied" },
      t.alice,
    );
    const input = { id: "retained", name: "retained" };
    const created = await t.request(
      "POST",
      "/api/domains",
      input,
      undefined,
      "retained-command",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      (await t.request("POST", "/api/operations/cleanup", {}, t.admin)).status,
      403,
    );
    const cleaned = await t.request("POST", "/api/operations/cleanup", {});
    assert.equal(cleaned.status, 200);
    assert.ok(cleaned.value.eventsRemoved >= 1);
    assert.equal(cleaned.value.policyId, "synthetic-test-policy");
    const replay = await t.request(
      "POST",
      "/api/domains",
      input,
      undefined,
      "retained-command",
    );
    assert.deepEqual(replay.value, created.value);
    assert.equal(
      (
        await t.request("POST", "/api/operations/cleanup", {
          deleteAnswers: true,
        })
      ).status,
      400,
    );
  } finally {
    await t.app.close();
  }
});

test("operator alerts include persisted unknown answer deliveries separately from notices", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Store } = await import("../src/core.js");
  const dir = await mkdtemp(join(tmpdir(), "wikibot-unknown-delivery-"));
  try {
    const database = join(dir, "state.sqlite");
    const store = new Store(database);
    store.put("inbox", {
      id: "unknown-receipt",
      domain: "ads",
      version: 1,
      state: "unknown",
      answerId: "answer-reference",
      owner: "private-user",
      messageId: "private-message",
    });
    store.put("revision", {
      id: "source-conflict",
      domain: "ads",
      version: 1,
      maintenance: { state: "conflict" },
    });
    store.close();
    const t = await setup({ database });
    try {
      const status = await t.request("GET", "/api/operations/status");
      assert.equal(status.value.deliveryUnknown, 1);
      assert.ok(
        status.value.alerts.some(
          (a: { code: string }) => a.code === "SOURCE_CONFLICT",
        ),
      );
      assert.equal(status.value.sourceIssues[0].id, "source-conflict");
      assert.equal(status.value.unknownDeliveries[0].id, "unknown-receipt");
      assert.equal(status.value.unknownDeliveries[0].kind, "inbox");
      assert.ok(
        status.value.alerts.some(
          (a: { code: string }) => a.code === "DELIVERY_UNKNOWN",
        ),
      );
      assert.ok(!JSON.stringify(status.value).includes("private-user"));
      assert.ok(!JSON.stringify(status.value).includes("private-message"));
    } finally {
      await t.app.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
