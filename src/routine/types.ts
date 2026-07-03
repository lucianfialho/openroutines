/**
 * Routine Types
 *
 * A routine is a declared configuration: triggers + pipeline + environment.
 */

import type { TaskState } from "../task-source/types.js";

export interface Routine {
  id: string;
  triggers: Array<TriggerDef>;
  pipeline: Pipeline;
  environment?: Environment;
  // NOTE: `connectors` and `gates` are only honored for format:"markdown" skills
  // (the generic ReAct loop in engine.ts). State-machine skills return early from
  // engine.execute() before these are read and declare gates per-state instead
  // (skill.yaml `gate:`). Editing them on a state-machine routine has no runtime
  // effect — they document human intent only.
  connectors?: Array<ConnectorRef>;
  gates?: Array<"manual_approval" | "security_review" | "test_pass">;
}

export interface TriggerDef {
  type: "schedule" | "github" | "api" | "task_source";
  cron?: string;
  events?: string[];
  /** task_source: configured source instance id (task-sources.yaml). Required for that type. */
  sourceId?: string;
  /** task_source: state filter. Default "queued" is applied by TriggerSchema, not read by the matcher. */
  state?: TaskState;
  /** task_source: task must carry all of these labels to match. */
  labels?: string[];
}

export interface Pipeline {
  skill: string;
}

export interface Environment {
  network?: { mode: "trusted" | "isolated" };
  vars?: Record<string, string>;
}

export interface ConnectorRef {
  name: string;
  source: string;
}
