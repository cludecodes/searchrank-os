import { handleOAuthCallback } from "@/core/integrations/oauth-callback";

type Params = { params: Promise<{ provider: string }> };

export async function GET(request: Request, { params }: Params) {
  const { provider } = await params;
  return handleOAuthCallback(request, provider);
}
