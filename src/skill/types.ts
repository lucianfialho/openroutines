/**
 * Skill Types
 *
 * A skill is a workflow unit (Markdown or YAML state machine).
 */

export interface Skill {
  name: string;
  content: string;
  source: string; // file path
}
