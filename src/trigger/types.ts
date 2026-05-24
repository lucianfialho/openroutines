import { Schema } from "@effect/schema";

export const CronTrigger = Schema.Struct({
  type: Schema.Literal("schedule"),
  cron: Schema.String,
});

export const GitHubTrigger = Schema.Struct({
  type: Schema.Literal("github"),
  events: Schema.Array(Schema.String),
});

export const Trigger = Schema.Union(CronTrigger, GitHubTrigger);

export type Trigger = typeof Trigger.Type;
