export interface CronTrigger {
  type: "schedule";
  cron: string;
}

export interface GitHubTrigger {
  type: "github";
  events: string[];
}

export type Trigger = CronTrigger | GitHubTrigger;
