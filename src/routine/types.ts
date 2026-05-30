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
