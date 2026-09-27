import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonTextExtractor } from "../src/explanation.js";

test("json text extractor streams decoded text across chunk boundaries", () => {
  const e = new JsonTextExtractor();
  e.push('```json\n{"text":"第一段');
  assert.equal(e.value(), "第一段");
  e.push("\\n继续"); // escape split across chunks
  assert.equal(e.value(), "第一段\n继续");
  e.push("\\u4e2d"); // unicode escape split across chunks
  assert.equal(e.value(), "第一段\n继续中");
  e.push('文","citations":["guide"]}"');
  assert.equal(e.value(), "第一段\n继续中文");
  e.push("\n```");
  assert.equal(e.value(), "第一段\n继续中文"); // closed; nothing more
});

test("json text extractor passes through bare markdown and stops at artifacts", () => {
  const e = new JsonTextExtractor();
  e.push("## 直接是正文");
  assert.equal(e.value(), "## 直接是正文");
  e.push("\n第二段");
  assert.equal(e.value(), "## 直接是正文\n第二段");
  e.push('\n{"text":"junk"}');
  assert.equal(e.value(), "## 直接是正文\n第二段\n"); // artifact cut
});

test("json text extractor waits while a fence prefix is still forming", () => {
  const e = new JsonTextExtractor();
  e.push("`");
  assert.equal(e.value(), "");
  e.push("`");
  assert.equal(e.value(), "");
  e.push("`");
  assert.equal(e.value(), "");
  e.push('\n{"text":"开始');
  assert.equal(e.value(), "开始");
});
