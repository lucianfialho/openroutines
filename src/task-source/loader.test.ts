import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadTaskSources } from "./loader.js";

const connectorYaml = `
name: trello
transport: rest
auth:
  scheme: query
  params: { key: key, token: token }
state:
  backlog: Backlog
  queued: "OpenRoutines — Fila"
`;

describe("loadTaskSources", () => {
  const originalEnv = process.env.TASK_SOURCES_FILE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.TASK_SOURCES_FILE;
    } else {
      process.env.TASK_SOURCES_FILE = originalEnv;
    }
  });

  it("resolves each entry's default connector manifest and returns it validated", () => {
    const dir = mkdtempSync(join(tmpdir(), "task-sources-"));
    mkdirSync(join(dir, ".gates", "connectors", "trello"), { recursive: true });
    writeFileSync(join(dir, ".gates", "connectors", "trello", "connector.yaml"), connectorYaml);
    writeFileSync(
      join(dir, "task-sources.yaml"),
      "sources:\n  - id: trello-main\n    type: trello\n    auth:\n      key: TRELLO_API_KEY\n"
    );

    const resolved = loadTaskSources(dir);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].entry).toEqual({
      id: "trello-main",
      type: "trello",
      pollIntervalMinutes: 30,
      containers: {},
      auth: { key: "TRELLO_API_KEY" },
    });
    expect(resolved[0].manifest.name).toBe("trello");
    expect(resolved[0].manifest.state.queued).toBe("OpenRoutines — Fila");

    rmSync(dir, { recursive: true });
  });

  it("resolves a custom entry.manifest path relative to rootDir", () => {
    const dir = mkdtempSync(join(tmpdir(), "task-sources-"));
    mkdirSync(join(dir, "custom"), { recursive: true });
    writeFileSync(join(dir, "custom", "trello.yaml"), connectorYaml);
    writeFileSync(
      join(dir, "task-sources.yaml"),
      "sources:\n  - id: trello-main\n    type: trello\n    manifest: custom/trello.yaml\n"
    );

    const resolved = loadTaskSources(dir);
    expect(resolved[0].manifest.name).toBe("trello");

    rmSync(dir, { recursive: true });
  });

  it("returns [] for a directory without task-sources.yaml, without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "task-sources-"));
    expect(loadTaskSources(dir)).toEqual([]);
    rmSync(dir, { recursive: true });
  });

  it("defaults rootDir to the current working directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "task-sources-"));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(loadTaskSources()).toEqual([]);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true });
    }
  });

  it("honors TASK_SOURCES_FILE to pick a differently named manifest file", () => {
    const dir = mkdtempSync(join(tmpdir(), "task-sources-"));
    mkdirSync(join(dir, ".gates", "connectors", "trello"), { recursive: true });
    writeFileSync(join(dir, ".gates", "connectors", "trello", "connector.yaml"), connectorYaml);
    writeFileSync(
      join(dir, "custom-sources.yaml"),
      "sources:\n  - id: trello-main\n    type: trello\n"
    );
    process.env.TASK_SOURCES_FILE = "./custom-sources.yaml";

    const resolved = loadTaskSources(dir);
    expect(resolved).toHaveLength(1);

    rmSync(dir, { recursive: true });
  });
});
