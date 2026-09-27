import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";
import type { Inbound, WecomTransport } from "../src/adapters/wecom.js";

test("two configured bots independently route identical callback and message ids to their domains", async () => {
  const handlers: ((event: Inbound) => Promise<void>)[] = [];
  const sent: string[][] = [[], []];
  const transport = (index: number): WecomTransport => ({
    start(handler) {
      handlers[index] = handler;
    },
    close() {},
    async reply(_event, _stream, text) {
      sent[index]!.push(text);
    },
  });
  const bots = [
    {
      botId: "ads-bot",
      domain: "ads",
      members: { callback: "alice" },
      transport: transport(0),
    },
    {
      botId: "equipment-bot",
      domain: "equipment",
      members: { callback: "bob" },
      transport: transport(1),
    },
  ];
  const t = await setup({ wecom: bots });
  try {
    assert.equal(
      (
        await t.request("POST", "/api/domains", {
          id: "equipment",
          name: "设备借用合成示例",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await t.request("PUT", "/api/domains/equipment/members/bob", {
          role: "member",
          expectedVersion: 0,
        })
      ).status,
      200,
    );
    const event: Inbound = {
      id: "same-message",
      botId: "ads-bot",
      userId: "callback",
      chatType: "single",
      text: "/登记 这是一条合成的领域隔离问题",
      replyContext: {},
    };
    await Promise.all([
      handlers[0]!(event),
      handlers[1]!({ ...event, botId: "equipment-bot" }),
    ]);
    assert.equal(sent[0]!.length, 1);
    assert.equal(sent[1]!.length, 1);
    const ads = (
      await t.request("GET", "/api/domains/ads/tickets", undefined, t.alice)
    ).value;
    const equipment = (
      await t.request("GET", "/api/domains/equipment/tickets", undefined, t.bob)
    ).value;
    assert.equal(ads.length, 1);
    assert.equal(equipment.length, 1);
    assert.notEqual(ads[0].id, equipment[0].id);
    for (const [domain, token, ticket] of [
      ["ads", t.alice, ads[0]],
      ["equipment", t.bob, equipment[0]],
    ] as const) {
      const receipts = (
        await t.request(
          "GET",
          `/api/domains/${domain}/channel-receipts`,
          undefined,
          token,
        )
      ).value;
      assert.deepEqual(
        receipts[0].commands.map((c: { state: string; objectId: string }) => [
          c.state,
          c.objectId,
        ]),
        [["committed", ticket.id]],
      );
    }
    assert.equal(
      (
        await t.request(
          "GET",
          "/api/domains/equipment/tickets",
          undefined,
          t.alice,
        )
      ).status,
      403,
    );
    await handlers[0]!({
      ...event,
      id: "forged-route",
      botId: "equipment-bot",
    });
    assert.equal(sent[0]!.length, 1);
  } finally {
    await t.app.close();
  }
});
