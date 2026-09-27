import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";

test("ticket attachments are disabled until configured and remain isolated after a merge", async () => {
  const t = await setup();
  try {
    const create = async (actor: string) =>
      (
        await t.request(
          "POST",
          "/api/domains/ads/tickets",
          {
            title: "问题",
            description: "需要进一步帮助解决",
            category: "question",
          },
          actor,
        )
      ).value;
    let a = await create(t.alice),
      b = await create(t.bob);
    const url = `/api/domains/ads/tickets/${a.id}/attachments`;
    const payload = {
      filename: "说明.txt",
      mediaType: "text/plain",
      data: Buffer.from("私人材料").toString("base64"),
      expectedVersion: a.version,
    };
    assert.equal((await t.request("POST", url, payload, t.alice)).status, 409);
    assert.equal(
      (
        await t.request(
          "PUT",
          "/api/domains/ads/ticket-attachment-policy",
          {
            enabled: true,
            maxBytes: 10000,
            retentionDays: 7,
            expectedVersion: 0,
          },
          t.alice,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await t.request("PUT", "/api/domains/ads/ticket-attachment-policy", {
          enabled: true,
          maxBytes: 10000,
          retentionDays: 7,
          expectedVersion: 0,
        })
      ).status,
      200,
    );
    const upload = await t.request(
      "POST",
      url,
      payload,
      t.alice,
      "upload-once",
    );
    assert.equal(upload.status, 201);
    assert.equal(
      (await t.request("POST", url, payload, t.alice, "upload-once")).value.id,
      upload.value.id,
    );
    assert.equal(
      (await t.request("GET", `${url}/${upload.value.id}`, undefined, t.bob))
        .status,
      404,
    );
    a = (
      await t.request(
        "GET",
        `/api/domains/ads/tickets/${a.id}`,
        undefined,
        t.alice,
      )
    ).value;
    assert.equal(
      (
        await t.request(
          "POST",
          url,
          { ...payload, internal: true, expectedVersion: a.version },
          t.alice,
        )
      ).status,
      403,
    );
    const internal = await t.request(
      "POST",
      url,
      { ...payload, internal: true, expectedVersion: a.version },
      t.admin,
    );
    assert.equal(internal.status, 201);
    assert.equal(
      (
        await t.request(
          "GET",
          `${url}/${internal.value.id}`,
          undefined,
          t.alice,
        )
      ).status,
      404,
    );
    assert.equal(
      (await t.request("GET", url, undefined, t.alice)).value.length,
      1,
    );
    a = (
      await t.request(
        "GET",
        `/api/domains/ads/tickets/${a.id}`,
        undefined,
        t.admin,
      )
    ).value;
    assert.equal(
      (
        await t.request(
          "POST",
          `/api/domains/ads/tickets/${a.id}/actions`,
          { action: "merge", targetId: b.id, expectedVersion: a.version },
          t.admin,
        )
      ).status,
      200,
    );
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
    assert.equal(
      (await t.request("GET", `${url}/${upload.value.id}`, undefined, t.bob))
        .status,
      404,
    );
    const own = await t.app.inject({
      method: "GET",
      url: `${url}/${upload.value.id}`,
      headers: { authorization: `Bearer ${t.alice}` },
    });
    assert.equal(own.statusCode, 200);
    assert.equal(own.body, "私人材料");
    assert.match(own.headers["content-disposition"] as string, /^attachment;/);
  } finally {
    await t.app.close();
  }
});

test("attachments reject unsafe content, stale uploads and downloads after access is revoked", async () => {
  const t = await setup();
  try {
    const ticket = (
      await t.request(
        "POST",
        "/api/domains/ads/tickets",
        {
          title: "测试",
          description: "附件校验公开入口",
          category: "question",
        },
        t.alice,
      )
    ).value;
    await t.request("PUT", "/api/domains/ads/ticket-attachment-policy", {
      enabled: true,
      maxBytes: 10,
      retentionDays: 1,
      expectedVersion: 0,
    });
    const url = `/api/domains/ads/tickets/${ticket.id}/attachments`;
    const input = {
      filename: "note.txt",
      mediaType: "text/plain",
      data: Buffer.from("hello").toString("base64"),
      expectedVersion: ticket.version,
    };
    assert.equal(
      (
        await t.request(
          "POST",
          url,
          { ...input, data: Buffer.alloc(11, 65).toString("base64") },
          t.alice,
        )
      ).status,
      413,
    );
    assert.equal(
      (
        await t.request(
          "POST",
          url,
          { ...input, data: Buffer.from([255, 254, 0]).toString("base64") },
          t.alice,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await t.request(
          "POST",
          url,
          { ...input, filename: "../secret.txt" },
          t.alice,
        )
      ).status,
      400,
    );
    const uploaded = await t.request("POST", url, input, t.alice);
    assert.equal(uploaded.status, 201);
    assert.equal((await t.request("POST", url, input, t.alice)).status, 409);
    await t.request("PUT", "/api/domains/ads/members/alice", {
      role: "member",
      enabled: false,
      expectedVersion: 1,
    });
    assert.equal(
      (
        await t.request(
          "GET",
          `${url}/${uploaded.value.id}`,
          undefined,
          t.alice,
        )
      ).status,
      403,
    );
  } finally {
    await t.app.close();
  }
});
