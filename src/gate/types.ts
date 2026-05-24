/**
 * Gate Types
 *
 * Quality gates enforce human-in-the-loop approval before
 * critical actions (e.g., creating a PR).
 */

export type GateStatus = "pending" | "approved" | "rejected";

export interface Gate {
  id: string;
  executionId: string;
  type: "manual_approval" | "security_review" | "test_pass";
  status: GateStatus;
  reason?: string;
  createdAt: Date;
  resolvedAt?: Date;
}

export interface GateRepository {
  save: (gate: Gate) => Promise<void>;
  findByExecution: (executionId: string) => Promise<Gate | undefined>;
  resolve: (gateId: string, status: GateStatus, reason?: string) => Promise<void>;
}
