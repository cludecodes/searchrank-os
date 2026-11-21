import { cookies, headers } from "next/headers";
import { eq } from "drizzle-orm";
import { apiErrorResponse } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { users, workspaceMembers, workspaces, type User } from "@/core/db/schema";
import { saveIntegration } from "@/core/integrations/credentials";
import { exchangeGoogleCode } from "@/core/integrations/google-search-console";
import { OAUTH_PROVIDERS, oauthCredentials } from "@/core/integrations/oauth";
import { createSession, getSessionUser } from "@/core/security/sessions";
import { hashPassword } from "@/core/security/password";
import { randomToken, safeEqual } from "@/core/security/crypto";

const clearOAuthCookie = "sr_oauth_state=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0";
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "sr_session";

function redirectTo(location: string, extraCookies: string[] = []) {
  const responseHeaders = new Headers();
  responseHeaders.set("Location", location);
  for (const cookie of [clearOAuthCookie, ...extraCookies]) {
    responseHeaders.append("Set-Cookie", cookie);
  }
  return new Response(null, { status: 302, headers: responseHeaders });
}

function loginError(request: Request, code: string) {
  const target = new URL("/login", request.url);
  target.searchParams.set("error", code);
  return redirectTo(target.toString());
}

async function sessionCookieFor(user: User, request: Request): Promise<string> {
  const headerStore = await headers();
  const { token, expiresAt } = await createSession(getDb(), user.id, {
    ipAddress: headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: headerStore.get("user-agent") ?? null,
  });
  void request;
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor((expiresAt.getTime() - Date.now()) / 1000)}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

async function resolveOrCreateUser(profile: { email: string; name?: string }): Promise<User> {
  const db = getDb();
  const [existing] = await db.select().from(users).where(eq(users.email, profile.email)).limit(1);
  if (existing) return existing;

  const created = await db.insert(users).values({
    email: profile.email,
    name: profile.name ?? profile.email.split("@")[0],
    passwordHash: await hashPassword(randomToken(32)),
    globalRole: "USER",
  }).returning();
  const user = created[0];
  const slug = `google-${profile.email.split("@")[0].replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${Date.now().toString(36)}`;
  const workspace = await db.insert(workspaces).values({
    name: `${profile.name ?? profile.email.split("@")[0]}'s Workspace`,
    slug,
    ownerId: user.id,
  }).returning();
  await db.insert(workspaceMembers).values({
    workspaceId: workspace[0].id,
    userId: user.id,
    role: "OWNER",
  });
  return user;
}

/** Shared Google callback: connects Search Console or signs the user into the app. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "";
    const errorParam = url.searchParams.get("error");
    const expected = (await cookies()).get("sr_oauth_state")?.value ?? "";
    const [purpose, provider, expectedState] = expected.split(":");

    if (errorParam) {
      return loginError(request, errorParam === "access_denied" ? "google_access_denied" : `google_${errorParam}`);
    }
    if (!code || !expectedState || !safeEqual(expectedState, state)) {
      return loginError(request, "google_invalid_state");
    }

    const { clientId, clientSecret } = oauthCredentials("google_search_console");
    const redirectUri = process.env.GOOGLE_CALLBACK_URL || `${url.origin}/api/auth/google/callback`;
    const tokens = await exchangeGoogleCode(clientId, clientSecret, code, redirectUri);

    // Fetch the profile once; both flows need a verified identity.
    const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!profileResponse.ok) return loginError(request, "google_profile_failed");
    const profile = (await profileResponse.json()) as { email?: string; name?: string; email_verified?: boolean };
    const email = profile.email?.toLowerCase();
    if (!email || !profile.email_verified) return loginError(request, "google_email_not_verified");

    const user = await resolveOrCreateUser({ email, name: profile.name });
    const session = await sessionCookieFor(user, request);

    if (purpose === "gsc" && provider === "google") {
      const config = OAUTH_PROVIDERS.google_search_console;
      // Bind credentials to a workspace: prefer the existing session's workspace,
      // otherwise fall back to the signed-in Google user's own workspace.
      const existingSession = (await cookies()).get(COOKIE_NAME)?.value;
      let workspaceId: string | undefined;
      if (existingSession) {
        const resolved = await getSessionUser(getDb(), existingSession);
        if (resolved) {
          const [membership] = await getDb()
            .select({ workspaceId: workspaceMembers.workspaceId })
            .from(workspaceMembers)
            .where(eq(workspaceMembers.userId, resolved.user.id))
            .limit(1);
          workspaceId = membership?.workspaceId;
        }
      }
      if (!workspaceId) {
        const [membership] = await getDb()
          .select({ workspaceId: workspaceMembers.workspaceId })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.userId, user.id))
          .limit(1);
        workspaceId = membership?.workspaceId;
      }
      if (!workspaceId) return loginError(request, "no_workspace");

      await saveIntegration(getDb(), {
        workspaceId,
        provider: "google_search_console",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        accountIdentifier: "default",
        displayName: config.label,
        scopes: tokens.scope?.split(/\s+/) ?? config.scopes,
        expiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null,
        metadata: { connectedAt: new Date().toISOString(), method: "google_oauth" },
      });
      return redirectTo(new URL("/dashboard/google?connected=google_search_console", request.url).toString(), [session]);
    }

    return redirectTo(new URL("/dashboard", request.url).toString(), [session]);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
