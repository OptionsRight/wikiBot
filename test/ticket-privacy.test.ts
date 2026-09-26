import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";
test("merging reports and internal notes never reveal another reporter’s material", async () => {
  const t = await setup();
  try {
    const a = (
      await t.request(
        "POST",
        "/api/domains/ads/tickets",
        {
          title: "甲问题",
          description: "甲的私人问题材料",
          category: "question",
        },
        t.alice,
      )
    ).value;
    const b = (
      await t.request(
        "POST",
        "/api/domains/ads/tickets",
        {
          title: "乙问题",
          description: "乙的私人问题材料",
          category: "question",
        },
        t.bob,
      )
    ).value;
    const noted = (
      await t.request(
        "POST",
        `/api/domains/ads/tickets/${a.id}/actions`,
        {
          action: "note",
          expectedVersion: a.version,
          text: "只允许处理人读取的内部判断",
        },
        t.admin,
      )
    ).value;
    const merged = (
      await t.request(
        "POST",
        `/api/domains/ads/tickets/${a.id}/actions`,
        { action: "merge", expectedVersion: noted.version, targetId: b.id },
        t.admin,
      )
    ).value;
    assert.equal(merged.state, "duplicate");
    const member = (
      await t.request(
        "GET",
        `/api/domains/ads/tickets/${a.id}`,
        undefined,
        t.alice,
      )
    ).value;
    assert.deepEqual(member.comments, []);
    assert.equal(member.duplicateOf, undefined);
    assert.equal(
      (
        await t.request(
          "GET",
          `/api/domains/ads/tickets/${b.id}`,
          undefined,
          t.alice,
        )
      ).status,
      404,
    );
  } finally {
    await t.app.close();
  }
});
