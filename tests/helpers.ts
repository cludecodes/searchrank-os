import { createTestDatabase, runMigrations, type Database } from "../src/core/db/client";
import { workspaces, users, workspaceMembers } from "../src/core/db/schema";
import { hashPassword } from "../src/core/security/password";

export async function setupTestDb() {
  const { db, client, close } = createTestDatabase();
  await runMigrations(db, "pglite");
  return { db, client, close };
}

export interface SeedFixture {
  userId: string;
  workspaceId: string;
}

export async function seedIdentity(db: Database, email = "owner@example.com"): Promise<SeedFixture> {
  const user = await db
    .insert(users)
    .values({ email, name: "Test Owner", passwordHash: await hashPassword("a-very-long-test-password") })
    .returning({ id: users.id });
  const workspace = await db
    .insert(workspaces)
    .values({ name: "Test Workspace", slug: `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ownerId: user[0].id })
    .returning({ id: workspaces.id });
  await db.insert(workspaceMembers).values({
    workspaceId: workspace[0].id,
    userId: user[0].id,
    role: "OWNER",
  });
  return { userId: user[0].id, workspaceId: workspace[0].id };
}
