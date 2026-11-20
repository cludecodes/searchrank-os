import { handleOAuthCallback } from "@/core/integrations/oauth-callback";

/** Alias callback path for OAuth apps registered with the legacy route shape
 *  (e.g. /api/auth/callback/github). Shares the exact same state-checked flow. */
type Params = { params: Promise<{ provider: string }> };

export async function GET(request: Request, { params }: Params) {
  const { provider } = await params;
  return handleOAuthCallback(request, provider);
}
