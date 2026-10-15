import { z } from "zod";
import { GENERATION_JSON_SCHEMA } from "./schema";
import { heuristicGenerate } from "./heuristic";
import type { GenerationContext, PromptMessages } from "./prompt";

/**
 * LLM providers. The provider is chosen with LLM_PROVIDER; credentials come only from
 * environment secrets (LLM_API_KEY), are never logged and never leave this module.
 *
 *   LLM_PROVIDER=openai-compatible  LLM_BASE_URL, LLM_MODEL, LLM_API_KEY
 *                                    (OpenAI, Azure OpenAI, OpenRouter, Ollama, vLLM, LM Studio…)
 *   LLM_PROVIDER=heuristic           built-in rule-based generator, no external calls (default)
 */

export type ProviderResult = { raw: unknown; provider: string; model: string; usage?: Record<string, number> };

export interface GenerationProvider {
  readonly name: string;
  readonly model: string;
  generate(prompt: PromptMessages, context: GenerationContext): Promise<ProviderResult>;
}

/** Failures worth retrying (rate limits, timeouts, 5xx) vs. permanent ones. */
export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

const envSchema = z.object({
  LLM_PROVIDER: z.enum(["openai-compatible", "heuristic"]).default("heuristic"),
  LLM_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  LLM_MODEL: z.string().min(1).optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(64_000).default(8_000),
});

export class OpenAICompatibleProvider implements GenerationProvider {
  readonly name = "openai-compatible";
  constructor(
    private readonly config: { baseUrl: string; model: string; apiKey?: string; timeoutMs: number; maxTokens: number },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get model() {
    return this.config.model;
  }

  async generate(prompt: PromptMessages): Promise<ProviderResult> {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0.2,
          max_tokens: this.config.maxTokens,
          response_format: { type: "json_schema", json_schema: { name: "test_cases", strict: false, schema: GENERATION_JSON_SCHEMA } },
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      const timeout = error instanceof Error && error.name === "TimeoutError";
      throw new ProviderError(timeout ? "The LLM request timed out" : "Could not reach the LLM provider", true);
    }

    if (!response.ok) {
      // Never echo the response body: it may contain the request or account details.
      const retryable = response.status === 429 || response.status >= 500;
      throw new ProviderError(`The LLM provider returned HTTP ${response.status}`, retryable);
    }

    const body = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
      usage?: Record<string, number>;
    } | null;
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new ProviderError("The LLM response had no content", false);
    if (body?.choices?.[0]?.finish_reason === "length") throw new ProviderError("The LLM response was truncated (max tokens reached)", false);

    let raw: unknown;
    try {
      raw = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {
      throw new ProviderError("The LLM did not return valid JSON", false);
    }
    return { raw, provider: this.name, model: this.config.model, usage: body?.usage };
  }
}

export class HeuristicProvider implements GenerationProvider {
  readonly name = "heuristic";
  readonly model = "rules-v1";
  async generate(_prompt: PromptMessages, context: GenerationContext): Promise<ProviderResult> {
    return { raw: { cases: heuristicGenerate(context) }, provider: this.name, model: this.model };
  }
}

/** Provider from environment configuration. */
export function providerFromEnv(env: Record<string, string | undefined> = process.env): GenerationProvider {
  const config = envSchema.parse(env);
  if (config.LLM_PROVIDER === "heuristic") return new HeuristicProvider();
  if (!config.LLM_BASE_URL || !config.LLM_MODEL) {
    throw new ProviderError("LLM_PROVIDER=openai-compatible needs LLM_BASE_URL and LLM_MODEL (and usually LLM_API_KEY)", false);
  }
  return new OpenAICompatibleProvider({
    baseUrl: config.LLM_BASE_URL,
    model: config.LLM_MODEL,
    apiKey: config.LLM_API_KEY,
    timeoutMs: config.LLM_TIMEOUT_MS,
    maxTokens: config.LLM_MAX_OUTPUT_TOKENS,
  });
}
