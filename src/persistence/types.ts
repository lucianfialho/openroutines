/**
 * Persistence Types
 *
 * Abstraction for execution state storage.
 */

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
  metadata?: Record<string, unknown>;
  startedAt: Date;
  finishedAt?: Date;
}

export interface ExecutionRepository {
  save: (record: ExecutionRecord) => Promise<void>;
  findById: (id: string) => Promise<ExecutionRecord | undefined>;
  findByRoutine: (routineId: string) => Promise<ExecutionRecord[]>;
  findAll: (opts?: { limit?: number; offset?: number }) => Promise<ExecutionRecord[]>;
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
