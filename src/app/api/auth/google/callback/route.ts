import { cookies, headers } from "next/headers";
import { eq } from "drizzle-orm";
import { apiErrorResponse } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { users, workspaceMembers, workspaces } from "@/core/db/schema";
import { saveIntegration } from "@/core/integrations/credentials";
import { exchangeGoogleCode } from "@/core/integrations/google-search-console";
import { OAUTH_PROVIDERS, oauthCredentials } from "@/core/integrations/oauth";
import { createSession } from "@/core/security/sessions";
import { hashPassword } from "@/core/security/password";
import { randomToken, safeEqual } from "@/core/security/crypto";

const clearOAuthCookie = "sr_oauth_state=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0";

function redirectWithCookies(location: string, extraCookies: string[] = []) {
  const responseHeaders = new Headers();
  responseHeaders.set("Location", location);
  for (const cookie of [clearOAuthCookie, ...extraCookies]) {
    responseHeaders.append("Set-Cookie", cookie);
  }
  return new Response(null, { status: 302, headers: responseHeaders });
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

    if (errorParam || !code || !expectedState || !safeEqual(expectedState, state)) {
      const target = new URL("/login", request.url);
      target.searchParams.set("error", errorParam ?? "invalid_state");
      return redirectWithCookies(target.toString());
    }

    const { clientId, clientSecret } = oauthCredentials("google_search_console");
    const redirectUri = process.env.GOOGLE_CALLBACK_URL || `${url.origin}/api/auth/google/callback`;
    const tokens = await exchangeGoogleCode(clientId, clientSecret, code, redirectUri);

    if (purpose === "gsc" && provider === "google") {
      const config = OAUTH_PROVIDERS.google_search_console;
      // Privacy: an unauthenticated visitor cannot bind tokens to a workspace.
      const sessionCookie = (await cookies()).get(process.env.SESSION_COOKIE_NAME || "sr_session")?.value;
      if (!sessionCookie) {
        return redirectWithCookies(new URL("/login?error=auth_required", request.url).toString());
      }
      const { getSessionUser } = await import("@/core/security/sessions");
      const resolved = await getSessionUser(getDb(), sessionCookie);
      if (!resolved) return redirectWithCookies(new URL("/login?error=auth_required", request.url).toString());
      const membership = await getDb()
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, resolved.user.id))
        .limit(1);
      if (!membership.length) return redirectWithCookies(new URL("/dashboard?error=no_workspace", request.url).toString());

      await saveIntegration(getDb(), {
        workspaceId: membership[0].workspaceId,
        provider: "google_search_console",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        accountIdentifier: "default",
        displayName: config.label,
        scopes: tokens.scope?.split(/\s+/) ?? config.scopes,
        expiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null,
        metadata: { connectedAt: new Date().toISOString(), method: "google_oauth" },
      });
      return redirectWithCookies(new URL("/dashboard/google?connected=google_search_console", request.url).toString());
    }

    // Sign-in with Google.
    const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!profileResponse.ok) {
      return redirectWithCookies(new URL("/login?error=google_profile_failed", request.url).toString());
    }
    const profile = (await profileResponse.json()) as {
      email?: string;
      name?: string;
      email_verified?: boolean;
    };
    const email = profile.email?.toLowerCase();
    if (!email || !profile.email_verified) {
      return redirectWithCookies(new URL("/login?error=google_email_not_verified", request.url).toString());
    }

    const db = getDb();
    let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      const created = await db.insert(users).values({
        email,
        name: profile.name ?? email.split("@")[0],
        passwordHash: await hashPassword(randomToken(32)),
        globalRole: "USER",
      }).returning();
      user = created[0];
      const slug = `google-${email.split("@")[0].replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${Date.now().toString(36)}`;
      const workspace = await db.insert(workspaces).values({
        name: `${profile.name ?? email.split("@")[0]}'s Workspace`,
        slug,
        ownerId: user.id,
      }).returning();
      await db.insert(workspaceMembers).values({
        workspaceId: workspace[0].id,
        userId: user.id,
        role: "OWNER",
      });
    }

    const headerStore = await headers();
    const { token: sessionToken, expiresAt } = await createSession(db, user.id, {
      ipAddress: headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: headerStore.get("user-agent") ?? null,
    });
    const cookieName = process.env.SESSION_COOKIE_NAME || "sr_session";
    const sessionCookie = `${cookieName}=${sessionToken}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor((expiresAt.getTime() - Date.now()) / 1000)}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
    return redirectWithCookies(new URL("/dashboard", request.url).toString(), [sessionCookie]);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
