import { beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, hashToken, randomToken, safeEqual } from "../src/core/security/crypto";
import { hashPassword, verifyPassword } from "../src/core/security/password";
import { createSession, getSessionUser, revokeSession } from "../src/core/security/sessions";
import { checkRateLimit } from "../src/core/security/rate-limit";
import { can, effectiveRole, hasWorkspaceRole } from "../src/core/security/rbac";
import { seedIdentity, setupTestDb } from "./helpers";

describe("security primitives", () => {
  beforeEach(() => {
    process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  it("hashes and verifies passwords with scrypt", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
    await expect(hashPassword("short")).rejects.toThrow(/12 characters/);
  });

  it("round-trips encrypted secrets and rejects tampering", () => {
    const envelope = encryptSecret("gho_supersecrettoken");
    expect(envelope).not.toContain("supersecrettoken");
    expect(decryptSecret(envelope)).toBe("gho_supersecrettoken");
    const tampered = envelope.slice(0, -3) + "AAA";
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("never stores raw session tokens", async () => {
    const { db, close } = await setupTestDb();
    const { userId } = await seedIdentity(db);
    const { token } = await createSession(db, userId, { ipAddress: "127.0.0.1" });
    expect(token).not.toBe(hashToken(token));
    const resolved = await getSessionUser(db, token);
    expect(resolved?.user.id).toBe(userId);
    await revokeSession(db, token);
    expect(await getSessionUser(db, token)).toBeNull();
    expect(safeEqual(token, token)).toBe(true);
    expect(safeEqual(token, randomToken())).toBe(false);
    await close();
  });

  it("rate limits repeated failures per subject", async () => {
    const { db, close } = await setupTestDb();
    const first = await checkRateLimit(db, "login", "user@example.com", 3, 60_000);
    expect(first.allowed).toBe(true);
    await checkRateLimit(db, "login", "user@example.com", 3, 60_000);
    await checkRateLimit(db, "login", "user@example.com", 3, 60_000);
    const fourth = await checkRateLimit(db, "login", "user@example.com", 3, 60_000);
    expect(fourth.allowed).toBe(false);
    expect(fourth.hits).toBe(4);
    expect(fourth.retryAfterSeconds).toBeGreaterThanOrEqual(0);
    await close();
  });

  it("enforces role hierarchy", () => {
    expect(hasWorkspaceRole("OWNER", "ADMIN")).toBe(true);
    expect(hasWorkspaceRole("VIEWER", "EDITOR")).toBe(false);
    expect(can("EDITOR", "project:write")).toBe(true);
    expect(can("EDITOR", "approval:decide")).toBe(false);
    expect(can("ADMIN", "approval:decide")).toBe(true);
    expect(effectiveRole("SUPERADMIN", "VIEWER")).toBe("OWNER");
    expect(effectiveRole("USER", undefined)).toBeNull();
  });
});
