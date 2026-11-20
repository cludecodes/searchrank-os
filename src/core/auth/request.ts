import { cookies, headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { workspaceMembers, type User, type WorkspaceRole } from "../db/schema";
import { getSessionUser } from "../security/sessions";
import { can, effectiveRole, type Permission } from "../security/rbac";

export interface RequestContext {
  user: User;
  workspaceId: string;
  role: WorkspaceRole;
}

export class ApiError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ApiError";
  }
}

/** Resolves the authenticated operator and their workspace role from the session cookie. */
export async function getRequestContext(): Promise<RequestContext | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(process.env.SESSION_COOKIE_NAME || "sr_session")?.value;
  if (!token) return null;
  const db = getDb();
  const resolved = await getSessionUser(db, token);
  if (!resolved) return null;

  const membership = await db
    .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, resolved.user.id))
    .limit(1);
  const headerStore = await headers();
  const requestedWorkspace = headerStore.get("x-workspace-id");
  const chosen = requestedWorkspace
    ? membership.find((m) => m.workspaceId === requestedWorkspace) ?? membership[0]
    : membership[0];
  if (!chosen) return null;

  const role = effectiveRole(resolved.user.globalRole, chosen.role);
  if (!role) return null;
  return { user: resolved.user, workspaceId: chosen.workspaceId, role };
}

export async function requireContext(): Promise<RequestContext> {
  const context = await getRequestContext();
  if (!context) throw new ApiError("Authentication required", 401);
  return context;
}

export async function requirePermission(permission: Permission): Promise<RequestContext> {
  const context = await requireContext();
  if (!can(context.role, permission)) {
    throw new ApiError(`Your role (${context.role}) cannot perform: ${permission}`, 403);
  }
  return context;
}

export function apiErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error("[api]", message);
  return Response.json({ error: message }, { status: 500 });
}

export async function requestMeta() {
  const headerStore = await headers();
  return {
    ipAddress: headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: headerStore.get("user-agent") ?? null,
  };
}

export async function writeAuditLog(
  action: string,
  context: { workspaceId: string | null; user: User },
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const { auditLogs } = await import("../db/schema");
  const db = getDb();
  await db.insert(auditLogs).values({
    workspaceId: context.workspaceId,
    actorId: context.user.id,
    action,
    metadata,
  });
}

export async function findWorkspaceBySlug(slug: string) {
  const { workspaces } = await import("../db/schema");
  const rows = await getDb().select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function userHasWorkspace(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
  const rows = await getDb()
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, workspaceId)))
    .limit(1);
  return rows[0]?.role ?? null;
}

export { and };
