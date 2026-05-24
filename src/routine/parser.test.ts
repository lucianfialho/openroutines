import { describe, it, expect } from "vitest";
import { parseRoutine, RoutineParseError } from "./parser.js";

describe("parseRoutine", () => {
  it("should parse a valid routine YAML", () => {
    const yaml = `
id: daily-pr-review
triggers:
  - type: schedule
    cron: "0 9 * * 1-5"
  - type: github
    events: [pull_request.opened]
pipeline:
  skill: solve-issue
environment:
  network: { mode: trusted }
connectors:
  - name: github
    source: .gates/connectors/github/connector.yaml
`;
    const routine = parseRoutine(yaml);
    expect(routine.id).toBe("daily-pr-review");
    expect(routine.triggers).toHaveLength(2);
    expect(routine.triggers[0]).toEqual({ type: "schedule", cron: "0 9 * * 1-5" });
    expect(routine.triggers[1]).toEqual({ type: "github", events: ["pull_request.opened"] });
    expect(routine.pipeline.skill).toBe("solve-issue");
    expect(routine.environment).toEqual({ network: { mode: "trusted" } });
    expect(routine.connectors).toHaveLength(1);
    expect(routine.connectors?.[0]).toEqual({ name: "github", source: ".gates/connectors/github/connector.yaml" });
  });

  it("should parse minimal routine", () => {
    const yaml = `
id: simple
triggers:
  - type: api
pipeline:
  skill: echo
`;
    const routine = parseRoutine(yaml);
    expect(routine.id).toBe("simple");
    expect(routine.triggers).toEqual([{ type: "api" }]);
    expect(routine.pipeline.skill).toBe("echo");
    expect(routine.environment).toBeUndefined();
    expect(routine.connectors).toBeUndefined();
  });

  it("should reject missing id", () => {
    expect(() => parseRoutine("triggers:\n  - type: api\npipeline:\n  skill: echo")).toThrow(RoutineParseError);
  });

  it("should reject missing triggers", () => {
    expect(() => parseRoutine("id: test\npipeline:\n  skill: echo")).toThrow(RoutineParseError);
  });

  it("should reject empty triggers", () => {
    expect(() => parseRoutine("id: test\ntriggers: []\npipeline:\n  skill: echo")).toThrow(RoutineParseError);
  });

  it("should reject missing pipeline", () => {
    expect(() => parseRoutine("id: test\ntriggers:\n  - type: api")).toThrow(RoutineParseError);
  });

  it("should reject missing skill in pipeline", () => {
    expect(() => parseRoutine("id: test\ntriggers:\n  - type: api\npipeline:\n  other: value")).toThrow(RoutineParseError);
  });

  it("should reject schedule trigger without cron", () => {
    expect(() => parseRoutine("id: test\ntriggers:\n  - type: schedule\npipeline:\n  skill: echo")).toThrow(RoutineParseError);
  });

  it("should reject github trigger without events", () => {
    expect(() => parseRoutine("id: test\ntriggers:\n  - type: github\npipeline:\n  skill: echo")).toThrow(RoutineParseError);
  });

  it("should reject unknown trigger type", () => {
    expect(() => parseRoutine("id: test\ntriggers:\n  - type: webhook\npipeline:\n  skill: echo")).toThrow(RoutineParseError);
  });

  it("should reject connector without name", () => {
    const yaml = `
id: test
triggers:
  - type: api
pipeline:
  skill: echo
connectors:
  - source: foo.yaml
`;
    expect(() => parseRoutine(yaml)).toThrow(RoutineParseError);
  });
});
