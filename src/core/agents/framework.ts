import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentRuns } from "../db/schema";
import type { AIProvider } from "../ai/provider";
import { getAIProvider } from "../ai/provider";
import { appendJobLog } from "../jobs/queue";

export const AGENT_KEYS = [
  "CHIEF_SUPERVISOR",
  "PROJECT_DISCOVERY_AGENT",
  "TECHNICAL_SEO_AGENT",
  "KEYWORD_INTELLIGENCE_AGENT",
  "COMPETITOR_INTELLIGENCE_AGENT",
  "CONTENT_STRATEGY_AGENT",
  "CONTENT_PRODUCTION_AGENT",
  "LINK_AUTHORITY_AGENT",
  "DEVELOPER_AGENT",
  "INDEXING_AGENT",
  "ANALYTICS_AGENT",
  "QUALITY_SECURITY_AGENT",
] as const;

export type AgentKey = (typeof AGENT_KEYS)[number];

export interface AgentContext {
  db: Database;
  workspaceId?: string | null;
  projectId?: string | null;
  jobId?: string | null;
  input: Record<string, unknown>;
  ai: AIProvider;
  log: (message: string, metadata?: Record<string, unknown>) => Promise<void>;
}

export interface AgentResult {
  summary: string;
  data?: Record<string, unknown>;
  /** Agent requests a human decision before any high-risk side effect. */
  requiresApproval?: boolean;
  skippedReason?: string;
}

export interface AgentDefinition {
  key: AgentKey;
  name: string;
  mission: string;
  responsibilities: string[];
  toolsets: string[];
  canMutateProduction: boolean;
  run: (ctx: AgentContext) => Promise<AgentResult>;
}

const registry = new Map<AgentKey, AgentDefinition>();

export function registerAgent(definition: AgentDefinition): void {
  if (registry.has(definition.key)) throw new Error(`Duplicate agent: ${definition.key}`);
  registry.set(definition.key, definition);
}

export function getAgent(key: AgentKey): AgentDefinition | undefined {
  return registry.get(key);
}

export function listAgents(): AgentDefinition[] {
  return [...registry.values()];
}

export async function runAgent(
  db: Database,
  key: AgentKey,
  options: {
    workspaceId?: string | null;
    projectId?: string | null;
    jobId?: string | null;
    input?: Record<string, unknown>;
    ai?: AIProvider;
  } = {},
): Promise<{ runId: string; result: AgentResult }> {
  const definition = registry.get(key);
  if (!definition) throw new Error(`Agent ${key} is not registered.`);

  const created = await db
    .insert(agentRuns)
    .values({
      workspaceId: options.workspaceId ?? null,
      projectId: options.projectId ?? null,
      jobId: options.jobId ?? null,
      agentKey: key,
      status: "running",
      input: options.input ?? {},
    })
    .returning({ id: agentRuns.id });
  const runId = created[0].id;

  const log = async (message: string, metadata: Record<string, unknown> = {}) => {
    if (options.jobId) await appendJobLog(db, options.jobId, "info", `[${key}] ${message}`, metadata);
  };

  try {
    const result = await definition.run({
      db,
      workspaceId: options.workspaceId,
      projectId: options.projectId,
      jobId: options.jobId,
      input: options.input ?? {},
      ai: options.ai ?? getAIProvider(),
      log,
    });
    await db
      .update(agentRuns)
      .set({
        status: result.skippedReason ? "skipped" : "succeeded",
        output: { ...result.data, summary: result.summary, skippedReason: result.skippedReason } as Record<string, unknown>,
        finishedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));
    return { runId, result };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    await db
      .update(agentRuns)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(eq(agentRuns.id, runId));
    throw error;
  }
}
