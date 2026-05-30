/**
 * Tool Types
 *
 * Abstraction for LLM-callable tools (function calling).
 * Maps to OpenAI's tool format, consumed by the provider.
 */

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, ToolParameter>;
  items?: ToolParameter;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  output: string;
  error?: string;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

export interface Tool {
  definition: ToolDefinition;
  handler: ToolHandler;
}
