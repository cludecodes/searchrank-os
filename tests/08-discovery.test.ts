import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { projects, deployments } from "../src/core/db/schema";
import { registerAllAgents } from "../src/core/agents/definitions";
import { runAgent } from "../src/core/agents/framework";
import { saveIntegration } from "../src/core/integrations/credentials";
import { encryptSecret } from "../src/core/security/crypto";
import { seedIdentity, setupTestDb } from "./helpers";

let originalFetch: typeof globalThis.fetch;

function jsonFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown; headers?: Record<string, string> }) {
  return (async (url: string, init: RequestInit) => {
    const out = handler(url, init);
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      headers: { get: (k: string) => out.headers?.[k.toLowerCase()] ?? null },
      text: async () => JSON.stringify(out.body),
      json: async () => out.body,
    } as Response;
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  registerAllAgents();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("project discovery engine", () => {
  it("skips when no GitHub or Vercel integration is connected", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const { result } = await runAgent(db, "PROJECT_DISCOVERY_AGENT", { workspaceId, input: {} });
    expect(result.skippedReason).toMatch(/no github or vercel/i);
    await close();
  });

  it("discovers public GitHub repositories, infers framework and category, omits private repos", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);

    await saveIntegration(db, {
      workspaceId,
      provider: "github",
      accessToken: encryptSecret("gho_test"),
      accountIdentifier: "testuser",
      displayName: "Test User",
      scopes: ["public_repo"],
    });

    globalThis.fetch = jsonFetch((url) => {
      if (url.includes("/user/repos")) {
        return {
          status: 200,
          body: [
            {
              id: 1,
              name: "acme-store",
              full_name: "testuser/acme-store",
              private: false,
              disabled: false,
              default_branch: "main",
              homepage: "https://acme.example.com",
              description: "Buy premium coffee beans online",
              language: "JavaScript",
              topics: ["shop", "coffee", "ecommerce"],
              pushed_at: "2026-01-01T00:00:00Z",
              owner: { login: "testuser", type: "User" },
            },
            {
              id: 2,
              name: "secret-repo",
              full_name: "testuser/secret-repo",
              private: true,
              disabled: false,
              default_branch: "main",
              homepage: null,
              description: null,
              language: null,
              topics: [],
              pushed_at: null,
              owner: { login: "testuser", type: "User" },
            },
          ],
        };
      }
      if (url.includes("/contents/package.json")) {
        return {
          status: 200,
          body: { content: Buffer.from(JSON.stringify({ dependencies: { next: "16.0.0" } })).toString("base64"), sha: "abc", path: "package.json" },
        };
      }
      return { status: 404, body: { message: "Not Found" } };
    });

    const { result } = await runAgent(db, "PROJECT_DISCOVERY_AGENT", { workspaceId, input: {} });
    expect(result.skippedReason).toBeUndefined();
    expect(result.summary).toMatch(/Discovered or refreshed 1 project/);

    const rows = await db.select().from(projects).where(eq(projects.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("acme-store");
    expect(rows[0].repositoryFullName).toBe("testuser/acme-store");
    expect(rows[0].domain).toBe("acme.example.com");
    expect(rows[0].framework).toBe("Next.js");
    expect(rows[0].businessCategory).toBe("ecommerce");
    expect(rows[0].isDuplicateDomain).toBe(false);
    expect(rows[0].discoveredBy).toBe("github");
    await close();
  });

  it("discovers Vercel projects, detects deployment failures and preview deployments", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);

    await saveIntegration(db, {
      workspaceId,
      provider: "vercel",
      accessToken: encryptSecret("vercel_test"),
      accountIdentifier: "testuser",
      displayName: "Test User",
      scopes: ["user:project", "user:deployment"],
    });

    globalThis.fetch = jsonFetch((url) => {
      if (url.includes("/v9/projects")) {
        return {
          status: 200,
          body: {
            projects: [
              {
                id: "vercel_proj_1",
                name: "My Store",
                framework: "nextjs",
                description: "Online store",
                targets: { production: { url: "mystore.vercel.app", alias: ["mystore.example.com"] } },
                updatedAt: Date.now(),
              },
              {
                id: "vercel_proj_2",
                name: "Preview Only",
                framework: "nextjs",
                description: "Preview",
                targets: {},
                updatedAt: Date.now(),
              },
            ],
            pagination: {},
          },
        };
      }
      if (url.includes("/v6/deployments")) {
        const projectId = url.split("projectId=")[1]?.split("&")[0];
        if (projectId === "vercel_proj_1") {
          return {
            status: 200,
            body: {
              deployments: [
                { id: "dep_prod_1", url: "mystore.vercel.app", state: "ERROR", target: "production", created: Date.now() },
                { id: "dep_preview_1", url: "preview-1.vercel.app", state: "READY", target: "preview", created: Date.now() - 1000 },
              ],
            },
          };
        }
        if (projectId === "vercel_proj_2") {
          return {
            status: 200,
            body: {
              deployments: [
                { id: "dep_preview_2", url: "preview-2.vercel.app", state: "READY", target: "preview", created: Date.now() },
              ],
            },
          };
        }
        return { status: 200, body: { deployments: [] } };
      }
      return { status: 404, body: { message: "Not Found" } };
    });

    const { result } = await runAgent(db, "PROJECT_DISCOVERY_AGENT", { workspaceId, input: {} });
    expect(result.skippedReason).toBeUndefined();
    expect(result.summary).toMatch(/2 project/);
    expect(result.summary).toMatch(/1 deployment failure/);
    expect(result.summary).toMatch(/2 with preview deployment/);

    const rows = await db.select().from(projects).where(eq(projects.workspaceId, workspaceId)).orderBy(projects.name);
    expect(rows).toHaveLength(2);

    const store = rows[0];
    expect(store.name).toBe("My Store");
    expect(store.domain).toBe("mystore.vercel.app");
    expect(store.status).toBe("error"); // production deployment failed
    expect(store.isPreview).toBe(false);

    const preview = rows[1];
    expect(preview.name).toBe("Preview Only");
    expect(preview.status).toBe("discovered"); // no production url
    expect(preview.isPreview).toBe(true);

    // Deployments should be recorded keyed to the project.
    const depRows = await db.select().from(deployments).where(eq(deployments.projectId, store.id));
    expect(depRows.length).toBeGreaterThanOrEqual(1);
    const failed = depRows.find((d) => d.state === "ERROR");
    expect(failed).toBeDefined();
    await close();
  });

  it("flags duplicate domains across GitHub and Vercel sources", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);

    await saveIntegration(db, {
      workspaceId,
      provider: "github",
      accessToken: encryptSecret("gho_test"),
      accountIdentifier: "testuser",
      scopes: ["public_repo"],
    });
    await saveIntegration(db, {
      workspaceId,
      provider: "vercel",
      accessToken: encryptSecret("vercel_test"),
      accountIdentifier: "testuser",
      scopes: ["user:project"],
    });

    let githubCalled = false;
    globalThis.fetch = jsonFetch((url) => {
      if (url.includes("/user/repos")) {
        githubCalled = true;
        return {
          status: 200,
          body: [
            {
              id: 1,
              name: "shared-domain",
              full_name: "testuser/shared-domain",
              private: false,
              disabled: false,
              default_branch: "main",
              homepage: "https://shared.example.com",
              description: "A shared domain repo",
              language: null,
              topics: [],
              pushed_at: null,
              owner: { login: "testuser", type: "User" },
            },
          ],
        };
      }
      if (url.includes("/v9/projects")) {
        return {
          status: 200,
          body: {
            projects: [
              {
                id: "vercel_dup",
                name: "Shared Domain Vercel",
                framework: null,
                description: null,
                targets: { production: { url: "shared.example.com" } },
                updatedAt: Date.now(),
              },
            ],
            pagination: {},
          },
        };
      }
      if (url.includes("/contents/package.json")) return { status: 404, body: { message: "Not Found" } };
      if (url.includes("/v6/deployments")) return { status: 200, body: { deployments: [] } };
      return { status: 404, body: { message: "Not Found" } };
    });

    const { result } = await runAgent(db, "PROJECT_DISCOVERY_AGENT", { workspaceId, input: {} });
    expect(result.skippedReason).toBeUndefined();
    expect(githubCalled).toBe(true);
    expect(result.data?.duplicateDomains).toContain("shared.example.com");

    const rows = await db.select().from(projects).where(eq(projects.workspaceId, workspaceId));
    expect(rows).toHaveLength(2);
    const dupes = rows.filter((r) => r.isDuplicateDomain);
    expect(dupes.length).toBeGreaterThanOrEqual(1);
    await close();
  });
});
