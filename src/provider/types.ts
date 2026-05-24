/**
 * Provider Types
 *
 * Shared types for LLM provider adapters.
 */

export interface CompletionRequest {
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface CompletionResponse {
  content: string;
  usage: TokenUsage;
  model: string;
  finishReason: string;
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
