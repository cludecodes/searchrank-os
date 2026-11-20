export type EnvGroup = "Core" | "Security" | "AI" | "OAuth" | "Vercel API" | "IndexNow" | "Worker";

export interface EnvVarStatus {
  name: string;
  group: EnvGroup;
  purpose: string;
  required: boolean;
  secret: boolean;
  configured: boolean;
  detail: string;
}

const SET = (name: string) => Boolean(process.env[name]?.trim());

const DEFINITIONS: Array<Omit<EnvVarStatus, "configured" | "detail"> & { detail?: string }> = [
  // Core
  { name: "DATABASE_URL", group: "Core", purpose: "Neon Postgres connection string (multi-process production)", required: true, secret: true },
  { name: "NEXT_PUBLIC_APP_URL", group: "Core", purpose: "Public app URL used in links and callbacks", required: false, secret: false },
  { name: "SESSION_COOKIE_NAME", group: "Core", purpose: "Session cookie name (default: sr_session)", required: false, secret: false },
  { name: "SESSION_TTL_HOURS", group: "Core", purpose: "Session lifetime in hours (default: 168)", required: false, secret: false },
  { name: "ALLOW_SIGNUPS", group: "Core", purpose: "Allow new accounts after bootstrap (default: false)", required: false, secret: false },
  // Security
  { name: "MASTER_ENCRYPTION_KEY", group: "Security", purpose: "AES-256-GCM key for credentials at rest (base64, 32 bytes)", required: true, secret: true },
  { name: "CRON_SECRET", group: "Security", purpose: "Protects /api/cron/scheduler", required: false, secret: true },
  // AI
  { name: "AI_PROVIDER", group: "AI", purpose: "pollinations | openai-compatible | anthropic | none", required: false, secret: false },
  { name: "AI_MODEL", group: "AI", purpose: "Model id (openai-fast = free open-weight GPT-OSS 20B)", required: false, secret: false },
  { name: "AI_BASE_URL", group: "AI", purpose: "OpenAI-compatible endpoint base URL", required: false, secret: false },
  { name: "AI_API_KEY", group: "AI", purpose: "Provider key; not needed for the free Pollinations model", required: false, secret: true },
  // OAuth
  { name: "GITHUB_CLIENT_ID", group: "OAuth", purpose: "GitHub OAuth app client id", required: false, secret: false },
  { name: "GITHUB_CLIENT_SECRET", group: "OAuth", purpose: "GitHub OAuth app client secret", required: false, secret: true },
  { name: "GITHUB_CALLBACK_URL", group: "OAuth", purpose: "GitHub OAuth redirect URI", required: false, secret: false },
  { name: "GOOGLE_CLIENT_ID", group: "OAuth", purpose: "Google Search Console OAuth client id", required: false, secret: false },
  { name: "GOOGLE_CLIENT_SECRET", group: "OAuth", purpose: "Google OAuth client secret", required: false, secret: true },
  { name: "GOOGLE_CALLBACK_URL", group: "OAuth", purpose: "Google OAuth redirect URI", required: false, secret: false },
  { name: "VERCEL_CLIENT_ID", group: "OAuth", purpose: "Vercel OAuth client id (optional if API token is used)", required: false, secret: false },
  { name: "VERCEL_CLIENT_SECRET", group: "OAuth", purpose: "Vercel OAuth client secret", required: false, secret: true },
  { name: "VERCEL_CALLBACK_URL", group: "OAuth", purpose: "Vercel OAuth redirect URI", required: false, secret: false },
  { name: "MICROSOFT_CLIENT_ID", group: "OAuth", purpose: "Bing Webmaster OAuth client id", required: false, secret: false },
  { name: "MICROSOFT_CLIENT_SECRET", group: "OAuth", purpose: "Bing Webmaster OAuth client secret", required: false, secret: true },
  { name: "MICROSOFT_CALLBACK_URL", group: "OAuth", purpose: "Bing Webmaster OAuth redirect URI", required: false, secret: false },
  // Vercel API
  { name: "VERCEL_TOKEN", group: "Vercel API", purpose: "Vercel API token for deployments and previews", required: false, secret: true },
  { name: "VERCEL_PROJECT_ID", group: "Vercel API", purpose: "Vercel project id used by deployment automation", required: false, secret: false },
  // IndexNow
  { name: "INDEXNOW_KEY", group: "IndexNow", purpose: "IndexNow submission key", required: false, secret: true },
  { name: "INDEXNOW_KEY_LOCATION", group: "IndexNow", purpose: "Public URL hosting the key file on the submitted host", required: false, secret: false },
  // Worker
  { name: "WORKER_POLL_MS", group: "Worker", purpose: "Background worker poll interval (default: 2000)", required: false, secret: false },
  { name: "WORKER_CONCURRENCY", group: "Worker", purpose: "Concurrent jobs per worker (default: 4)", required: false, secret: false },
  { name: "WORKER_ID", group: "Worker", purpose: "Worker instance identifier", required: false, secret: false },
];

/** All environment variables the platform understands. Secret values are never returned. */
export function getEnvStatus(): EnvVarStatus[] {
  return DEFINITIONS.map((definition) => ({
    ...definition,
    configured: SET(definition.name),
    detail: definition.secret
      ? (SET(definition.name) ? "value hidden" : "not set")
      : (SET(definition.name) ? (process.env[definition.name] ?? "").slice(0, 90) : "not set"),
  } as EnvVarStatus));
}

export function missingRequiredEnv(): string[] {
  return DEFINITIONS.filter((d) => d.required && !SET(d.name)).map((d) => d.name);
}
