import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { integrations, type Integration, type IntegrationProvider } from "../db/schema";
import { decryptSecret, encryptSecret } from "../security/crypto";

export interface SaveIntegrationInput {
  workspaceId: string;
  provider: IntegrationProvider;
  accessToken: string;
  refreshToken?: string | null;
  accountIdentifier?: string | null;
  displayName?: string | null;
  scopes?: string[];
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
}

/** Stores provider credentials encrypted at rest (AES-256-GCM). */
export async function saveIntegration(db: Database, input: SaveIntegrationInput): Promise<Integration> {
  const values = {
    workspaceId: input.workspaceId,
    provider: input.provider,
    accountIdentifier: input.accountIdentifier ?? null,
    displayName: input.displayName ?? null,
    encryptedAccessToken: encryptSecret(input.accessToken),
    encryptedRefreshToken: input.refreshToken ? encryptSecret(input.refreshToken) : null,
    scopes: input.scopes ?? [],
    expiresAt: input.expiresAt ?? null,
    metadata: input.metadata ?? {},
    status: "connected" as const,
    lastError: null,
    lastSyncedAt: new Date(),
    updatedAt: new Date(),
  };
  const existing = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(
      and(
        eq(integrations.workspaceId, input.workspaceId),
        eq(integrations.provider, input.provider),
        eq(integrations.accountIdentifier, input.accountIdentifier ?? ""),
      ),
    )
    .limit(1);

  if (existing.length) {
    const updated = await db
      .update(integrations)
      .set(values)
      .where(eq(integrations.id, existing[0].id))
      .returning();
    return updated[0];
  }
  const created = await db.insert(integrations).values(values).returning();
  return created[0];
}

export async function getIntegration(
  db: Database,
  workspaceId: string,
  provider: IntegrationProvider,
): Promise<Integration | null> {
  const rows = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider)))
    .orderBy(integrations.updatedAt)
    .limit(1);
  return rows[0] ?? null;
}

export async function getDecryptedTokens(
  db: Database,
  workspaceId: string,
  provider: IntegrationProvider,
): Promise<{ accessToken: string; refreshToken: string | null; integration: Integration } | null> {
  const integration = await getIntegration(db, workspaceId, provider);
  if (!integration?.encryptedAccessToken) return null;
  return {
    accessToken: decryptSecret(integration.encryptedAccessToken),
    refreshToken: integration.encryptedRefreshToken ? decryptSecret(integration.encryptedRefreshToken) : null,
    integration,
  };
}

export async function markIntegrationError(
  db: Database,
  integrationId: string,
  error: string,
): Promise<void> {
  await db
    .update(integrations)
    .set({ status: "error", lastError: error.slice(0, 2000), updatedAt: new Date() })
    .where(eq(integrations.id, integrationId));
}

export async function listIntegrations(db: Database, workspaceId: string) {
  return db.select().from(integrations).where(eq(integrations.workspaceId, workspaceId));
}
