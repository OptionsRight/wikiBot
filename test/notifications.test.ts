import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { setup, publish } from "./helpers.js";
import type { WecomTransport } from "../src/adapters/wecom.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";

async function eventually<T>(
  read: () => Promise<T>,
  accept: (v: T) => boolean,
) {
  for (let i = 0; i < 50; i++) {
    const value = await read();
    if (accept(value)) return value;
    await delay(20);
  }
  assert.fail("Expected observable state was not reached");
}

test("ticket notifications reach only the mapped reporter with a stable event ID, without private content or duplicate business work", async () => {
  const sent: { user: string; text: string }[] = [];
  const transport: WecomTransport = {
    start() {},
    close() {},
    async reply() {},
    async notify(user, text) {
      sent.push({ user, text });
      return { state: "acked" };
    },
  };
  const t = await setup({
    wecom: {
      botId: "test",
      domain: "ads",
      members: { opaqueCallback: "alice" },
      notificationRecipients: { alice: "wecomAlice" },
      transport,
      notifications: true,
    },
  });
  try {
    const input = {
      title: "私人标题",
      description: "不应推送的详细私人描述",
      category: "question",
    };
    const ticket = (
      await t.request(
        "POST",
        "/api/domains/ads/tickets",
        input,
        t.alice,
        "one-ticket",
      )
    ).value;
    const notices = await eventually(
      async () =>
        (await t.request("GET", "/api/domains/ads/notices", undefined, t.alice))
          .value,
      (v) => v[0]?.state === "acked",
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.user, "wecomAlice");
    assert.ok(sent[0]!.text.includes(notices[0].id));
    assert.ok(sent[0]!.text.includes(ticket.id));
    assert.doesNotMatch(sent[0]!.text, /私人/);
    assert.deepEqual(
      (await t.request("GET", "/api/domains/ads/notices", undefined, t.bob))
        .value,
      [],
    );
    await t.request(
      "POST",
      "/api/domains/ads/tickets",
      input,
      t.alice,
      "one-ticket",
    );
    await delay(150);
    assert.equal(sent.length, 1);
    assert.equal(notices[0].attempts, 1);
  } finally {
    await t.app.close();
  }
});

test("queued notices recheck access; model and withdrawal notices contain only status for an already acknowledged answer", async () => {
  let connected = false;
  const sent: { user: string; text: string }[] = [];
  const transport: WecomTransport = {
    start() {},
    close() {},
    async reply() {},
    ready() {
      return connected;
    },
    async notify(user, text) {
      sent.push({ user, text });
      return { state: "acked" };
    },
  };
  const t = await setup({
    wecom: {
      botId: "test",
      domain: "ads",
      members: { alice: "alice", bob: "bob" },
      notificationRecipients: { alice: "alice", bob: "bob" },
      transport,
      notifications: true,
    },
  });
  try {
    const release = await publish(t);
    await t.request(
      "POST",
      "/api/domains/ads/tickets",
      {
        title: "test",
        description: "等待送达的私人问题",
        category: "question",
      },
      t.bob,
    );
    await t.request("PUT", "/api/domains/ads/members/bob", {
      role: "member",
      enabled: false,
      expectedVersion: 1,
    });
    const ask = async (sessionId: string) =>
      (
        await t.request(
          "POST",
          "/api/domains/ads/answers",
          { question: "示例流程怎么做", sessionId },
          t.alice,
        )
      ).value;
    const delivered = await ask("delivered"),
      undelivered = await ask("undelivered");
    await eventually(
      async () =>
        (
          await t.request(
            "GET",
            `/api/domains/ads/answers/${delivered.id}`,
            undefined,
            t.alice,
          )
        ).value,
      (v) => v.state === "complete",
    );
    await t.request(
      "POST",
      `/api/domains/ads/answers/${delivered.id}/ack`,
      { through: 1 },
      t.alice,
    );
    await t.request("POST", "/api/models/change", {
      model: "test-model",
      revision: "r1",
      expectedEpoch: 0,
      reason: "测试模型变化后的原受众通知",
    });
    connected = true;
    await eventually(
      async () => sent,
      (v) => v.length === 1,
    );
    assert.equal(sent[0]!.user, "alice");
    assert.match(sent[0]!.text, /模型验证待确认/);
    assert.ok(sent[0]!.text.includes(delivered.id));
    assert.ok(!sent[0]!.text.includes(undelivered.id));
    assert.doesNotMatch(sent[0]!.text, /这是测试模型的回答|私人/);
    await t.request(
      "POST",
      `/api/domains/ads/releases/${release.id}/revoke`,
      {
        expectedVersion: release.version,
        expectedEpoch: 1,
        expectedActive: release.id,
        descriptorHash: release.descriptorHash,
        reason: "专家确认测试流程需要立即撤回",
      },
      t.admin,
    );
    await eventually(
      async () => sent,
      (v) => v.length === 2,
    );
    assert.match(sent[1]!.text, /已失效/);
    assert.doesNotMatch(sent[1]!.text, /这是测试模型的回答/);
    await delay(150);
    assert.equal(sent.length, 2);
  } finally {
    await t.app.close();
  }
});

test("an unacknowledged notification survives a restart without another send", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wikibot-notices-"));
  let sends = 0,
    reopened;
  const transport: WecomTransport = {
    start() {},
    close() {},
    async reply() {},
    async notify() {
      sends++;
      return { state: "unknown" };
    },
  };
  const wecom = {
    botId: "test",
    domain: "ads",
    members: { alice: "alice" },
    notificationRecipients: { alice: "alice" },
    transport,
    notifications: true,
  };
  const database = join(dir, "state.sqlite");
  const t = await setup({ database, wecom });
  try {
    await t.request(
      "POST",
      "/api/domains/ads/tickets",
      { title: "test", description: "等待通知的问题", category: "question" },
      t.alice,
    );
    const before = (
      await eventually(
        async () =>
          (
            await t.request(
              "GET",
              "/api/domains/ads/notices",
              undefined,
              t.alice,
            )
          ).value,
        (v) => v[0]?.state === "unknown",
      )
    )[0];
    await t.app.close();
    reopened = await buildApp({ database, wecom });
    await reopened.ready();
    await delay(250);
    const restored = (
      await reopened.inject({
        method: "GET",
        url: "/api/domains/ads/notices",
        headers: { authorization: `Bearer ${t.alice}` },
      })
    ).json();
    assert.equal(restored[0].id, before.id);
    assert.equal(restored[0].state, "unknown");
    assert.equal(sends, 1);
  } finally {
    await t.app.close();
    await reopened?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("only an explicit server refusal can be retried; an unknown ACK stays uncertain and never re-executes the ticket", async () => {
  let mode: "failed" | "unknown" | "acked" = "failed";
  const sent: string[] = [];
  const transport: WecomTransport = {
    start() {},
    close() {},
    async reply() {},
    async notify(_user, text) {
      sent.push(text);
      return mode === "failed"
        ? { state: mode, code: "WECOM_REJECTED_45009" }
        : { state: mode };
    },
  };
  const t = await setup({
    wecom: {
      botId: "test",
      domain: "ads",
      members: { alice: "alice" },
      notificationRecipients: { alice: "alice" },
      transport,
      notifications: true,
    },
  });
  const notices = async () =>
    (await t.request("GET", "/api/domains/ads/notices", undefined, t.alice))
      .value;
  try {
    await t.request(
      "POST",
      "/api/domains/ads/tickets",
      { title: "test", description: "需要跟进的问题", category: "question" },
      t.alice,
    );
    const failed = (
      await eventually(notices, (v) => v[0]?.state === "failed")
    )[0];
    assert.equal(failed.retryable, true);
    assert.equal(
      (
        await t.request(
          "POST",
          `/api/domains/ads/notices/${failed.id}/retry`,
          { expectedVersion: failed.version },
          t.bob,
        )
      ).status,
      404,
    );
    mode = "unknown";
    assert.equal(
      (
        await t.request(
          "POST",
          `/api/domains/ads/notices/${failed.id}/retry`,
          { expectedVersion: failed.version },
          t.alice,
        )
      ).status,
      200,
    );
    const unknown = (
      await eventually(
        notices,
        (v) => v[0]?.state === "unknown" && v[0]?.attempts === 2,
      )
    )[0];
    assert.equal(
      (
        await t.request(
          "POST",
          `/api/domains/ads/notices/${unknown.id}/retry`,
          { expectedVersion: unknown.version },
          t.alice,
        )
      ).status,
      409,
    );
    mode = "acked";
    await delay(250);
    assert.equal(sent.length, 2);
    assert.equal(sent[0], sent[1]);
    assert.equal(
      (await t.request("GET", "/api/domains/ads/tickets", undefined, t.alice))
        .value.length,
      1,
    );
  } finally {
    await t.app.close();
  }
});

test("a callback identity alone never becomes a proactive notification address", async () => {
  let sends = 0;
  const transport: WecomTransport = {
    start() {},
    close() {},
    async reply() {},
    async notify() {
      sends++;
      return { state: "acked" };
    },
  };
  const t = await setup({
    wecom: {
      botId: "test",
      domain: "ads",
      members: { opaqueCallback: "alice" },
      notifications: true,
      transport,
    },
  });
  try {
    await t.request(
      "POST",
      "/api/domains/ads/tickets",
      {
        title: "测试通知",
        description: "回调身份不等于发送地址",
        category: "question",
      },
      t.alice,
    );
    const notices = await eventually(
      async () =>
        (await t.request("GET", "/api/domains/ads/notices", undefined, t.alice))
          .value,
      (v) => v[0]?.code === "RECIPIENT_UNMAPPED",
    );
    assert.equal(notices[0].state, "pending");
    assert.equal(sends, 0);
  } finally {
    await t.app.close();
  }
});
