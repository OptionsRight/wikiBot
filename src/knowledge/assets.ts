import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { rawSha256, digest } from "./contracts.js";
import { requireThat } from "../core.js";

/** Only server-generated digest keys are accepted. Public DTOs never contain paths. */
export class AssetStore {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    requireThat(
      !lstatSync(this.root).isSymbolicLink(),
      400,
      "ASSET_SYMLINK_FORBIDDEN",
    );
  }
  private directory(domain: string) {
    const dir = join(this.root, rawSha256(domain));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    requireThat(
      !lstatSync(dir).isSymbolicLink(),
      400,
      "ASSET_SYMLINK_FORBIDDEN",
    );
    return dir;
  }
  put(domain: string, bytes: Uint8Array) {
    const hash = rawSha256(bytes),
      target = join(this.directory(domain), hash);
    if (!existsSync(target)) {
      // Interrupted writes are detected by every read. Incomplete blobs cannot
      // become DB references because this read occurs before the transaction.
      const temp = join(this.directory(domain), `.pending-${randomUUID()}`);
      writeFileSync(temp, bytes, { flag: "wx", mode: 0o600, flush: true });
      renameSync(temp, target);
    }
    this.read(domain, hash);
    return hash;
  }
  read(domain: string, hash: string): Buffer {
    digest.parse(hash);
    const target = join(this.directory(domain), hash);
    requireThat(existsSync(target), 409, "ASSET_MISSING");
    const stat = lstatSync(target);
    requireThat(
      stat.isFile() && !stat.isSymbolicLink() && stat.size <= 512 * 1024 * 1024,
      409,
      "ASSET_INVALID",
    );
    const bytes = readFileSync(target);
    requireThat(rawSha256(bytes) === hash, 409, "ASSET_HASH_MISMATCH");
    return bytes;
  }
  verifyDomain(domain: string) {
    return readdirSync(this.directory(domain))
      .filter((name) => !name.startsWith(".pending-"))
      .map((hash) => ({ hash, bytes: this.read(domain, hash).length }));
  }
}
