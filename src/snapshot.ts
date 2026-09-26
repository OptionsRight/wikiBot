import { open, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, relative, sep, join } from "node:path";
import { bundleSchema, validateBundle, type Bundle } from "./procedures.js";
import { hash, requireThat } from "./core.js";
export async function snapshot(
  root: string,
  manifest: unknown,
): Promise<Bundle> {
  const bundle = bundleSchema.parse(manifest),
    base = await realpath(root);
  validateBundle(bundle);
  async function read(path: string) {
    let part = base;
    for (const segment of path.split("/")) {
      part = join(part, segment);
      requireThat(
        !(await lstat(part)).isSymbolicLink(),
        400,
        "SYMLINK_FORBIDDEN",
      );
    }
    const target = resolve(base, path),
      location = relative(base, await realpath(target));
    requireThat(
      !location.startsWith(`..${sep}`) &&
        location !== ".." &&
        !location.startsWith(sep),
      400,
      "PATH_ESCAPE",
    );
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      requireThat(
        stat.isFile() && stat.size <= 200000,
        400,
        "INVALID_SOURCE_FILE",
      );
      return new TextDecoder("utf-8", { fatal: true }).decode(
        await file.readFile(),
      );
    } finally {
      await file.close();
    }
  }
  const pages = [];
  for (const page of bundle.pages) {
    const content = await read(page.path);
    requireThat(hash(content) === page.hash, 409, "SOURCE_BASELINE_CONFLICT");
    pages.push({ ...page, content });
  }
  // A second complete read detects changes during capture. Operators must still pause all writers.
  for (const page of pages)
    requireThat(
      hash(await read(page.path)) === page.hash,
      409,
      "SOURCE_CHANGED_DURING_SNAPSHOT",
    );
  const result = { ...bundle, pages };
  requireThat(
    Buffer.byteLength(JSON.stringify(result)) <= 4 * 1024 * 1024,
    413,
    "SNAPSHOT_TOO_LARGE",
  );
  validateBundle(result);
  return result;
}
