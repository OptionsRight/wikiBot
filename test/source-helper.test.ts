import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { setup, publish } from "./helpers.js";

test("the real helper CLI writes an isolated paired source and retries upload as the same unactivated candidate", async () => {
  const t = await setup(),
    dir = await mkdtemp(join(tmpdir(), "wikibot-helper-cli-"));
  try {
    const release = await publish(t),
      root = join(dir, "wiki");
    await mkdir(join(root, "workflows"), { recursive: true });
    await writeFile(
      join(root, ".wikibot-isolated-copy"),
      "isolated experiment\n",
    );
    for (const p of release.bundle.pages)
      await writeFile(join(root, p.path), p.content);
    const content =
      release.bundle.pages[0].content + " 测试补充：需要复核审批材料。";
    const revision = (
      await t.request(
        "POST",
        "/api/domains/ads/revisions",
        {
          title: "隔离更正",
          reason: "合成实验更正准备材料步骤",
          scope: "仅测试",
          changes: [
            {
              pageId: "guide",
              baseHash: release.bundle.pages[0].hash,
              content,
              source: "合成依据 TEST-CLI-001",
            },
          ],
        },
        t.admin,
      )
    ).value;
    await t.request(
      "POST",
      `/api/domains/ads/revisions/${revision.id}/submit`,
      { expectedVersion: 1 },
      t.admin,
    );
    const helper = (
      await t.request("POST", "/api/identities/source-helper/tokens", {})
    ).value.token;
    await t.request(
      "PUT",
      "/api/domains/ads/source-workspace",
      {
        expectedVersion: 0,
        root,
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
        evidence: "维护者确认所有其他编辑和导入暂停，只有本次隔离实验。",
      },
      t.admin,
    );
    const server = await t.app.listen({ host: "127.0.0.1", port: 0 });
    const config = join(dir, "helper.json");
    await writeFile(
      config,
      JSON.stringify({
        server,
        domain: "ads",
        root,
        records: join(dir, "records"),
      }),
    );
    const run = async (action: string) =>
      JSON.parse(
        (
          await promisify(execFile)(
            process.execPath,
            [
              "--import",
              "tsx",
              "tools/source-helper.ts",
              config,
              revision.id,
              action,
            ],
            { env: { ...process.env, WIKIBOT_SOURCE_TOKEN: helper } },
          )
        ).stdout,
      );
    assert.equal((await run("apply")).state, "applied");
    assert.equal(
      await readFile(join(root, release.bundle.pages[0].path), "utf8"),
      content,
    );
    await rename(
      join(root, release.bundle.pages[0].path),
      join(root, "workflows/renamed.md"),
    );
    const candidate = await run("snapshot");
    assert.equal(candidate.state, "submitted");
    assert.equal((await run("snapshot")).candidateId, candidate.candidateId);
    assert.equal(
      (await t.request("GET", "/api/domains/ads/knowledge", undefined, t.alice))
        .value.release.id,
      release.id,
    );
    const direct = await t.request(
      "POST",
      `/api/domains/ads/releases/${candidate.candidateId}/activate`,
      {},
      helper,
    );
    assert.notEqual(direct.status, 200);
  } finally {
    await t.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
