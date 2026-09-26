import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, publish, sampleBundle } from "./helpers.js";
test("confirmed inputs follow the consulting object and only compatible semantic versions survive a release", async () => {
  const t = await setup();
  try {
    await publish(t);
    const ask = async (objectId: string, inputs = {}) =>
      (
        await t.request(
          "POST",
          "/api/domains/ads/answers",
          { question: "示例", sessionId: "same-session", objectId, inputs },
          t.alice,
        )
      ).value;
    await ask("customer-a", { scenario: "new" });
    assert.deepEqual((await ask("customer-a")).inputs, { scenario: "new" });
    assert.deepEqual((await ask("customer-b")).inputs, {});
    await ask("customer-b", { scenario: "existing" });
    const copy = sampleBundle();
    copy.procedures[0]!.inputs[0]!.question = "请确认申请类别";
    await publish(t, copy);
    assert.deepEqual((await ask("customer-b")).inputs, {
      scenario: "existing",
    });
    const changed = sampleBundle();
    changed.procedures[0]!.inputs[0]!.semanticVersion = "2";
    await publish(t, changed);
    assert.deepEqual((await ask("customer-b")).inputs, {});
  } finally {
    await t.app.close();
  }
});
