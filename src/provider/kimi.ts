/**
 * Kimi K2.6 Provider Adapter
 *
 * MVP provider. Uses Moonshot OpenAI-compatible API.
 */

import { Effect } from "effect";

export interface KimiConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
}

export const makeKimiProvider = (config: KimiConfig) => {
  const model = config.model ?? "kimi-k2-6";
  const baseURL = config.baseURL ?? "https://api.moonshot.cn/v1";

  return {
    complete: (prompt: string) =>
      Effect.gen(function* () {
        yield* Effect.log(`[Kimi] Sending prompt (${prompt.length} chars)`);
        // TODO: implement actual API call using openai SDK
        yield* Effect.sleep("500 millis");
        return `[Kimi ${model}] TODO: implement completion`;
      }),
  };
};
