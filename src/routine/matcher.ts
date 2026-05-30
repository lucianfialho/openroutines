/**
 * Routine Matcher
 *
 * Given a trigger event, find all routines that should fire.
 */

import type { Routine, TriggerDef } from "./types.js";

export interface TriggerEvent {
  type: string;
  payload: unknown;
  routineId?: string;
  executionId?: string;
}

export const matchesTrigger = (
  triggerDef: TriggerDef,
  event: TriggerEvent
): boolean => {
  if (triggerDef.type !== event.type) return false;

  if (triggerDef.type === "github" && triggerDef.events) {
    const payload = event.payload as { event?: string } | undefined;
    const eventName = payload?.event;
    // If the trigger specifies events, require a matching event name.
    // If no event name is provided in the payload, this trigger does NOT match.
    if (!eventName) return false;
    return triggerDef.events.includes(eventName);
  }

  return true;
};

export const findMatchingRoutines = (
  routines: Routine[],
  event: TriggerEvent
): Routine[] => {
  return routines.filter((routine) =>
    routine.triggers.some((trigger) => matchesTrigger(trigger, event))
  );
};

/** Resolve a single routine from a trigger event, or fail if ambiguous/missing. */
export const resolveRoutine = (
  routines: Routine[],
  event: TriggerEvent
): { matched: Routine } | { error: "none" | "ambiguous"; count: number } => {
  // When routineId is explicitly provided (manual trigger), force that routine
  // without requiring the trigger payload to match perfectly.
  if (event.routineId) {
    const forced = routines.find((r) => r.id === event.routineId);
    if (forced) {
      return { matched: forced };
    }
    return { error: "none", count: 0 };
  }
  const matches = findMatchingRoutines(routines, event);
  if (matches.length === 0) {
    return { error: "none", count: 0 };
  }
  if (matches.length > 1) {
    return { error: "ambiguous", count: matches.length };
  }
  return { matched: matches[0] };
};
