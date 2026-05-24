/**
 * Routine Parser
 *
 * Parse routine YAML definitions into typed Routine objects.
 * Uses Zod for strict validation.
 */

import { parse } from "yaml";
import { RoutineSchema } from "./schema.js";
import type { Routine } from "./types.js";

export class RoutineParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineParseError";
  }
}

export const parseRoutine = (yamlContent: string): Routine => {
  const raw = parse(yamlContent) as unknown;

  if (!raw || typeof raw !== "object") {
    throw new RoutineParseError("Routine YAML must be an object");
  }

  const result = RoutineSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new RoutineParseError(`Invalid routine: ${issues}`);
  }

  return result.data as Routine;
};
