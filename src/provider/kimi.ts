/**
 * Kimi K2.6 Provider Adapter
 *
 * MVP provider. Uses Moonshot OpenAI-compatible API.
 *
 * Features:
 * - Authenticate with KIMI_API_KEY
 * - Support streaming and non-streaming completions
 * - Handle rate limits (429) with exponential backoff retry
 * - Track token usage per execution
 */

import { Data, Effect, Schedule } from "effect";
import OpenAI from "openai";
import type {
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  TokenUsage,
} from "./types.js";

export interface KimiConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  timeoutMs?: number;
  retries?: number;
}

export class KimiError extends Data.TaggedError("KimiError")<{
  message: string;
  status?: number;
  cause?: unknown;
}> {}

const DEFAULT_MODEL = "kimi-k2-6";
const DEFAULT_BASE_URL = "https://api.moonshot.cn/v1";

/** Build an OpenAI client configured for Moonshot API. */
const makeClient = (config: KimiConfig): OpenAI =>
  new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
  });

/** Convert an OpenAI API error into our KimiError. */
const mapError = (err: unknown): KimiError => {
  if (
    err &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status?: number }).status === "number"
  ) {
    return new KimiError({
      message: err instanceof Error ? err.message : String(err),
      status: (err as { status: number }).status,
      cause: err,
    });
  }
  if (err instanceof Error) {
    return new KimiError({ message: err.message, cause: err });
  }
  return new KimiError({ message: String(err) });
};

/** Check if the error is a rate-limit (429). */
const isRateLimit = (err: KimiError): boolean => err.status === 429;

/** Build retry policy from config. */
const makeRetryPolicy = (retries: number) =>
  Schedule.compose(
    Schedule.exponential("1 second"),
    Schedule.recurs(retries)
  ).pipe(Schedule.whileInput<KimiError>((err) => isRateLimit(err)));

export const makeKimiProvider = (config: KimiConfig) => {
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new Error("KimiConfig.apiKey is required");
  }

  const client = makeClient(config);
  const model = config.model ?? DEFAULT_MODEL;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const retries = config.retries ?? 3;
  const retryPolicy = makeRetryPolicy(retries);

  const complete = (request: CompletionRequest): Effect.Effect<CompletionResponse, KimiError> =>
    Effect.gen(function* () {
      yield* Effect.log(`[Kimi] Non-streaming completion (${request.prompt.length} chars)`);

      const response = yield* Effect.tryPromise({
        try: () =>
          Promise.race([
            client.chat.completions.create({
              model,
              messages: [
                ...(request.system ? [{ role: "system" as const, content: request.system }] : []),
                { role: "user" as const, content: request.prompt },
              ],
              temperature: request.temperature ?? 0.2,
              max_tokens: request.maxTokens ?? 4096,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Request timeout")), timeoutMs)
            ),
          ]),
        catch: mapError,
      }).pipe(Effect.retry(retryPolicy));

      const choice = response.choices[0];
      if (!choice) {
        yield* Effect.logError(`[Kimi] No completion choice returned. Response: ${JSON.stringify(response)}`);
        return yield* Effect.fail(new KimiError({ message: "No completion choice returned" }));
      }

      if (choice.finish_reason === "length") {
        yield* Effect.logWarning(`[Kimi] Completion truncated due to max_tokens limit`);
      }

      const usage: TokenUsage = {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      };

      yield* Effect.log(
        `[Kimi] Completed. Tokens: ${usage.totalTokens} (${usage.promptTokens} prompt, ${usage.completionTokens} completion)`
      );

      return {
        content: choice.message.content ?? "",
        usage,
        model: response.model,
        finishReason: choice.finish_reason ?? "stop",
      };
    });

  const completeStream = (
    request: CompletionRequest
  ): Effect.Effect<AsyncIterable<StreamChunk>, KimiError> =>
    Effect.gen(function* () {
      yield* Effect.log(`[Kimi] Streaming completion (${request.prompt.length} chars)`);

      const stream = yield* Effect.tryPromise({
        try: () =>
          Promise.race([
            client.chat.completions.create({
              model,
              messages: [
                ...(request.system ? [{ role: "system" as const, content: request.system }] : []),
                { role: "user" as const, content: request.prompt },
              ],
              temperature: request.temperature ?? 0.2,
              max_tokens: request.maxTokens ?? 4096,
              stream: true,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Request timeout")), timeoutMs)
            ),
          ]),
        catch: mapError,
      }).pipe(Effect.retry(retryPolicy));

      const iterator: AsyncIterable<StreamChunk> = {
        async *[Symbol.asyncIterator]() {
          let totalPromptTokens = 0;
          let totalCompletionTokens = 0;

          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content ?? "";
            const finishReason = chunk.choices[0]?.finish_reason ?? undefined;

            // Usage info sometimes comes in the last chunk
            if (chunk.usage) {
              totalPromptTokens = chunk.usage.prompt_tokens;
              totalCompletionTokens = chunk.usage.completion_tokens;
            } else if (delta.length > 0) {
              // Fallback: estimate completion tokens from content length
              totalCompletionTokens += Math.ceil(delta.length / 4);
            }

            yield {
              content: delta,
              usage:
                finishReason
                  ? {
                      promptTokens: totalPromptTokens,
                      completionTokens: totalCompletionTokens,
                      totalTokens: totalPromptTokens + totalCompletionTokens,
                    }
                  : undefined,
              finishReason: finishReason ?? undefined,
            };
          }
        },
      };

      return iterator;
    });

  return { complete, completeStream };
};
