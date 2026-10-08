import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, hash } from "../src/core.js";
import {
  rawSha256,
  wireCanonical,
  wireHash,
} from "../src/knowledge/contracts.js";
import { bundleSchema } from "../src/procedures.js";
import { sampleBundle } from "./helpers.js";

test("V1 parsing preserves original bytes and legacy hashes; raw SHA differs", () => {
  const original = sampleBundle();
  assert.deepEqual(bundleSchema.parse(original), original);
  assert.equal(hash(bundleSchema.parse(original)), hash(original));
  assert.notEqual(hash("知识\n"), rawSha256("知识\n"));
  assert.throws(() => bundleSchema.parse({ ...original, schemaVersion: 3 }));
  assert.throws(() => bundleSchema.parse({ ...original, sourceManifest: [] }));
});
test("wire contract hashes match Python for unicode, escaping, key order and integer limits", () => {
  const vector = {
    z: ['中文😀\n\t\\"', null, true, false, -9007199254740991],
    A: 0,
    a: { z: 1, A: 2, _: 3 },
  };
  const result = execFileSync(
    process.env.CONTRACT_PYTHON ?? "python",
    [
      "-c",
      "import sys,json; sys.path.insert(0,'python'); from common import wire_hash,canonical; v=json.loads(sys.stdin.read()); print(wire_hash(v)); print(canonical(v))",
    ],
    {
      input: JSON.stringify(vector),
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    },
  )
    .trim()
    .split(/\r?\n/);
  assert.equal(result[0], wireHash(vector));
  assert.equal(result[1], wireCanonical(vector));
  assert.throws(() => wireHash({ float: 0.5 }));
  assert.throws(() => wireHash({ a: undefined }));
  assert.throws(() => wireHash("\ud800"));
});
test("v3 migration is repeatable, keeps old data and uses the same rollback transaction", () => {
  const dir = mkdtempSync(join(tmpdir(), "wikibot-migrate-")),
    path = join(dir, "db.sqlite");
  try {
    const old = new DatabaseSync(path);
    old.exec("PRAGMA user_version=3");
    old.close();
    let store = new Store(path);
    store.put("release", {
      id: "legacy",
      domain: "ads",
      version: 1,
      bundle: sampleBundle(),
      descriptorHash: hash(sampleBundle()),
    });
    assert.throws(() =>
      store.tx(() => {
        store.knowledgePut("claims", { id: "c", domain: "ads", version: 1 });
        store.put("test", { id: "t", domain: "ads", version: 1 });
        throw Error("rollback");
      }),
    );
    assert.equal(store.knowledgeGet("claims", "c"), undefined);
    assert.equal(store.get("test", "t"), undefined);
    store.close();
    store = new Store(path);
    assert.ok(store.get("release", "legacy"));
    store.close();
    const db = new DatabaseSync(path);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 4);
    db.exec("PRAGMA user_version=5");
    db.close();
    assert.throws(() => new Store(path), /DATABASE_VERSION_UNSUPPORTED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
