/**
 * Skill State Machine Schema
 *
 * Zod validation for YAML state-machine skill definitions.
 * Compatible with atomic-gates skill format.
 */

import { z } from "zod";

export const SkillInputSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "integer", "number", "boolean", "array", "object"]),
  required: z.boolean().optional(),
  description: z.string().optional(),
});

export const SkillTransitionSchema = z.object({
  to: z.string(),
  when: z.string().optional(),
  /** Generic per-edge retry cap, counted by the runner (replaces hardcoded loop counters). */
  max_retries: z.number().int().min(0).optional(),
});

/** One parallel reviewer inside a `type: fanout` state (F1: adversarial multi-lens review). */
export const SkillLensSchema = z.object({
  name: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  agent_prompt: z.string(),
  output_schema: z.string().optional(),
});

export const SkillStateSchema = z.object({
  description: z.string().optional(),
  agent_prompt: z.string().optional(),
  output_schema: z.string().optional(),
  output_path: z.string().optional(),
  tools: z.array(z.string()).optional(),
  gate: z.enum(["manual_approval", "security_review", "test_pass"]).optional(),
  transitions: z.array(SkillTransitionSchema).optional(),
  terminal: z.boolean().optional(),
  delegate_to: z.string().optional(),
  delegate_inputs: z.record(z.string()).optional(),
  /** Named provider from the registry for this state (absent → default provider). */
  provider: z.string().optional(),
  /** Model override passed to the resolved provider. */
  model: z.string().optional(),
  /** State kind. Absent → "agent" (LLM tool-loop, current behavior). */
  type: z.enum(["agent", "script", "fanout"]).optional(),
  /** Built-in auto-action to run instead of an LLM loop (dispatched by value, not state name). */
  auto_action: z.enum(["commit_and_push", "create_pr"]).optional(),
  /** Script handler name for `type: script` (absent → the stateId). */
  script: z.string().optional(),
  /** Parallel reviewer lenses for `type: fanout`. */
  lenses: z.array(SkillLensSchema).optional(),
  /** Timeout for `type: script` handlers (default 300000ms). */
  timeout_ms: z.number().int().positive().optional(),
});

export const SkillStateMachineSchema = z.object({
  id: z.string(),
  version: z.number().default(1),
  description: z.string().optional(),
  inputs: z
    .object({
      required: z.array(SkillInputSchema).optional(),
      optional: z.array(SkillInputSchema).optional(),
    })
    .optional(),
  initial_state: z.string(),
  states: z.record(z.string(), SkillStateSchema),
});

export type SkillStateMachineInput = z.infer<typeof SkillInputSchema>;
export type SkillStateMachineTransition = z.infer<typeof SkillTransitionSchema>;
export type SkillStateMachineState = z.infer<typeof SkillStateSchema>;
export type SkillStateMachine = z.infer<typeof SkillStateMachineSchema>;
