/**
 * Output Extractor
 *
 * Extract structured output from LLM responses.
 * Supports JSON (preferred) and YAML. The agent either writes to a file
 * path or returns inline.
 */

import { readFileSync } from "fs";
import { parse } from "yaml";

export class OutputExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputExtractError";
  }
}

export const extractOutput = (content: string, outputPath?: string): unknown => {
  // If output_path was specified, try reading from disk first
  if (outputPath) {
    try {
      const fileContent = readFileSync(outputPath, "utf-8");
      return parseJsonOrYaml(fileContent);
    } catch {
      // File doesn't exist or isn't valid, fall through to inline extraction
    }
  }

  // Try extracting inline from markdown code blocks
  const jsonBlockMatch = content.match(/```(?:json)?\n([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1]);
    } catch {
      // Fall through
    }
  }

  const yamlBlockMatch = content.match(/```(?:yaml|yml)?\n([\s\S]*?)```/);
  if (yamlBlockMatch) {
    const parsed = parseJsonOrYaml(yamlBlockMatch[1]);
    if (parsed !== undefined) return parsed;
  }

  // Try parsing the entire content as JSON first, then YAML
  const parsed = parseJsonOrYaml(content);
  if (parsed !== undefined) return parsed;

  // Return raw content as string fallback
  return content;
};

const parseJsonOrYaml = (text: string): unknown | undefined => {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  // Try JSON first (more robust for agent output)
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to YAML
  }

  // Try YAML
  try {
    return parse(trimmed);
  } catch {
    return undefined;
  }
};
