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

import { Effect, Schedule, pipe } from "effect";
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
}

export class KimiError {
  readonly _tag = "KimiError";
  constructor(
    readonly message: string,
    readonly status?: number,
    readonly cause?: unknown
  ) {}
}

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
    return new KimiError(
      err instanceof Error ? err.message : String(err),
      (err as { status: number }).status,
      err
    );
  }
  if (err instanceof Error) {
    return new KimiError(err.message, undefined, err);
  }
  return new KimiError(String(err), undefined, err);
};

/** Check if the error is a rate-limit (429). */
const isRateLimit = (err: KimiError): boolean => err.status === 429;

/** Retry policy: exponential backoff, max 3 attempts, starting at 1s. */
const retryPolicy = pipe(
  Schedule.exponential("1 second"),
  Schedule.compose(Schedule.recurs(3)),
  Schedule.whileInput<KimiError>((err) => isRateLimit(err))
);

export const makeKimiProvider = (config: KimiConfig) => {
  const client = makeClient(config);
  const model = config.model ?? DEFAULT_MODEL;

  const complete = (request: CompletionRequest): Effect.Effect<CompletionResponse, KimiError> =>
    Effect.gen(function* () {
      yield* Effect.log(`[Kimi] Non-streaming completion (${request.prompt.length} chars)`);

      const response = yield* Effect.tryPromise({
        try: () =>
          client.chat.completions.create({
            model,
            messages: [
              ...(request.system ? [{ role: "system" as const, content: request.system }] : []),
              { role: "user" as const, content: request.prompt },
            ],
            temperature: request.temperature ?? 0.2,
            max_tokens: request.maxTokens ?? 4096,
          }),
        catch: mapError,
      }).pipe(Effect.retry(retryPolicy));

      const choice = response.choices[0];
      if (!choice) {
        return yield* Effect.fail(new KimiError("No completion choice returned"));
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
