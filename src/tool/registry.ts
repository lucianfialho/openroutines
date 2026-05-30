/**
 * Tool Registry
 *
 * Holds tool definitions and their handlers.
 * The engine uses this to resolve tool calls from the LLM.
 */

import type { Tool, ToolDefinition, ToolHandler } from "./types.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  registerMany(tools: Tool[]): void {
    for (const t of tools) this.register(t);
  }

  getDefinition(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  getHandler(name: string): ToolHandler | undefined {
    return this.tools.get(name)?.handler;
  }

  listDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}
