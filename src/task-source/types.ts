/**
 * Task Source Types
 *
 * TaskSource is the Effect-based contract any backlog system (Trello now,
 * Linear/GitHub Projects/Jira later) implements to feed the OpenRoutines
 * night-run cycle (decision D33). Poller, persistence and the engine talk to
 * this interface only — never to a source's REST API directly.
 *
 * Leaf module: no imports from src/connector, src/routine or src/persistence.
 */

import { Effect } from "effect";

export const TASK_STATES = ["backlog", "queued", "working", "blocked", "review", "done"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_TYPES = ["implementation", "research", "mapping", "update"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_COMPLEXITIES = ["lowest", "low", "medium", "high", "highest", "not_sure"] as const;
export type TaskComplexity = (typeof TASK_COMPLEXITIES)[number];

export const TASK_SOURCE_METHODS = [
  "listQueue",
  "getTask",
  "comment",
  "attachArtifact",
  "moveTo",
  "setClassification",
  "watchNew",
] as const;
export type TaskSourceMethodName = (typeof TASK_SOURCE_METHODS)[number];

export interface Task {
  sourceId: string; // configured source instance id (task-sources.yaml, e.g. "trello-main")
  id: string; // opaque native id from the source (e.g. Trello card id) — never parsed by callers
  title: string;
  body: string; // markdown
  url: string;
  state: TaskState;
  type: TaskType;
  complexity?: TaskComplexity;
  priority?: string;
  labels: string[];
  assignees: string[];
  createdAt: Date;
  updatedAt: Date;
  raw?: unknown; // original source payload, debug/escape-hatch only
}

export interface TaskArtifact {
  filename: string;
  content: string; // text (markdown/plain) — binary attachments are out of scope
  mimeType?: string;
}

export interface TaskClassification {
  type?: TaskType;
  complexity?: TaskComplexity;
  priority?: string;
}

export class TaskSourceError extends Error {
  constructor(
    message: string,
    readonly operation?: TaskSourceMethodName | "auth",
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "TaskSourceError";
  }
}

export interface TaskSource {
  listQueue(state: TaskState): Effect.Effect<Task[], TaskSourceError>;
  getTask(id: string): Effect.Effect<Task, TaskSourceError>;
  comment(id: string, body: string): Effect.Effect<void, TaskSourceError>;
  attachArtifact(id: string, artifact: TaskArtifact): Effect.Effect<void, TaskSourceError>;
  moveTo(id: string, state: TaskState): Effect.Effect<void, TaskSourceError>;
  setClassification(id: string, classification: TaskClassification): Effect.Effect<void, TaskSourceError>;
  // Pull, not a real stream: takes the last persisted cursor (or null on the
  // first call), returns tasks new/changed since then plus the next cursor
  // to persist. Called periodically by the poller.
  watchNew(cursor: string | null): Effect.Effect<{ tasks: Task[]; cursor: string }, TaskSourceError>;
}
