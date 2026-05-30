/**
 * Output Extractor
 *
 * Extract structured YAML output from LLM responses.
 * The agent either writes to a file path or returns inline.
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
      return parse(fileContent);
    } catch {
      // File doesn't exist or isn't valid YAML, fall through to inline extraction
    }
  }

  // Try extracting inline YAML from markdown code blocks
  const yamlBlockMatch = content.match(/```(?:yaml|yml)?\n([\s\S]*?)```/);
  if (yamlBlockMatch) {
    try {
      return parse(yamlBlockMatch[1]);
    } catch {
      // Fall through to return raw text
      return yamlBlockMatch[1];
    }
  }

  // Try parsing the entire content as YAML
  try {
    return parse(content);
  } catch {
    // Return raw content as string fallback
    return content;
  }
};
