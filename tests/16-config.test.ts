import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEnvStatus, missingRequiredEnv } from "../src/core/config/env-status";

const original: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ["DATABASE_URL", "MASTER_ENCRYPTION_KEY", "VERCEL_TOKEN", "VERCEL_PROJECT_ID", "AI_PROVIDER", "AI_MODEL"]) {
    original[name] = process.env[name];
  }
});

afterEach(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("configuration status", () => {
  it("lists every variable the platform needs without exposing secrets", () => {
    process.env.DATABASE_URL = "postgresql://example";
    process.env.MASTER_ENCRYPTION_KEY = "supersecretkeyvalue";
    process.env.VERCEL_TOKEN = "vcp_supersecret";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    process.env.AI_PROVIDER = "pollinations";
    process.env.AI_MODEL = "openai-fast";

    const rows = getEnvStatus();
    expect(rows.length).toBeGreaterThan(25);
    const token = rows.find((r) => r.name === "VERCEL_TOKEN")!;
    expect(token.group).toBe("Vercel API");
    expect(token.secret).toBe(true);
    expect(token.configured).toBe(true);
    expect(token.detail).toBe("value hidden");
    expect(JSON.stringify(rows)).not.toContain("vcp_supersecret");
    expect(JSON.stringify(rows)).not.toContain("supersecretkeyvalue");

    const projectId = rows.find((r) => r.name === "VERCEL_PROJECT_ID")!;
    expect(projectId.secret).toBe(false);
    expect(projectId.detail).toContain("prj_test");
    expect(missingRequiredEnv()).toEqual([]);
  });

  it("reports missing required variables honestly", () => {
    delete process.env.DATABASE_URL;
    delete process.env.MASTER_ENCRYPTION_KEY;
    expect(missingRequiredEnv()).toEqual(["DATABASE_URL", "MASTER_ENCRYPTION_KEY"]);
    const dbRow = getEnvStatus().find((r) => r.name === "DATABASE_URL")!;
    expect(dbRow.configured).toBe(false);
    expect(dbRow.detail).toBe("not set");
  });
});
