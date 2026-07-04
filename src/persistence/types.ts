/**
 * Persistence Types
 *
 * Abstraction for execution state storage.
 */

import type { Task } from "../task-source/types.js";

export interface ExecutionRecord {
  id: string;
  routineId: string;
  triggerType: string;
  skillName: string;
  status: "pending" | "running" | "completed" | "failed" | "paused";
  output?: string;
  error?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Total USD cost of the execution (sum of per-invocation costUsd). */
  costUsd?: number;
  /** Per-provider USD breakdown keyed by provider name (jsonb). */
  providerBreakdown?: Record<string, number>;
  metadata?: Record<string, unknown>;
  /** Originating task, composite key (never a bare card id) — undefined for schedule/github triggers (F2 #144). */
  sourceId?: string;
  taskId?: string;
  startedAt: Date;
  finishedAt?: Date;
}

export interface ExecutionRepository {
  save: (record: ExecutionRecord) => Promise<void>;
  findById: (id: string) => Promise<ExecutionRecord | undefined>;
  findByRoutine: (routineId: string) => Promise<ExecutionRecord[]>;
  findByTask: (sourceId: string, taskId: string) => Promise<ExecutionRecord[]>;
  /** `status` filter is additive — boot reconciliation uses it to find orphaned `running` executions (F3 #149). */
  findAll: (opts?: {
    limit?: number;
    offset?: number;
    status?: ExecutionRecord["status"];
  }) => Promise<ExecutionRecord[]>;
}

/** One logical external side effect of an execution, keyed by (executionId, actionKey) — the idempotency unit (F3 #149). */
export interface ActionLedgerEntry {
  id?: string;
  executionId: string;
  stateId: string;
  actionKey: string;
  status: "pending" | "done" | "failed";
  externalRef?: string;
  createdAt?: Date;
  completedAt?: Date;
}

export interface ActionLedgerRepository {
  findByKey: (executionId: string, actionKey: string) => Promise<ActionLedgerEntry | undefined>;
  recordPending: (executionId: string, stateId: string, actionKey: string) => Promise<void>;
  complete: (executionId: string, actionKey: string, externalRef?: string) => Promise<void>;
  fail: (executionId: string, actionKey: string, error: string) => Promise<void>;
}

/** card ↔ PR linkage, keyed to tasks by (sourceId, taskId) — F2 composite (F3 #146). */
export interface PrLink {
  id?: string;
  sourceId: string;
  taskId: string;
  repo: string;
  prNumber?: number;
  branch: string;
  status: string; // 'open' | 'merged' | 'closed' ...
  reviewState?: string;
  /** Completed rework rounds (F4 #157, D24); 2 => retrabalho-esgotado. */
  reworkCount?: number;
  /** Agent's HEAD after its last push — a human commit past it aborts rework (F4 #157). */
  lastAgentCommitSha?: string;
  /** Night that ran the last rework — max 1 rework/card/night (F4 #157). */
  lastReworkNightId?: string;
  /** Deterministic risk score, computed once at PR creation (F4 #158, D29). */
  riskScore?: number;
  /** 100%-safe PR eligible for the batch-merge block (F4 #158, D29). */
  greenLane?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Mutable pr_links columns — everything except the identity key (sourceId, taskId, branch). */
export type PrLinkPatch = Partial<
  Pick<PrLink, "prNumber" | "status" | "reviewState" | "reworkCount" | "lastAgentCommitSha" | "lastReworkNightId" | "riskScore" | "greenLane">
>;

export interface PrLinkRepository {
  create: (link: PrLink) => Promise<void>;
  findByTask: (sourceId: string, taskId: string) => Promise<PrLink[]>;
  /** Open PRs of a night, via executions(source_id, task_id, night_id) — the global PR-cap count (F3 #147). */
  countOpenForNight: (nightId: string) => Promise<number>;
  /** All links with status='open' — scanned by the PR-review poller (F4 #157). */
  findOpen: () => Promise<PrLink[]>;
  /** Patch a link identified by (sourceId, taskId, branch). No-op when the link doesn't exist. */
  update: (key: { sourceId: string; taskId: string; branch: string }, patch: PrLinkPatch) => Promise<void>;
  /** Links whose task executed under this night, ordered by risk_score DESC — morning-report (F4 #159). */
  findForNight: (nightId: string) => Promise<PrLink[]>;
}

/** Task snapshot persistence, keyed by composite (sourceId, taskId) — reuses Task from task-source (F2 #144). */
export interface TaskRepository {
  /** Upsert by (task.sourceId, task.id). */
  save: (task: Task) => Promise<void>;
  findByKey: (sourceId: string, taskId: string) => Promise<Task | undefined>;
  findBySource: (sourceId: string) => Promise<Task[]>;
}

export type SpanType = "llm_call" | "tool_call" | "gate_check" | "prompt_build" | "execution_start" | "execution_end";
export type SpanStatus = "started" | "completed" | "failed";

export interface ExecutionSpan {
  id?: string;
  executionId: string;
  parentId?: string;
  type: SpanType;
  name?: string;
  status: SpanStatus;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  model?: string;
  startedAt: Date;
  finishedAt?: Date;
}

export interface ExecutionFeedback {
  id?: string;
  executionId: string;
  rating?: number;
  tags?: string[];
  notes?: string;
  createdBy?: string;
  createdAt?: Date;
}

export interface SpanRepository {
  save: (span: ExecutionSpan) => Promise<void>;
  findByExecution: (executionId: string) => Promise<ExecutionSpan[]>;
  findById: (id: string) => Promise<ExecutionSpan | undefined>;
}

export interface FeedbackRepository {
  save: (feedback: ExecutionFeedback) => Promise<void>;
  findByExecution: (executionId: string) => Promise<ExecutionFeedback | undefined>;
  findAll: (opts?: { limit?: number; offset?: number }) => Promise<ExecutionFeedback[]>;
}

export interface RunState {
  id?: string;
  executionId: string;
  stateId: string;
  skillId: string;
  agentPrompt?: string;
  output?: Record<string, unknown>;
  outputValidated?: boolean;
  gateId?: string;
  status: "pending" | "running" | "completed" | "failed" | "paused";
  startedAt: Date;
  finishedAt?: Date;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Real USD cost of this single provider invocation (claude-cli); undefined for providers without cost. */
  costUsd?: number;
}

export interface SubRun {
  id?: string;
  parentExecutionId: string;
  parentStateId: string;
  childExecutionId: string;
  childSkillId: string;
  createdAt?: Date;
}

export interface RunStateRepository {
  save: (state: RunState) => Promise<void>;
  findByExecution: (executionId: string) => Promise<RunState[]>;
}

export interface SubRunRepository {
  save: (subRun: SubRun) => Promise<void>;
  findByParent: (parentExecutionId: string) => Promise<SubRun[]>;
  findByChild: (childExecutionId: string) => Promise<SubRun | undefined>;
}

export interface FileMetadata {
  id?: string;
  path: string;
  executionId?: string;
  issueNumber?: number;
  status: "stub" | "complete";
  summary?: string;
  changes?: Array<{ file: string; description: string }>;
  specialist?: string;
  decisions?: string[];
  alternativesRejected?: string[];
  verifiedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface FileMetadataRepository {
  save: (meta: FileMetadata) => Promise<void>;
  findByPath: (path: string) => Promise<FileMetadata | undefined>;
  findByExecution: (executionId: string) => Promise<FileMetadata[]>;
  findByIssue: (issueNumber: number) => Promise<FileMetadata[]>;
}

/** OS process spawned by a coarse-state executor — tracked so timeouts can kill the group and boot can reap zombies (F1). */
export interface ExecutionProcess {
  id?: string;
  executionId: string;
  pid: number;
  worktree?: string;
  startedAt?: Date;
  finishedAt?: Date;
}

export interface ExecutionProcessRepository {
  save: (proc: ExecutionProcess) => Promise<void>;
  markFinished: (id: string, finishedAt: Date) => Promise<void>;
  /** Rows with finished_at IS NULL — used by boot zombie cleanup. */
  findRunning: () => Promise<ExecutionProcess[]>;
}

/** Cursor + dedupe state for TaskSourcePoller, keyed per source (F2 #143). */
export interface PollStateRepository {
  getCursor: (sourceId: string) => Promise<string | undefined>;
  setCursor: (sourceId: string, cursor: string) => Promise<void>;
  /**
   * Atomically claims a (sourceId, taskId) as seen. Returns `true` if this
   * call is the one that recorded it (caller should enqueue), `false` if it
   * was already seen (caller skips). Single atomic operation — replaces a
   * check-then-act hasSeen/markSeen pair so overlapping poll ticks of the same
   * source can never both claim the same task and double-enqueue it.
   */
  claimUnseen: (sourceId: string, taskId: string) => Promise<boolean>;
}
