import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parsePolicy, loadPolicy, validateProposedChange, BOUNDS, PolicyError } from "./policy.js";

const VALID_YAML = `
version: 1
night:
  max_prs_per_night: 5
  circuit_breaker_failure_rate: 0.6
  max_opus_calls_per_night: 12
  budget_usd: 30
day:
  max_auto_proposed_cards_per_week: 3
backpressure:
  max_open_prs_per_repo: 3
`;

describe("parsePolicy", () => {
  it("returns the typed object for a valid policy.yaml (AC1)", () => {
    const policy = parsePolicy(VALID_YAML);
    expect(policy).toEqual({
      version: 1,
      night: { max_prs_per_night: 5, circuit_breaker_failure_rate: 0.6, max_opus_calls_per_night: 12, budget_usd: 30 },
      day: { max_auto_proposed_cards_per_week: 3 },
      backpressure: { max_open_prs_per_repo: 3 },
    });
  });

  it("throws when a value falls outside its compiled bound (AC1: 12 outside 1-8)", () => {
    const yaml = VALID_YAML.replace("max_prs_per_night: 5", "max_prs_per_night: 12");
    expect(() => parsePolicy(yaml)).toThrow(PolicyError);
    expect(() => parsePolicy(yaml)).toThrow(/max_prs_per_night=12.*outside/);
  });

  it("throws when night.budget_usd falls outside its compiled bound (F5 #168: was the hardcoded NIGHT_BUDGET_USD default)", () => {
    const yaml = VALID_YAML.replace("budget_usd: 30", "budget_usd: 200");
    expect(() => parsePolicy(yaml)).toThrow(/budget_usd=200.*outside/);
  });

  it("throws on a schema violation instead of applying anything silently (missing key)", () => {
    const yaml = VALID_YAML.replace("  max_prs_per_night: 5\n", "");
    expect(() => parsePolicy(yaml)).toThrow(PolicyError);
  });

  it("wraps malformed YAML syntax in PolicyError too — callers only ever need to catch one error type", () => {
    expect(() => parsePolicy("night:\n  max_prs_per_night: 5\n bad_indent: 1")).toThrow(PolicyError);
  });

  it("rejects a safety-sounding key nested under an existing section (min_confidence), never silently ignores it (AC3)", () => {
    const yaml = VALID_YAML.replace("max_prs_per_night: 5", "max_prs_per_night: 5\n  min_confidence: 8");
    expect(() => parsePolicy(yaml)).toThrow(PolicyError);
  });

  it("rejects an unknown top-level section (e.g. a 'security' block), never silently ignores it (AC3)", () => {
    const yaml = `${VALID_YAML}\nsecurity:\n  min_confidence: 8\n`;
    expect(() => parsePolicy(yaml)).toThrow(PolicyError);
  });

  it("rejects a wrong version instead of guessing a migration", () => {
    const yaml = VALID_YAML.replace("version: 1", "version: 2");
    expect(() => parsePolicy(yaml)).toThrow(PolicyError);
  });
});

describe("loadPolicy", () => {
  it("reads and validates a real file on disk (AC2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-test-"));
    const path = join(dir, "policy.yaml");
    writeFileSync(path, VALID_YAML);
    expect(loadPolicy(path).night.max_prs_per_night).toBe(5);
  });

  it("fails loud (propagates ENOENT) instead of falling back to a hardcoded default when the file is absent (AC2)", () => {
    expect(() => loadPolicy(join(tmpdir(), `policy-does-not-exist-${Date.now()}.yaml`))).toThrow();
  });

  it("the committed root policy.yaml is itself valid", () => {
    const policy = loadPolicy(join(process.cwd(), "policy.yaml"));
    expect(policy.version).toBe(1);
    expect(policy.backpressure.max_open_prs_per_repo).toBeGreaterThan(0);
  });
});

describe("validateProposedChange (D27 calibration loop integration)", () => {
  it("accepts a proposal that stays within bound (5 -> 7, AC4)", () => {
    expect(validateProposedChange("night.max_prs_per_night", 7)).toEqual({ ok: true });
  });

  it("rejects a proposal outside bound (5 -> 9, AC4) instead of letting it become a diff", () => {
    const result = validateProposedChange("night.max_prs_per_night", 9);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/outside/);
  });

  it("rejects a path BOUNDS doesn't declare — the calibration loop can only move known knobs", () => {
    const result = validateProposedChange("night.min_confidence", 5);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unknown policy path/);
  });

  it("every schema field has a compiled bound (no knob escapes the ceiling check)", () => {
    for (const path of [
      "night.max_prs_per_night",
      "night.circuit_breaker_failure_rate",
      "night.max_opus_calls_per_night",
      "night.budget_usd",
      "day.max_auto_proposed_cards_per_week",
      "backpressure.max_open_prs_per_repo",
    ]) {
      expect(BOUNDS[path]).toBeDefined();
    }
  });
});
