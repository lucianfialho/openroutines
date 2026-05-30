/**
 * Kimi Coding Provider Adapter
 *
 * Uses Kimi Code's Anthropic-compatible API endpoint.
 * Required because Kimi Code keys are rejected by the OpenAI endpoint.
 */

import { Data, Effect } from "effect";
import type {
  CompletionRequest,
  CompletionResponse,
  Message,
  TokenUsage,
} from "./types.js";
import type { ToolDefinition, ToolCall } from "../tool/types.js";

export interface KimiCodingConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  timeoutMs?: number;
}

export class KimiCodingError extends Data.TaggedError("KimiCodingError")<{
  message: string;
  status?: number;
  cause?: unknown;
}> {}

const DEFAULT_MODEL = "kimi-coding/k2p5";
const DEFAULT_BASE_URL = "https://api.kimi.com/coding";

/** Convert our Message[] to Anthropic message format. */
const toAnthropicMessages = (
  messages: Message[]
): Array<{ role: string; content: string }> => {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "user", content: `[tool result: ${m.content}]` };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      // When using native Anthropic tools, assistant messages with tool_calls
      // should not include artificial "[tool calls: ...]" text — the API
      // handles tool_use blocks natively. Only include the assistant's text.
      return { role: "assistant", content: m.content || "" };
    }
    return { role: m.role, content: m.content };
  });
};

/** Convert Anthropic tool format to our ToolCall[]. */
const extractToolCalls = (
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>
): ToolCall[] | undefined => {
  const toolUseBlocks = content.filter((c) => c.type === "tool_use");
  if (toolUseBlocks.length === 0) return undefined;
  return toolUseBlocks.map((tc) => ({
    id: tc.id ?? `call_${Math.random().toString(36).slice(2)}`,
    name: tc.name ?? "unknown",
    arguments: tc.input ?? {},
  }));
};

export const makeKimiCodingProvider = (config: KimiCodingConfig) => {
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new Error("KimiCodingConfig.apiKey is required");
  }

  const baseURL = config.baseURL ?? DEFAULT_BASE_URL;
  const model = config.model ?? DEFAULT_MODEL;
  const timeoutMs = config.timeoutMs ?? 300_000;

  const buildMessages = (
    request: CompletionRequest
  ): Array<{ role: string; content: string }> => {
    if (request.messages && request.messages.length > 0) {
      return toAnthropicMessages(request.messages);
    }
    return [
      ...(request.system
        ? [{ role: "user", content: `System: ${request.system}` }]
        : []),
      { role: "user", content: request.prompt ?? "" },
    ];
  };

  const toAnthropicTools = (
    tools: ToolDefinition[]
  ): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> => {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  };

  const complete = (
    request: CompletionRequest
  ): Effect.Effect<CompletionResponse, KimiCodingError> =>
    Effect.gen(function* () {
      const inputDesc = request.prompt
        ? `${request.prompt.length} chars`
        : `${request.messages?.length ?? 0} messages`;
      yield* Effect.log(`[KimiCoding] Anthropic completion (${inputDesc})`);

      const messages = buildMessages(request);
      const hasTools = request.tools && request.tools.length > 0;

      const body: Record<string, unknown> = {
        model,
        messages,
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.2,
      };

      if (hasTools) {
        body.tools = toAnthropicTools(request.tools!);
      }

      const response = (yield* Effect.tryPromise({
        try: () =>
          Promise.race([
            fetch(`${baseURL}/v1/messages`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": config.apiKey,
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify(body),
            }).then(async (res) => {
              const data = (await res.json()) as Record<string, unknown>;
              if (!res.ok) {
                throw new Error(
                  `HTTP ${res.status}: ${(data.error as Record<string, string> | undefined)?.message ?? JSON.stringify(data)}`
                );
              }
              return data;
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Request timeout")), timeoutMs)
            ),
          ]),
        catch: (err) =>
          new KimiCodingError({
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          }),
      })) as Record<string, unknown>;

      const content = (response.content ?? []) as Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      const textParts = content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");

      const usageData = (response.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      const usage: TokenUsage = {
        promptTokens: usageData.input_tokens ?? 0,
        completionTokens: usageData.output_tokens ?? 0,
        totalTokens: (usageData.input_tokens ?? 0) + (usageData.output_tokens ?? 0),
      };

      yield* Effect.log(
        `[KimiCoding] Completed. Tokens: ${usage.totalTokens}`
      );

      return {
        content: textParts,
        usage,
        model: (response.model as string) ?? model,
        finishReason: (response.stop_reason as string) ?? "stop",
        toolCalls: extractToolCalls(content),
      };
    });

  return { complete };
};
