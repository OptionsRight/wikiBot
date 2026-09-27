import { constants } from "node:fs";
import { open, lstat, realpath, readdir } from "node:fs/promises";
import { resolve, relative, sep, join } from "node:path";
import { requireThat, hash } from "./core.js";

export function sourcePath(path: string) {
  requireThat(
    path.length <= 300 &&
      path
        .split("/")
        .every(
          (s) =>
            /^[\p{L}\p{N}_ .-]+$/u.test(s) &&
            !s.startsWith(".") &&
            s.trim() === s,
        ) &&
      !path.includes("\\"),
    400,
    "INVALID_SOURCE_PATH",
  );
}
export async function sourceTarget(root: string, path: string) {
  sourcePath(path);
  const base = await realpath(root);
  let target = base;
  for (const segment of path.split("/")) {
    target = join(target, segment);
    requireThat(
      !(await lstat(target)).isSymbolicLink(),
      400,
      "SYMLINK_FORBIDDEN",
    );
  }
  const location = relative(base, await realpath(target));
  requireThat(
    location !== ".." &&
      !location.startsWith(`..${sep}`) &&
      !location.startsWith(sep),
    400,
    "PATH_ESCAPE",
  );
  return target;
}
export async function readSource(
  root: string,
  path: string,
  limit = 200000,
): Promise<Buffer> {
  const target = await sourceTarget(root, path);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    requireThat(
      stat.isFile() && stat.size <= limit,
      400,
      "INVALID_SOURCE_FILE",
    );
    const content = await file.readFile();
    requireThat(content.byteLength <= limit, 400, "INVALID_SOURCE_FILE");
    return content;
  } finally {
    await file.close();
  }
}
export async function readSourceText(root: string, path: string) {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await readSource(root, path),
  );
}
// The full directory inventory fences unrelated additions/deletions, too. Hidden
// application metadata is excluded, but ordinary symlinks are never followed.
export async function sourceInventory(root: string) {
  const files: { path: string; hash: string }[] = [];
  async function walk(dir: string) {
    for (const entry of (
      await readdir(resolve(root, dir), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      requireThat(!entry.isSymbolicLink(), 400, "SYMLINK_FORBIDDEN");
      if (entry.isDirectory()) await walk(path);
      else {
        requireThat(files.length < 10000, 413, "SOURCE_TOO_LARGE");
        files.push({
          path,
          hash: hash(
            (await readSource(root, path, 16 * 1024 * 1024)).toString("base64"),
          ),
        });
      }
    }
  }
  await walk("");
  return files;
}
