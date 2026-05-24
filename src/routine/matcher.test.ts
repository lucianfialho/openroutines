import { describe, it, expect } from "vitest";
import { matchesTrigger, findMatchingRoutines, resolveRoutine } from "./matcher.js";
import type { Routine, TriggerEvent } from "./types.js";

const makeRoutine = (id: string, triggers: Routine["triggers"]): Routine => ({
  id,
  triggers,
  pipeline: { skill: "echo" },
});

describe("matchesTrigger", () => {
  it("should match api trigger", () => {
    expect(matchesTrigger({ type: "api" }, { type: "api", payload: {} })).toBe(true);
  });

  it("should not match different types", () => {
    expect(matchesTrigger({ type: "github" }, { type: "api", payload: {} })).toBe(false);
  });

  it("should match github trigger with specific event", () => {
    expect(
      matchesTrigger(
        { type: "github", events: ["pull_request.opened"] },
        { type: "github", payload: { event: "pull_request.opened" } }
      )
    ).toBe(true);
  });

  it("should not match github trigger with wrong event", () => {
    expect(
      matchesTrigger(
        { type: "github", events: ["pull_request.opened"] },
        { type: "github", payload: { event: "issues.opened" } }
      )
    ).toBe(false);
  });

  it("should match github trigger when no event filter in payload", () => {
    expect(
      matchesTrigger(
        { type: "github", events: ["pull_request.opened"] },
        { type: "github", payload: {} }
      )
    ).toBe(true);
  });
});

describe("findMatchingRoutines", () => {
  const routines: Routine[] = [
    makeRoutine("r1", [{ type: "api" }]),
    makeRoutine("r2", [{ type: "github", events: ["pull_request.opened"] }]),
    makeRoutine("r3", [{ type: "schedule", cron: "0 9 * * *" }]),
  ];

  it("should find routine matching api trigger", () => {
    const event: TriggerEvent = { type: "api", payload: {} };
    const matches = findMatchingRoutines(routines, event);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe("r1");
  });

  it("should find routine matching github event", () => {
    const event: TriggerEvent = { type: "github", payload: { event: "pull_request.opened" } };
    const matches = findMatchingRoutines(routines, event);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe("r2");
  });

  it("should return empty array when no match", () => {
    const event: TriggerEvent = { type: "webhook", payload: {} };
    const matches = findMatchingRoutines(routines, event);
    expect(matches).toHaveLength(0);
  });
});

describe("resolveRoutine", () => {
  const routines: Routine[] = [
    makeRoutine("r1", [{ type: "api" }]),
    makeRoutine("r2", [{ type: "github", events: ["pull_request.opened"] }]),
  ];

  it("should return matched routine when single match", () => {
    const event: TriggerEvent = { type: "api", payload: {} };
    const result = resolveRoutine(routines, event);
    expect("matched" in result).toBe(true);
    if ("matched" in result) {
      expect(result.matched.id).toBe("r1");
    }
  });

  it("should return error none when no match", () => {
    const event: TriggerEvent = { type: "webhook", payload: {} };
    const result = resolveRoutine(routines, event);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("none");
    }
  });

  it("should return error ambiguous when multiple match", () => {
    const event: TriggerEvent = { type: "api", payload: {} };
    const result = resolveRoutine([...routines, makeRoutine("r3", [{ type: "api" }])], event);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("ambiguous");
      expect(result.count).toBe(2);
    }
  });
});
