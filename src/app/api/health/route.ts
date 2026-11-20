import { sql } from "drizzle-orm";
import { databaseMode, getDb } from "@/core/db/client";
import { getAIProvider } from "@/core/ai/provider";
import { OAUTH_PROVIDERS } from "@/core/integrations/oauth";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, unknown> = {};
  let healthy = true;
  try {
    const result = await getDb().execute(sql`select 1 as ok`);
    const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
    checks.database = { ok: rows.length === 1, mode: databaseMode() };
    healthy = healthy && rows.length === 1;
  } catch (error) {
    checks.database = { ok: false, error: error instanceof Error ? error.message : String(error) };
    healthy = false;
  }
  const ai = getAIProvider();
  checks.ai = { configured: ai.name !== "none", provider: ai.name };
  checks.integrations = Object.fromEntries(
    Object.values(OAUTH_PROVIDERS).map((p) => [p.provider, { configured: p.isConfigured(), scopes: p.scopes }]),
  );
  checks.indexNow = { configured: Boolean(process.env.INDEXNOW_KEY && process.env.INDEXNOW_KEY_LOCATION) };
  return Response.json({ healthy, checks, timestamp: new Date().toISOString() }, { status: healthy ? 200 : 503 });
}
