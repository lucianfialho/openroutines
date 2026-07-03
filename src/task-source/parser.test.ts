import { describe, it, expect } from "vitest";
import { parseTaskSourcesFile, parseConnectorManifest, TaskSourceConfigError } from "./parser.js";

const validTaskSourcesYaml = `
sources:
  - id: trello-main
    type: trello
    manifest: .gates/connectors/trello/connector.yaml
    pollIntervalMinutes: 30
    containers:
      board: "6a4308b89057059398fbd438"
    auth:
      key: TRELLO_API_KEY
      token: TRELLO_API_TOKEN
`;

const validConnectorYaml = `
name: trello
transport: rest
baseUrl: https://api.trello.com/1
auth:
  scheme: query
  params: { key: key, token: token }
container:
  kind: list
  flag:
    kind: label
    name: OpenRoutines
fields:
  title: name
  body: desc
  url: shortUrl
state:
  backlog: Backlog
  queued: "OpenRoutines — Fila"
  working: "OpenRoutines — Working"
  blocked: Blocked
  review: Review
  done: Done
classification:
  type:
    research: "OpenRoutines: Pesquisa"
    mapping: "OpenRoutines: Mapeamento"
    update: "OpenRoutines: Update"
  complexity: { field: Complexidade }
  priority: { field: Prioridade }
operations:
  listQueue: { method: GET, path: "/lists/{containerId}/cards" }
  getTask: { method: GET, path: "/cards/{id}" }
capabilities: [customFields, twoStepClassification]
`;

describe("parseTaskSourcesFile", () => {
  it("parses the task-sources.yaml example from the issue", () => {
    const file = parseTaskSourcesFile(validTaskSourcesYaml);
    expect(file.sources).toHaveLength(1);
    expect(file.sources[0]).toEqual({
      id: "trello-main",
      type: "trello",
      manifest: ".gates/connectors/trello/connector.yaml",
      pollIntervalMinutes: 30,
      containers: { board: "6a4308b89057059398fbd438" },
      auth: { key: "TRELLO_API_KEY", token: "TRELLO_API_TOKEN" },
    });
  });

  it("applies defaults for a minimal entry", () => {
    const file = parseTaskSourcesFile("sources:\n  - id: min\n    type: trello\n");
    expect(file.sources[0]).toEqual({
      id: "min",
      type: "trello",
      pollIntervalMinutes: 30,
      containers: {},
      auth: {},
    });
  });

  it("allows an empty sources list", () => {
    expect(parseTaskSourcesFile("sources: []").sources).toEqual([]);
    expect(parseTaskSourcesFile("{}").sources).toEqual([]);
  });

  it("rejects a source missing id, pointing at the field", () => {
    const yaml = "sources:\n  - type: trello\n";
    expect(() => parseTaskSourcesFile(yaml)).toThrow(TaskSourceConfigError);
    expect(() => parseTaskSourcesFile(yaml)).toThrow(/sources\.0\.id/);
  });

  it("rejects an empty id", () => {
    const yaml = "sources:\n  - id: ''\n    type: trello\n";
    expect(() => parseTaskSourcesFile(yaml)).toThrow(/sources\.0\.id/);
  });

  it("rejects a missing type", () => {
    const yaml = "sources:\n  - id: trello-main\n";
    expect(() => parseTaskSourcesFile(yaml)).toThrow(/sources\.0\.type/);
  });

  it("rejects a non-positive pollIntervalMinutes", () => {
    const yaml = "sources:\n  - id: x\n    type: trello\n    pollIntervalMinutes: 0\n";
    expect(() => parseTaskSourcesFile(yaml)).toThrow(/pollIntervalMinutes/);
  });

  it("rejects non-object top-level content", () => {
    expect(() => parseTaskSourcesFile("- just\n- a\n- list")).toThrow(TaskSourceConfigError);
  });
});

describe("parseConnectorManifest", () => {
  it("parses the connector.yaml example from the issue", () => {
    const manifest = parseConnectorManifest(validConnectorYaml);
    expect(manifest.name).toBe("trello");
    expect(manifest.transport).toBe("rest");
    expect(manifest.auth).toEqual({ scheme: "query", params: { key: "key", token: "token" } });
    expect(manifest.container).toEqual({ kind: "list", flag: { kind: "label", name: "OpenRoutines" } });
    expect(manifest.fields).toEqual({ title: "name", body: "desc", url: "shortUrl" });
    expect(manifest.state.queued).toBe("OpenRoutines — Fila");
    expect(manifest.classification?.type.research).toBe("OpenRoutines: Pesquisa");
    expect(manifest.classification?.complexity).toEqual({ field: "Complexidade" });
    expect(manifest.operations.listQueue).toEqual({ method: "GET", path: "/lists/{containerId}/cards" });
    expect(manifest.capabilities).toEqual(["customFields", "twoStepClassification"]);
  });

  it("accepts the bearer and basic auth schemes with no extra fields", () => {
    expect(
      parseConnectorManifest("name: a\ntransport: rest\nauth:\n  scheme: bearer\n").auth
    ).toEqual({ scheme: "bearer" });
    expect(
      parseConnectorManifest("name: a\ntransport: rest\nauth:\n  scheme: basic\n").auth
    ).toEqual({ scheme: "basic" });
  });

  it("accepts the header auth scheme", () => {
    const manifest = parseConnectorManifest("name: a\ntransport: rest\nauth:\n  scheme: header\n  header: X-Api-Key\n");
    expect(manifest.auth).toEqual({ scheme: "header", header: "X-Api-Key" });
  });

  it("rejects an unknown auth.scheme, pointing at the field", () => {
    const yaml = "name: a\ntransport: rest\nauth:\n  scheme: oauth\n";
    expect(() => parseConnectorManifest(yaml)).toThrow(TaskSourceConfigError);
    expect(() => parseConnectorManifest(yaml)).toThrow(/auth\.scheme/);
  });

  it("rejects auth.scheme query without params", () => {
    const yaml = "name: a\ntransport: rest\nauth:\n  scheme: query\n";
    expect(() => parseConnectorManifest(yaml)).toThrow(/auth\.params/);
  });

  it("rejects auth.scheme header without a header name", () => {
    const yaml = "name: a\ntransport: rest\nauth:\n  scheme: header\n";
    expect(() => parseConnectorManifest(yaml)).toThrow(/auth\.header/);
  });

  it("rejects an unknown state key, pointing at the field (e.g. \"queue\" instead of \"queued\")", () => {
    const yaml = "name: a\ntransport: rest\nauth:\n  scheme: bearer\nstate:\n  queue: Backlog\n";
    expect(() => parseConnectorManifest(yaml)).toThrow(TaskSourceConfigError);
    expect(() => parseConnectorManifest(yaml)).toThrow(/state\.queue/);
  });

  it("rejects an unknown classification.type key", () => {
    const yaml =
      "name: a\ntransport: rest\nauth:\n  scheme: bearer\nclassification:\n  type:\n    bugfix: Bug\n";
    expect(() => parseConnectorManifest(yaml)).toThrow(/classification\.type\.bugfix/);
  });

  it("rejects operations.listQueue.method outside the enum, pointing at the field", () => {
    const yaml =
      "name: a\ntransport: rest\nauth:\n  scheme: bearer\noperations:\n  listQueue: { method: FETCH, path: /x }\n";
    expect(() => parseConnectorManifest(yaml)).toThrow(TaskSourceConfigError);
    expect(() => parseConnectorManifest(yaml)).toThrow(/operations\.listQueue\.method/);
  });

  it("rejects an operation with an empty path", () => {
    const yaml = "name: a\ntransport: rest\nauth:\n  scheme: bearer\noperations:\n  listQueue: { method: GET, path: '' }\n";
    expect(() => parseConnectorManifest(yaml)).toThrow(/operations\.listQueue\.path/);
  });

  it("rejects an unknown transport", () => {
    const yaml = "name: a\ntransport: soap\nauth:\n  scheme: bearer\n";
    expect(() => parseConnectorManifest(yaml)).toThrow(/transport/);
  });

  it("treats operations, state, classification, fields and capabilities as optional", () => {
    const manifest = parseConnectorManifest("name: a\ntransport: graphql\nauth:\n  scheme: bearer\n");
    expect(manifest.operations).toEqual({});
    expect(manifest.state).toEqual({});
    expect(manifest.classification).toBeUndefined();
    expect(manifest.fields).toEqual({});
    expect(manifest.capabilities).toEqual([]);
    expect(manifest.container).toBeUndefined();
  });

  it("rejects non-object top-level content", () => {
    expect(() => parseConnectorManifest("- just\n- a\n- list")).toThrow(TaskSourceConfigError);
  });
});
