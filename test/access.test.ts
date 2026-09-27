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

test("platform configures independent membership roles and multiple expression tags", async () => {
  const { setup } = await import("./helpers.js");
  const t = await setup();
  try {
    const update = {
      role: "member",
      expectedVersion: 1,
      tags: ["business", "technical"],
    };
    const denied = await t.request(
      "PUT",
      "/api/domains/ads/members/alice",
      update,
      t.admin,
    );
    assert.equal(denied.status, 403);
    const saved = await t.request(
      "PUT",
      "/api/domains/ads/members/alice",
      update,
    );
    assert.equal(saved.status, 200);
    const capability = await t.request(
      "GET",
      "/api/domains/ads/capabilities",
      undefined,
      t.alice,
    );
    assert.deepEqual(capability.value.tags, ["business", "technical"]);
    assert.equal(capability.value.defaultStyle, "technical");
    assert.equal(capability.value.role, "member");
    assert.equal(
      (await t.request("GET", "/api/domains/ads/releases", undefined, t.alice))
        .status,
      403,
    );
    const listed = await t.request("GET", "/api/domains/ads/members");
    assert.equal(listed.status, 200);
    assert.equal(
      listed.value.find((g: { subject: string }) => g.subject === "alice")
        .defaultStyle,
      "technical",
    );
    assert.equal(
      (await t.request("GET", "/api/domains/ads/members", undefined, t.alice))
        .status,
      403,
    );
    const preserved = await t.request("PUT", "/api/domains/ads/members/alice", {
      role: "admin",
      expectedVersion: 2,
    });
    assert.deepEqual(preserved.value.tags, ["business", "technical"]);
  } finally {
    await t.app.close();
  }
});
