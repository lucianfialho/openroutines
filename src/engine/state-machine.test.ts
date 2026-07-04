import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveOutputPaths,
  buildContext,
  evaluateNextState,
  applyReviewRejection,
  extractAndValidateOutput,
  applyToolCalls,
  executeLLMStep,
  checkGateTransition,
  runAutoActions,
  persistImplementFileMetadata,
  persistStateContext,
} from "./state-machine.js";
import type { SkillStateMachineState } from "../skill/schema.js";
import type { CompletionResponse, Message } from "../provider/types.js";
import type { ToolCall } from "../tool/types.js";
import { loadSkill } from "../skill/loader.js";

const state = (s: Partial<SkillStateMachineState>): SkillStateMachineState => s as SkillStateMachineState;

const response = (over: Partial<CompletionResponse>): CompletionResponse => ({
  content: "",
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  model: "mock",
  finishReason: "stop",
  ...over,
});

const registryOf = (handlers: Record<string, (args: any) => Promise<string>>) => ({
  getHandler: (name: string) => handlers[name],
  getDefinition: (name: string) => ({ name, description: "", parameters: { type: "object", properties: {} } }),
  listDefinitions: () => [],
}) as any;

describe("resolveOutputPaths", () => {
  it("uses the state's explicit output_path verbatim", () => {
    const r = resolveOutputPaths(state({ output_path: "custom/out.yaml" }), {}, "exec1", "s1");
    expect(r.outputPath).toBe("custom/out.yaml");
    expect(r.templateOutputPath).toBe("custom/out.yaml");
    expect(r.worktreePath).toBeUndefined();
  });

  it("derives a worktree path and a cwd-relative template path", () => {
    const outputs = { create_worktree: { worktree: { path: "/wt/repo" } } };
    const r = resolveOutputPaths(state({}), outputs, "exec1", "implement");
    expect(r.worktreePath).toBe("/wt/repo");
    expect(r.outputPath).toBe("/wt/repo/.gates/outputs/exec1/implement.output.yaml");
    expect(r.templateOutputPath).toBe(".gates/outputs/exec1/implement.output.yaml");
  });

  it("falls back to a repo-relative path with no worktree", () => {
    const r = resolveOutputPaths(state({}), {}, "exec1", "s1");
    expect(r.outputPath).toBe(".gates/outputs/exec1/s1.output.yaml");
  });

  it("derives the worktree from the F3 `preparation` output key too (card-to-pr)", () => {
    const outputs = { preparation: { worktree: { path: "/wt/card-x" } } };
    const r = resolveOutputPaths(state({}), outputs, "exec1", "implementation");
    expect(r.worktreePath).toBe("/wt/card-x");
    expect(r.outputPath).toBe("/wt/card-x/.gates/outputs/exec1/implementation.output.yaml");
  });

  it("derives the worktree from the F4 #157 `rework_preparation` output key too (rework flow)", () => {
    const outputs = { rework_preparation: { worktree: { path: "/wt/rework-x" } } };
    const r = resolveOutputPaths(state({}), outputs, "exec1", "rework");
    expect(r.worktreePath).toBe("/wt/rework-x");
    expect(r.outputPath).toBe("/wt/rework-x/.gates/outputs/exec1/rework.output.yaml");
  });
});

describe("buildContext", () => {
  it("assembles the template context", () => {
    const ctx = buildContext({ a: 1 }, { b: 2 }, "out.yaml");
    expect(ctx).toEqual({ inputs: { a: 1 }, outputs: { b: 2 }, output_path: "out.yaml" });
  });
});

describe("evaluateNextState", () => {
  it("returns the first unconditional transition", () => {
    expect(evaluateNextState(state({ transitions: [{ to: "next" }] }), {})).toBe("next");
  });

  it("skips a transition whose condition is false", () => {
    const s = state({ transitions: [{ to: "a", when: "output.x == 'y'" }, { to: "b" }] });
    expect(evaluateNextState(s, { x: "z" })).toBe("b");
  });

  it("returns undefined when nothing matches", () => {
    const s = state({ transitions: [{ to: "a", when: "output.x == 'y'" }] });
    expect(evaluateNextState(s, { x: "z" })).toBeUndefined();
  });

  it("returns undefined with no transitions", () => {
    expect(evaluateNextState(state({}), {})).toBeUndefined();
  });

  // #128 exit criterion: the REAL solve-issue skill.yaml must cross `verify`
  // without a defect. Loads the actual artifact so a future `outputs.`/typo
  // regression in a condition (e.g. via POST /skills/:name) fails CI, not prod.
  it("routes the real solve-issue verify state without throwing", () => {
    const skill = loadSkill(".gates/skills", "solve-issue");
    expect(skill.format).toBe("state-machine");
    const verify = (skill as { stateMachine: { states: Record<string, SkillStateMachineState> } }).stateMachine.states.verify;
    expect(verify).toBeDefined();

    // tests fail → back to implement; tests pass → forward (pr_gate). Neither throws.
    const failed = evaluateNextState(verify, { verify: { verification: { tests_passed: false, typecheck_passed: true } } });
    expect(failed).toBe("implement");
    const passed = evaluateNextState(verify, { verify: { verification: { tests_passed: true, typecheck_passed: true } } });
    expect(passed).toBe("pr_gate");
  });
});

describe("applyReviewRejection", () => {
  it("passes non-review states through unchanged", () => {
    const out = { anything: true };
    expect(applyReviewRejection("implement", out, {}, {})).toBe(out);
  });

  it("rejects a review when implement produced no changes", () => {
    const result = applyReviewRejection(
      "review",
      { verdict: "approved" },
      { implement: { changes: [] } },
      { issue_title: "Add feature" }
    ) as { verdict: string; note: string };
    expect(result.verdict).toBe("rejected");
    expect(result.note).toContain("No files were modified");
  });

  it("does not reject a no-op issue with no changes", () => {
    const out = { verdict: "approved" };
    const result = applyReviewRejection("review", out, { implement: { changes: [] } }, { issue_title: "No-op cleanup" });
    expect(result).toBe(out);
  });

  it("keeps a review with changes untouched", () => {
    const out = { verdict: "approved" };
    const result = applyReviewRejection("review", out, { implement: { changes: [{ file: "a" }] } }, {});
    expect(result).toBe(out);
  });
});

describe("extractAndValidateOutput", () => {
  it("prefers emitted JSON output", () => {
    const r = extractAndValidateOutput(response({}), '{"ok":true}', undefined, state({}), "no/such/path", "s1");
    expect(r).toEqual({ ok: true, output: { ok: true } });
  });

  it("falls back to raw string for unparseable emitted output", () => {
    const r = extractAndValidateOutput(response({}), "just text", undefined, state({}), "no/such/path", "s1");
    expect(r).toEqual({ ok: true, output: "just text" });
  });

  it("extracts from LLM content when nothing was emitted", () => {
    const r = extractAndValidateOutput(response({ content: '{"from":"content"}' }), undefined, undefined, state({}), "no/such/path", "s1");
    expect(r).toEqual({ ok: true, output: { from: "content" } });
  });

  it("uses the last structured tool result when extraction is not structured", () => {
    const r = extractAndValidateOutput(response({ content: "plain text" }), undefined, { tool: "result" }, state({}), "no/such/path", "s1");
    expect(r).toEqual({ ok: true, output: { tool: "result" } });
  });

  it("fails schema validation", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-schema-"));
    const schemaPath = join(dir, "schema.json");
    writeFileSync(schemaPath, JSON.stringify({ type: "object", required: ["name"], properties: { name: { type: "string" } } }));
    const r = extractAndValidateOutput(response({}), '{"other":1}', undefined, state({ output_schema: schemaPath }), "no/path", "s1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Schema validation failed in state s1");
  });
});

describe("applyToolCalls", () => {
  const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: `id-${name}`, name, arguments: args });

  it("captures emit_output and appends tool messages", async () => {
    const messages: Message[] = [];
    const registry = registryOf({ emit_output: async () => JSON.stringify({ emitted: true }) });
    const r = await Effect.runPromise(
      applyToolCalls([call("emit_output", { content: '{"done":1}' })], registry, "s1", undefined, "exec1", messages, new Map())
    );
    expect(r.emitOutputCalled).toBe(true);
    expect(r.emittedOutput).toBe('{"done":1}');
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("tool");
  });

  it("captures structured tool results (non-emit)", async () => {
    const messages: Message[] = [];
    const registry = registryOf({ read_file: async () => JSON.stringify({ data: 42 }) });
    const r = await Effect.runPromise(
      applyToolCalls([call("read_file")], registry, "s1", undefined, "exec1", messages, new Map())
    );
    expect(r.emitOutputCalled).toBe(false);
    expect(r.lastStructuredToolResult).toEqual({ data: 42 });
  });

  it("auto-injects cwd for filesystem tools in a worktree", async () => {
    const seen: any[] = [];
    const registry = registryOf({ write_file: async (a: any) => { seen.push(a); return "{}"; } });
    await Effect.runPromise(
      applyToolCalls([call("write_file", { path: "x" })], registry, "s1", "/wt", "exec1", [], new Map())
    );
    expect(seen[0].cwd).toBe("/wt");
    expect(seen[0]._executionId).toBe("exec1");
  });

  it("enforces the repeat limit after two uses", async () => {
    const messages: Message[] = [];
    const counts = new Map<string, number>();
    const registry = registryOf({ search: async () => "{}" });
    const batch = [call("search"), call("search"), call("search")];
    await Effect.runPromise(applyToolCalls(batch, registry, "s1", undefined, "exec1", messages, counts));
    const limited = messages.filter((m) => String(m.content).includes("has already been used"));
    expect(limited).toHaveLength(1);
  });

  it("reports unknown tools", async () => {
    const messages: Message[] = [];
    const r = await Effect.runPromise(
      applyToolCalls([call("nope")], registryOf({}), "s1", undefined, "exec1", messages, new Map())
    );
    expect(r.emitOutputCalled).toBe(false);
    expect(String(messages[0].content)).toContain("not found");
  });

  it("rejects a tool outside the state allowlist even when globally registered", async () => {
    const messages: Message[] = [];
    let ran = false;
    const registry = registryOf({ run_shell: async () => { ran = true; return JSON.stringify({ ran: true }); } });
    const r = await Effect.runPromise(
      applyToolCalls([call("run_shell", { command: "id" })], registry, "verify", undefined, "exec1", messages, new Map(), ["read_file"])
    );
    expect(ran).toBe(false);
    expect(r.lastStructuredToolResult).toBeUndefined();
    expect(String(messages[0].content)).toContain("not allowed");
  });

  it("allows a tool that is in the state allowlist", async () => {
    const messages: Message[] = [];
    const registry = registryOf({ read_file: async () => JSON.stringify({ data: 1 }) });
    const r = await Effect.runPromise(
      applyToolCalls([call("read_file")], registry, "verify", undefined, "exec1", messages, new Map(), ["read_file"])
    );
    expect(r.lastStructuredToolResult).toEqual({ data: 1 });
  });
});

describe("executeLLMStep", () => {
  const provider = (r: CompletionResponse | Error) => ({
    complete: () => (r instanceof Error ? Effect.fail(r) : Effect.succeed(r)),
  });

  it("returns ok with a final answer when no tools are called", async () => {
    const p = provider(response({ content: "answer", usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } }));
    const r = await Effect.runPromise(
      executeLLMStep(p as any, "skill", state({}), "s1", "prompt", undefined, undefined, "exec1")
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.llmResponse.content).toBe("answer");
      expect(r.usage.totalTokens).toBe(7);
      expect(r.emittedOutput).toBeUndefined();
    }
  });

  it("stops on emit_output and captures the payload", async () => {
    const registry = registryOf({ emit_output: async () => "{}" });
    const p = provider(response({ toolCalls: [{ id: "1", name: "emit_output", arguments: { content: "final" } }] }));
    const r = await Effect.runPromise(
      executeLLMStep(p as any, "skill", state({ tools: ["emit_output"] }), "s1", "prompt", registry, undefined, "exec1")
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.emittedOutput).toBe("final");
  });

  it("returns an error result when the provider fails", async () => {
    const r = await Effect.runPromise(
      executeLLMStep(provider(new Error("boom")) as any, "skill", state({}), "s1", "prompt", undefined, undefined, "exec1")
    );
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.error).toContain("LLM error in state s1: boom");
  });

  it("threads structured tool results and tokens across multiple rounds", async () => {
    let call = 0;
    const multi = {
      complete: () => {
        call++;
        return Effect.succeed(
          call === 1
            ? response({ toolCalls: [{ id: "t1", name: "read_file", arguments: { path: "a" } }], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
            : response({ content: "final answer", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } })
        );
      },
    };
    const registry = registryOf({ read_file: async () => JSON.stringify({ found: "data" }) });
    const r = await Effect.runPromise(
      executeLLMStep(multi as any, "skill", state({ tools: ["read_file"] }), "s1", "prompt", registry, undefined, "exec1")
    );
    expect(call).toBe(2);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.lastStructuredToolResult).toEqual({ found: "data" });
      expect(r.llmResponse.content).toBe("final answer");
      expect(r.usage.totalTokens).toBe(5);
    }
  });
});

describe("checkGateTransition", () => {
  it("approves when the state has no gate", async () => {
    const r = await Effect.runPromise(checkGateTransition(undefined, "exec1", "s1", state({})));
    expect(r).toEqual({ approved: true });
  });

  it("delegates to the gate engine when a gate is set", async () => {
    const engine = { checkGate: async () => ({ approved: false, gateId: "g1" }) } as any;
    const r = await Effect.runPromise(checkGateTransition(engine, "exec1", "s1", state({ gate: "manual_approval" })));
    expect(r).toEqual({ approved: false, gateId: "g1" });
  });
});

describe("runAutoActions", () => {
  it("does nothing for a state without auto_action", async () => {
    const r = await Effect.runPromise(runAutoActions(state({}), "implement", "/wt", {}, {}, undefined, undefined));
    expect(r).toEqual({ succeeded: false });
  });

  it("blocks a commit when file metadata is missing", async () => {
    const fileMetadata = { findByPath: async () => undefined } as any;
    const outputs = { implement: { changes: [{ file: "src/a.ts" }] } };
    const r = await Effect.runPromise(runAutoActions(state({ auto_action: "commit_and_push" }), "commit_and_push", "/wt", outputs, {}, undefined, fileMetadata));
    expect(r.succeeded).toBe(false);
    expect(r.blocked).toContain("src/a.ts");
  });

  it("blocks a commit when metadata exists but is not complete", async () => {
    const fileMetadata = { findByPath: async () => ({ path: "src/a.ts", status: "stub" }) } as any;
    const outputs = { implement: { changes: [{ file: "src/a.ts" }] } };
    const r = await Effect.runPromise(runAutoActions(state({ auto_action: "commit_and_push" }), "commit_and_push", "/wt", outputs, {}, undefined, fileMetadata));
    expect(r.succeeded).toBe(false);
    expect(r.blocked).toContain("src/a.ts");
  });

  it("dispatches by auto_action value, not by state name", async () => {
    // A state NOT named commit_and_push still auto-commits when it declares the action.
    const fileMetadata = { findByPath: async () => undefined } as any;
    const outputs = { implement: { changes: [{ file: "src/a.ts" }] } };
    const r = await Effect.runPromise(runAutoActions(state({ auto_action: "commit_and_push" }), "finalize", "/wt", outputs, {}, undefined, fileMetadata));
    expect(r.succeeded).toBe(false);
    expect(r.blocked).toContain("src/a.ts");
  });
});

describe("persistImplementFileMetadata", () => {
  it("saves metadata for each implement change", async () => {
    const saved: any[] = [];
    const repo = { save: async (m: any) => { saved.push(m); } } as any;
    const output = { changes: [{ file: "src/a.ts", description: "edit a" }, { file: "src/b.ts", description: "edit b" }] };
    await Effect.runPromise(persistImplementFileMetadata(repo, "implement", output, { issue_number: 7 }, "exec1"));
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ path: "src/a.ts", status: "complete", issueNumber: 7, executionId: "exec1", specialist: "backend" });
    expect(saved[0].summary).toContain("edit a");
  });

  it("is a no-op for non-implement states and when the repo is absent", async () => {
    const repo = { save: async () => { throw new Error("should not save"); } } as any;
    const output = { changes: [{ file: "x", description: "y" }] };
    await expect(Effect.runPromise(persistImplementFileMetadata(repo, "verify", output, {}, "e1"))).resolves.toBeUndefined();
    await expect(Effect.runPromise(persistImplementFileMetadata(undefined, "implement", output, {}, "e1"))).resolves.toBeUndefined();
  });
});

describe("persistStateContext", () => {
  it("merges the state machine context into the existing record", async () => {
    const records = new Map<string, any>();
    records.set("exec1", { id: "exec1", metadata: { existing: true } });
    const repo = {
      findById: async (id: string) => records.get(id),
      save: async (rec: any) => { records.set(rec.id, rec); },
    } as any;
    await Effect.runPromise(
      persistStateContext(repo, "exec1", {
        currentState: "s2",
        outputs: { out: 1 },
        inputs: { in: 2 },
        transitionCounts: { "a->b": 1 },
        totalCostUsd: 0.07,
        costByProvider: { default: 0.07 },
      })
    );
    const saved = records.get("exec1");
    expect(saved.metadata.existing).toBe(true);
    expect(saved.metadata.stateMachineContext).toEqual({
      currentState: "s2",
      outputs: { out: 1 },
      inputs: { in: 2 },
      transitionCounts: { "a->b": 1 },
      totalCostUsd: 0.07,
      costByProvider: { default: 0.07 },
    });
  });

  it("is a no-op when the execution does not exist", async () => {
    const repo = { findById: async () => undefined, save: async () => { throw new Error("should not save"); } } as any;
    await expect(
      Effect.runPromise(persistStateContext(repo, "missing", { currentState: "s1", outputs: {} }))
    ).resolves.toBeUndefined();
  });
});
