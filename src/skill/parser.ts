/**
 * Skill State Machine Parser
 *
 * Parse skill YAML definitions into typed SkillStateMachine objects.
 */

import { parse } from "yaml";
import { SkillStateMachineSchema } from "./schema.js";
import type { SkillStateMachine } from "./schema.js";

export class SkillParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillParseError";
  }
}

export const parseSkillStateMachine = (yamlContent: string): SkillStateMachine => {
  const raw = parse(yamlContent) as unknown;

  if (!raw || typeof raw !== "object") {
    throw new SkillParseError("Skill YAML must be an object");
  }

  const result = SkillStateMachineSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new SkillParseError(`Invalid skill state machine: ${issues}`);
  }

  return result.data;
};
