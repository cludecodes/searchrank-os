import { z } from "zod";

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AICompletionRequest {
  messages: AIMessage[];
  temperature?: number;
  maxTokens?: number;
  model?: string;
}

export interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface AICompletion {
  text: string;
  model: string;
  provider: string;
  usage?: AIUsage;
}

export interface AIProvider {
  readonly name: string;
  complete(request: AICompletionRequest): Promise<AICompletion>;
}

export class AIProviderNotConfiguredError extends Error {
  constructor() {
    super(
      "No AI provider is configured. Set AI_PROVIDER to 'openai-compatible' or " +
        "'anthropic' and supply AI_API_KEY. The platform will not fabricate " +
        "AI output when no provider is available.",
    );
    this.name = "AIProviderNotConfiguredError";
  }
}

type FetchLike = typeof globalThis.fetch;

interface OpenAICompatibleOptions {
  name?: string;
  baseURL: string;
  apiKey: string;
  model: string;
  defaultMaxTokens?: number;
  fetch?: FetchLike;
}

/** Works with OpenAI, OpenRouter, and any OpenAI-compatible gateway such as
 *  the Neon AI Gateway by changing only the base URL. */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name: string;
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly defaultMaxTokens: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.name ?? "openai-compatible";
    this.baseURL = options.baseURL.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.defaultMaxTokens = options.defaultMaxTokens ?? 4096;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async complete(request: AICompletionRequest): Promise<AICompletion> {
    const response = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: request.model ?? this.model,
        messages: request.messages,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? this.defaultMaxTokens,
      }),
    });
    if (!response.ok) {
      throw new Error(`AI provider ${this.name} returned HTTP ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = payload.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error(`AI provider ${this.name} returned no text content.`);
    return {
      text,
      model: payload.model ?? request.model ?? this.model,
      provider: this.name,
      usage: {
        inputTokens: payload.usage?.prompt_tokens,
        outputTokens: payload.usage?.completion_tokens,
      },
    };
  }
}

interface AnthropicOptions {
  baseURL?: string;
  apiKey: string;
  model: string;
  defaultMaxTokens?: number;
  fetch?: FetchLike;
}

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly defaultMaxTokens: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: AnthropicOptions) {
    this.baseURL = (options.baseURL ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.defaultMaxTokens = options.defaultMaxTokens ?? 4096;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async complete(request: AICompletionRequest): Promise<AICompletion> {
    const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    const response = await this.fetchImpl(`${this.baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: request.model ?? this.model,
        system: system || undefined,
        messages,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? this.defaultMaxTokens,
      }),
    });
    if (!response.ok) {
      throw new Error(`AI provider anthropic returned HTTP ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = payload.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    if (!text) throw new Error("AI provider anthropic returned no text content.");
    return {
      text,
      model: payload.model ?? request.model ?? this.model,
      provider: this.name,
      usage: {
        inputTokens: payload.usage?.input_tokens,
        outputTokens: payload.usage?.output_tokens,
      },
    };
  }
}

let cachedProvider: AIProvider | null = null;

/** Builds the configured provider. Returns a provider that throws a clear
 *  "not configured" error when no credentials are present. */
export function getAIProvider(): AIProvider {
  if (cachedProvider) return cachedProvider;
  const kind = (process.env.AI_PROVIDER || "none").toLowerCase();
  const apiKey = process.env.AI_API_KEY || "";
  const model = process.env.AI_MODEL || "gpt-4o-mini";

  if (kind === "openai-compatible" && apiKey) {
    cachedProvider = new OpenAICompatibleProvider({
      baseURL: process.env.AI_BASE_URL || "https://api.openai.com/v1",
      apiKey,
      model,
    });
  } else if (kind === "anthropic" && apiKey) {
    cachedProvider = new AnthropicProvider({ apiKey, model });
  } else if (kind === "pollinations") {
    // Free, keyless, open-weight GPT-OSS 20B via Pollinations' OpenAI-compatible API.
    cachedProvider = new OpenAICompatibleProvider({
      name: "pollinations-gpt-oss-20b",
      baseURL: process.env.AI_BASE_URL || "https://text.pollinations.ai/openai",
      apiKey: "",
      model: model === "gpt-4o-mini" ? "openai-fast" : model,
    });
  } else {
    cachedProvider = {
      name: "none",
      async complete() {
        throw new AIProviderNotConfiguredError();
      },
    };
  }
  return cachedProvider;
}

export function resetAIProviderCache(): void {
  cachedProvider = null;
}

/** Extracts JSON from a model response, tolerating Markdown code fences. */
export function parseModelJSON(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  return JSON.parse(cleaned);
}

/** Complete a request and validate the parsed JSON against a Zod schema. */
export async function generateStructured<T extends z.ZodTypeAny>(
  provider: AIProvider,
  schema: T,
  request: AICompletionRequest,
): Promise<{ data: z.infer<T>; completion: AICompletion }> {
  const completion = await provider.complete({
    ...request,
    messages: [
      ...request.messages,
      {
        role: "system",
        content: "Respond with a single valid JSON object and nothing else. No Markdown, no commentary.",
      },
    ],
  });
  const parsed = schema.parse(parseModelJSON(completion.text));
  return { data: parsed, completion };
}
