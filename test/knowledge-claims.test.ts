import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, hash } from "../src/core.js";
import {
  proposeClaim,
  approveClaims,
  resolveConflict,
  temporalMatch,
  type ClaimVersion,
  type Conflict,
} from "../src/knowledge/claims.js";
import {
  registerWikiSource,
  createTextEvidence,
} from "../src/knowledge/evidence.js";
import { wireHash } from "../src/knowledge/contracts.js";

test("bitemporal late correction preserves old release bytes and separates qualifiers", () => {
  const store = new Store(":memory:"),
    actor = { subject: "admin", platform: false },
    domain = "ads";
  try {
    store.put("domain", { id: domain, domain, version: 1, maintenance: false });
    store.put("grant", {
      id: "ads:admin",
      domain,
      version: 1,
      enabled: true,
      role: "admin",
    });
    const page = {
      id: "policy",
      path: "policy.md",
      title: "Limits",
      content: "Limit 100; corrected to 80 from September 20.",
      hash: hash("Limit 100; corrected to 80 from September 20."),
    };
    const source = registerWikiSource(store, domain, page),
      e = createTextEvidence(store, domain, source.id, 1, 1);
    const common = {
      expectedVersion: 0,
      subjectId: "travel",
      predicate: "limit",
      qualifiers: { currency: "USD", channel: "web" },
      statement: "Limit 100",
      typedValue: 100,
      validityKind: "known" as const,
      validFrom: 100,
      validTo: null,
      evidenceIds: [e.id],
      extractionProfileHash: wireHash(["manual", 1]),
      batchId: "batch1",
      reason: "合成数据：管理员核对原始政策内容",
    };
    const a = store.tx(() => proposeClaim(store, actor, domain, common));
    store.tx(() =>
      approveClaims(
        store,
        actor,
        domain,
        [{ id: a.id, expectedVersion: 1 }],
        common.reason,
      ),
    );
    const frozen = structuredClone(
      store.knowledgeGet<ClaimVersion>("claim_versions", a.id)!,
    );
    const oldHash = hash(frozen);
    const b = store.tx(() =>
      proposeClaim(store, actor, domain, {
        ...common,
        claimId: a.claimId,
        expectedVersion: 1,
        statement: "Limit 80",
        typedValue: 80,
        validFrom: 200,
      }),
    );
    const old = store.knowledgeGet<ClaimVersion>("claim_versions", a.id)!;
    assert.equal(old.recordedTo, b.recordedFrom);
    assert.ok(temporalMatch(old, 250, a.recordedFrom));
    assert.ok(!temporalMatch(old, 250, b.recordedFrom));
    assert.ok(temporalMatch(b, 250, b.recordedFrom));
    assert.ok(!temporalMatch(b, 150, b.recordedFrom));
    assert.equal(hash(frozen), oldHash);
    assert.equal(frozen.recordedTo, null);
    const conflict = store.knowledgeList<Conflict>("conflicts", domain)[0]!;
    assert.deepEqual(conflict.members, [a.id, b.id]);
    assert.throws(
      () =>
        store.tx(() =>
          approveClaims(
            store,
            actor,
            domain,
            [{ id: b.id, expectedVersion: 1 }],
            common.reason,
          ),
        ),
      /CLAIM_CONFLICT_OPEN/,
    );
    assert.throws(
      () =>
        store.tx(() =>
          resolveConflict(store, actor, domain, conflict.id, {
            expectedVersion: 1,
            members: [b.id, "wrong"],
            rejectVersionIds: [a.id],
            reason: common.reason,
          }),
        ),
      /CONFLICT_MEMBERS_CHANGED/,
    );
    store.tx(() =>
      resolveConflict(store, actor, domain, conflict.id, {
        expectedVersion: 1,
        members: conflict.members,
        rejectVersionIds: [a.id],
        reason: common.reason,
      }),
    );
    store.tx(() =>
      approveClaims(
        store,
        actor,
        domain,
        [{ id: b.id, expectedVersion: 1 }],
        common.reason,
      ),
    );
    const separate = store.tx(() =>
      proposeClaim(store, actor, domain, {
        ...common,
        qualifiers: { currency: "EUR", channel: "web" },
        typedValue: 90,
      }),
    );
    assert.notEqual(separate.claimId, a.claimId);
    assert.equal(store.knowledgeList("conflicts", domain).length, 1);
    const unknown = store.tx(() =>
      proposeClaim(store, actor, domain, {
        ...common,
        subjectId: "unknown",
        validityKind: "unknown",
        validFrom: null,
      }),
    );
    assert.equal(temporalMatch(unknown, 250), false);
  } finally {
    store.close();
  }
});

test("contradicting evidence is retained and must be explicitly adjudicated before approval", () => {
  const store = new Store(":memory:"),
    actor = { subject: "admin", platform: false },
    domain = "ads";
  try {
    store.put("domain", { id: domain, domain, version: 1, maintenance: false });
    store.put("grant", {
      id: "ads:admin",
      domain,
      version: 1,
      enabled: true,
      role: "admin",
    });
    const content = "Limit 80.\nOld circular says 100.\nTravel context.";
    const source = registerWikiSource(store, domain, {
      id: "policy",
      path: "policy.md",
      title: "Policy",
      content,
      hash: hash(content),
    });
    const es = [1, 2, 3].map((line) =>
      createTextEvidence(store, domain, source.id, line, line),
    );
    const v = store.tx(() =>
      proposeClaim(store, actor, domain, {
        expectedVersion: 0,
        subjectId: "travel",
        predicate: "limit",
        qualifiers: {},
        statement: "Limit 80",
        typedValue: 80,
        validityKind: "unknown",
        validFrom: null,
        validTo: null,
        evidenceIds: [es[0]!.id],
        additionalEvidence: [
          { evidenceId: es[1]!.id, relation: "contradicts" },
          { evidenceId: es[2]!.id, relation: "context" },
        ],
        extractionProfileHash: wireHash([]),
        batchId: "b",
        reason: "Synthetic original circular requires adjudication",
      }),
    );
    const conflict = store.knowledgeList<Conflict>("conflicts", domain)[0]!;
    assert.throws(
      () =>
        store.tx(() =>
          approveClaims(
            store,
            actor,
            domain,
            [{ id: v.id, expectedVersion: 1 }],
            "Human reviews original",
          ),
        ),
      /CONFLICT_OPEN/,
    );
    store.tx(() =>
      resolveConflict(store, actor, domain, conflict.id, {
        expectedVersion: 1,
        members: [v.id],
        rejectVersionIds: [],
        dismissEvidenceIds: [es[1]!.id],
        reason:
          "Original circular was superseded; verified exact applicability.",
      }),
    );
    store.tx(() =>
      approveClaims(
        store,
        actor,
        domain,
        [{ id: v.id, expectedVersion: 1 }],
        "Original policy independently checked",
      ),
    );
    assert.equal(store.knowledgeList("claim_evidence", domain).length, 3);
    assert.equal(store.knowledgeList("evidence", domain).length, 3);
    assert.equal(
      store.knowledgeGet<ClaimVersion>("claim_versions", v.id)!.status,
      "approved",
    );
  } finally {
    store.close();
  }
});
