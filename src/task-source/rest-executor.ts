/**
 * REST Task Source Executor
 *
 * Manifest-driven TaskSource for "well-behaved" REST connectors (decision
 * D33): every operation is one declarative request, no source-specific code.
 * Sources with multi-step quirks (e.g. Trello's two-step custom field write)
 * get a bespoke adapter instead (issue #4) — this stays generic on purpose.
 */

import { Effect } from "effect";
import { TaskSourceError } from "./types.js";
import type {
  Task,
  TaskArtifact,
  TaskClassification,
  TaskSource,
  TaskSourceMethodName,
  TaskState,
} from "./types.js";
import type { ConnectorManifest, OperationSpec } from "./schema.js";

export interface RestTaskSourceConfig {
  manifest: ConnectorManifest;
  sourceId: string;
  containers: Record<string, string>; // canonical TaskState -> resolved runtime container id
  authEnv: Record<string, string>; // auth param name -> NAME of the env var holding the secret
}

type Params = Record<string, string>;

// Copied from src/engine/template.ts's getNestedValue (~8 lines) rather than
// imported: that engine renders {{inputs.x}} skill prompts, a different
// domain from this module's plain {x} operation-param substitution — not
// worth coupling the two for one small helper.
const getNestedValue = (obj: Record<string, unknown>, path: string): unknown => {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
};

const renderString = (value: string, params: Params): string =>
  value.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? params[key] : match));

const renderQuery = (query: Record<string, unknown> | undefined, params: Params): Params => {
  const out: Params = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    const rendered = typeof value === "string" ? renderString(value, params) : value;
    out[key] = rendered === undefined || rendered === null ? "" : String(rendered);
  }
  return out;
};

const renderBody = (value: unknown, params: Params): unknown => {
  if (typeof value === "string") return renderString(value, params);
  if (Array.isArray(value)) return value.map((v) => renderBody(v, params));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, renderBody(v, params)])
    );
  }
  return value;
};

const toQueryString = (params: Params): string => {
  const entries = Object.entries(params);
  return entries.length === 0
    ? ""
    : `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;
};

export const makeRestTaskSource = (config: RestTaskSourceConfig): TaskSource => {
  if (config.manifest.transport !== "rest") {
    throw new TaskSourceError(
      `makeRestTaskSource only supports transport "rest", got "${config.manifest.transport}"`
    );
  }

  const readAuthEnv = (paramKey: string): Effect.Effect<string, TaskSourceError> => {
    const envVarName = config.authEnv[paramKey];
    if (!envVarName) {
      return Effect.fail(new TaskSourceError(`Missing authEnv entry for "${paramKey}"`, "auth"));
    }
    const value = process.env[envVarName];
    if (!value) {
      return Effect.fail(new TaskSourceError(`Missing env var "${envVarName}" (authEnv.${paramKey})`, "auth"));
    }
    return Effect.succeed(value);
  };

  // Named tuple->object helper so every switch branch below returns the exact
  // same inferred shape — plain per-branch object literals infer mismatched
  // (Authorization-optional vs indexed) header types that Effect.gen can't
  // unify into resolveAuth's declared return type.
  const authResult = (headers: Params, query: Params = {}): { headers: Params; query: Params } => ({
    headers,
    query,
  });

  const resolveAuth = (): Effect.Effect<{ headers: Params; query: Params }, TaskSourceError> =>
    Effect.gen(function* () {
      const auth = config.manifest.auth;
      switch (auth.scheme) {
        case "bearer": {
          const token = yield* readAuthEnv("token");
          return authResult({ Authorization: `Bearer ${token}` });
        }
        case "header": {
          const value = yield* readAuthEnv("apiKey");
          return authResult({ [auth.header]: value });
        }
        case "query": {
          const query: Params = {};
          for (const paramKey of Object.keys(auth.params)) {
            query[auth.params[paramKey]] = yield* readAuthEnv(paramKey);
          }
          return authResult({}, query);
        }
        case "basic": {
          const username = yield* readAuthEnv("username");
          const password = yield* readAuthEnv("password");
          const token = Buffer.from(`${username}:${password}`).toString("base64");
          return authResult({ Authorization: `Basic ${token}` });
        }
        default: {
          const exhaustive: never = auth;
          return yield* Effect.fail(
            new TaskSourceError(`Unsupported auth scheme: ${JSON.stringify(exhaustive)}`, "auth")
          );
        }
      }
    });

  // One request per TaskSource method call — no multi-step flows (that's what
  // makes a source "well-behaved" enough for this generic executor).
  const request = (methodName: TaskSourceMethodName, params: Params): Effect.Effect<unknown, TaskSourceError> =>
    Effect.gen(function* () {
      const op: OperationSpec | undefined = config.manifest.operations[methodName];
      if (!op) {
        return yield* Effect.fail(
          new TaskSourceError(`${methodName} not declared in connector manifest`, methodName)
        );
      }

      const auth = yield* resolveAuth();
      const path = renderString(op.path, params);
      const query = { ...renderQuery(op.query, params), ...auth.query };
      const headers: Params = { ...auth.headers };

      let body: string | undefined;
      if (op.body) {
        body = JSON.stringify(renderBody(op.body, params));
        headers["Content-Type"] = "application/json";
      }

      const url = `${config.manifest.baseUrl ?? ""}${path}${toQueryString(query)}`;

      return yield* Effect.tryPromise({
        try: async () => {
          const res = await fetch(url, { method: op.method, headers, body });
          const text = await res.text();
          if (!res.ok) {
            throw new TaskSourceError(`${op.method} ${path} failed with status ${res.status}`, methodName, text);
          }
          return text ? JSON.parse(text) : undefined;
        },
        catch: (err) =>
          err instanceof TaskSourceError ? err : new TaskSourceError(`${op.method} ${path} failed`, methodName, err),
      });
    });

  const toTask = (raw: unknown, overrides: { id?: string; state?: TaskState } = {}): Task => {
    const fields = config.manifest.fields;
    const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

    const str = (path: string | undefined): string => {
      if (!path) return "";
      const value = getNestedValue(obj, path);
      return value === undefined || value === null ? "" : String(value);
    };
    const arr = (path: string | undefined): string[] => {
      const value = path ? getNestedValue(obj, path) : undefined;
      return Array.isArray(value) ? value.map(String) : [];
    };
    const date = (path: string | undefined): Date => {
      const value = path ? getNestedValue(obj, path) : undefined;
      const parsed = typeof value === "string" || typeof value === "number" ? new Date(value) : new Date(NaN);
      return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    };

    return {
      sourceId: config.sourceId,
      id: overrides.id ?? str(fields.id ?? "id"),
      title: str(fields.title),
      body: str(fields.body),
      url: str(fields.url),
      // ponytail: state/type/createdAt/updatedAt have no reverse-mapping rule
      // in this issue (manifest.state/classification are write-direction only
      // here) — listQueue/moveTo pass the queried state, which is exact;
      // getTask falls back to sensible defaults. Add manifest.fields-driven
      // reverse lookups if a real getTask consumer needs the true value.
      state: overrides.state ?? "backlog",
      type: "implementation",
      labels: arr(fields.labels),
      assignees: arr(fields.assignees),
      createdAt: date(fields.createdAt),
      updatedAt: date(fields.updatedAt),
      raw,
    };
  };

  const listQueue = (state: TaskState): Effect.Effect<Task[], TaskSourceError> =>
    Effect.gen(function* () {
      const containerId = config.containers[state] ?? "";
      const raw = yield* request("listQueue", { containerId, state });
      const items = Array.isArray(raw) ? raw : [];
      return items.map((item) => toTask(item, { state }));
    });

  const getTask = (id: string): Effect.Effect<Task, TaskSourceError> =>
    Effect.gen(function* () {
      const raw = yield* request("getTask", { id });
      return toTask(raw, { id });
    });

  const comment = (id: string, body: string): Effect.Effect<void, TaskSourceError> =>
    Effect.gen(function* () {
      yield* request("comment", { id, body });
    });

  const attachArtifact = (id: string, artifact: TaskArtifact): Effect.Effect<void, TaskSourceError> =>
    Effect.gen(function* () {
      yield* request("attachArtifact", {
        id,
        filename: artifact.filename,
        content: artifact.content,
        mimeType: artifact.mimeType ?? "",
      });
    });

  const moveTo = (id: string, state: TaskState): Effect.Effect<void, TaskSourceError> =>
    Effect.gen(function* () {
      const containerId = config.containers[state] ?? "";
      yield* request("moveTo", { id, state, containerId });
    });

  const setClassification = (id: string, classification: TaskClassification): Effect.Effect<void, TaskSourceError> =>
    Effect.gen(function* () {
      yield* request("setClassification", {
        id,
        type: classification.type ?? "",
        complexity: classification.complexity ?? "",
        priority: classification.priority ?? "",
      });
    });

  // ponytail: MVP — no real source drives watchNew yet (Trello is bespoke,
  // issue #4); this just satisfies the {tasks, cursor} contract. No
  // dedupe/advance logic — revisit once a real polling source needs it.
  const watchNew = (cursor: string | null): Effect.Effect<{ tasks: Task[]; cursor: string }, TaskSourceError> =>
    Effect.gen(function* () {
      const raw = yield* request("watchNew", { cursor: cursor ?? "" });
      const items = Array.isArray(raw) ? raw : [];
      return { tasks: items.map((item) => toTask(item)), cursor: cursor ?? "" };
    });

  return { listQueue, getTask, comment, attachArtifact, moveTo, setClassification, watchNew };
};
