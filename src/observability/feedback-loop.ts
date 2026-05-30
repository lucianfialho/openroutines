/**
 * Feedback Loop — Phase 3
 *
 * Analyzes executions with negative feedback and generates
 * actionable skill improvement suggestions.
 *
 * When a user rates an execution poorly or tags it with
 * "false-positive", "needs-improvement", etc., the system
 * inspects the spans and produces concrete suggestions for
 * the skill markdown (add step, refine goal, add validation,
 * adjust gate, etc.).
 */

import { randomUUID } from "crypto";
import type { ExecutionRecord, ExecutionSpan } from "../persistence/types.js";

export type ImprovementType =
  | "add-step"
  | "refine-goal"
  | "add-validation"
  | "remove-gate"
  | "add-constraint"
  | "split-step";

export type Confidence = "high" | "medium" | "low";

export interface SkillImprovement {
  id: string;
  skillName: string;
  executionId: string;
  type: ImprovementType;
  description: string;
  suggestedContent: string;
  targetSection: string;
  confidence: Confidence;
  status: "pending" | "applied" | "dismissed";
  createdAt: string;
}

export interface ExecutionFeedback {
  rating?: number;
  tags?: string[];
  notes?: string;
}

/* ------------------------------------------------------------------ */
/*  In-memory store (same pattern as the rest of the codebase)        */
/* ------------------------------------------------------------------ */

const improvements: SkillImprovement[] = [];

export const listImprovements = (): SkillImprovement[] =>
  improvements.filter((i) => i.status === "pending");

export const getImprovement = (id: string): SkillImprovement | undefined =>
  improvements.find((i) => i.id === id);

export const applyImprovement = (id: string): SkillImprovement | undefined => {
  const imp = improvements.find((i) => i.id === id);
  if (imp) imp.status = "applied";
  return imp;
};

export const dismissImprovement = (id: string): SkillImprovement | undefined => {
  const imp = improvements.find((i) => i.id === id);
  if (imp) imp.status = "dismissed";
  return imp;
};

/* ------------------------------------------------------------------ */
/*  Analyzer                                                           */
/* ------------------------------------------------------------------ */

const NEGATIVE_TAGS = new Set([
  "false-positive",
  "needs-improvement",
  "wrong-output",
  "hallucination",
  "incomplete",
]);

function isNegativeFeedback(feedback: ExecutionFeedback): boolean {
  if (feedback.rating != null && feedback.rating <= 2) return true;
  if (feedback.tags?.some((t) => NEGATIVE_TAGS.has(t))) return true;
  return false;
}

function countToolCalls(spans: ExecutionSpan[], name: string): number {
  return spans.filter((s) => s.type === "tool_call" && s.name === name).length;
}

function countFailedToolCalls(spans: ExecutionSpan[]): number {
  return spans.filter((s) => s.type === "tool_call" && s.status === "failed").length;
}

function countLLMCalls(spans: ExecutionSpan[]): number {
  return spans.filter((s) => s.type === "llm_call").length;
}

function extractRepeatedTools(spans: ExecutionSpan[]): string[] {
  const counts = new Map<string, number>();
  for (const s of spans) {
    if (s.type === "tool_call" && s.name) {
      counts.set(s.name, (counts.get(s.name) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .filter(([, c]) => c > 1)
    .map(([name]) => name);
}

function avgLLMDurationMs(spans: ExecutionSpan[]): number {
  const llm = spans.filter((s) => s.type === "llm_call" && s.durationMs);
  if (!llm.length) return 0;
  return llm.reduce((sum, s) => sum + (s.durationMs || 0), 0) / llm.length;
}

function rejectedGates(spans: ExecutionSpan[]): string[] {
  return spans
    .filter(
      (s) =>
        s.type === "gate_check" &&
        s.output &&
        typeof s.output === "object" &&
        (s.output as Record<string, unknown>).approved === false
    )
    .map((s) => s.name)
    .filter((n): n is string => !!n);
}

function createSuggestion(
  executionId: string,
  skillName: string,
  type: ImprovementType,
  description: string,
  suggestedContent: string,
  targetSection: string,
  confidence: Confidence
): SkillImprovement {
  return {
    id: randomUUID(),
    skillName,
    executionId,
    type,
    description,
    suggestedContent,
    targetSection,
    confidence,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Main entry point: analyze a single execution + its feedback and
 * generate 0..N improvement suggestions.
 */
export function analyzeFeedback(
  execution: ExecutionRecord,
  spans: ExecutionSpan[],
  feedback: ExecutionFeedback
): SkillImprovement[] {
  if (!isNegativeFeedback(feedback)) return [];

  const suggestions: SkillImprovement[] = [];
  const skillName = execution.skillName;

  /* 1. Many iterations → LLM struggling, add more specific instruction */
  const llmCount = countLLMCalls(spans);
  if (llmCount > 3) {
    suggestions.push(
      createSuggestion(
        execution.id,
        skillName,
        "add-constraint",
        `The execution required ${llmCount} LLM iterations, indicating the skill instructions may be too vague or ambiguous.`,
        "- **Avoid loops**: After fetching data once, do not refetch the same resource. Use the data already in context.\n- **Decision rule**: If an issue is already CLOSED, stop and report immediately.",
        "Steps",
        "high"
      )
    );
  }

  /* 2. Repeated tool calls → add anti-redundancy rule */
  const repeated = extractRepeatedTools(spans);
  for (const toolName of repeated) {
    suggestions.push(
      createSuggestion(
        execution.id,
        skillName,
        "add-validation",
        `Tool '${toolName}' was called ${countToolCalls(spans, toolName)} times. The skill should cache or reuse results.`,
        `- **Cache rule**: After calling \`${toolName}\`, store the result and reuse it. Do not call the same tool with identical parameters twice.`,
        "Steps",
        "high"
      )
    );
  }

  /* 3. Failed tool calls → add error handling / validation */
  const failedTools = countFailedToolCalls(spans);
  if (failedTools > 0) {
    suggestions.push(
      createSuggestion(
        execution.id,
        skillName,
        "add-validation",
        `${failedTools} tool call(s) failed. The skill should validate inputs before calling tools.`,
        "- **Pre-validation**: Before calling any tool, verify all required parameters are present and valid.\n- **Error handling**: If a tool fails, log the error and decide whether to retry, skip, or abort.",
        "Steps",
        "high"
      )
    );
  }

  /* 4. Slow LLM calls → simplify instructions */
  const avgDur = avgLLMDurationMs(spans);
  if (avgDur > 5000) {
    suggestions.push(
      createSuggestion(
        execution.id,
        skillName,
        "split-step",
        `Average LLM call took ${(avgDur / 1000).toFixed(1)}s. Consider breaking the skill into smaller, focused steps.`,
        "Break this skill into two sub-skills:\n1. **Research** — fetch and analyze only.\n2. **Implement** — act on the research output.\nThis reduces context window and speeds up each call.",
        "Goal",
        "medium"
      )
    );
  }

  /* 5. Gate blocked frequently → suggest gate adjustment */
  const rejected = rejectedGates(spans);
  if (rejected.length > 0) {
    for (const gateName of rejected) {
      suggestions.push(
        createSuggestion(
          execution.id,
          skillName,
          "remove-gate",
          `Gate '${gateName}' blocked this execution. If this happens frequently, the gate criteria may be too strict for this skill.`,
            `- **Review gate '${gateName}'**: Consider making the criteria conditional or adding an override path for low-risk changes.`,
          "Quality Gates",
          "medium"
        )
      );
    }
  }

  /* 6. Low rating with notes mentioning "wrong" or "incorrect" */
  const notes = (feedback.notes || "").toLowerCase();
  if (notes.includes("wrong") || notes.includes("incorrect") || notes.includes("bad")) {
    suggestions.push(
      createSuggestion(
        execution.id,
        skillName,
        "refine-goal",
        "User reported the output was incorrect. The skill goal or constraints may need clarification.",
        "Clarify the expected output format and add explicit constraints: e.g., 'Always verify the issue state before acting' or 'If unsure, ask for clarification rather than guessing'.",
        "Goal",
        "medium"
      )
    );
  }

  /* 7. Tag: false-positive → add verification step */
  if (feedback.tags?.includes("false-positive")) {
    suggestions.push(
      createSuggestion(
        execution.id,
        skillName,
        "add-step",
        "Execution tagged as false-positive. Add a verification step before finalizing output.",
        "1. **Verify result** — Before returning the final answer, cross-check against the original request.\n2. **Self-critique** — Ask: 'Does this actually solve the stated problem?'",
        "Steps",
        "high"
      )
    );
  }

  /* 8. Tag: incomplete → add completion checklist */
  if (feedback.tags?.includes("incomplete")) {
    suggestions.push(
      createSuggestion(
        execution.id,
        skillName,
        "add-step",
        "Execution tagged as incomplete. Add a completion checklist to ensure nothing is missed.",
        "- **Completion checklist**: Before finishing, verify:\n  - [ ] All acceptance criteria from the issue are addressed\n  - [ ] Tests are written and passing\n  - [ ] No TODOs or placeholders remain",
        "Steps",
        "high"
      )
    );
  }

  /* Store suggestions */
  for (const s of suggestions) {
    improvements.push(s);
  }

  return suggestions;
}

/**
 * Batch analyze: look at all executions with negative feedback
 * and generate suggestions.
 */
export function generateAllImprovements(
  executions: ExecutionRecord[],
  allSpans: Map<string, ExecutionSpan[]>,
  allFeedback: Map<string, ExecutionFeedback>
): SkillImprovement[] {
  const generated: SkillImprovement[] = [];
  for (const ex of executions) {
    const feedback = allFeedback.get(ex.id);
    if (!feedback || !isNegativeFeedback(feedback)) continue;
    const spans = allSpans.get(ex.id) || [];
    const sugs = analyzeFeedback(ex, spans, feedback);
    generated.push(...sugs);
  }
  return generated;
}
