import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AIProviderNotConfiguredError,
  AnthropicProvider,
  OpenAICompatibleProvider,
  generateStructured,
  getAIProvider,
  parseModelJSON,
  resetAIProviderCache,
  type AICompletionRequest,
  type AIProvider,
} from "../src/core/ai/provider";

class EchoProvider implements AIProvider {
  readonly name = "echo";
  async complete(request: AICompletionRequest) {
    return { text: '{"ok":true,"count":3}', model: "echo-1", provider: this.name, usage: { inputTokens: 10 } };
  }
}

describe("AI provider abstraction", () => {
  beforeEach(() => {
    delete process.env.AI_PROVIDER;
    delete process.env.AI_API_KEY;
    resetAIProviderCache();
  });

  it("throws a clear error instead of fabricating output when unconfigured", async () => {
    expect(getAIProvider().name).toBe("none");
    await expect(getAIProvider().complete({ messages: [] })).rejects.toBeInstanceOf(AIProviderNotConfiguredError);
  });

  it("parses fenced and raw JSON and validates against a schema", async () => {
    expect(parseModelJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    const schema = z.object({ ok: z.boolean(), count: z.number() });
    const { data, completion } = await generateStructured(new EchoProvider(), schema, { messages: [] });
    expect(data).toEqual({ ok: true, count: 3 });
    expect(completion.provider).toBe("echo");
  });

  it("calls an OpenAI-compatible endpoint with the right shape", async () => {
    let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, headers: init.headers as Record<string, string>, body: init.body as string };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "hello" } }], model: "gpt-test", usage: { prompt_tokens: 4 } }),
      } as Response;
    }) as typeof globalThis.fetch;
    const provider = new OpenAICompatibleProvider({ baseURL: "https://api.example.com/v1", apiKey: "key", model: "gpt-test", fetch: fakeFetch });
    const result = await provider.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(result.text).toBe("hello");
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://api.example.com/v1/chat/completions");
    expect(captured!.headers.Authorization).toBe("Bearer key");
    expect(JSON.parse(captured!.body).model).toBe("gpt-test");
  });

  it("maps Anthropic message roles and system prompts", async () => {
    let body = "";
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = init.body as string;
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "anthropic answer" }], model: "claude-test" }),
      } as Response;
    }) as typeof globalThis.fetch;
    const provider = new AnthropicProvider({ apiKey: "key", model: "claude-test", fetch: fakeFetch });
    const result = await provider.complete({
      messages: [
        { role: "system", content: "Be brief" },
        { role: "user", content: "Hello" },
      ],
    });
    expect(result.text).toBe("anthropic answer");
    const parsed = JSON.parse(body);
    expect(parsed.system).toBe("Be brief");
    expect(parsed.messages).toEqual([{ role: "user", content: "Hello" }]);
  });
});
