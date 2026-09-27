import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sampleBundle, publish } from "./helpers.js";

test("an approved immutable flow becomes readable to granted members only", async () => {
  const t = await setup();
  try {
    const release = await publish(t);
    const view = await t.request(
      "GET",
      "/api/domains/ads/knowledge",
      undefined,
      t.alice,
    );
    assert.equal(view.status, 200);
    assert.equal(view.value.release.id, release.id);
    assert.equal(view.value.pages[0].title, "示例流程");
    const forbidden = await t.request(
      "POST",
      "/api/domains/ads/submissions",
      sampleBundle(),
      t.alice,
    );
    assert.equal(forbidden.status, 403);
  } finally {
    await t.app.close();
  }
});

test("two approved candidates with the same baseline cannot both activate", async () => {
  const t = await setup();
  try {
    const candidates = [];
    for (let i = 0; i < 2; i++) {
      const bundle = sampleBundle();
      bundle.pages[0]!.title += ` ${i}`;
      const candidate = (
        await t.request("POST", "/api/domains/ads/submissions", bundle, t.admin)
      ).value;
      for (const c of bundle.cases) {
        const evaluation = await t.request(
          "POST",
          `/api/domains/ads/releases/${candidate.id}/evaluations`,
          { caseId: c.id, descriptorHash: candidate.descriptorHash },
          t.admin,
        );
        assert.equal(evaluation.value.state, "complete");
      }
      const ready = await t.request(
        "POST",
        `/api/domains/ads/releases/${candidate.id}/review`,
        {
          expectedVersion: candidate.version,
          descriptorHash: candidate.descriptorHash,
          evidence: "synthetic concurrent release approval",
          approved: true,
        },
        t.admin,
      );
      assert.equal(ready.status, 200);
      candidates.push(ready.value);
    }
    const results = await Promise.all(
      candidates.map((candidate) =>
        t.request(
          "POST",
          `/api/domains/ads/releases/${candidate.id}/activate`,
          {
            expectedVersion: candidate.version,
            expectedEpoch: 0,
            expectedActive: null,
            descriptorHash: candidate.descriptorHash,
          },
          t.admin,
        ),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const winner = results.find((r) => r.status === 200)!.value;
    const knowledge = await t.request(
      "GET",
      "/api/domains/ads/knowledge",
      undefined,
      t.alice,
    );
    assert.equal(knowledge.value.release.id, winner.id);
    const loser = candidates.find((c) => c.id !== winner.id);
    const retried = await t.request(
      "POST",
      `/api/domains/ads/releases/${loser.id}/activate`,
      {
        expectedVersion: loser.version,
        expectedEpoch: 0,
        expectedActive: null,
        descriptorHash: loser.descriptorHash,
      },
      t.admin,
    );
    assert.equal(retried.status, 409);
  } finally {
    await t.app.close();
  }
});
