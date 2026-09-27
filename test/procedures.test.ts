import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sampleBundle } from "./helpers.js";
import { hash } from "../src/core.js";

test("submission cannot hide missing dependencies or external links behind alternate Markdown syntax", async () => {
  const t = await setup();
  try {
    for (const content of [
      "![x](missing.png 'caption')",
      "[x](missing.md (caption))",
      "<https://example.com/private>",
      "[x](missing(foo).md)",
      "[outer [inner]](missing.md)",
    ]) {
      const bundle = sampleBundle();
      bundle.pages[0]!.content = content;
      bundle.pages[0]!.hash = hash(content);
      const response = await t.request(
        "POST",
        "/api/domains/ads/submissions",
        bundle,
        t.admin,
      );
      assert.equal(response.status, 400, content);
      assert.match(
        response.value.error.code,
        /BROKEN_SOURCE_LINK|EXTERNAL_SOURCE_LINK_FORBIDDEN|UNSUPPORTED_SOURCE_LINK_FORMAT/,
      );
    }
  } finally {
    await t.app.close();
  }
});

test("page packages with duplicate ids, bad hashes, or dangling citations cannot be submitted", async () => {
  const t = await setup();
  try {
    const duplicate = sampleBundle();
    duplicate.pages[1]!.id = duplicate.pages[0]!.id;
    const rejected = await t.request(
      "POST",
      "/api/domains/ads/submissions",
      duplicate,
      t.admin,
    );
    assert.equal(rejected.status, 400);
    assert.equal(rejected.value.error.code, "DUPLICATE_ID");
    const stale = sampleBundle();
    stale.pages[0]!.hash = "0".repeat(64);
    const mismatch = await t.request(
      "POST",
      "/api/domains/ads/submissions",
      stale,
      t.admin,
    );
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.value.error.code, "CONTENT_HASH_MISMATCH");
    const dangling = sampleBundle();
    dangling.cases[0]!.expectedCitations = ["missing-page"];
    const invalid = await t.request(
      "POST",
      "/api/domains/ads/submissions",
      dangling,
      t.admin,
    );
    assert.equal(invalid.status, 400);
    assert.equal(invalid.value.error.code, "INVALID_CITATION");
  } finally {
    await t.app.close();
  }
});

test("domain templates and immutable source artifacts are bound to the release descriptor", async () => {
  const t = await setup();
  try {
    const base = sampleBundle();
    const a = await t.request(
      "POST",
      "/api/domains/ads/submissions",
      base,
      t.admin,
    );
    const configured = {
      ...base,
      config: {
        ...base.config,
        domainLabel: "设备支持",
        answerTemplates: {
          business: "业务",
          technical: "技术",
          beginner: "入门",
          experienced: "熟练",
        },
      },
      sourceArtifacts: [],
    };
    const b = await t.request(
      "POST",
      "/api/domains/ads/submissions",
      configured,
      t.admin,
    );
    assert.equal(b.status, 201);
    assert.notEqual(a.value.descriptorHash, b.value.descriptorHash);
  } finally {
    await t.app.close();
  }
});
