/**
 * End-to-end integration test for the OpenRoutines pipeline.
 *
 * This test verifies the foundation layer (worktree, git, tools, state machine)
 * without relying on external services (LLM, GitHub). All LLM responses are
 * mocked; all filesystem/git operations are real.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { resolve, join } from "path";
import { execSync } from "child_process";
import { Effect } from "effect";
import { runStateMachine } from "./state-machine.js";
import { makeGateEngine } from "../gate/gate.js";
import { makeInMemoryGateRepository } from "../gate/in-memory.js";
import { makeFilesystemTools } from "../tool/filesystem-tools.js";
import { makeGitWorktreeTools } from "../tool/git-worktree-tools.js";
import type { SkillStateMachine } from "../skill/schema.js";
import type { Routine, TriggerEvent } from "../routine/types.js";
import type { CompletionRequest, CompletionResponse } from "../provider/types.js";

// ── Test Environment ───────────────────────────────────────────────────────

const TEST_ROOT = mkdtempSync(resolve(tmpdir(), "or-e2e-"));
const REPO_PATH = join(TEST_ROOT, "repo");
const WORKTREE_BASE = join(TEST_ROOT, "worktrees");

// Create a minimal git repo with a TypeScript file and package.json
function setupRepo() {
  mkdirSync(REPO_PATH, { recursive: true });
  mkdirSync(WORKTREE_BASE, { recursive: true });

  execSync("git init", { cwd: REPO_PATH });
  execSync("git config user.email 'test@test.com'", { cwd: REPO_PATH });
  execSync("git config user.name 'Test'", { cwd: REPO_PATH });

  writeFileSync(
    join(REPO_PATH, "package.json"),
    JSON.stringify({
      name: "test-repo",
      version: "1.0.0",
      scripts: { test: "node --eval \"console.log('ok')\"" },
    })
  );

  mkdirSync(join(REPO_PATH, "src"), { recursive: true });
  writeFileSync(
    join(REPO_PATH, "src", "app.ts"),
    `export const app = () => "hello";\n`
  );

  writeFileSync(join(REPO_PATH, ".gitignore"), "node_modules\n");

  execSync("git add -A", { cwd: REPO_PATH });
  execSync("git commit -m 'initial'", { cwd: REPO_PATH });
}

function teardownRepo() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
}

// ── Mock LLM Provider ──────────────────────────────────────────────────────

interface MockLLMScenario {
  stateId: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

function createMockProvider(scenarios: MockLLMScenario[]) {
  let callIndex = 0;

  return {
    complete: (request: CompletionRequest) =>
      Effect.gen(function* () {
        const scenario = scenarios[callIndex];
        if (!scenario) {
          return {
            content: "No more scenarios",
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            toolCalls: [],
          };
        }

        callIndex++;

        // Build tool calls from scenario
        const toolCalls = scenario.toolCalls.map((tc) => ({
          id: `call-${callIndex}-${tc.name}`,
          name: tc.name,
          arguments: tc.args,
        }));

        return {
          content: `Mock response for ${scenario.stateId}`,
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          toolCalls,
        };
      }),
  };
}

// ── Mock Persistence ───────────────────────────────────────────────────────

function createMockPersistence() {
  const executions = new Map<string, any>();
  const runStates = new Map<string, any[]>();

  return {
    save: async (record: any) => {
      executions.set(record.id, record);
    },
    findById: async (id: string) => executions.get(id),
    findByExecution: async (executionId: string) => {
      return runStates.get(executionId) || [];
    },
    saveRunState: async (state: any) => {
      const list = runStates.get(state.executionId) || [];
      list.push(state);
      runStates.set(state.executionId, list);
    },
    getExecutions: () => executions,
    getRunStates: () => runStates,
  };
}

// ── Skill Definition ───────────────────────────────────────────────────────

const testSkill: SkillStateMachine = {
  id: "test-solve-issue",
  initial_state: "fetch_issue",
  states: {
    fetch_issue: {
      agent_prompt: "Fetch issue {{inputs.issue_number}}.",
      tools: ["emit_output"],
      transitions: [{ to: "analyze" }],
    },
    analyze: {
      agent_prompt: "Analyze issue.",
      tools: ["emit_output"],
      transitions: [{ to: "create_worktree" }],
    },
    create_worktree: {
      agent_prompt: "Create worktree.",
      tools: ["git_create_worktree", "emit_output"],
      transitions: [{ to: "implement" }],
    },
    implement: {
      agent_prompt: "Implement fix.",
      tools: ["edit_file", "emit_output"],
      transitions: [{ to: "verify" }],
    },
    verify: {
      agent_prompt: "Run tests.",
      tools: ["run_shell", "emit_output"],
      transitions: [{ to: "commit_and_push" }],
    },
    commit_and_push: {
      agent_prompt: "Commit changes.",
      tools: ["git_commit_and_push", "emit_output"],
      transitions: [{ to: "done" }],
    },
    done: {
      terminal: true,
    },
  },
};

const testRoutine: Routine = {
  id: "test-routine",
  triggers: [{ type: "api" }],
  pipeline: { skill: "test-solve-issue" },
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("OpenRoutines E2E Pipeline", () => {
  beforeAll(() => {
    setupRepo();
  });

  afterAll(() => {
    teardownRepo();
  });

  it("should complete the full pipeline end-to-end", async () => {
    // Override env for test
    const originalProjectRoot = process.env.PROJECT_ROOT;
    const originalWorktreeBase = process.env.WORKTREE_BASE;
    process.env.PROJECT_ROOT = REPO_PATH;
    process.env.WORKTREE_BASE = WORKTREE_BASE;

    try {
      const persistence = createMockPersistence();
      const gateRepository = makeInMemoryGateRepository();
      const gateEngine = makeGateEngine({ repository: gateRepository });

      // Prepare the exact sequence of tool calls the agent will make
      const worktreeBranch = "feat/e2e-test";
      const scenarios: MockLLMScenario[] = [
        // fetch_issue: emit issue details
        {
          stateId: "fetch_issue",
          toolCalls: [
            {
              name: "emit_output",
              args: {
                content: JSON.stringify({
                  issue: {
                    number: 999,
                    title: "Add goodbye endpoint",
                    body: "Add a goodbye function.",
                    labels: [{ name: "enhancement" }],
                  },
                }),
              },
            },
          ],
        },
        // analyze: emit plan
        {
          stateId: "analyze",
          toolCalls: [
            {
              name: "emit_output",
              args: {
                content: JSON.stringify({
                  plan: {
                    summary: "Add goodbye function",
                    files_to_modify: ["src/app.ts"],
                    files_to_create: [],
                    test_strategy: "Run npm test",
                  },
                }),
              },
            },
          ],
        },
        // create_worktree: create worktree then emit output
        {
          stateId: "create_worktree",
          toolCalls: [
            {
              name: "git_create_worktree",
              args: { branch: worktreeBranch },
            },
            {
              name: "emit_output",
              args: {
                content: JSON.stringify({ worktree: { path: "__DYNAMIC__", branch: worktreeBranch } }),
              },
            },
          ],
        },
        // implement: edit file then emit
        {
          stateId: "implement",
          toolCalls: [
            {
              name: "edit_file",
              args: {
                path: "src/app.ts",
                cwd: "__DYNAMIC__",
                operations: [
                  {
                    type: "insert_after",
                    target: 'export const app = () => "hello";',
                    content: '\nexport const goodbye = () => "bye";',
                  },
                ],
              },
            },
            {
              name: "emit_output",
              args: {
                content: JSON.stringify({
                  changes: [{ file: "src/app.ts", action: "modified", description: "Added goodbye" }],
                }),
              },
            },
          ],
        },
        // verify: run tests then emit
        {
          stateId: "verify",
          toolCalls: [
            {
              name: "run_shell",
              args: {
                command: "npm test -- --run",
                cwd: "__DYNAMIC__",
              },
            },
            {
              name: "emit_output",
              args: {
                content: JSON.stringify({
                  verification: {
                    tests_passed: true,
                    typecheck_passed: true,
                    lint_passed: true,
                    notes: "All good",
                  },
                }),
              },
            },
          ],
        },
        // commit_and_push: commit then emit
        {
          stateId: "commit_and_push",
          toolCalls: [
            {
              name: "git_commit_and_push",
              args: {
                message: "feat: add goodbye endpoint",
                cwd: "__DYNAMIC__",
              },
            },
            {
              name: "emit_output",
              args: {
                content: JSON.stringify({ commit: { committed: true, pushed: true, branch: worktreeBranch } }),
              },
            },
          ],
        },
      ];

      const mockProvider = createMockProvider(scenarios);

      // We need to resolve the worktree path dynamically after create_worktree runs.
      // The mock provider uses "__DYNAMIC__" as placeholder for cwd.
      // We'll patch the tool registry to inject the real worktree path.
      let worktreePath = "";

      const baseTools = [
        ...makeFilesystemTools(),
        ...makeGitWorktreeTools(),
      ];

      const tools = baseTools.map((tool) => {
        if (tool.definition.name === "git_create_worktree") {
          return {
            ...tool,
            handler: async (args: any) => {
              const result = await tool.handler(args);
              const parsed = JSON.parse(String(result));
              if (parsed.worktree?.path) {
                worktreePath = parsed.worktree.path;
              }
              return result;
            },
          };
        }
        if (tool.definition.name === "edit_file" || tool.definition.name === "run_shell" || tool.definition.name === "git_commit_and_push") {
          return {
            ...tool,
            handler: async (args: any) => {
              const patched = { ...args };
              if (patched.cwd === "__DYNAMIC__") {
                patched.cwd = worktreePath;
              }
              return tool.handler(patched);
            },
          };
        }
        return tool;
      });

      const toolRegistry = {
        getHandler: (name: string) => {
          const tool = tools.find((t) => t.definition.name === name);
          return tool ? tool.handler : undefined;
        },
        getDefinition: (name: string) => {
          const tool = tools.find((t) => t.definition.name === name);
          return tool ? tool.definition : undefined;
        },
        listDefinitions: () => tools.map((t) => t.definition),
      };

      const stateMachine = runStateMachine({
        provider: mockProvider,
        repository: persistence as any,
        gateEngine,
        toolRegistry: toolRegistry as any,
      });

      const event: TriggerEvent = {
        type: "api",
        payload: { repo: "test/test", issue_number: 999 },
      };

      const result = await Effect.runPromise(
        stateMachine(testSkill, testRoutine, event, "test-exec-1")
      );

      // ── Assertions ──

      // 1. Pipeline completed successfully
      expect(result.success).toBe(true);

      // 2. Worktree was created
      expect(worktreePath).not.toBe("");
      expect(existsSync(worktreePath)).toBe(true);

      // 3. File was edited in the worktree
      const editedFile = join(worktreePath, "src", "app.ts");
      expect(existsSync(editedFile)).toBe(true);
      const content = readFileSync(editedFile, "utf-8");
      expect(content).toContain("goodbye");

      // 4. Changes were committed
      const log = execSync(`git log --oneline ${worktreeBranch}`, { cwd: REPO_PATH, encoding: "utf-8" });
      expect(log).toContain("feat: add goodbye endpoint");

      // 5. Run states were persisted
      const runStates = persistence.getRunStates().get("test-exec-1") || [];
      const stateIds = runStates.map((rs: any) => rs.stateId);
      expect(stateIds).toContain("fetch_issue");
      expect(stateIds).toContain("analyze");
      expect(stateIds).toContain("create_worktree");
      expect(stateIds).toContain("implement");
      expect(stateIds).toContain("verify");
      expect(stateIds).toContain("commit_and_push");

      // 6. No gates were created (skill has no gate)
      const gate = await gateRepository.findByExecution("test-exec-1");
      expect(gate).toBeUndefined();

    } finally {
      process.env.PROJECT_ROOT = originalProjectRoot;
      process.env.WORKTREE_BASE = originalWorktreeBase;
    }
  }, 60000);
});
