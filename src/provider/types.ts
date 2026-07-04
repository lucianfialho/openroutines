/**
 * Provider Types
 *
 * Shared types for LLM provider adapters.
 */

import type { ToolDefinition, ToolCall } from "../tool/types.js";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface CompletionRequest {
  prompt?: string;
  messages?: Message[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  /** Worktree path handed to the CLI executor via --add-dir (F1: coarse states). */
  workdir?: string;
  /** JSON schema constraining the structured output of a coarse state. */
  jsonSchema?: Record<string, unknown> | string;
  /** Reserved API-billing ceiling for the billed claude-api provider; not yet enforced (CLI/subscription providers ignore it). */
  maxBudgetUsd?: number;
  /** Execution owning this call — used to track spawned processes (F1). */
  executionId?: string;
  /**
   * Per-request CLI tool allowlist (F4 #153: lens least privilege, e.g.
   * [Read, Grep, Glob]). Overrides the provider config's allowedTools for this
   * call; providers without native tool gating ignore it.
   */
  allowedTools?: string[];
  /**
   * Image blocks for a vision call (F5 #160: the visual phase escalates a
   * low-confidence assertion to Sonnet vision with the screenshot). Appended to
   * the final user turn as base64 image content by the claude provider;
   * text-only providers ignore it.
   */
  images?: Array<{ base64: string; mediaType: string }>;
}

export interface CompletionResponse {
  content: string;
  usage: TokenUsage;
  model: string;
  finishReason: string;
  toolCalls?: ToolCall[];
  /** Real USD cost reported by the provider (claude-cli via total_cost_usd); undefined when unknown. */
  costUsd?: number;
  /** Provider session id for audit trail; never used for --resume (each retry is fresh). */
  sessionId?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StreamChunk {
  content: string;
  usage?: TokenUsage;
  finishReason?: string;
}
