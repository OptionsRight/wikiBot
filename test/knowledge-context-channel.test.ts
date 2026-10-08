import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evidenceContext } from "../src/knowledge/context.js";
import {
  profileSchema,
  type ClaimSnapshot,
  type EvidenceSnapshot,
} from "../src/knowledge/contracts.js";
import type { BundleV2 } from "../src/procedures.js";
import { sampleBundle, setup } from "./helpers.js";
import type { Inbound } from "../src/adapters/wecom.js";

test("release-local mixed context cannot bypass draft, stale, hidden or out-of-time facts using page text", () => {
  const base = sampleBundle(),
    page = base.pages[0]!;
  const claim = {
    claimId: "c",
    versionId: "cv",
    status: "approved",
    evidenceIds: ["e"],
    validityKind: "known",
    validFrom: 100,
    validTo: 200,
    recordedFrom: 10,
    recordedTo: null,
    statement: "80",
  } as ClaimSnapshot;
  const evidence = {
    evidenceId: "e",
    state: "fresh",
    visibility: "excerpt",
  } as EvidenceSnapshot;
  const bundle = {
    ...base,
    schemaVersion: 2,
    groundingManifest: {
      mode: "mixed",
      claims: [claim],
      evidence: [evidence],
      sidecars: [
        { pageId: page.id, pageHash: page.hash, claimVersionIds: ["cv"] },
      ],
    },
  } as unknown as BundleV2;
  const retrieved = [
    { page, content: page.content, score: 1, truncated: false },
  ];
  assert.equal(evidenceContext(bundle, retrieved, 150).pages.length, 1);
  assert.equal(evidenceContext(bundle, retrieved, 250).pages.length, 0);
  claim.status = "proposed";
  assert.equal(evidenceContext(bundle, retrieved, 150).pages.length, 0);
  claim.status = "approved";
  evidence.state = "stale";
  assert.equal(evidenceContext(bundle, retrieved, 150).pages.length, 0);
  evidence.state = "fresh";
  evidence.visibility = "admin";
  assert.equal(evidenceContext(bundle, retrieved, 150).pages.length, 0);
  evidence.visibility = "excerpt";
  claim.validityKind = "unknown";
  assert.equal(evidenceContext(bundle, retrieved, 150).pages.length, 0);
  claim.validityKind = "known";
  bundle.groundingManifest.mode = "claims";
  assert.equal(evidenceContext(bundle, retrieved, 150).pages[0]!.content, "80");
});

test("knowledge bot commands enforce the same administrator boundary as web APIs", async () => {
  const root = mkdtempSync(join(tmpdir(), "wikibot-channel-knowledge-"));
  let receive!: (e: Inbound) => Promise<void>;
  const sent: string[] = [];
  const t = await setup({
    knowledge: {
      assetRoot: root,
      normalizerProfile: profileSchema.parse(
        JSON.parse(readFileSync("config/normalizer.native.json", "utf8")),
      ),
    },
    wecom: {
      botId: "test",
      domain: "ads",
      members: { admin: "admin", member: "alice" },
      transport: {
        start(fn) {
          receive = fn;
        },
        close() {},
        async reply(_e, _s, text) {
          sent.push(text);
        },
      },
    },
  });
  const command = (userId: string, text: string, id: string) =>
    receive({
      id,
      botId: "test",
      userId,
      text,
      chatType: "single",
      replyContext: {},
    });
  try {
    await command("member", "/知识来源", "1");
    assert.match(sent.at(-1)!, /FORBIDDEN/);
    await command("admin", "/知识来源", "2");
    assert.match(sent.at(-1)!, /来源 0 项/);
    await command("member", "/解析来源 source version", "3");
    assert.match(sent.at(-1)!, /FORBIDDEN/);
    await t.request("PUT", "/api/domains/ads/members/admin", {
      role: "member",
      expectedVersion: 1,
    });
    await command("admin", "/知识来源", "4");
    assert.match(sent.at(-1)!, /FORBIDDEN/);
  } finally {
    await t.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
