/**
 * Kimi Agent Provider
 *
 * Uses the official Kimi Agent SDK to connect to the locally-authenticated
 * Kimi Code CLI. No platform API key required — reuses the user's Kimi
 * Code OAuth session.
 *
 * The SDK handles tool calling, approvals, and execution internally.
 * Our engine receives the final text output.
 */

import { Effect } from "effect";
import { createSession } from "@moonshot-ai/kimi-agent-sdk";
import type { CompletionRequest, CompletionResponse } from "./types.js";

export interface KimiAgentConfig {
  env?: Record<string, string>;
  workDir: string;
  model?: string;
  thinking?: boolean;
}

export const makeKimiAgentProvider = (config: KimiAgentConfig) => {
  const model = config.model ?? "kimi-latest";

  const complete = (
    request: CompletionRequest
  ): Effect.Effect<CompletionResponse, Error> =>
    Effect.tryPromise({
      try: async () => {
        const session = createSession({
          env: config.env,
          workDir: config.workDir,
          model,
          thinking: config.thinking ?? false,
          yoloMode: true, // auto-approve all tool calls
        });

        const promptText =
          request.messages && request.messages.length > 0
            ? request.messages
                .map((m) => {
                  if (m.role === "tool") {
                    return `[tool result: ${m.content}]`;
                  }
                  if (m.role === "assistant" && m.toolCalls) {
                    return `[assistant requested tools: ${m.toolCalls.map((tc) => tc.name).join(", ")}]`;
                  }
                  return `${m.role}: ${m.content}`;
                })
                .join("\n\n")
            : request.prompt ?? "";

        const turn = session.prompt(promptText);
        let fullText = "";

        for await (const event of turn) {
          if (
            event.type === "ContentPart" &&
            event.payload.type === "text"
          ) {
            fullText += event.payload.text;
          }
        }

        await session.close();

        return {
          content: fullText,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model,
          finishReason: "stop",
        };
      },
      catch: (err) =>
        err instanceof Error ? err : new Error(String(err)),
    });

  return { complete };
};
