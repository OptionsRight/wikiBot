import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex"),
    key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt-v1:${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(
  password: string,
  encoded: string | undefined,
) {
  const parts = encoded?.split(":");
  if (
    !parts ||
    parts[0] !== "scrypt-v1" ||
    !/^[a-f0-9]{32}$/.test(parts[1] ?? "") ||
    !/^[a-f0-9]{128}$/.test(parts[2] ?? "")
  )
    return false;
  const key = (await scrypt(password, parts[1]!, 64)) as Buffer;
  return timingSafeEqual(key, Buffer.from(parts[2]!, "hex"));
}
