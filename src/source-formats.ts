import { posix } from "node:path";
import { hash, requireThat } from "./core.js";
import { sourceInventory, readSourceText, sourcePath } from "./source-files.js";
export interface PageManifest {
  id: string;
  path: string;
  title: string;
  hash: string;
}
export function nativePageId(content: string): string | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return;
  let data: { id?: unknown };
  try {
    data = JSON.parse(match[1]!);
  } catch {
    throw new Error("UNSUPPORTED_FRONTMATTER_FORMAT");
  }
  requireThat(
    typeof data.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(data.id),
    400,
    "INVALID_NATIVE_PAGE_ID",
  );
  return data.id;
}
export async function createPageManifest(
  root: string,
  previous: PageManifest[] = [],
  renames: Record<string, string> = {},
  excludedPaths: string[] = [],
): Promise<PageManifest[]> {
  const pages: PageManifest[] = [],
    oldPaths = new Map(previous.map((p) => [p.path, p]));
  for (const file of (await sourceInventory(root)).filter(
    (p) => p.path.endsWith(".md") && !excludedPaths.includes(p.path),
  )) {
    const content = await readSourceText(root, file.path),
      digest = hash(content),
      nativeId = nativePageId(content);
    const renameFrom = Object.keys(renames).filter(
      (p) => renames[p] === file.path,
    );
    requireThat(renameFrom.length <= 1, 400, "AMBIGUOUS_RENAME");
    if (renameFrom[0])
      requireThat(oldPaths.has(renameFrom[0]), 400, "UNKNOWN_RENAME_SOURCE");
    const exact = previous.filter(
      (p) => p.hash === digest && !pages.some((done) => done.id === p.id),
    );
    const old =
      oldPaths.get(file.path) ??
      (renameFrom[0] ? oldPaths.get(renameFrom[0]) : undefined) ??
      previous.find((p) => p.id === nativeId) ??
      (exact.length === 1 ? exact[0] : undefined);
    const slug = file.path
      .replace(/\.md$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    pages.push({
      id:
        old?.id ??
        nativeId ??
        `${slug.slice(0, 90)}-${hash(file.path).slice(0, 6)}`,
      path: file.path,
      title: content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file.path,
      hash: digest,
    });
  }
  requireThat(
    new Set(pages.map((p) => p.id)).size === pages.length,
    400,
    "DUPLICATE_SOURCE_ID",
  );
  requireThat(
    previous.every((p) => pages.some((next) => next.id === p.id)),
    409,
    "RENAME_MAPPING_OR_REMOVAL_REVIEW_REQUIRED",
  );
  return pages;
}
// Resolve links against the immutable package, not the operator's filesystem.
export function validateSourceLinks(
  pages: { path: string; content: string }[],
  artifactPaths: string[],
) {
  const known = new Set([...pages.map((p) => p.path), ...artifactPaths]);
  for (const page of pages) {
    requireThat(
      !/<(?:[a-z][a-z0-9+.-]*:[^<>\s]*|[^<>\s]+@[^<>\s]+)>/i.test(page.content),
      400,
      "EXTERNAL_SOURCE_LINK_FORBIDDEN",
    );
    requireThat(
      !/!?\[[^\]\n]+\]\[[^\]\n]*\]|^\s{0,3}\[[^\]\n]+\]:|<[^>]+\s(?:href|src)\s*=/im.test(
        page.content,
      ),
      400,
      "UNSUPPORTED_SOURCE_LINK_FORMAT",
    );
    const targets: { value: string; wiki: boolean }[] = [];
    for (const m of page.content.matchAll(/\[\[([^\]\n]+)\]\]/g))
      targets.push({ value: m[1]!.split("|")[0]!, wiki: true });
    const consumedOpenings = new Set<number>();
    for (const opening of page.content.matchAll(/!?\[[^\]\n]*\]\(/g)) {
      const match = page.content
        .slice(opening.index)
        .match(
          /^!?\[[^\]\n]*\]\(([^\s()<>]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\)/,
        );
      // Never silently ignore a link-shaped expression outside our supported subset.
      requireThat(match, 400, "UNSUPPORTED_SOURCE_LINK_FORMAT");
      consumedOpenings.add(opening.index + opening[0].length - 2);
      targets.push({ value: match[1]!, wiki: false });
    }
    for (const delimiter of page.content.matchAll(/\]\(/g))
      requireThat(
        consumedOpenings.has(delimiter.index),
        400,
        "UNSUPPORTED_SOURCE_LINK_FORMAT",
      );
    for (const item of targets) {
      const raw = item.value.split("#")[0]!;

      requireThat(
        !/^[a-z][a-z0-9+.-]*:|^\/\/|^\//i.test(raw),
        400,
        "EXTERNAL_SOURCE_LINK_FORBIDDEN",
      );
      let decoded: string;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        throw new Error("INVALID_SOURCE_LINK");
      }
      const target = !raw
        ? page.path
        : posix.normalize(
            item.wiki && !decoded.startsWith(".")
              ? decoded
              : posix.join(posix.dirname(page.path), decoded),
          );
      sourcePath(target);
      requireThat(known.has(target), 400, "BROKEN_SOURCE_LINK");
      if (item.value.includes("#")) {
        let fragment: string;
        try {
          fragment = decodeURIComponent(
            item.value.slice(item.value.indexOf("#") + 1),
          );
        } catch {
          throw new Error("INVALID_SOURCE_LINK");
        }
        const targetPage = pages.find((p) => p.path === target);
        const anchors = [
          ...(targetPage?.content ?? "").matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm),
        ].map((m) =>
          m[1]!
            .trim()
            .toLowerCase()
            .replace(/[^\p{L}\p{N}_ -]/gu, "")
            .replace(/ /g, "-"),
        );
        requireThat(
          fragment.length > 0 && anchors.includes(fragment),
          400,
          "BROKEN_SOURCE_ANCHOR",
        );
      }
    }
  }
}

// One conversion shared by local tools: immutable package bodies never enter a manifest.
export function bundleManifest<
  T extends {
    pages: { content?: string }[];
    sourceArtifacts?: { content?: string }[];
  },
>(bundle: T) {
  const { pages, sourceArtifacts, ...rest } = bundle;
  return {
    ...rest,
    pages: pages.map(({ content: _content, ...p }) => p),
    ...(sourceArtifacts
      ? {
          sourceArtifacts: sourceArtifacts.map(
            ({ content: _content, ...a }) => a,
          ),
        }
      : {}),
  };
}
