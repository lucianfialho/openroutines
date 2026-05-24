/**
 * Routine Parser
 *
 * Parse routine YAML definitions into typed Routine objects.
 */

import { parse } from "yaml";
import type { Routine, TriggerDef } from "./types.js";

export class RoutineParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineParseError";
  }
}

export const parseRoutine = (yamlContent: string): Routine => {
  const raw = parse(yamlContent) as unknown;

  if (!raw || typeof raw !== "object") {
    throw new RoutineParseError("Routine YAML must be an object");
  }

  const obj = raw as Record<string, unknown>;

  if (!obj.id || typeof obj.id !== "string") {
    throw new RoutineParseError("Routine must have an 'id' string");
  }

  if (!Array.isArray(obj.triggers) || obj.triggers.length === 0) {
    throw new RoutineParseError("Routine must have at least one trigger");
  }

  const triggers: TriggerDef[] = obj.triggers.map((t: unknown, i: number) => {
    if (!t || typeof t !== "object") {
      throw new RoutineParseError(`Trigger ${i} must be an object`);
    }
    const trigger = t as Record<string, unknown>;
    if (!trigger.type || typeof trigger.type !== "string") {
      throw new RoutineParseError(`Trigger ${i} must have a 'type'`);
    }
    const type = trigger.type as TriggerDef["type"];
    if (type === "schedule") {
      if (!trigger.cron || typeof trigger.cron !== "string") {
        throw new RoutineParseError(`Schedule trigger ${i} must have 'cron'`);
      }
      return { type, cron: trigger.cron };
    }
    if (type === "github") {
      if (!Array.isArray(trigger.events)) {
        throw new RoutineParseError(`GitHub trigger ${i} must have 'events' array`);
      }
      return { type, events: trigger.events.map(String) };
    }
    if (type === "api") {
      return { type };
    }
    throw new RoutineParseError(`Unknown trigger type: ${type}`);
  });

  if (!obj.pipeline || typeof obj.pipeline !== "object") {
    throw new RoutineParseError("Routine must have a 'pipeline' object");
  }
  const pipeline = obj.pipeline as Record<string, unknown>;
  if (!pipeline.skill || typeof pipeline.skill !== "string") {
    throw new RoutineParseError("Pipeline must have a 'skill' string");
  }

  const routine: Routine = {
    id: obj.id,
    triggers,
    pipeline: { skill: pipeline.skill },
  };

  if (obj.environment && typeof obj.environment === "object") {
    routine.environment = obj.environment as Routine["environment"];
  }

  if (Array.isArray(obj.connectors)) {
    routine.connectors = obj.connectors.map((c: unknown, i: number) => {
      if (!c || typeof c !== "object") {
        throw new RoutineParseError(`Connector ${i} must be an object`);
      }
      const conn = c as Record<string, unknown>;
      if (!conn.name || typeof conn.name !== "string") {
        throw new RoutineParseError(`Connector ${i} must have 'name'`);
      }
      if (!conn.source || typeof conn.source !== "string") {
        throw new RoutineParseError(`Connector ${i} must have 'source'`);
      }
      return { name: conn.name, source: conn.source };
    });
  }

  return routine;
};
