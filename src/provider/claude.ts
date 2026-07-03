/**
 * Claude Provider Adapter
 *
 * Talks directly to the Anthropic Messages API (billed by API key).
 * Used for judge/architecture roles where billing must be traceable to the
 * API key rather than a CLI subscription. Mirrors kimi-coding.ts, with two
 * differences: `system` is sent as the native top-level Messages API field
 * (not synthesized into a user message), and 429/529 get exponential
 * backoff with jitter.
 */

import { Data, Effect, Schedule } from "effect";
import type {
  CompletionRequest,
  CompletionResponse,
  Message,
  TokenUsage,
} from "./types.js";
import type { ToolDefinition, ToolCall } from "../tool/types.js";

export interface ClaudeConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  timeoutMs?: number;
  retries?: number;
}

export class ClaudeError extends Data.TaggedError("ClaudeError")<{
  message: string;
  status?: number;
  cause?: unknown;
}> {}

const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_BASE_URL = "https://api.anthropic.com";

/** Convert a thrown fetch/HTTP error into ClaudeError, preserving status if present. */
const mapError = (err: unknown): ClaudeError => {
  const status =
    err && typeof err === "object" && typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : undefined;
  return new ClaudeError({
    message: err instanceof Error ? err.message : String(err),
    status,
    cause: err,
  });
};

/** Only 429 (rate limit) and 529 (overloaded) are transient — safe to retry. */
const isRetryable = (err: ClaudeError): boolean =>
  err.status === 429 || err.status === 529;

/** Exponential backoff with jitter, capped at `retries` attempts after the initial call. */
const makeRetryOptions = (retries: number) => ({
  schedule: Schedule.exponential("300 millis").pipe(
    Schedule.jittered,
    Schedule.both(Schedule.recurs(retries))
  ),
  while: isRetryable,
});

/** Convert our Message[] to Anthropic message format (no system synthesis — system is native). */
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

export const makeClaudeProvider = (config: ClaudeConfig) => {
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new Error("ClaudeConfig.apiKey is required");
  }

  const baseURL = config.baseURL ?? DEFAULT_BASE_URL;
  const model = config.model ?? DEFAULT_MODEL;
  const timeoutMs = config.timeoutMs ?? 300_000;
  const retryOptions = makeRetryOptions(config.retries ?? 5);

  const buildMessages = (
    request: CompletionRequest
  ): { system?: string; messages: Array<{ role: string; content: string }> } => {
    if (request.messages && request.messages.length > 0) {
      // Hoist any role:"system" message into the native top-level `system` field.
      // The runner (executeLLMStep) emits the system prompt AS a message, but the
      // Anthropic /v1/messages API rejects role:"system" inside the messages array
      // (it must be the top-level `system` field) — forwarding it would be a 400.
      const systemFromMessages = request.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .filter((c) => c && c.length > 0)
        .join("\n\n");
      const messages = toAnthropicMessages(request.messages.filter((m) => m.role !== "system"));
      return {
        system: systemFromMessages.length > 0 ? systemFromMessages : undefined,
        messages: messages.length > 0 ? messages : [{ role: "user", content: request.prompt ?? "" }],
      };
    }
    return { messages: [{ role: "user", content: request.prompt ?? "" }] };
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
  ): Effect.Effect<CompletionResponse, ClaudeError> =>
    Effect.gen(function* () {
      const inputDesc = request.prompt
        ? `${request.prompt.length} chars`
        : `${request.messages?.length ?? 0} messages`;
      yield* Effect.log(`[Claude] Anthropic completion (${inputDesc})`);

      const { system: systemFromMessages, messages } = buildMessages(request);
      const hasTools = request.tools && request.tools.length > 0;

      const body: Record<string, unknown> = {
        model,
        messages,
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.2,
      };

      // `system` is native on the Messages API — top-level field, not a
      // synthesized user message (unlike kimi-coding's buildMessages). Accept it
      // from either the explicit request.system field or a hoisted role:"system"
      // message (the shape the runner's executeLLMStep emits).
      const systemField = [request.system, systemFromMessages].filter((s) => s && s.length > 0).join("\n\n");
      if (systemField.length > 0) {
        body.system = systemField;
      }

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
                const err = new Error(
                  `HTTP ${res.status}: ${(data.error as Record<string, string> | undefined)?.message ?? JSON.stringify(data)}`
                ) as Error & { status?: number };
                err.status = res.status;
                throw err;
              }
              return data;
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Request timeout")), timeoutMs)
            ),
          ]),
        catch: mapError,
      }).pipe(Effect.retry(retryOptions))) as Record<string, unknown>;

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

      yield* Effect.log(`[Claude] Completed. Tokens: ${usage.totalTokens}`);

      return {
        content: textParts,
        usage,
        model: (response.model as string) ?? model,
        finishReason: (response.stop_reason as string) ?? "stop",
        toolCalls: extractToolCalls(content),
        // No $/token price table yet (known gap) — leave cost unset rather
        // than guess; a future issue wires up per-model pricing.
        costUsd: undefined,
        // Each retry is a fresh call; no provider session to resume from.
        sessionId: undefined,
      };
    });

  return { complete };
};
