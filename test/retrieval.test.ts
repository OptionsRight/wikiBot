import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleSchema } from "../src/procedures.js";
import { retrieve } from "../src/retrieval.js";
import { generateAnswer } from "../src/explanation.js";
import { sampleBundle } from "./helpers.js";
import { hash } from "../src/core.js";

test("retrieved context obeys its serialized UTF-8 budget including escaped text and metadata", async () => {
  const bundle = bundleSchema.parse(sampleBundle());
  bundle.pages[0]!.content = '示例流程😀\\"\n'.repeat(10000);
  bundle.pages[1]!.content = "示例流程".repeat(10000);
  const pages = retrieve(bundle, "示例流程", { maxContextBytes: 500 });
  assert.ok(pages.length > 0);
  let bytes = 0;
  await generateAnswer(
    {
      async generate(r) {
        const payload = JSON.parse(r.prompt);
        bytes = Buffer.byteLength(JSON.stringify(payload.pages));
        assert.ok(
          !payload.pages.some((p: { content: string }) =>
            p.content.includes("\ufffd"),
          ),
        );
        return {
          text: JSON.stringify({
            text: "测试",
            citations: [pages[0]!.page.id],
          }),
          model: r.model,
          stopReason: "end_turn",
          inputTokens: 1,
          outputTokens: 1,
          firstTextMs: 1,
          totalMs: 1,
        };
      },
    },
    {
      modelId: "test",
      question: "示例流程",
      pages,
      style: "business",
      depth: "beginner",
    },
    new AbortController().signal,
  );
  assert.ok(bytes <= 500, `actual bytes ${bytes}`);
});

test("mixed CJK-Latin query segments split instead of fusing into one token", () => {
  const capPage = {
    id: "platforms-cap-overview",
    path: "platforms/cap/overview.md",
    title: "CAP 平台概述",
    content:
      "CAP 是部门的网关系统。回调通知配置用 cnc cap 工具写入，唯一键为服务码。通信经 RMB 消息中间件转发，服务号 CAP_API。",
  };
  const historyPage = {
    id: "history",
    path: "history/ad.md",
    title: "广告需求演进史",
    content: "从直投到程序化投放的演进记录。",
  };
  const bundle = bundleSchema.parse({
    pages: [
      { ...capPage, hash: hash(capPage.content) },
      { ...historyPage, hash: hash(historyPage.content) },
    ],
    cases: [{ id: "cap", question: "介绍下 CAP", expectedCitations: [capPage.id] }],
    config: sampleBundle().config,
  });
  for (const question of [
    "看下 platforms目录下的cap介绍下",
    "介绍下cap在广告系统上的定位",
    "什么是CAP网关",
  ]) {
    const pages = retrieve(bundle, question);
    assert.equal(
      pages[0]?.page.id,
      capPage.id,
      `query ${question} should rank the CAP page first, got ${pages.map((p) => p.page.id).join(",")}`,
    );
  }
});
