/**
 * Routine Schema
 *
 * Zod validation for routine YAML definitions.
 */

import { z } from "zod";

/** Basic cron validation: 5 fields (minute hour day month weekday) */
const cronRegex = /^([\d*,/-]+)\s+([\d*,/-]+)\s+([\d*,/-]+)\s+([\d*,/-]+)\s+([\d*,/-]+)$/;

export const TriggerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("schedule"),
    cron: z
      .string()
      .regex(cronRegex, "Invalid cron expression (expected 5 fields)"),
  }),
  z.object({
    type: z.literal("github"),
    events: z.array(z.string()).min(1, "GitHub trigger must have at least one event"),
  }),
  z.object({
    type: z.literal("api"),
  }),
]);

export const ConnectorSchema = z.object({
  name: z.string().min(1, "Connector name is required"),
  source: z.string().min(1, "Connector source is required"),
});

export const RoutineSchema = z.object({
  id: z.string().min(1, "Routine id is required"),
  triggers: z
    .array(TriggerSchema)
    .min(1, "Routine must have at least one trigger"),
  pipeline: z.object({
    skill: z.string().min(1, "Pipeline skill is required"),
  }),
  environment: z
    .object({
      network: z
        .object({
          mode: z.enum(["trusted", "isolated"]),
        })
        .optional(),
      vars: z.record(z.string()).optional(),
    })
    .optional(),
  connectors: z.array(ConnectorSchema).optional(),
  gates: z.array(z.enum(["manual_approval", "security_review", "test_pass"])).optional(),
});

export type RoutineInput = z.infer<typeof RoutineSchema>;
