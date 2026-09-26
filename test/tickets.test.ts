import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";
test("standalone issues work without a model, and only the reporter can confirm resolution", async () => {
  const t = await setup({ model: undefined });
  try {
    const payload = {
      title: "配置问题",
      description: "资料没有覆盖当前的配置场景，需要处理人帮助",
      category: "question",
    };
    const created = await t.request(
      "POST",
      "/api/domains/ads/tickets",
      payload,
      t.alice,
      "ticket-once",
    );
    assert.equal(created.status, 201);
    let ticket = created.value;
    assert.equal(
      (
        await t.request(
          "POST",
          "/api/domains/ads/tickets",
          payload,
          t.alice,
          "ticket-once",
        )
      ).value.id,
      ticket.id,
    );
    assert.equal(
      (
        await t.request(
          "GET",
          `/api/domains/ads/tickets/${ticket.id}`,
          undefined,
          t.bob,
        )
      ).status,
      404,
    );
    for (const action of ["triage", "start", "resolve"]) {
      const result = await t.request(
        "POST",
        `/api/domains/ads/tickets/${ticket.id}/actions`,
        {
          action,
          expectedVersion: ticket.version,
          text: "已在操作手册第三节找到依据，请报告人核验",
        },
        t.admin,
      );
      assert.equal(result.status, 200);
      ticket = result.value;
    }
    assert.equal(ticket.state, "resolved");
    assert.equal(
      (
        await t.request(
          "POST",
          `/api/domains/ads/tickets/${ticket.id}/actions`,
          { action: "close", expectedVersion: ticket.version },
          t.admin,
        )
      ).status,
      403,
    );
    ticket = (
      await t.request(
        "POST",
        `/api/domains/ads/tickets/${ticket.id}/actions`,
        { action: "close", expectedVersion: ticket.version },
        t.alice,
      )
    ).value;
    assert.equal(ticket.state, "closed");
    ticket = (
      await t.request(
        "POST",
        `/api/domains/ads/tickets/${ticket.id}/actions`,
        {
          action: "reopen",
          expectedVersion: ticket.version,
          text: "再次出现相同问题",
        },
        t.alice,
      )
    ).value;
    assert.equal(ticket.state, "submitted");
  } finally {
    await t.app.close();
  }
});
