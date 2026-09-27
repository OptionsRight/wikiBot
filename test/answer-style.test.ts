import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, publish } from "./helpers.js";
import { setTimeout as delay } from "node:timers/promises";
import type { Inbound } from "../src/adapters/wecom.js";

const route = "/api/domains/ads/answer-style";

test("knowledge administrators can save expression drafts without changing published answers or granting members configuration access", async () => {
  const t = await setup();
  try {
    const active = await publish(t);
    const state = await t.request("GET", route, undefined, t.admin);
    assert.equal(state.status, 200);
    assert.equal(state.value.active.id, active.id);
    assert.equal(state.value.publishedTemplates, null);
    assert.match(state.value.recommendedTemplates.business, /业务目标/);
    assert.match(state.value.recommendedTemplates.technical, /接口/);
    assert.match(state.value.recommendedTemplates.beginner, /术语/);
    assert.match(state.value.recommendedTemplates.experienced, /结论/);
    const input = {
      expectedVersion: 0,
      baseReleaseId: active.id,
      templates: state.value.recommendedTemplates,
      caseId: "example",
    };
    assert.equal(
      (await t.request("GET", route, undefined, t.alice)).status,
      403,
    );
    assert.equal(
      (await t.request("PUT", `${route}/draft`, input, t.alice)).status,
      403,
    );
    const saved = await t.request("PUT", `${route}/draft`, input, t.admin);
    assert.equal(saved.status, 200);
    const reloaded = (await t.request("GET", route, undefined, t.admin)).value;
    assert.deepEqual(reloaded.draft.templates, input.templates);
    assert.equal(reloaded.draft.version, 1);
    assert.equal(reloaded.publishedTemplates, null);
    assert.equal(reloaded.active.id, active.id);
    assert.equal(
      (await t.request("PUT", `${route}/draft`, input, t.admin)).status,
      409,
    );
    const blank = structuredClone(input);
    blank.expectedVersion = 1;
    blank.templates.business = "  ";
    assert.equal(
      (await t.request("PUT", `${route}/draft`, blank, t.admin)).status,
      400,
    );
  } finally {
    await t.app.close();
  }
});

test("four expression previews use the same published evidence and only a reviewed new version changes member answers", async () => {
  const prompts: string[] = [];
  let receive!: (event: Inbound) => Promise<void>;
  const messages: string[] = [];
  const t = await setup({
    wecom: {
      botId: "test",
      domain: "ads",
      members: { alice: "alice" },
      transport: {
        start(handler) {
          receive = handler;
        },
        close() {},
        async reply(_event, _stream, text) {
          messages.push(text);
        },
      },
    },
    model: {
      async generate(r) {
        prompts.push(r.system);
        const pages = JSON.parse(r.prompt).pages;
        return {
          text: JSON.stringify({
            text: r.system.includes("业务表达标记")
              ? "业务表达"
              : r.system.includes("技术表达标记")
                ? "技术表达"
                : "原版表达",
            citations: [pages[0].id],
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
    const active = await publish(t);
    const state = (await t.request("GET", route, undefined, t.admin)).value;
    const templates = { ...state.recommendedTemplates };
    templates.business += "业务表达标记";
    templates.technical += "技术表达标记";
    const draft = (
      await t.request(
        "PUT",
        `${route}/draft`,
        {
          expectedVersion: 0,
          baseReleaseId: active.id,
          templates,
          caseId: "example",
        },
        t.admin,
      )
    ).value;
    const input = { expectedVersion: draft.version };
    const submission = await t.request(
      "POST",
      `${route}/submissions`,
      input,
      t.admin,
      "style-submit",
    );
    assert.equal(submission.status, 201);
    const candidate = submission.value;
    assert.deepEqual(candidate.bundle.pages, active.bundle.pages);
    assert.deepEqual(candidate.bundle.config.answerTemplates, templates);
    assert.equal(candidate.answerStyle.caseIds.length, 4);
    assert.equal(candidate.state, "submitted");
    assert.equal(
      (
        await t.request(
          "POST",
          `${route}/submissions`,
          input,
          t.admin,
          "style-submit",
        )
      ).value.id,
      candidate.id,
    );
    const before = (await t.request("GET", route, undefined, t.admin)).value;
    assert.equal(before.active.id, active.id);
    assert.equal(before.candidate.id, candidate.id);
    const review = {
      expectedVersion: 1,
      descriptorHash: candidate.descriptorHash,
      evidence: "测试核对四种表达及其引用，未修改业务知识",
      approved: true,
    };
    assert.equal(
      (
        await t.request(
          "POST",
          `/api/domains/ads/releases/${candidate.id}/review`,
          review,
          t.admin,
        )
      ).status,
      409,
    );
    const previewPairs = new Set<string>();
    for (const c of candidate.bundle.cases) {
      const evaluated = await t.request(
        "POST",
        `/api/domains/ads/releases/${candidate.id}/evaluations`,
        { caseId: c.id, descriptorHash: candidate.descriptorHash },
        t.admin,
      );
      assert.equal(evaluated.value.verdict, "pass");
      if (candidate.answerStyle.caseIds.includes(c.id)) {
        assert.equal(c.question, "示例流程怎么走？");
        const prompt = prompts.at(-1)!;
        assert.ok(prompt.includes(templates[c.style]));
        assert.ok(prompt.includes(templates[c.depth]));
        previewPairs.add(`${c.style}/${c.depth}`);
      }
    }
    assert.deepEqual([...previewPairs].sort(), [
      "business/beginner",
      "business/experienced",
      "technical/beginner",
      "technical/experienced",
    ]);
    const ready = (
      await t.request(
        "POST",
        `/api/domains/ads/releases/${candidate.id}/review`,
        review,
        t.admin,
      )
    ).value;
    const activated = await t.request(
      "POST",
      `/api/domains/ads/releases/${candidate.id}/activate`,
      {
        expectedVersion: ready.version,
        expectedEpoch: candidate.baseEpoch,
        expectedActive: active.id,
        descriptorHash: candidate.descriptorHash,
      },
      t.admin,
    );
    assert.equal(activated.status, 200);
    for (const style of ["business", "technical"] as const) {
      const answer = (
        await t.request(
          "POST",
          "/api/domains/ads/answers",
          { question: "示例流程怎么做", sessionId: style, style },
          t.alice,
        )
      ).value;
      let final;
      for (let i = 0; i < 50; i++) {
        final = (
          await t.request(
            "GET",
            `/api/domains/ads/answers/${answer.id}`,
            undefined,
            t.alice,
          )
        ).value;
        if (!["queued", "running"].includes(final.state)) break;
        await delay(10);
      }
      assert.equal(final.state, "complete");
      assert.equal(final.releaseId, candidate.id);
      assert.equal(
        final.blocks[0].text,
        style === "business" ? "业务表达" : "技术表达",
      );
    }
    await t.request("PUT", "/api/domains/ads/members/alice", {
      expectedVersion: 1,
      role: "member",
      tags: ["business", "technical"],
    });
    const send = (id: string, text: string) =>
      receive({
        id,
        text,
        botId: "test",
        userId: "alice",
        chatType: "single",
        replyContext: {},
      });
    await send("technical-default", "示例流程怎么做");
    assert.match(messages.at(-1)!, /技术表达/);
    await send("preference", "/偏好 业务 熟练");
    await send("business-preference", "示例流程怎么做");
    assert.match(messages.at(-1)!, /业务表达/);
    assert.ok(prompts.at(-1)!.includes(templates.experienced));
    const after = (await t.request("GET", route, undefined, t.admin)).value;
    assert.deepEqual(
      after.cases.map((c: { id: string }) => c.id),
      ["example", "billing"],
    );
    const nextDraft = (
      await t.request(
        "PUT",
        `${route}/draft`,
        {
          expectedVersion: after.draft.version,
          baseReleaseId: candidate.id,
          templates,
          caseId: "billing",
        },
        t.admin,
      )
    ).value;
    const next = (
      await t.request(
        "POST",
        `${route}/submissions`,
        { expectedVersion: nextDraft.version },
        t.admin,
      )
    ).value;
    assert.equal(next.bundle.cases.length, candidate.bundle.cases.length);
    assert.deepEqual(next.bundle.pages, active.bundle.pages);
    for (const c of next.bundle.cases.filter((c: { id: string }) =>
      next.answerStyle.caseIds.includes(c.id),
    ))
      assert.equal(c.question, "代理商结算后多久打款？");
  } finally {
    await t.app.close();
  }
});

test("expression submission rejects stale drafts and cannot replace published knowledge through configuration input", async () => {
  const t = await setup();
  try {
    const active = await publish(t);
    const state = (await t.request("GET", route, undefined, t.admin)).value;
    const input = {
      expectedVersion: 0,
      baseReleaseId: active.id,
      templates: state.recommendedTemplates,
      caseId: "example",
    };
    await t.request("PUT", `${route}/draft`, input, t.admin);
    assert.equal(
      (
        await t.request(
          "POST",
          `${route}/submissions`,
          { expectedVersion: 1 },
          t.alice,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await t.request(
          "POST",
          `${route}/submissions`,
          { expectedVersion: 1, pages: [] },
          t.admin,
        )
      ).status,
      400,
    );
    const newer = await publish(t);
    assert.equal(
      (
        await t.request(
          "POST",
          `${route}/submissions`,
          { expectedVersion: 1 },
          t.admin,
        )
      ).value.error.code,
      "BASELINE_STALE",
    );
    assert.equal(
      (
        await t.request(
          "PUT",
          `${route}/draft`,
          { ...input, expectedVersion: 1 },
          t.admin,
        )
      ).value.error.code,
      "BASELINE_STALE",
    );
    const fresh = (await t.request("GET", route, undefined, t.admin)).value;
    assert.equal(fresh.active.id, newer.id);
    assert.equal(fresh.draft.baseReleaseId, active.id);
    assert.deepEqual(fresh.draft.templates, input.templates);
  } finally {
    await t.app.close();
  }
});
