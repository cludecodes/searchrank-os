import type { GlobalRole, WorkspaceRole } from "../db/schema";

export type Permission =
  | "project:read"
  | "project:write"
  | "audit:run"
  | "keyword:write"
  | "content:write"
  | "content:approve"
  | "integration:write"
  | "agent:run"
  | "approval:decide"
  | "deployment:approve"
  | "workspace:manage"
  | "report:read";

const RANK: Record<WorkspaceRole, number> = {
  VIEWER: 0,
  EDITOR: 1,
  ADMIN: 2,
  OWNER: 3,
};

const MIN_ROLE: Record<Permission, WorkspaceRole> = {
  "project:read": "VIEWER",
  "report:read": "VIEWER",
  "project:write": "EDITOR",
  "audit:run": "EDITOR",
  "keyword:write": "EDITOR",
  "content:write": "EDITOR",
  "agent:run": "EDITOR",
  "content:approve": "ADMIN",
  "approval:decide": "ADMIN",
  "deployment:approve": "ADMIN",
  "integration:write": "ADMIN",
  "workspace:manage": "OWNER",
};

export function hasWorkspaceRole(actual: WorkspaceRole, required: WorkspaceRole): boolean {
  return RANK[actual] >= RANK[required];
}

export function can(role: WorkspaceRole, permission: Permission): boolean {
  return hasWorkspaceRole(role, MIN_ROLE[permission]);
}

export function isSuperAdmin(role: GlobalRole | undefined | null): boolean {
  return role === "SUPERADMIN";
}

/** Resolve the effective role: a superadmin acts as OWNER in every workspace. */
export function effectiveRole(
  globalRole: GlobalRole | undefined | null,
  workspaceRole: WorkspaceRole | undefined,
): WorkspaceRole | null {
  if (isSuperAdmin(globalRole)) return "OWNER";
  return workspaceRole ?? null;
}
