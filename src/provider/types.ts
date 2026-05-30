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
}

export interface CompletionResponse {
  content: string;
  usage: TokenUsage;
  model: string;
  finishReason: string;
  toolCalls?: ToolCall[];
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
