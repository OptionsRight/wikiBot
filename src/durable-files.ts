import { open } from "node:fs/promises";

/** Windows cannot fsync a directory handle. File contents are always synced
 * before rename; recovery must verify the journal/manifest after a crash. */
export async function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
