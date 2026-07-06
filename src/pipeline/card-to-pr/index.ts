/**
 * card-to-pr script handlers (F3 #146).
 *
 * Wires the 4 deterministic (`type: script`) states of
 * `.gates/skills/card-to-pr/skill.yaml` into a ScriptRegistry. Dependencies
 * are injected as closures (ScriptContext carries no DI container), with an
 * injectable seam per external effect so tests never need a real repo,
 * GitHub, or task source.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import type { Pool } from "pg";
import type { ScriptRegistry } from "../../script/registry.js";
import type { RepoRegistry } from "../../repo-registry/schema.js";
import type { ActionLedgerRepository, PrLinkRepository } from "../../persistence/types.js";
import type { TaskSource } from "../../task-source/types.js";
import { makeGitHubConnector } from "../../connector/github.js";
import { runVerifyCommands } from "../../verify/run-commands.js";
import { getOrCreateBaseline } from "../../verify/baseline.js";
import { pickEnv, BASE_ENV_VARS } from "../../util/env.js";
import { sendTelegramAlert } from "../../notify/telegram.js";
import { aggregateReview } from "../../review/aggregate.js";
import { makePreparation } from "./preparation.js";
import { makeVerify } from "./verify.js";
import { makePr } from "./pr.js";
import { makeBlocked } from "./blocked.js";
import { makeReworkPreparation, makeReworkQuestion } from "./rework.js";
import { makeVisual, type VisualDeps } from "./visual.js";

/**
 * Named `type: fanout` aggregators for card-to-pr (F4 #153) — resolved by the
 * runner via `StateMachineConfig.fanoutAggregators` when a state declares
 * `aggregate: aggregateReview` (see skill.yaml's `review` state). Wiring
 * this into StateMachineConfig at boot is the next agent's job (app.ts).
 */
export const cardToPrFanoutAggregators = { aggregateReview };

const execFileAsync = promisify(execFile);

export interface CardToPrDeps {
  pool?: Pool; // for baseline; undefined in no-DB mode
  registry: RepoRegistry;
  githubToken: string;
  worktreeBase: string; // env WORKTREE_BASE, e.g. /tmp/or-worktrees
  /** REPOS_BASE_DIR — root for resolving/cloning a card's repo by name (Bloco 1). */
  reposBaseDir?: string;
  /** ALLOWED_REPO_OWNERS — owners a bare card repo name may be cloned from (Bloco 1). */
  allowedOwners?: string[];
  ledger: ActionLedgerRepository;
  prLinks: PrLinkRepository;
  taskSourceFor: (sourceId: string) => TaskSource | undefined;
  // Injectable seams for tests (default to the real impls):
  makeGithub?: (cfg: { token: string; repo: string }) => ReturnType<typeof makeGitHubConnector>;
  runGit?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  runVerify?: typeof runVerifyCommands;
  getBaseline?: typeof getOrCreateBaseline;
  /** Telegram alert seam (D22, F4 #186) — defaults to the real sender; tests inject a mock. */
  sendAlert?: typeof sendTelegramAlert;
  /**
   * Agent commit identity for the rework human-commit guard (F4 #157) —
   * matched against git log %an/%ae. Defaults to DEFAULT_AGENT_GIT_AUTHORS
   * (the identity git-worktree-tools configures in worktrees).
   */
  agentGitAuthors?: string[];
  /**
   * Visual phase deps (F5 #160) — the Kimi/vision providers + compose/SSIM/
   * attach seams the `visual` state needs. Absent in flows that never reach
   * `visual` (non-UI cards); the handler throws if invoked without it.
   */
  visual?: VisualDeps;
}

/**
 * Default `runGit`: execFile argv only, never a shell string. Every call
 * inherits the full process env, like the trusted repos.yaml verify commands
 * do (src/verify/run-commands.ts) — EXCEPT `git push`, the one call that
 * authenticates against GitHub, which gets a minimal env (PATH/HOME/
 * GITHUB_TOKEN only), never the orchestrator's full secret set. Shared by
 * preparation (fetch/worktree/rev-parse), verify (diff --name-only) and pr
 * (push) so a single injected seam covers every git call in this module.
 */
export const defaultRunGit =
  (githubToken: string) =>
  (args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> =>
    execFileAsync(
      "git",
      args,
      args[0] === "push" ? { cwd, env: { ...pickEnv(BASE_ENV_VARS), GITHUB_TOKEN: githubToken } } : { cwd }
    );

export const registerCardToPrHandlers = (reg: ScriptRegistry, deps: CardToPrDeps): void => {
  reg.register("card-to-pr-preparation", makePreparation(deps));
  reg.register("card-to-pr-verify", makeVerify(deps));
  reg.register("card-to-pr-visual", makeVisual(deps));
  reg.register("card-to-pr-pr", makePr(deps));
  reg.register("card-to-pr-blocked", makeBlocked(deps));
  reg.register("card-to-pr-rework-preparation", makeReworkPreparation(deps));
  reg.register("card-to-pr-rework-question", makeReworkQuestion(deps));
};
