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
  status: "pending" | "running" | "completed" | "failed";
  output?: string;
  error?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  startedAt: Date;
  finishedAt?: Date;
}

export interface ExecutionRepository {
  save: (record: ExecutionRecord) => Promise<void>;
  findById: (id: string) => Promise<ExecutionRecord | undefined>;
  findByRoutine: (routineId: string) => Promise<ExecutionRecord[]>;
}
