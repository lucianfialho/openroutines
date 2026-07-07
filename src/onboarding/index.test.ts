import { describe, it, expect, vi } from "vitest";
import {
  needsOnboarding,
  buildTaskSourcesYaml,
  updateConnectorState,
  appendMissingEnv,
  maybeRunOnboarding,
  type OnboardingPaths,
} from "./index.js";

const paths: OnboardingPaths = { taskSources: "/ts.yaml", connector: "/c.yaml", env: "/.env" };
const TRELLO_YAML =
  "sources:\n  - type: trello\n    containers: { board: b1 }\n    auth: { key: TRELLO_API_KEY, token: TRELLO_API_TOKEN }\n";

describe("needsOnboarding", () => {
  it("needs it when task-sources.yaml is absent", () => {
    const r = needsOnboarding(paths, { fileExists: () => false });
    expect(r.needed).toBe(true);
    expect(r.reasons[0]).toMatch(/ausente/);
  });

  it("needs it when there is no trello source", () => {
    const r = needsOnboarding(paths, { fileExists: () => true, readFile: () => "sources: []", env: {} });
    expect(r.needed).toBe(true);
  });

  it("needs it when the key/token env vars are not set", () => {
    const r = needsOnboarding(paths, { fileExists: () => true, readFile: () => TRELLO_YAML, env: {} });
    expect(r.needed).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/TRELLO_API_KEY/);
  });

  it("is complete when board + resolved creds are present", () => {
    const r = needsOnboarding(paths, {
      fileExists: () => true,
      readFile: () => TRELLO_YAML,
      env: { TRELLO_API_KEY: "k", TRELLO_API_TOKEN: "t" },
    });
    expect(r.needed).toBe(false);
  });
});

describe("buildTaskSourcesYaml", () => {
  it("embeds the board id and the fixed env var names", () => {
    const y = buildTaskSourcesYaml("board123");
    expect(y).toContain('board: "board123"');
    expect(y).toContain("key: TRELLO_API_KEY");
  });
});

describe("updateConnectorState", () => {
  it("rewrites state lines in place, quoting columns with spaces, preserving comments", () => {
    const src = "# manifest\nstate:\n  backlog: Backlog\n  queued: OldQueue\n  done: Done\n# tail comment\n";
    const out = updateConnectorState(src, { queued: "OpenRoutines — Fila", backlog: "Ideias" });
    expect(out).toContain('  queued: "OpenRoutines — Fila"');
    expect(out).toContain("  backlog: Ideias");
    expect(out).toContain("  done: Done"); // untouched
    expect(out).toContain("# tail comment"); // comments preserved
  });
});

describe("appendMissingEnv", () => {
  it("appends only vars not already present, never overwriting", () => {
    const out = appendMissingEnv("EXISTING=1\nTRELLO_API_KEY=already\n", { TRELLO_API_KEY: "new", REPOS_BASE_DIR: "/p" });
    expect(out).toContain("TRELLO_API_KEY=already");
    expect(out).not.toContain("TRELLO_API_KEY=new");
    expect(out).toContain("REPOS_BASE_DIR=/p");
  });

  it("skips empty values", () => {
    const out = appendMissingEnv("", { A: "", B: "x" });
    expect(out).not.toContain("A=");
    expect(out).toContain("B=x");
  });
});

describe("maybeRunOnboarding — same-run board provisioning", () => {
  // Minimal fixtures just for parseOnboardingConfig to succeed; contents
  // beyond that don't matter since deps.validate.validate is faked below.
  const VALID_TASK_SOURCES_YAML = `
sources:
  - id: trello-main
    type: trello
    containers:
      board: "board123"
    auth:
      key: TRELLO_API_KEY
      token: TRELLO_API_TOKEN
`;
  const VALID_CONNECTOR_YAML = `
name: trello
transport: rest
auth:
  scheme: query
  params: { key: key, token: token }
state:
  backlog: Backlog
  queued: Fila
  working: Working
  blocked: Blocked
  review: Review
  done: Done
`;

  it("runs board validation right after the wizard, in the same call (bug: used to wait for the next boot)", async () => {
    const wizard = vi.fn(async () => {});
    const validateFn = vi.fn(async () => ({
      ok: true,
      createdLists: [],
      createdLabel: undefined,
      createdLabels: [],
      missingShared: [],
      existingLists: [],
    }));

    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      await maybeRunOnboarding(paths, {
        runOnboarding: wizard,
        validate: {
          readFile: (p) => (p === paths.taskSources ? VALID_TASK_SOURCES_YAML : VALID_CONNECTOR_YAML),
          env: { TRELLO_API_KEY: "k", TRELLO_API_TOKEN: "t" },
          validate: validateFn,
        },
      });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    }

    expect(wizard).toHaveBeenCalledTimes(1);
    expect(validateFn).toHaveBeenCalledTimes(1);
    expect(validateFn).toHaveBeenCalledWith("board123", expect.any(Object), "OpenRoutines", { key: "k", token: "t" });
  });
});
