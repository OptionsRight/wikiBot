import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, publish } from "./helpers.js";

async function queued(t: Awaited<ReturnType<typeof setup>>) {
  const release = await publish(t);
  const draft = await t.request(
    "POST",
    "/api/domains/ads/revisions",
    {
      title: "来源更正",
      reason: "合成专家更正用于受控实验",
      scope: "测试范围",
      changes: [
        {
          pageId: "guide",
          baseHash: release.bundle.pages[0].hash,
          content: "更正后先准备审批材料，再提交申请。",
          source: "合成专家记录 TEST-001",
        },
      ],
    },
    t.admin,
  );
  await t.request(
    "POST",
    `/api/domains/ads/revisions/${draft.value.id}/submit`,
    { expectedVersion: 1 },
    t.admin,
  );
  return { revision: draft.value, release };
}

test("a paired helper can claim one workspace but cannot publish or bypass the human maintenance window", async () => {
  const t = await setup();
  try {
    const { revision } = await queued(t);
    const helper = (
      await t.request("POST", "/api/identities/source-helper/tokens", {})
    ).value.token;
    const pairing = {
      expectedVersion: 0,
      root: "/isolated/wiki",
      helperSubject: "source-helper",
      adapter: { kind: "manual" as const, version: "contract-1" },
      enabled: true,
    };
    assert.equal(
      (
        await t.request(
          "PUT",
          "/api/domains/ads/source-workspace",
          pairing,
          t.alice,
        )
      ).status,
      403,
    );
    const paired = await t.request(
      "PUT",
      "/api/domains/ads/source-workspace",
      pairing,
      t.admin,
    );
    assert.equal(paired.status, 200);
    const claimPath = `/api/domains/ads/revisions/${revision.id}/claim`;
    const claim = { expectedVersion: 2, workspaceVersion: 1 };
    assert.equal(
      (await t.request("POST", claimPath, claim, helper)).value.error.code,
      "MAINTENANCE_WINDOW_REQUIRED",
    );
    const opened = await t.request(
      "POST",
      "/api/domains/ads/source-workspace/window",
      {
        expectedVersion: 1,
        durationSeconds: 300,
        evidence: "维护者确认摄入和所有外部编辑已暂停；合成实验。",
      },
      t.admin,
    );
    assert.equal(opened.status, 200);
    const leased = await t.request(
      "POST",
      claimPath,
      { ...claim, workspaceVersion: 2 },
      helper,
      "claim-once",
    );
    assert.equal(leased.status, 200);
    assert.equal(leased.value.maintenance.state, "claimed");
    assert.equal(
      (
        await t.request(
          "GET",
          `/api/domains/ads/revisions/${revision.id}`,
          undefined,
          helper,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await t.request(
          "POST",
          "/api/domains/ads/releases/anything/activate",
          {},
          helper,
        )
      ).status >= 400,
      true,
    );
    assert.equal(
      (
        await t.request(
          "POST",
          claimPath,
          { ...claim, workspaceVersion: 2 },
          t.alice,
        )
      ).status,
      403,
    );
    await t.request("PUT", "/api/domains/ads/members/admin", {
      role: "admin",
      enabled: false,
      expectedVersion: 1,
    });
    assert.equal(
      (
        await t.request(
          "POST",
          `/api/domains/ads/revisions/${revision.id}/start`,
          {
            leaseId: leased.value.maintenance.leaseId,
          },
          helper,
        )
      ).status,
      403,
    );
  } finally {
    await t.app.close();
  }
});

test("unknown source outcomes fence the workspace and only explicit human reconciliation permits a new claim", async () => {
  const t = await setup();
  try {
    const { revision } = await queued(t);
    const helper = (
      await t.request("POST", "/api/identities/source-helper/tokens", {})
    ).value.token;
    await t.request(
      "PUT",
      "/api/domains/ads/source-workspace",
      {
        expectedVersion: 0,
        root: "/isolated/wiki",
        helperSubject: "source-helper",
        adapter: { kind: "isolated-markdown", version: "1" },
        enabled: true,
      },
      t.admin,
    );
    await t.request(
      "POST",
      "/api/domains/ads/source-workspace/window",
      {
        expectedVersion: 1,
        durationSeconds: 300,
        evidence: "管理员确认隔离副本且已暂停其他编辑与摄入。",
      },
      t.admin,
    );
    const prefix = `/api/domains/ads/revisions/${revision.id}`;
    const claimed = (
      await t.request(
        "POST",
        `${prefix}/claim`,
        { expectedVersion: 2, workspaceVersion: 2 },
        helper,
      )
    ).value;
    assert.equal(
      (
        await t.request(
          "GET",
          `/api/domains/ads/source-tasks/${revision.id}`,
          undefined,
          t.alice,
        )
      ).status,
      403,
    );
    const leaseId = claimed.maintenance.leaseId;
    await t.request("POST", `${prefix}/start`, { leaseId }, helper);
    const unknown = (
      await t.request(
        "POST",
        `${prefix}/source-result`,
        {
          leaseId,
          state: "recovery_required",
          journalHash: "a".repeat(64),
          evidence: "写入中断，部分文件可能已改，需人工检查真实目录。",
        },
        helper,
      )
    ).value;
    assert.equal(
      (
        await t.request(
          "POST",
          `${prefix}/claim`,
          { expectedVersion: unknown.version, workspaceVersion: 2 },
          helper,
        )
      ).status,
      409,
    );
    assert.equal(
      (await t.request("POST", `${prefix}/lease`, { leaseId }, helper)).status,
      409,
    );
    const fixed = await t.request(
      "POST",
      `${prefix}/reconcile`,
      {
        expectedVersion: unknown.version,
        outcome: "baseline_restored",
        journalHash: "b".repeat(64),
        evidence:
          "维护者停止旧助手，逐文件核对确认原基线完整恢复，其他编辑和摄入仍已暂停。",
      },
      t.admin,
    );
    assert.equal(fixed.status, 200);
    const next = (
      await t.request(
        "POST",
        `${prefix}/claim`,
        { expectedVersion: fixed.value.version, workspaceVersion: 2 },
        helper,
      )
    ).value;
    assert.notEqual(next.maintenance.leaseId, leaseId);
    assert.equal(
      (await t.request("POST", `${prefix}/start`, { leaseId }, helper)).status,
      409,
    );
  } finally {
    await t.app.close();
  }
});
