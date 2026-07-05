/**
 * Provider Registry
 *
 * Resolves LLM providers by name (and optional model) so a single pipeline can
 * use Kimi on triage, claude-cli on implementation, and claude-api on judging.
 * Replaces the boot-time binary provider selection. Instances are cached by
 * `${name}:${model}` and built lazily; an unknown name or a missing credential
 * fails fast at resolve time rather than silently falling back.
 */

import { Effect } from "effect";
import type { CompletionRequest, CompletionResponse } from "./types.js";
import { makeKimiCliProvider, type KimiCliConfig } from "./kimi-cli.js";
import { makeClaudeCliProvider, type ClaudeCliConfig } from "./claude-cli.js";
import { makeClaudeProvider } from "./claude.js";
import { makeSecurityJudgeProvider } from "./security-judge.js";
import { makeArchitectureJudgeProvider } from "./architecture-judge.js";

export type ProviderName = "kimi-cli" | "claude-cli" | "claude-api" | "security-judge" | "architecture-judge";

export interface ProviderAdapter {
  complete: (request: CompletionRequest) => Effect.Effect<CompletionResponse, Error>;
}

export interface ProviderRegistryConfig {
  kimiCli?: KimiCliConfig;
  claudeCli?: ClaudeCliConfig;
  claudeApi?: { apiKey: string; baseURL?: string };
}

export interface ProviderRegistry {
  resolve: (name: ProviderName, model?: string) => ProviderAdapter;
}

const withModel = <T extends { model?: string }>(base: T | undefined, model: string | undefined): T =>
  ({ ...(base ?? ({} as T)), ...(model !== undefined ? { model } : {}) });

/**
 * Per-model inner adapter for the composite judges (security/architecture).
 * CLI-first (Bloco 2): a judge is the SAME headless `claude` the pipeline
 * already runs, just a different prompt — no API key required. `--model` is
 * explicit and no fallback model is ever set, so a weaker model can't silently
 * answer a security/architecture verdict. The billed claude-api is OPT-IN
 * (ANTHROPIC_API_KEY): it restores the real `resp.model` anti-bypass check for
 * anyone who wants it, but is never required.
 */
const judgeInnerFactory = (config: ProviderRegistryConfig) =>
  (c: { apiKey?: string; baseURL?: string; model: string }): ProviderAdapter =>
    config.claudeApi?.apiKey
      ? makeClaudeProvider({ apiKey: config.claudeApi.apiKey, baseURL: config.claudeApi.baseURL, model: c.model })
      : makeClaudeCliProvider({ ...config.claudeCli, model: c.model, fallbackModel: undefined });

const buildProvider = (
  name: ProviderName,
  model: string | undefined,
  config: ProviderRegistryConfig
): ProviderAdapter => {
  switch (name) {
    case "kimi-cli":
      return makeKimiCliProvider(withModel(config.kimiCli, model));
    case "claude-cli":
      return makeClaudeCliProvider(withModel(config.claudeCli, model));
    case "claude-api": {
      if (!config.claudeApi?.apiKey) {
        throw new Error(
          'Provider "claude-api" requested but no apiKey configured (set ANTHROPIC_API_KEY)'
        );
      }
      return makeClaudeProvider({ ...config.claudeApi, ...(model !== undefined ? { model } : {}) });
    }
    case "security-judge": {
      // Composite judge (F4 #154) — CLI-first (Bloco 2), API opt-in. Opus is
      // the apex judge (round-1 findings + round-2 per-finding verification).
      return makeSecurityJudgeProvider({
        makeInnerProvider: judgeInnerFactory(config),
        ...(model !== undefined ? { model } : {}),
      });
    }
    case "architecture-judge": {
      // Composite judge (F4 #185) — CLI-first (Bloco 2), API opt-in. Opus is
      // the apex; it judges the plan and its verdict is final (no escalation).
      return makeArchitectureJudgeProvider({
        makeInnerProvider: judgeInnerFactory(config),
        ...(model !== undefined ? { model } : {}),
      });
    }
    default:
      throw new Error(`Unknown provider: ${name as string}`);
  }
};

export const makeProviderRegistry = (config: ProviderRegistryConfig): ProviderRegistry => {
  const cache = new Map<string, ProviderAdapter>();
  const resolve: ProviderRegistry["resolve"] = (name, model) => {
    const key = `${name}:${model ?? "default"}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const built = buildProvider(name, model, config);
    cache.set(key, built);
    return built;
  };
  return { resolve };
};
