import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Cause } from "effect";
import { makeRestTaskSource } from "./rest-executor.js";
import { TaskSourceError, TASK_SOURCE_METHODS } from "./types.js";
import { parseConnectorManifest } from "./parser.js";

const ENV_KEYS = ["ACME_TOKEN", "ACME_API_KEY", "ACME_KEY", "ACME_QUERY_TOKEN", "ACME_USER", "ACME_PASS"];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) delete process.env[key];
});

const manifestYaml = (authYaml: string) => `
name: acme
transport: rest
baseUrl: https://api.acme.test
auth:
${authYaml}
fields:
  title: name
  body: desc
  url: link
operations:
  getTask: { method: GET, path: "/cards/{id}" }
`;

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: "OK",
  text: async () => JSON.stringify(body),
});

const errorResponse = (status: number, text: string) => ({
  ok: false,
  status,
  statusText: "Error",
  text: async () => text,
});

const rawCard = { name: "Fix bug", desc: "details", link: "https://acme.test/c/123" };

// Runs the effect, asserts it failed with a TaskSourceError (via Effect.fail,
// never a raw synchronous throw), and returns the error for further checks.
const expectTaskSourceError = async (effect: Effect.Effect<unknown, TaskSourceError>): Promise<TaskSourceError> => {
  const exit = await Effect.runPromiseExit(effect);
  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure") {
    const result = Cause.findError(exit.cause);
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.success).toBeInstanceOf(TaskSourceError);
      return result.success as TaskSourceError;
    }
  }
  throw new Error("expected a TaskSourceError failure");
};

describe("makeRestTaskSource — auth schemes (getTask)", () => {
  it("bearer: sends Authorization: Bearer <authEnv.token value> and maps the response via fields", async () => {
    process.env.ACME_TOKEN = "secret-token";
    const manifest = parseConnectorManifest(manifestYaml("  scheme: bearer"));
    const source = makeRestTaskSource({
      manifest,
      sourceId: "acme-main",
      containers: {},
      authEnv: { token: "ACME_TOKEN" },
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, rawCard));
    vi.stubGlobal("fetch", fetchMock);

    const task = await Effect.runPromise(source.getTask("123"));

    expect(fetchMock).toHaveBeenCalledWith("https://api.acme.test/cards/123", {
      method: "GET",
      headers: { Authorization: "Bearer secret-token" },
      body: undefined,
    });
    expect(task).toMatchObject({
      sourceId: "acme-main",
      id: "123",
      title: "Fix bug",
      body: "details",
      url: "https://acme.test/c/123",
    });
  });

  it('header: sends "<manifest.auth.header>: <authEnv.apiKey value>"', async () => {
    process.env.ACME_API_KEY = "secret-key";
    const manifest = parseConnectorManifest(manifestYaml("  scheme: header\n  header: X-Api-Key"));
    const source = makeRestTaskSource({
      manifest,
      sourceId: "acme-main",
      containers: {},
      authEnv: { apiKey: "ACME_API_KEY" },
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, rawCard));
    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(source.getTask("123"));

    expect(fetchMock).toHaveBeenCalledWith("https://api.acme.test/cards/123", {
      method: "GET",
      headers: { "X-Api-Key": "secret-key" },
      body: undefined,
    });
  });

  it("query: appends <params[paramKey]>=<authEnv[paramKey] value> for every configured param", async () => {
    process.env.ACME_KEY = "k1";
    process.env.ACME_QUERY_TOKEN = "t1";
    const manifest = parseConnectorManifest(manifestYaml("  scheme: query\n  params: { key: key, token: token }"));
    const source = makeRestTaskSource({
      manifest,
      sourceId: "acme-main",
      containers: {},
      authEnv: { key: "ACME_KEY", token: "ACME_QUERY_TOKEN" },
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, rawCard));
    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(source.getTask("123"));

    expect(fetchMock).toHaveBeenCalledWith("https://api.acme.test/cards/123?key=k1&token=t1", {
      method: "GET",
      headers: {},
      body: undefined,
    });
  });

  it("basic: sends Authorization: Basic base64(username:password)", async () => {
    process.env.ACME_USER = "bob";
    process.env.ACME_PASS = "hunter2";
    const manifest = parseConnectorManifest(manifestYaml("  scheme: basic"));
    const source = makeRestTaskSource({
      manifest,
      sourceId: "acme-main",
      containers: {},
      authEnv: { username: "ACME_USER", password: "ACME_PASS" },
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, rawCard));
    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(source.getTask("123"));

    const expectedToken = Buffer.from("bob:hunter2").toString("base64");
    expect(fetchMock).toHaveBeenCalledWith("https://api.acme.test/cards/123", {
      method: "GET",
      headers: { Authorization: `Basic ${expectedToken}` },
      body: undefined,
    });
  });

  it("fails with a TaskSourceError('auth') without calling fetch when the required env var is missing", async () => {
    const manifest = parseConnectorManifest(manifestYaml("  scheme: bearer"));
    const source = makeRestTaskSource({ manifest, sourceId: "acme-main", containers: {}, authEnv: {} });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const err = await expectTaskSourceError(source.getTask("123"));

    expect(err.operation).toBe("auth");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows an empty env var value and sends it as the auth token", async () => {
    process.env.ACME_TOKEN = "";
    const manifest = parseConnectorManifest(manifestYaml("  scheme: bearer"));
    const source = makeRestTaskSource({
      manifest,
      sourceId: "acme-main",
      containers: {},
      authEnv: { token: "ACME_TOKEN" },
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, rawCard));
    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(source.getTask("123"));

    expect(fetchMock).toHaveBeenCalledWith("https://api.acme.test/cards/123", {
      method: "GET",
      headers: { Authorization: "Bearer " },
      body: undefined,
    });
  });
});

describe("makeRestTaskSource — operation contract", () => {
  it("fails with TaskSourceError, without calling fetch, for every method whose operation isn't declared", async () => {
    const manifest = parseConnectorManifest("name: acme\ntransport: rest\nauth:\n  scheme: bearer\n");
    process.env.ACME_TOKEN = "t";
    const source = makeRestTaskSource({
      manifest,
      sourceId: "acme-main",
      containers: {},
      authEnv: { token: "ACME_TOKEN" },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const calls: Array<Effect.Effect<unknown, TaskSourceError>> = [
      source.listQueue("queued"),
      source.getTask("1"),
      source.comment("1", "hi"),
      source.attachArtifact("1", { filename: "a.md", content: "x" }),
      source.moveTo("1", "queued"),
      source.setClassification("1", { type: "research" }),
      source.watchNew(null),
    ];
    expect(calls).toHaveLength(TASK_SOURCE_METHODS.length);

    for (const effect of calls) {
      const err = await expectTaskSourceError(effect);
      expect(err.message).toMatch(/not declared/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails with Effect.fail(TaskSourceError) on a non-2xx response, with the response text as cause", async () => {
    process.env.ACME_TOKEN = "t";
    const manifest = parseConnectorManifest(manifestYaml("  scheme: bearer"));
    const source = makeRestTaskSource({
      manifest,
      sourceId: "acme-main",
      containers: {},
      authEnv: { token: "ACME_TOKEN" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(404, "card not found")));

    const err = await expectTaskSourceError(source.getTask("999"));

    expect(err.operation).toBe("getTask");
    expect(err.cause).toBe("card not found");
  });

  it("fails with TaskSourceError when fetch itself rejects (network error)", async () => {
    process.env.ACME_TOKEN = "t";
    const manifest = parseConnectorManifest(manifestYaml("  scheme: bearer"));
    const source = makeRestTaskSource({
      manifest,
      sourceId: "acme-main",
      containers: {},
      authEnv: { token: "ACME_TOKEN" },
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const err = await expectTaskSourceError(source.getTask("1"));

    expect(err.operation).toBe("getTask");
  });

  it("throws synchronously and clearly when manifest.transport is graphql, instead of treating it as REST", () => {
    const manifest = parseConnectorManifest("name: acme\ntransport: graphql\nauth:\n  scheme: bearer\n");

    expect(() => makeRestTaskSource({ manifest, sourceId: "acme-main", containers: {}, authEnv: {} })).toThrow(
      TaskSourceError
    );
    expect(() => makeRestTaskSource({ manifest, sourceId: "acme-main", containers: {}, authEnv: {} })).toThrow(
      /graphql/
    );
  });
});

describe("makeRestTaskSource — other methods", () => {
  it("listQueue: substitutes {containerId} from config.containers[state] and maps each item, tagged with the queried state", async () => {
    process.env.ACME_TOKEN = "t";
    const manifest = parseConnectorManifest(`
name: acme
transport: rest
baseUrl: https://api.acme.test
auth:
  scheme: bearer
fields:
  title: name
  id: cardId
operations:
  listQueue: { method: GET, path: "/lists/{containerId}/cards" }
`);
    const source = makeRestTaskSource({
      manifest,
      sourceId: "acme-main",
      containers: { queued: "list-123" },
      authEnv: { token: "ACME_TOKEN" },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, [{ cardId: "1", name: "First" }, { cardId: "2", name: "Second" }]));
    vi.stubGlobal("fetch", fetchMock);

    const tasks = await Effect.runPromise(source.listQueue("queued"));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.acme.test/lists/list-123/cards",
      expect.objectContaining({ method: "GET" })
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ id: "1", title: "First", state: "queued" });
    expect(tasks[1]).toMatchObject({ id: "2", title: "Second", state: "queued" });
  });

  it("listQueue: drops items missing the manifest's label flag (#139 contract)", async () => {
    process.env.ACME_TOKEN = "t";
    const manifest = parseConnectorManifest(`
name: acme
transport: rest
baseUrl: https://api.acme.test
auth:
  scheme: bearer
container:
  kind: list
  flag: { kind: label, name: OpenRoutines }
fields:
  title: name
  id: cardId
  labels: labels
operations:
  listQueue: { method: GET, path: "/lists/{containerId}/cards" }
`);
    const source = makeRestTaskSource({
      manifest,
      sourceId: "acme-main",
      containers: { queued: "list-123" },
      authEnv: { token: "ACME_TOKEN" },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, [
        { cardId: "1", name: "Ours", labels: ["OpenRoutines"] },
        { cardId: "2", name: "Theirs", labels: ["Bug"] },
      ])
    );
    vi.stubGlobal("fetch", fetchMock);

    const tasks = await Effect.runPromise(source.listQueue("queued"));

    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("1");
  });

  it("comment: renders {body} into the operation's JSON body and sends Content-Type: application/json", async () => {
    process.env.ACME_TOKEN = "t";
    const manifest = parseConnectorManifest(`
name: acme
transport: rest
baseUrl: https://api.acme.test
auth:
  scheme: bearer
operations:
  comment: { method: POST, path: "/cards/{id}/comments", body: { text: "{body}" } }
`);
    const source = makeRestTaskSource({
      manifest,
      sourceId: "acme-main",
      containers: {},
      authEnv: { token: "ACME_TOKEN" },
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(source.comment("42", "hello world"));

    expect(fetchMock).toHaveBeenCalledWith("https://api.acme.test/cards/42/comments", {
      method: "POST",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello world" }),
    });
  });

  it("watchNew: satisfies the {tasks, cursor} contract from a mocked array response", async () => {
    process.env.ACME_TOKEN = "t";
    const manifest = parseConnectorManifest(`
name: acme
transport: rest
baseUrl: https://api.acme.test
auth:
  scheme: bearer
fields:
  title: name
operations:
  watchNew: { method: GET, path: "/cards/updated" }
`);
    const source = makeRestTaskSource({
      manifest,
      sourceId: "acme-main",
      containers: {},
      authEnv: { token: "ACME_TOKEN" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, [{ name: "New" }])));

    const result = await Effect.runPromise(source.watchNew("cursor-1"));

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe("New");
    expect(result.cursor).toBe("cursor-1");
  });
});
