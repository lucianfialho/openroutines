/**
 * Routine Types
 *
 * A routine is a declared configuration: triggers + pipeline + environment.
 */

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
  type: "schedule" | "github" | "api";
  cron?: string;
  events?: string[];
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
