/**
 * Skill Types
 *
 * A skill is a workflow unit (Markdown prose or YAML state machine).
 */

import type { SkillStateMachine } from "./schema.js";

export interface MarkdownSkill {
  format: "markdown";
  name: string;
  content: string;
  source: string;
}

export interface StateMachineSkill {
  format: "state-machine";
  name: string;
  stateMachine: SkillStateMachine;
  source: string;
}

export type Skill = MarkdownSkill | StateMachineSkill;
