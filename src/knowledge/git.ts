import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { extname } from "node:path";
import { Store, requireThat, id, type Entity } from "../core.js";
import { wireHash, rawSha256 } from "./contracts.js";
import { createTextEvidence, type TextSource } from "./evidence.js";
import { hash } from "../core.js";
import type { Page } from "../procedures.js";
const execute = promisify(execFile);
export interface RepositoryConfig {
  root: string;
  ref: string;
  allowedPaths: string[];
  extensions: string[];
}
export interface CodeSnapshot extends Entity {
  repoId: string;
  commit: string;
  configurationHash: string;
  sources: TextSource[];
  createdAt: number;
}
function permitted(path: string, config: RepositoryConfig) {
  return (
    path
      .split("/")
      .every(
        (s) =>
          s &&
          !s.startsWith(".") &&
          ![
            "node_modules",
            "dist",
            "build",
            "metadata",
            "generated",
            "code-wiki",
          ].includes(s.toLowerCase()),
      ) &&
    !/(secret|credential|private[-_]?key|password)/i.test(path) &&
    !path.includes("\\") &&
    config.allowedPaths.some(
      (p) =>
        p === "" || path === p || path.startsWith(p.replace(/\/$/, "") + "/"),
    ) &&
    config.extensions.includes(extname(path))
  );
}
/** Only Git object reads: no checkout, hooks, repository scripts or submodules. */
export async function captureRepository(
  domain: string,
  repoId: string,
  config: RepositoryConfig,
): Promise<CodeSnapshot> {
  const root = await realpath(config.root);
  const git = async (args: string[], maxBuffer = 10 * 1024 * 1024) =>
    execute("git", ["--no-optional-locks", "-C", root, ...args], {
      windowsHide: true,
      maxBuffer,
      timeout: 30000,
      encoding: "buffer",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  requireThat(
    !config.ref.startsWith("-") && !/[\x00-\x20]/.test(config.ref),
    400,
    "INVALID_REPOSITORY_REF",
  );
  const commit = (
    await git(["rev-parse", "--verify", `${config.ref}^{commit}`])
  ).stdout
    .toString()
    .trim();
  requireThat(/^[a-f0-9]{40,64}$/.test(commit), 400, "INVALID_COMMIT");
  const entries = (await git(["ls-tree", "-r", "-z", commit])).stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const selected = entries
    .map((line) => line.match(/^(\d+) blob ([a-f0-9]+)\t(.+)$/s))
    .filter(
      (m): m is RegExpMatchArray =>
        !!m && ["100644", "100755"].includes(m[1]!) && permitted(m[3]!, config),
    );
  requireThat(
    selected.length > 0 && selected.length <= 500,
    400,
    "REPOSITORY_SCOPE_LIMIT",
  );
  const configurationHash = wireHash({
    allowedPaths: config.allowedPaths,
    extensions: config.extensions,
    resolverVersion: "1",
  });
  const sources: TextSource[] = [];
  let total = 0;
  for (const m of selected) {
    const blob = m[2]!,
      path = m[3]!,
      bytes = (await git(["cat-file", "blob", blob], 200001)).stdout;
    total += bytes.length;
    requireThat(
      bytes.length <= 200000 && total <= 8 * 1024 * 1024,
      413,
      "CODE_SNAPSHOT_LIMIT",
    );
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    requireThat(!content.includes("\0"), 400, "BINARY_CODE_SOURCE");
    sources.push({
      id: wireHash([domain, repoId, commit, path, blob]),
      domain,
      version: 1,
      kind: "repository",
      sourceId: wireHash([repoId, path]),
      rawSha256: rawSha256(bytes),
      profileHash: configurationHash,
      artifactHash: wireHash([commit, blob, path]),
      content,
      repoId,
      commit,
      blob,
      path,
    });
  }
  return {
    id: wireHash([domain, repoId, commit, configurationHash]),
    domain,
    version: 1,
    repoId,
    commit,
    configurationHash,
    sources,
    createdAt: Date.now(),
  };
}
export function registerCodeSnapshot(store: Store, snapshot: CodeSnapshot) {
  for (const source of snapshot.sources)
    store.knowledgePut("source_versions", source);
  return store.put("code-snapshot", snapshot);
}
export function deriveCodeWiki(store: Store, snapshot: CodeSnapshot) {
  const pages: Page[] = [],
    mapping: Record<string, string[]> = {},
    evidence = [];
  for (const source of snapshot.sources) {
    const lines = source.content.split("\n");
    // A bounded exact excerpt is evidence; inferred semantics remain for review.
    const end = Math.min(lines.length, 80);
    if (!lines.slice(0, end).join("\n").trim()) continue;
    const e = createTextEvidence(store, snapshot.domain, source.id, 1, end);
    evidence.push(e);
    const pageId = `code_${wireHash([snapshot.repoId, source.path]).slice(0, 24)}`;
    const declarations = lines
      .filter((l) =>
        /^\s*(export\s+|(?:async\s+)?function\s+|class\s+|def\s+|interface\s+|type\s+|const\s+)/.test(
          l,
        ),
      )
      .slice(0, 20);
    const fence = "`".repeat(
      Math.max(
        3,
        ...Array.from(source.content.matchAll(/`+/g), (m) => m[0].length + 1),
      ),
    );
    const content = `# ${source.path}\n\n受控代码仓库：${snapshot.repoId}\n固定提交：${snapshot.commit}\n\n## 文件声明索引\n\n${declarations.length ? declarations.map((d) => "- " + d.trim()).join("\n") : "本片段未识别出声明，需人工补充说明。"}\n\n## 可核对片段（第 1–${end} 行）\n\n${fence}\n${e.excerpt}\n${fence}\n\n证据编号：${e.evidenceId}\n\n本页为待复核代码摘录；声明的业务含义和跨文件关系须由负责人补充核对。\n`;
    pages.push({
      id: pageId,
      path: `code/${pageId}.md`,
      title: source.path!,
      content,
      hash: hash(content),
    });
    mapping[pageId] = [e.evidenceId];
  }
  requireThat(pages.length > 0, 400, "EMPTY_CODE_WIKI");
  return {
    id: id(),
    domain: snapshot.domain,
    version: 1,
    snapshotId: snapshot.id,
    state: "draft",
    pages,
    pageEvidence: mapping,
    evidence,
  };
}
