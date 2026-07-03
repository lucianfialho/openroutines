/**
 * Task Source Schema
 *
 * Zod validation for task-sources.yaml (registered source instances) and
 * connector.yaml (per-type source manifest). See src/task-source/types.ts
 * for the canonical TaskState/TaskType enums these schemas key off of.
 */

import { z } from "zod";
import { TASK_STATES, TASK_TYPES } from "./types.js";

// --- task-sources.yaml -----------------------------------------------------

export const TaskSourceEntrySchema = z.object({
  id: z.string().min(1, "Task source id is required"),
  type: z.string().min(1, "Task source type is required"),
  manifest: z.string().min(1, "Manifest path must not be empty").optional(),
  pollIntervalMinutes: z.number().positive("pollIntervalMinutes must be a positive number").default(30),
  containers: z.record(z.string()).default({}),
  auth: z.record(z.string()).default({}),
});

export const TaskSourcesFileSchema = z.object({
  sources: z.array(TaskSourceEntrySchema).default([]),
});

export type TaskSourceEntry = z.infer<typeof TaskSourceEntrySchema>;
export type TaskSourcesFile = z.infer<typeof TaskSourcesFileSchema>;

// --- connector.yaml ----------------------------------------------------------

export const AuthSchemeSchema = z.discriminatedUnion("scheme", [
  z.object({ scheme: z.literal("bearer") }),
  z.object({
    scheme: z.literal("header"),
    header: z.string().min(1, 'header is required when auth.scheme is "header"'),
  }),
  z.object({
    scheme: z.literal("query"),
    params: z
      .record(z.string())
      .refine((params) => Object.keys(params).length > 0, {
        message: 'params must not be empty when auth.scheme is "query"',
      }),
  }),
  z.object({ scheme: z.literal("basic") }),
]);
export type AuthScheme = z.infer<typeof AuthSchemeSchema>;

export const OperationSpecSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1, "Operation path is required"),
  query: z.record(z.unknown()).optional(),
  body: z.record(z.unknown()).optional(),
});
export type OperationSpec = z.infer<typeof OperationSpecSchema>;

const ContainerSchema = z.object({
  kind: z.string().min(1, "container.kind is required"),
  flag: z
    .object({
      kind: z.enum(["label", "field"]),
      name: z.string().min(1),
    })
    .optional(),
});

const ClassificationSchema = z.object({
  type: z.record(z.enum(TASK_TYPES), z.string().min(1)).default({}),
  complexity: z.object({ field: z.string().min(1) }).optional(),
  priority: z.object({ field: z.string().min(1) }).optional(),
});

export const ConnectorManifestSchema = z.object({
  name: z.string().min(1, "Connector name is required"),
  transport: z.enum(["rest", "graphql"]),
  baseUrl: z.string().min(1).optional(),
  auth: AuthSchemeSchema,
  container: ContainerSchema.optional(),
  fields: z.record(z.string()).default({}),
  state: z.record(z.enum(TASK_STATES), z.string().min(1)).default({}),
  classification: ClassificationSchema.optional(),
  operations: z.record(OperationSpecSchema).default({}),
  capabilities: z.array(z.string()).default([]),
});
export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;
