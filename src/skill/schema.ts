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
