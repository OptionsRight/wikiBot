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
        { question: "示例流程怎么做", sessionId: "s" },
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
    assert.equal(restored.json().blocks.length, 1);
  } finally {
    await reopened?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("process death before commit rolls back business receipt; death after commit replays exactly the recorded result", async () => {
  const { spawnSync } = await import("node:child_process");
  const { Store } = await import("../src/core.js");
  const dir = await mkdtemp(join(tmpdir(), "wikibot-crash-command-"));
  try {
    for (const phase of ["before-commit", "after-commit"]) {
      const database = join(dir, `${phase}.sqlite`);
      const code = `
        import { Store } from ${JSON.stringify(new URL("../src/core.ts", import.meta.url).href)};
        const store = new Store(${JSON.stringify(database)});
        store.command({subject:"operator",platform:true}, "ads", "crash-probe", "same-key", {question:"synthetic"}, () => {}, () => {
          const result = store.put("probe", {id:"original",domain:"ads",version:1});
          if (${JSON.stringify(phase)} === "before-commit") process.exit(73);
          return result;
        });
        process.exit(74);
      `;
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", code],
        { timeout: 10000 },
      );
      assert.equal(
        child.status,
        phase === "before-commit" ? 73 : 74,
        child.stderr.toString(),
      );
      const store = new Store(database);
      try {
        const actor = { subject: "operator", platform: true };
        const retry = store.command(
          actor,
          "ads",
          "crash-probe",
          "same-key",
          { question: "synthetic" },
          () => {},
          () => store.put("probe", { id: "retry", domain: "ads", version: 1 }),
        );
        assert.equal(
          retry.id,
          phase === "before-commit" ? "retry" : "original",
        );
        assert.throws(
          () =>
            store.command(
              actor,
              "ads",
              "crash-probe",
              "same-key",
              { question: "changed" },
              () => {},
              () => ({ id: "bad" }),
            ),
          /IDEMPOTENCY_CONFLICT/,
        );
      } finally {
        store.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a worker killed during a model call expires without another generation or a reset deadline", async () => {
  const { spawnSync } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "wikibot-worker-death-"));
  let reopened;
  try {
    const database = join(dir, "worker.sqlite");
    const t = await setup({ database });
    await publish(t);
    await t.app.close();
    const input = { question: "示例流程怎么做", sessionId: "crashed" };
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { buildApp } from ${JSON.stringify(new URL("../src/app.ts", import.meta.url).href)};
      const app = await buildApp({database:${JSON.stringify(database)},model:{async generate(){process.exit(72);}}});
      await app.inject({method:"POST",url:"/api/domains/ads/answers",headers:{authorization:${JSON.stringify(`Bearer ${t.alice}`)},"idempotency-key":"crashed-call"},payload:${JSON.stringify(input)}});
    `,
      ],
      { timeout: 10000, env: { ...process.env, ANSWER_DEADLINE_MS: "50" } },
    );
    assert.equal(child.status, 72, child.stderr.toString());
    let calls = 0;
    reopened = await buildApp({
      database,
      model: {
        async generate() {
          calls++;
          throw new Error("must not replay unknown execution");
        },
      },
    });
    const retried = await reopened.inject({
      method: "POST",
      url: "/api/domains/ads/answers",
      headers: {
        authorization: `Bearer ${t.alice}`,
        "idempotency-key": "crashed-call",
      },
      payload: input,
    });
    const original = retried.json();
    assert.ok(original.id);
    await new Promise((resolve) => setTimeout(resolve, 5300));
    const fetched = await reopened.inject({
      url: `/api/domains/ads/answers/${original.id}`,
      headers: { authorization: `Bearer ${t.alice}` },
    });
    assert.equal(fetched.json().state, "failed");
    assert.equal(fetched.json().code, "EXECUTION_UNKNOWN");
    assert.equal(fetched.json().deadline, original.deadline);
    assert.equal(calls, 0);
  } finally {
    await reopened?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
