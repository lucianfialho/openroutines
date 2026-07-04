/**
 * card-pesquisa script handlers (F5 #161).
 *
 * Wires the 4 deterministic (`type: script`) states of
 * `.gates/skills/card-pesquisa/skill.yaml` into a ScriptRegistry, following the
 * same shape as card-to-pr's index.ts (registerCardToPrHandlers): deps injected
 * as closures, one injectable seam per external effect so tests never need a
 * real repo, GitHub, Trello, or a live model call.
 *
 * Unlike card-to-pr, the two LLM phases (levantamento, julgamento) are ALSO
 * script states here, not `type: agent` states — the runner only wires a
 * per-phase CLI tool allowlist for `fanout` lenses, and levantamento REQUIRES a
 * restricted allowlist (no Write/Edit). So the handlers own the provider calls,
 * and provider/model live here rather than in the YAML.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { Effect } from "effect";
import type { ScriptRegistry } from "../../script/registry.js";
import type { RepoRegistry } from "../../repo-registry/schema.js";
import type { TaskSource } from "../../task-source/types.js";
import type { ActionLedgerRepository } from "../../persistence/types.js";
import type { CompletionRequest, CompletionResponse } from "../../provider/types.js";
import { makeGitHubConnector } from "../../connector/github.js";
import { makeClaudeCliProvider } from "../../provider/claude-cli.js";
import { makeClaudeProvider } from "../../provider/claude.js";
import { makePreparacao } from "./preparacao.js";
import { makeLevantamento } from "./levantamento.js";
import { makeJulgamento } from "./julgamento.js";
import { makeEntrega } from "./entrega.js";

const execFileAsync = promisify(execFile);

/** Models per phase (constants, not skill.yaml `model:` — these are script states). */
export const SONNET_MODEL = "claude-sonnet-5";
export const OPUS_MODEL = "claude-opus-4-8";
export const FABLE_MODEL = "claude-fable-5";

/**
 * Minimal provider seam: only `complete` is used. Both real factories
 * (claude-cli, claude) satisfy it (their ClaudeCliError/ClaudeError error
 * channels widen to `unknown`), and a test fake is just `{ complete }`.
 */
export interface PesquisaProvider {
  complete: (req: CompletionRequest) => Effect.Effect<CompletionResponse, unknown>;
}

export interface PesquisaDeps {
  registry: RepoRegistry;
  githubToken: string;
  worktreeBase: string; // env WORKTREE_BASE, e.g. /tmp/or-worktrees
  taskSourceFor: (sourceId: string) => TaskSource | undefined;
  /** Anthropic API key for the billed judge provider (claude.ts / Opus+Fable). */
  claudeApiKey: string;
  /**
   * Action ledger (F5 #162 hardening): when present, entrega wraps its GitHub
   * issue/milestone creation and card handoff so a crash mid-delivery + resume
   * never mints a duplicate issue. Optional to keep the existing e2e harness
   * (which never crashes mid-delivery) unchanged; app.ts always wires it.
   */
  ledger?: ActionLedgerRepository;
  // Injectable seams for tests (default to the real impls):
  makeGithub?: (cfg: { token: string; repo: string }) => ReturnType<typeof makeGitHubConnector>;
  /** CLI provider for the read-only survey (claude-cli / Sonnet). */
  makeCliProvider?: (cfg: { model: string }) => PesquisaProvider;
  /** Billed API provider for the architecture judgment (claude.ts / Opus, Fable). */
  makeApiProvider?: (cfg: { apiKey: string; model: string }) => PesquisaProvider;
  /** Read-only worktree git ops (fetch/worktree add/rev-parse). */
  runGit?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
}

/** Default git runner: execFile argv only, inherits the full env (all ops are read-only local). */
export const defaultRunGit =
  (args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> =>
    execFileAsync("git", args, { cwd });

export const resolveGithub = (deps: PesquisaDeps, repo: string) =>
  (deps.makeGithub ?? makeGitHubConnector)({ token: deps.githubToken, repo });

export const resolveCliProvider = (deps: PesquisaDeps, model: string): PesquisaProvider =>
  (deps.makeCliProvider ?? ((cfg) => makeClaudeCliProvider({ model: cfg.model })))({ model });

export const resolveApiProvider = (deps: PesquisaDeps, model: string): PesquisaProvider =>
  (deps.makeApiProvider ?? ((cfg) => makeClaudeProvider({ apiKey: cfg.apiKey, model: cfg.model })))({
    apiKey: deps.claudeApiKey,
    model,
  });

export const registerPesquisaHandlers = (reg: ScriptRegistry, deps: PesquisaDeps): void => {
  reg.register("card-pesquisa-preparacao", makePreparacao(deps));
  reg.register("card-pesquisa-levantamento", makeLevantamento(deps));
  reg.register("card-pesquisa-julgamento", makeJulgamento(deps));
  reg.register("card-pesquisa-entrega", makeEntrega(deps));
};
