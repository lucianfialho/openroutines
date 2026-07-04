/**
 * card-mapeamento script handlers (F5 #162).
 *
 * Wires the 5 deterministic (`type: script`) states of
 * `.gates/skills/card-mapeamento/skill.yaml` into a ScriptRegistry, following
 * the same shape as card-pesquisa's index.ts: deps injected as closures, one
 * injectable seam per external effect so tests never need a real repo, GitHub,
 * Trello, docker daemon, or a live model call.
 *
 * Like card-pesquisa (and unlike a `type: agent` card), the two LLM phases run
 * inside script handlers, not agent states, because the runner only wires a
 * per-phase CLI tool allowlist for `fanout` lenses — and varredura REQUIRES a
 * restricted allowlist (Write/Edit confined to docs/**). So the handlers own
 * the provider calls and provider/model live here, not in the YAML.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { Effect } from "effect";
import type { ScriptRegistry } from "../../script/registry.js";
import type { RepoRegistry } from "../../repo-registry/schema.js";
import type { TaskSource } from "../../task-source/types.js";
import type { ActionLedgerRepository } from "../../persistence/types.js";
import type { CompletionRequest, CompletionResponse } from "../../provider/types.js";
import type { ProviderAdapter } from "../../provider/registry.js";
import { makeGitHubConnector } from "../../connector/github.js";
import { makeClaudeCliProvider } from "../../provider/claude-cli.js";
import { up as composeUpDefault, down as composeDownDefault } from "../../orchestrator/compose-lifecycle.js";
import { makePreparacao } from "./preparacao.js";
import { makeVarredura } from "./varredura.js";
import { makeCapturaVisual } from "./captura-visual.js";
import { makeValidacao, type ValidacaoProbes } from "./validacao.js";
import { makePrDocs } from "./pr-docs.js";

const execFileAsync = promisify(execFile);

/** Sonnet drives the read-broad, docs-write survey (claude-cli). */
export const SONNET_MODEL = "claude-sonnet-5";

/**
 * Minimal provider seam for the varredura CLI call: only `complete` is used.
 * The real claude-cli factory satisfies it (its error channel widens to
 * `unknown`); a test fake is just `{ complete }`.
 */
export interface MapeamentoProvider {
  complete: (req: CompletionRequest) => Effect.Effect<CompletionResponse, unknown>;
}

/**
 * captura_visual deps: the Kimi-with-Playwright-MCP agent plus the compose
 * seams. compose up/down are REUSED from src/orchestrator/compose-lifecycle.ts
 * (never reimplemented) — the seams exist only so tests avoid a real docker
 * daemon. Absent in flows that never reach captura_visual (non-UI repos); the
 * handler throws if invoked without it (app.ts always wires it).
 */
export interface MapeamentoVisualDeps {
  agentProvider: ProviderAdapter;
  composeUp?: typeof composeUpDefault;
  composeDown?: typeof composeDownDefault;
  composeFile?: string;
  baseUrl?: string;
}

export interface MapeamentoDeps {
  registry: RepoRegistry;
  githubToken: string;
  worktreeBase: string; // env WORKTREE_BASE, e.g. /tmp/or-worktrees
  ledger: ActionLedgerRepository;
  taskSourceFor: (sourceId: string) => TaskSource | undefined;
  // Injectable seams for tests (default to the real impls):
  makeGithub?: (cfg: { token: string; repo: string }) => ReturnType<typeof makeGitHubConnector>;
  /** CLI provider for the docs survey (claude-cli / Sonnet). */
  makeCliProvider?: (cfg: { model: string }) => MapeamentoProvider;
  /** Worktree git ops (fetch/worktree add/rev-parse/log/show/add/commit/push). */
  runGit?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  /** captura_visual deps (Kimi + compose). */
  visual?: MapeamentoVisualDeps;
  /** validacao worktree probes (default: real fs) — injected in tests. */
  validacao?: ValidacaoProbes;
}

/**
 * Default git runner: execFile argv only. Read ops inherit the full env; the
 * one authenticating call (`git push`) gets GITHUB_TOKEN injected so the docs
 * branch can be pushed. Kept as a single seam so every git call in the module
 * is mockable at once (card-to-pr's index.ts uses the same shape).
 */
export const defaultRunGit =
  (githubToken: string) =>
  (args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> =>
    execFileAsync(
      "git",
      args,
      args[0] === "push" ? { cwd, env: { ...process.env, GITHUB_TOKEN: githubToken } } : { cwd }
    );

export const resolveGithub = (deps: MapeamentoDeps, repo: string) =>
  (deps.makeGithub ?? makeGitHubConnector)({ token: deps.githubToken, repo });

export const resolveCliProvider = (deps: MapeamentoDeps, model: string): MapeamentoProvider =>
  (deps.makeCliProvider ?? ((cfg) => makeClaudeCliProvider({ model: cfg.model })))({ model });

export const registerMapeamentoHandlers = (reg: ScriptRegistry, deps: MapeamentoDeps): void => {
  reg.register("card-mapeamento-preparacao", makePreparacao(deps));
  reg.register("card-mapeamento-varredura", makeVarredura(deps));
  reg.register("card-mapeamento-captura-visual", makeCapturaVisual(deps));
  reg.register("card-mapeamento-validacao", makeValidacao(deps));
  reg.register("card-mapeamento-pr-docs", makePrDocs(deps));
};
