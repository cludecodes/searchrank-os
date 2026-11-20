import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const ENVELOPE_PREFIX = "v1";
let warnedDevKey = false;

/** Resolve the 32-byte master key used for credential encryption. */
export function getMasterKey(): Buffer {
  const raw = process.env.MASTER_ENCRYPTION_KEY;
  if (raw && raw.trim()) {
    const key = Buffer.from(raw.trim(), "base64");
    if (key.length !== 32) {
      throw new Error("MASTER_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
    }
    return key;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("MASTER_ENCRYPTION_KEY is required in production.");
  }

  // Explicit, clearly-labelled development fallback. Never used in production.
  if (!warnedDevKey) {
    console.warn(
      "[searchrank] MASTER_ENCRYPTION_KEY is not set — using a deterministic " +
        "development-only key. Set a real key before deploying.",
    );
    warnedDevKey = true;
  }
  return scryptSync("searchrank-os-development-only-key", "dev-salt", 32);
}

export function isUsingDevelopmentKey(): boolean {
  return !process.env.MASTER_ENCRYPTION_KEY?.trim();
}

/** AES-256-GCM envelope encryption for OAuth tokens and other secrets. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getMasterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_PREFIX,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSecret(envelope: string): string {
  const [version, ivPart, tagPart, cipherPart] = envelope.split(":");
  if (version !== ENVELOPE_PREFIX || !ivPart || !tagPart || !cipherPart) {
    throw new Error("Malformed encrypted secret envelope.");
  }
  const decipher = createDecipheriv("aes-256-gcm", getMasterKey(), Buffer.from(ivPart, "base64"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherPart, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** URL-safe random token for session identifiers. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** SHA-256 hex digest, used so raw session tokens are never stored. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
