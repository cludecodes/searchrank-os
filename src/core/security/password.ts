import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options?: ScryptOptions,
) => Promise<Buffer>;
const KEY_LENGTH = 64;

/** Hash a password with a random salt using scrypt (N=16384, r=8, p=1). */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new Error("Password must be at least 12 characters long.");
  }
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt$16384$8$1$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/** Verify a password against a stored scrypt hash in constant time. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltPart, hashPart] = parts;
  try {
    const salt = Buffer.from(saltPart, "base64");
    const expected = Buffer.from(hashPart, "base64");
    const actual = (await scrypt(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    })) as Buffer;
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
