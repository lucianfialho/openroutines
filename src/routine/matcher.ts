/**
 * Routine Matcher
 *
 * Given a trigger event, find all routines that should fire.
 */

import type { Routine, TriggerDef } from "./types.js";

export interface TriggerEvent {
  type: string;
  payload: unknown;
}

export const matchesTrigger = (
  triggerDef: TriggerDef,
  event: TriggerEvent
): boolean => {
  if (triggerDef.type !== event.type) return false;

  if (triggerDef.type === "github" && triggerDef.events) {
    const payload = event.payload as { event?: string } | undefined;
    const eventName = payload?.event;
    if (!eventName) return true; // match all GitHub events if no specific filter
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
