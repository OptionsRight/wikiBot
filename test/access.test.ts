import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";

test("authenticated members see only their granted domains; self-declared roles grant nothing", async () => {
  const app = await buildApp({
    database: ":memory:",
    bootstrap: { token: "operator-test", subject: "operator" },
  });
  try {
    const headers = {
      authorization: "Bearer operator-test",
      "idempotency-key": "create-ads",
    };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/domains",
          headers,
          payload: { id: "ads", name: "广告" },
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/domains/ads/members/member",
          headers: { ...headers, "idempotency-key": "grant-member" },
          payload: { role: "member", expectedVersion: 0 },
        })
      ).statusCode,
      200,
    );
    const token = (
      await app.inject({
        method: "POST",
        url: "/api/identities/member/tokens",
        headers: { ...headers, "idempotency-key": "issue-token" },
        payload: {},
      })
    ).json().token;
    const listed = await app.inject({
      url: "/api/domains",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.deepEqual(
      listed.json().map((d: { id: string }) => d.id),
      ["ads"],
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/domains",
          headers: {
            authorization: `Bearer ${token}`,
            "idempotency-key": "forgery",
            "x-role": "admin",
          },
          payload: { id: "other", name: "其他" },
        })
      ).statusCode,
      403,
    );
    assert.equal((await app.inject({ url: "/api/domains" })).statusCode, 401);
  } finally {
    await app.close();
  }
});
