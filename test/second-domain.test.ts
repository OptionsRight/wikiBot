import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { snapshot } from "../src/snapshot.js";
import { setup, publish } from "./helpers.js";

test("a configured non-advertising domain publishes and answers without crossing knowledge, roles, preferences or private objects", async () => {
  const prompts: {
    question: string;
    history?: unknown[];
    pages: { id: string }[];
  }[] = [];
  const systems: string[] = [];
  const t = await setup({
    model: {
      async generate(r) {
        systems.push(r.system);
        const prompt = JSON.parse(r.prompt);
        prompts.push(prompt);
        return {
          text: JSON.stringify({
            text: "合成领域的回答",
            citations: [prompt.pages[0].id],
          }),
          model: r.model,
          inputTokens: 1,
          outputTokens: 1,
          firstTextMs: 1,
          totalMs: 1,
          stopReason: "end_turn",
        };
      },
    },
  });
  try {
    await publish(t);
    assert.equal(
      (
        await t.request("POST", "/api/domains", {
          id: "equipment",
          name: "设备借用合成示例",
        })
      ).status,
      201,
    );
    for (const [subject, role] of [
      ["equipment-admin", "admin"],
      ["alice", "member"],
    ])
      assert.equal(
        (
          await t.request("PUT", `/api/domains/equipment/members/${subject}`, {
            role,
            tags: ["business", "technical"],
            expectedVersion: 0,
          })
        ).status,
        200,
      );
    const admin = (
      await t.request("POST", "/api/identities/equipment-admin/tokens", {})
    ).value.token;
    const manifest = JSON.parse(
      await readFile(
        new URL("../examples/second-domain/manifest.json", import.meta.url),
        "utf8",
      ),
    );
    const bundle = await snapshot(
      new URL("../examples/second-domain/wiki", import.meta.url).pathname,
      manifest,
    );
    const release = await publish(t, bundle, "equipment", admin);
    assert.equal(
      (
        await t.request(
          "POST",
          "/api/domains/equipment/submissions",
          bundle,
          t.admin,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await t.request(
          "GET",
          "/api/domains/equipment/knowledge",
          undefined,
          t.bob,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await t.request(
          "GET",
          "/api/domains/equipment/releases",
          undefined,
          t.alice,
        )
      ).status,
      403,
    );
    const ask = async (domain: string, question: string) => {
      const created = await t.request(
        "POST",
        `/api/domains/${domain}/answers`,
        { question, sessionId: "same-session" },
        t.alice,
      );
      assert.equal(created.status, 202);
      for (let n = 0; n < 100; n++) {
        const response = await t.request(
          "GET",
          `/api/domains/${domain}/answers/${created.value.id}`,
          undefined,
          t.alice,
        );
        if (!["running", "queued"].includes(response.value.state))
          return response.value;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Answer did not settle");
    };
    const [ads, equipment] = await Promise.all([
      ask("ads", "示例流程怎么走"),
      ask("equipment", "设备借用如何登记领取"),
    ]);
    assert.equal(equipment.releaseId, release.id);
    assert.equal(equipment.state, "complete");
    assert.deepEqual(equipment.blocks[0].citations, ["equipment"]);
    assert.equal(equipment.style, "technical");
    assert.equal(ads.style, "business");
    const equipmentPrompt = prompts.find(
      (p) => p.question === "设备借用如何登记领取",
    )!;
    assert.deepEqual(
      equipmentPrompt.pages.map((p) => p.id),
      ["equipment"],
    );
    assert.equal(equipmentPrompt.history, undefined);
    assert.ok(
      systems.some(
        (s) => s.includes("设备借用合成示例") && s.includes("保留设备编号"),
      ),
    );
    assert.equal(
      (
        await t.request(
          "GET",
          `/api/domains/ads/answers/${equipment.id}`,
          undefined,
          t.alice,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await t.request(
          "GET",
          `/api/domains/equipment/answers/${ads.id}`,
          undefined,
          t.alice,
        )
      ).status,
      404,
    );
    await t.request(
      "PATCH",
      "/api/domains/ads/preferences",
      { style: "technical", depth: "experienced", expectedVersion: 0 },
      t.alice,
    );
    assert.equal(
      (
        await t.request(
          "GET",
          "/api/domains/equipment/preferences",
          undefined,
          t.alice,
        )
      ).value.depth,
      "beginner",
    );
    const ticket = await t.request(
      "POST",
      "/api/domains/equipment/tickets",
      {
        title: "设备借用示例问题",
        description: "请设备管理员核对该示例问题的知识依据",
        category: "question",
      },
      t.alice,
    );
    assert.equal(ticket.status, 201);
    assert.equal(
      (
        await t.request(
          "GET",
          `/api/domains/equipment/tickets/${ticket.value.id}`,
          undefined,
          t.admin,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await t.request(
          "GET",
          `/api/domains/ads/tickets/${ticket.value.id}`,
          undefined,
          t.alice,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await t.request(
          "GET",
          `/api/domains/equipment/tickets/${ticket.value.id}`,
          undefined,
          admin,
        )
      ).status,
      200,
    );
  } finally {
    await t.app.close();
  }
});
