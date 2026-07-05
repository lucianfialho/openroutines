/**
 * card-research script handlers (F5 #161).
 *
 * Wires the 4 deterministic (`type: script`) states of
 * `.gates/skills/card-research/skill.yaml` into a ScriptRegistry, following the
 * same shape as card-to-pr's index.ts (registerCardToPrHandlers): deps injected
 * as closures, one injectable seam per external effect so tests never need a
 * real repo, GitHub, Trello, or a live model call.
 *
 * Unlike card-to-pr, the two LLM phases (survey, judgment) are ALSO
 * script states here, not `type: agent` states — the runner only wires a
 * per-phase CLI tool allowlist for `fanout` lenses, and survey REQUIRES a
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
import { makePreparation } from "./preparation.js";
import { makeSurvey } from "./survey.js";
import { makeJudgment } from "./judgment.js";
import { makeDelivery } from "./delivery.js";

const execFileAsync = promisify(execFile);

/** Models per phase (constants, not skill.yaml `model:` — these are script states). */
export const SONNET_MODEL = "claude-sonnet-5";
export const OPUS_MODEL = "claude-opus-4-8";

/**
 * Minimal provider seam: only `complete` is used. Both real factories
 * (claude-cli, claude) satisfy it (their ClaudeCliError/ClaudeError error
 * channels widen to `unknown`), and a test fake is just `{ complete }`.
 */
export interface ResearchProvider {
  complete: (req: CompletionRequest) => Effect.Effect<CompletionResponse, unknown>;
}

export interface ResearchDeps {
  registry: RepoRegistry;
  githubToken: string;
  worktreeBase: string; // env WORKTREE_BASE, e.g. /tmp/or-worktrees
  taskSourceFor: (sourceId: string) => TaskSource | undefined;
  /** Anthropic API key for the billed judge provider (claude.ts / Opus). */
  claudeApiKey: string;
  /**
   * Action ledger (F5 #162 hardening): when present, delivery wraps its GitHub
   * issue/milestone creation and card handoff so a crash mid-delivery + resume
   * never mints a duplicate issue. Optional to keep the existing e2e harness
   * (which never crashes mid-delivery) unchanged; app.ts always wires it.
   */
  ledger?: ActionLedgerRepository;
  // Injectable seams for tests (default to the real impls):
  makeGithub?: (cfg: { token: string; repo: string }) => ReturnType<typeof makeGitHubConnector>;
  /** CLI provider for the read-only survey (claude-cli / Sonnet). */
  makeCliProvider?: (cfg: { model: string }) => ResearchProvider;
  /** Billed API provider for the architecture judgment (claude.ts / Opus). */
  makeApiProvider?: (cfg: { apiKey: string; model: string }) => ResearchProvider;
  /** Read-only worktree git ops (fetch/worktree add/rev-parse). */
  runGit?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
}

/** Default git runner: execFile argv only, inherits the full env (all ops are read-only local). */
export const defaultRunGit =
  (args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> =>
    execFileAsync("git", args, { cwd });

export const resolveGithub = (deps: ResearchDeps, repo: string): ReturnType<typeof makeGitHubConnector> =>
  (deps.makeGithub ?? makeGitHubConnector)({ token: deps.githubToken, repo });

export const resolveCliProvider = (deps: ResearchDeps, model: string): ResearchProvider =>
  (deps.makeCliProvider ?? ((cfg) => makeClaudeCliProvider({ model: cfg.model })))({ model });

export const resolveApiProvider = (deps: ResearchDeps, model: string): ResearchProvider =>
  (deps.makeApiProvider ?? ((cfg) => makeClaudeProvider({ apiKey: cfg.apiKey, model: cfg.model })))({
    apiKey: deps.claudeApiKey,
    model,
  });

export const registerResearchHandlers = (reg: ScriptRegistry, deps: ResearchDeps): void => {
  reg.register("card-research-preparation", makePreparation(deps));
  reg.register("card-research-survey", makeSurvey(deps));
  reg.register("card-research-judgment", makeJudgment(deps));
  reg.register("card-research-delivery", makeDelivery(deps));
};
