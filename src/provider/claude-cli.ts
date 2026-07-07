/**
 * Claude CLI Provider Adapter
 *
 * Invokes the headless `claude` binary (subscription/OAuth auth, not API-key
 * billed) via argv-only spawn — mirrors kimi-cli.ts's shape. Adds trackable,
 * killable processes (F1 #137): spawn detached so the child is its own
 * process-group leader, persist {execution_id, pid} so a timeout can kill
 * the whole group (not just the immediate child) and a boot-time sweep can
 * reap zombies left by a crashed orchestrator.
 */

import { Data, Effect } from "effect";
import { spawn } from "child_process";
import type { CompletionRequest, CompletionResponse } from "./types.js";
import type { ExecutionProcessRepository } from "../persistence/types.js";
import { pickEnv, BASE_ENV_VARS } from "../util/env.js";
import { withSupplyChainPath } from "../security/supply-chain-guard.js";

export interface ClaudeCliConfig {
  binPath?: string;
  model?: string;
  settingsFile?: string;
  appendSystemPromptFile?: string;
  allowedTools?: string[];
  fallbackModel?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  processRepository?: ExecutionProcessRepository;
}

export class ClaudeCliError extends Data.TaggedError("ClaudeCliError")<{
  message: string;
  exitCode?: number;
  stderr?: string;
  cause?: unknown;
}> {}

const DEFAULT_TIMEOUT_MS = 1_500_000;

interface ClaudeCliJson {
  result?: string;
  /**
   * Present when `--json-schema` was passed: the model's output already parsed
   * and validated against the schema by the CLI. `result` is the model's raw
   * text (may interleave prose or truncate the JSON), so it is not reliably
   * parseable — prefer this when it exists.
   */
  structured_output?: unknown;
  total_cost_usd?: number;
  session_id?: string;
  is_error?: boolean;
}

/** Flatten request.messages (or request.prompt) into one argv-safe string — same shape as kimi-cli.ts. */
const buildPromptText = (request: CompletionRequest): string =>
  request.messages
    ?.map((m) => {
      if (m.role === "tool") return `[tool result: ${m.content}]`;
      if (m.role === "assistant" && m.toolCalls)
        return `[assistant tools: ${m.toolCalls.map((t) => t.name).join(", ")}]`;
      return `${m.role}: ${m.content}`;
    })
    .join("\n\n") ?? request.prompt ?? "";

/**
 * Build argv for the headless `claude` call. Every flag is a separate array
 * element — never a concatenated/interpolated string — so untrusted prompt
 * text can never reach a shell.
 *
 * `--bare` and `--max-budget-usd` are intentionally never emitted: `--bare`
 * forces API-key auth and breaks the OAuth/subscription flow this provider
 * exists for; `--max-budget-usd` has no headless-CLI equivalent, so
 * `request.maxBudgetUsd` is read here only to document that it is ignored —
 * budget ceilings are enforced by the billed claude-api provider instead.
 */
const buildArgs = (config: ClaudeCliConfig, request: CompletionRequest, promptText: string): string[] => {
  void request.maxBudgetUsd; // deliberately ignored — see doc comment above

  const args = ["-p", promptText];
  if (config.appendSystemPromptFile) args.push("--append-system-prompt-file", config.appendSystemPromptFile);
  args.push("--exclude-dynamic-system-prompt-sections", "--strict-mcp-config");
  if (config.model) args.push("--model", config.model);
  args.push("--permission-mode", "dontAsk");
  // Per-request allowlist (F4 #153: lens least privilege) overrides the
  // provider-level config; both are argv elements, never shell strings.
  const allowedTools = request.allowedTools ?? config.allowedTools;
  if (allowedTools && allowedTools.length > 0) {
    args.push("--allowedTools", allowedTools.join(","));
  }
  if (config.settingsFile) args.push("--settings", config.settingsFile);
  if (request.workdir) args.push("--add-dir", request.workdir);
  args.push("--output-format", "json");
  if (request.jsonSchema) {
    const schema = typeof request.jsonSchema === "string" ? request.jsonSchema : JSON.stringify(request.jsonSchema);
    args.push("--json-schema", schema);
  }
  if (config.fallbackModel) args.push("--fallback-model", config.fallbackModel);
  return args;
};

const runClaudeCli = (config: ClaudeCliConfig, request: CompletionRequest): Promise<CompletionResponse> => {
  const binPath = config.binPath ?? "claude";
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestedModel = config.model ?? "default";
  const promptText = buildPromptText(request);
  const args = buildArgs(config, request, promptText);

  return new Promise<CompletionResponse>((resolve, reject) => {
    const child = spawn(binPath, args, {
      // Run INSIDE the card's worktree when one is set (card-to-pr's plan/
      // implementation) so the agent explores/edits/git-operates on the card's
      // checkout, not the orchestrator's repo. --add-dir already whitelists it;
      // without this the cwd was the orchestrator dir (wrong repo).
      cwd: request.workdir ?? process.cwd(),
      // Minimal env: subscription/OAuth auth + PATH/HOME only. Never the
      // orchestrator's DB/GitHub/webhook secrets, and deliberately NOT
      // ANTHROPIC_API_KEY — that would make the CLI bill via the paid API
      // instead of the subscription (D3/#133); the API key belongs to claude-api.
      // PATH is prefixed with supplyChainShimDir() (F4 #156) so any npm/pnpm/npx
      // the agent's Bash tool runs resolves to the supply-chain guard shims.
      env: withSupplyChainPath({
        ...pickEnv([...BASE_ENV_VARS, "CLAUDE_CODE_OAUTH_TOKEN"]),
        ...(config.env ?? {}),
      }),
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group: makes `process.kill(-pid, ...)` below kill the
      // whole tree (claude + any tool subprocess it spawns), not just claude.
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let processId: string | undefined;

    // Best-effort tracking: a save/markFinished failure must never fail the
    // completion call itself, only get logged.
    const trackStart = async (): Promise<void> => {
      if (!config.processRepository || !request.executionId || !child.pid) return;
      processId = crypto.randomUUID();
      try {
        await config.processRepository.save({
          id: processId,
          executionId: request.executionId,
          pid: child.pid,
          worktree: request.workdir,
        });
      } catch (err) {
        console.error(`[claude-cli] failed to save execution_process: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const trackStartPromise = trackStart();

    const trackFinish = async (): Promise<void> => {
      if (!config.processRepository || !processId) return;
      try {
        await config.processRepository.markFinished(processId, new Date());
      } catch (err) {
        console.error(`[claude-cli] failed to mark execution_process finished: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const finish = (result: { ok: true; value: CompletionResponse } | { ok: false; error: ClaudeCliError }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      void trackStartPromise.then(trackFinish).finally(() => {
        if (result.ok) resolve(result.value);
        else reject(result.error);
      });
    };

    const timeoutHandle = setTimeout(() => {
      if (child.pid) {
        // Negative pid == kill the whole process group (see `detached` above).
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      finish({
        ok: false,
        error: new ClaudeCliError({ message: `claude CLI timed out after ${timeoutMs}ms`, stderr: stderr.slice(0, 500) }),
      });
    }, timeoutMs);

    child.stdout?.on("data", (d) => { stdout += String(d); });
    child.stderr?.on("data", (d) => { stderr += String(d); });

    child.on("error", (err) => {
      finish({ ok: false, error: new ClaudeCliError({ message: `claude CLI failed to start: ${err.message}`, cause: err }) });
    });

    child.on("close", (code) => {
      if (code !== 0) {
        finish({
          ok: false,
          error: new ClaudeCliError({ message: `claude CLI failed (code=${code})`, exitCode: code ?? undefined, stderr: stderr.slice(0, 500) }),
        });
        return;
      }

      let parsed: ClaudeCliJson;
      try {
        parsed = JSON.parse(stdout);
      } catch (err) {
        finish({
          ok: false,
          error: new ClaudeCliError({ message: `claude CLI returned unparseable stdout: ${stdout.slice(0, 500)}`, cause: err }),
        });
        return;
      }

      const response: CompletionResponse = {
        // With --json-schema the CLI exposes the validated object in
        // structured_output; serialize THAT (extractOutput re-parses the
        // content string) instead of parsed.result, which is the model's raw
        // text and often fails schema validation ("got string").
        content: parsed.structured_output != null ? JSON.stringify(parsed.structured_output) : parsed.result ?? "",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: requestedModel,
        finishReason: parsed.is_error ? "error" : "stop",
        costUsd: parsed.total_cost_usd,
        sessionId: parsed.session_id,
      };

      if (parsed.is_error) {
        finish({
          ok: false,
          error: new ClaudeCliError({ message: `claude CLI reported is_error=true: ${response.content.slice(0, 500)}`, stderr: stderr.slice(0, 500) }),
        });
        return;
      }

      finish({ ok: true, value: response });
    });
  });
};

export const makeClaudeCliProvider = (config: ClaudeCliConfig = {}) => {
  const complete = (request: CompletionRequest): Effect.Effect<CompletionResponse, ClaudeCliError> =>
    Effect.tryPromise({
      try: () => runClaudeCli(config, request),
      catch: (err) =>
        err instanceof ClaudeCliError ? err : new ClaudeCliError({ message: err instanceof Error ? err.message : String(err), cause: err }),
    });

  return { complete };
};
