import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wecomConfiguration,
  operationalRetention,
} from "../src/runtime-config.js";

test("startup resolves each bot's explicitly named secret and independently configured mappings", () => {
  const bots = wecomConfiguration({
    WECOM_ENABLED: "1",
    BOT_A_SECRET: "secret-a",
    BOT_B_SECRET: "secret-b",
    WECOM_BOTS_JSON: JSON.stringify([
      {
        botId: "a",
        domain: "ads",
        secretEnv: "BOT_A_SECRET",
        members: { callback: "alice" },
      },
      {
        botId: "b",
        domain: "equipment",
        secretEnv: "BOT_B_SECRET",
        members: { callback: "bob" },
      },
    ]),
  });
  assert.equal(bots.length, 2);
  assert.equal(bots[1]!.secret, "secret-b");
  assert.equal(bots[1]!.members.callback, "bob");
  assert.deepEqual(
    wecomConfiguration({ WECOM_ENABLED: "0", WECOM_BOTS_JSON: "invalid" }),
    [],
  );
  assert.throws(() =>
    wecomConfiguration({
      WECOM_ENABLED: "1",
      WECOM_BOTS_JSON:
        '[{"botId":"a","domain":"ads","secretEnv":"MISSING","members":{}}]',
    }),
  );
});

test("retention is disabled until an explicit policy and duration are both configured", () => {
  assert.equal(operationalRetention({}), undefined);
  assert.deepEqual(
    operationalRetention({
      OPERATIONAL_RETENTION_MS: "86400000",
      OPERATIONAL_RETENTION_POLICY: "approved-test-policy",
    }),
    { eventRetentionMs: 86400000, policyId: "approved-test-policy" },
  );
  assert.throws(() =>
    operationalRetention({ OPERATIONAL_RETENTION_MS: "86400000" }),
  );
  assert.throws(() =>
    operationalRetention({
      OPERATIONAL_RETENTION_MS: "NaN",
      OPERATIONAL_RETENTION_POLICY: "policy",
    }),
  );
});
