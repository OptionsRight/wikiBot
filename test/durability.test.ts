import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, publish } from "./helpers.js";
import { buildApp } from "../src/app.js";
test("a completed answer remains readable after a process restart without regenerating it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wikibot-durable-"));
  let reopened;
  try {
    const t = await setup({ database: join(dir, "state.sqlite") });
    await publish(t);
    const a = (
      await t.request(
        "POST",
        "/api/domains/ads/answers",
        {
          question: "示例",
          sessionId: "s",
          objectId: "a",
          inputs: { scenario: "new" },
        },
        t.alice,
      )
    ).value;
    await t.app.close();
    reopened = await buildApp({
      database: join(dir, "state.sqlite"),
      model: {
        async generate() {
          throw new Error(
            "No new generation is permitted in this restart scenario",
          );
        },
      },
    });
    const restored = await reopened.inject({
      method: "GET",
      url: `/api/domains/ads/answers/${a.id}`,
      headers: { authorization: `Bearer ${t.alice}` },
    });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().id, a.id);
    assert.equal(restored.json().state, "complete");
    assert.equal(restored.json().blocks.length, 4);
  } finally {
    await reopened?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
