import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPageManifest } from "../src/source-formats.js";

test("native JSON frontmatter IDs survive page moves and unsafe paths are rejected before reading", async () => {
  const root = await mkdtemp(join(tmpdir(), "wikibot-formats-"));
  try {
    await mkdir(join(root, "pages"));
    const content =
      '---\n{"id":"stable-rule","kind":"rule"}\n---\n# Rule\nRule body';
    await writeFile(join(root, "pages", "old.md"), content);
    const first = await createPageManifest(root);
    assert.equal(first[0]!.id, "stable-rule");
    await rename(join(root, "pages", "old.md"), join(root, "pages", "new.md"));
    const moved = await createPageManifest(root, first);
    assert.equal(moved[0]!.id, "stable-rule");
    assert.equal(moved[0]!.path, "pages/new.md");
    await writeFile(join(root, "pages", "other.md"), content);
    await assert.rejects(() => createPageManifest(root), /DUPLICATE_SOURCE_ID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import {
  captureSourceArtifacts,
  validateSourceArtifacts,
} from "../src/source-artifacts.js";
import { validateSourceLinks } from "../src/source-formats.js";

test("approved static source attachments and excerpts retain hashes while missing links and active formats fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "wikibot-artifacts-"));
  try {
    await writeFile(join(root, "quote.txt"), "Synthetic source excerpt");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6N6kAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(join(root, "diagram.png"), png);
    const artifacts = await captureSourceArtifacts(
      root,
      [
        {
          id: "excerpt",
          path: "quote.txt",
          kind: "excerpt",
          mediaType: "text/plain",
        },
        {
          id: "diagram",
          path: "diagram.png",
          kind: "attachment",
          mediaType: "image/png",
        },
      ],
      ["image/png"],
    );
    validateSourceArtifacts(artifacts, ["image/png"]);
    assert.equal(artifacts[0]!.content, "Synthetic source excerpt");
    assert.equal(artifacts[1]!.content, png.toString("base64"));
    assert.throws(
      () => validateSourceArtifacts(artifacts, []),
      /SOURCE_ATTACHMENT_TYPE_NOT_APPROVED/,
    );
    validateSourceLinks(
      [
        {
          path: "rule.md",
          content: "[evidence](quote.txt) ![diagram](diagram.png)",
        },
      ],
      artifacts.map((a) => a.path),
    );
    assert.throws(
      () =>
        validateSourceLinks(
          [{ path: "rule.md", content: "[missing](missing.md)" }],
          [],
        ),
      /BROKEN_SOURCE_LINK/,
    );
    assert.throws(
      () =>
        validateSourceLinks(
          [{ path: "rule.md", content: "[external](https:\/\/example.com)" }],
          [],
        ),
      /EXTERNAL_SOURCE_LINK_FORBIDDEN/,
    );
    assert.throws(() =>
      validateSourceArtifacts(
        [{ ...artifacts[1]!, path: "x.svg", mediaType: "image/svg+xml" }],
        ["image/png"],
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { setup, publish, sampleBundle } from "./helpers.js";
import { hash } from "../src/core.js";

test("published source excerpts require current object and domain access and stop serving after revocation", async () => {
  const t = await setup();
  try {
    const base = sampleBundle();
    const content = "Synthetic archived evidence excerpt.";
    const bundle = {
      ...base,
      sourceArtifacts: [
        {
          id: "evidence",
          path: "evidence.txt",
          kind: "excerpt" as const,
          mediaType: "text/plain" as const,
          content,
          hash: hash(content),
        },
      ],
    };
    const active = await publish(t, bundle);
    const url = `/api/domains/ads/releases/${active.id}/source-artifacts/evidence`;
    const read = await t.app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${t.alice}` },
    });
    assert.equal(read.statusCode, 200);
    assert.equal(read.body, content);
    assert.match(read.headers["content-disposition"] as string, /^attachment;/);
    await t.request("PUT", "/api/domains/ads/members/alice", {
      role: "member",
      enabled: false,
      expectedVersion: 1,
    });
    assert.equal(
      (
        await t.app.inject({
          method: "GET",
          url,
          headers: { authorization: `Bearer ${t.alice}` },
        })
      ).statusCode,
      403,
    );
    await t.request(
      "POST",
      `/api/domains/ads/releases/${active.id}/revoke`,
      {
        expectedVersion: active.version,
        expectedEpoch: active.baseEpoch + 1,
        expectedActive: active.id,
        descriptorHash: active.descriptorHash,
        reason: "合成测试：来源更正撤回验证",
      },
      t.admin,
    );
    assert.equal(
      (
        await t.app.inject({
          method: "GET",
          url,
          headers: { authorization: `Bearer ${t.bob}` },
        })
      ).statusCode,
      410,
    );
  } finally {
    await t.app.close();
  }
});

import { bundleManifest } from "../src/source-formats.js";
import { snapshot } from "../src/snapshot.js";

test("an existing excerpt package roundtrips through the shared manifest conversion and missing attachments cannot hide by omitting the field", async () => {
  const root = await mkdtemp(join(tmpdir(), "wikibot-artifact-roundtrip-"));
  try {
    const bundle = sampleBundle();
    await mkdir(join(root, "workflows"));
    for (const p of bundle.pages)
      await writeFile(join(root, p.path), p.content);
    await writeFile(join(root, "source.txt"), "independent synthetic excerpt");
    const sourceArtifacts = await captureSourceArtifacts(root, [
      {
        id: "source",
        path: "source.txt",
        kind: "excerpt",
        mediaType: "text/plain",
      },
    ]);
    bundle.pages[0]!.content += " [source](../source.txt)";
    bundle.pages[0]!.hash = hash(bundle.pages[0]!.content);
    await writeFile(
      join(root, bundle.pages[0]!.path),
      bundle.pages[0]!.content,
    );
    const captured = await snapshot(
      root,
      bundleManifest({ ...bundle, sourceArtifacts }),
    );
    assert.deepEqual(captured.sourceArtifacts, sourceArtifacts);
    bundle.pages[0]!.content = "See [missing attachment](missing.png)";
    bundle.pages[0]!.hash = hash(bundle.pages[0]!.content);
    await writeFile(
      join(root, bundle.pages[0]!.path),
      bundle.pages[0]!.content,
    );
    await assert.rejects(
      () => snapshot(root, bundleManifest(bundle)),
      /BROKEN_SOURCE_LINK/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported reference or HTML links fail closed and declared heading anchors must exist", () => {
  assert.throws(
    () =>
      validateSourceLinks(
        [
          {
            path: "rule.md",
            content: "[source][id]\n[id]: https://example.com",
          },
        ],
        [],
      ),
    /UNSUPPORTED_SOURCE_LINK_FORMAT/,
  );
  assert.throws(
    () =>
      validateSourceLinks(
        [{ path: "rule.md", content: '<img src="missing.png">' }],
        [],
      ),
    /UNSUPPORTED_SOURCE_LINK_FORMAT/,
  );
  validateSourceLinks(
    [{ path: "rule.md", content: "# Section\n[section](#section)" }],
    [],
  );
  assert.throws(
    () =>
      validateSourceLinks(
        [{ path: "rule.md", content: "# Section\n[missing](#missing)" }],
        [],
      ),
    /BROKEN_SOURCE_ANCHOR/,
  );
});
