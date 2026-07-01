/**
 * State Machine Runner
 *
 * Executes YAML state-machine skills step by step.
 * Ported from atomic-gates/lib/runner.py to TypeScript/Effect v4.
 *
 * `runStateMachine` drives the main loop; the per-state work is split into
 * small, independently testable helpers below (path resolution, LLM step,
 * tool-call execution, output extraction/validation, gate check, transition).
 */

import { Effect } from "effect";
import type { SkillStateMachine, SkillStateMachineState } from "../skill/schema.js";
import type { CompletionRequest, CompletionResponse, Message } from "../provider/types.js";
import type { ToolCall, ToolDefinition } from "../tool/types.js";
import type { ExecutionResult } from "./types.js";
import type { TriggerEvent } from "../routine/matcher.js";
import type { Routine } from "../routine/types.js";
import type { GateEngine } from "../gate/gate.js";
import type { ToolRegistry } from "../tool/registry.js";
import type {
  ExecutionRepository,
  RunStateRepository,
  FileMetadataRepository,
} from "../persistence/types.js";
import { renderTemplate, type TemplateContext } from "./template.js";
import { extractOutput } from "./output.js";
import { evaluateCondition } from "./condition.js";
import { validate, type JsonSchema } from "./schema-validate.js";
import { readFileSync, mkdirSync } from "fs";

const AUTO_ACTIONS_ENABLED = !process.env.OPENROUTINES_DISABLE_AUTO_ACTIONS;

export interface StateMachineConfig {
  provider: {
    complete: (request: CompletionRequest) => Effect.Effect<CompletionResponse, Error>;
  };
  repository: ExecutionRepository;
  runStateRepository?: RunStateRepository;
  fileMetadataRepository?: FileMetadataRepository;
  gateEngine?: GateEngine;
  toolRegistry?: ToolRegistry;
}

export interface StateMachineContext {
  currentState: string;
  outputs: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  implementReviewIterations?: number;
}

type Provider = StateMachineConfig["provider"];

export type GateCheckResult = { approved: true } | { approved: false; gateId: string };

export interface TokenTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Result of running the LLM tool-use loop for a single state. */
export type LLMStepResult =
  | { kind: "error"; error: string }
  | { kind: "noResponse" }
  | {
      kind: "ok";
      llmResponse: CompletionResponse;
      emittedOutput: string | undefined;
      lastStructuredToolResult: unknown;
      usage: TokenTotals;
    };

/** Result of executing one batch of tool calls. */
export interface ToolBatchResult {
  emitOutputCalled: boolean;
  emittedOutput: string | undefined;
  lastStructuredToolResult: unknown;
}

type OutputResult = { ok: true; output: unknown } | { ok: false; error: string };

const maxToolIterations = 10;

export const runStateMachine = (
  config: StateMachineConfig
) => (
  skill: SkillStateMachine,
  routine: Routine,
  event: TriggerEvent,
  executionId: string,
  context?: StateMachineContext
): Effect.Effect<ExecutionResult, never> =>
  Effect.gen(function* () {
    const { provider, repository, runStateRepository, fileMetadataRepository, gateEngine, toolRegistry } = config;
    const startedAt = new Date();
    const outputs: Record<string, unknown> = {};

    // Build inputs from event payload, or restore from resumed context
    const inputs = (context?.inputs as Record<string, unknown>) ?? (event.payload as Record<string, unknown>) ?? {};

    yield* Effect.log(`[StateMachine] Starting execution ${executionId} for skill ${skill.id}`);

    let stateId = context?.currentState ?? skill.initial_state;
    if (context) {
      Object.assign(outputs, context.outputs);
      yield* Effect.log(`[StateMachine] Resuming execution ${executionId} at state ${stateId}`);
    }
    let implementReviewIterations = context?.implementReviewIterations ?? 0;
    const maxImplementReviewIterations = 3;
    let iterations = 0;
    const maxIterations = 50;

    const fail = (error: string): Effect.Effect<ExecutionResult, never> =>
      Effect.gen(function* () {
        yield* Effect.log(`[StateMachine] Execution failed: ${error}`);
        const finishedAt = new Date();
        yield* persistExecution(repository, {
          id: executionId,
          routineId: routine.id,
          triggerType: event.type,
          skillName: skill.id,
          status: "failed",
          error,
          startedAt,
          finishedAt,
        });
        return { executionId, success: false, output: error, logs: [error], startedAt, finishedAt };
      });

    const succeed = (output: string): Effect.Effect<ExecutionResult, never> =>
      Effect.gen(function* () {
        const finishedAt = new Date();
        yield* persistExecution(repository, {
          id: executionId,
          routineId: routine.id,
          triggerType: event.type,
          skillName: skill.id,
          status: "completed",
          output,
          startedAt,
          finishedAt,
        });
        return {
          executionId,
          success: true,
          output,
          logs: [`Reached terminal state: ${stateId}`],
          startedAt,
          finishedAt,
        };
      });

    const pauseForGate = (
      state: SkillStateMachineState,
      stateId: string,
      gateId: string
    ): Effect.Effect<ExecutionResult, never> =>
      Effect.gen(function* () {
        yield* Effect.log(`[StateMachine] Gate '${state.gate}' blocked at state ${stateId}`);
        yield* persistExecution(repository, {
          id: executionId,
          routineId: routine.id,
          triggerType: event.type,
          skillName: skill.id,
          status: "paused",
          output: `Waiting for gate approval: ${state.gate} at state ${stateId}`,
          startedAt,
          metadata: {
            stateMachineContext: { currentState: stateId, outputs, inputs, implementReviewIterations },
            gateId,
            gateType: state.gate,
            gateStatus: "pending",
          },
        });
        return {
          executionId,
          success: false,
          output: `Waiting for gate approval: ${state.gate} at state ${stateId}`,
          logs: [`Gate blocked: ${state.gate} at state ${stateId}`, `Gate ID: ${gateId}`],
          startedAt,
          finishedAt: new Date(),
          paused: true,
          gateId,
        };
      });

    while (stateId) {
      iterations++;
      if (iterations > maxIterations) {
        yield* Effect.log(`[StateMachine] Max iterations exceeded`);
        return yield* fail("Max iterations exceeded");
      }

      const state = skill.states[stateId];
      if (!state) {
        yield* Effect.log(`[StateMachine] Unknown state: ${stateId}`);
        return yield* fail(`Unknown state: ${stateId}`);
      }

      yield* Effect.log(`[StateMachine] State: ${stateId}`);

      // Persist context at the START of each state so resume begins from the correct state
      yield* persistStateContext(repository, executionId, stateId, outputs, inputs, implementReviewIterations);

      // Terminal state
      if (state.terminal) {
        yield* Effect.log(`[StateMachine] Reached terminal state: ${stateId}`);
        const finalOutput = outputs[stateId] ?? "";
        const output = typeof finalOutput === "string" ? finalOutput : JSON.stringify(finalOutput);
        return yield* succeed(output);
      }

      const { worktreePath, outputPath, templateOutputPath } = resolveOutputPaths(state, outputs, executionId, stateId);

      if (!state.agent_prompt && state.gate) {
        yield* Effect.log(`[StateMachine] State ${stateId} is gate-only, skipping LLM`);
      } else if (!state.agent_prompt) {
        yield* Effect.log(`[StateMachine] State ${stateId} has no agent_prompt and no gate`);
        return yield* fail(`State ${stateId} has no agent_prompt and no gate`);
      } else {
        // Ensure output directory exists in worktree so write_file can use cwd
        if (worktreePath && !state.output_path) {
          try {
            mkdirSync(`${worktreePath}/.gates/outputs/${executionId}`, { recursive: true });
          } catch {
            // ignore
          }
        }

        const auto = yield* runAutoActions(stateId, worktreePath, outputs, inputs, toolRegistry, fileMetadataRepository);
        if (auto.blocked) {
          return yield* fail(auto.blocked);
        }

        if (auto.succeeded) {
          yield* Effect.log(`[StateMachine] Auto-action succeeded for ${stateId}, skipping LLM loop`);
        } else {
          const context: TemplateContext = buildContext(inputs, outputs, templateOutputPath);
          const prompt = renderTemplate(state.agent_prompt, context);
          yield* Effect.log(`[StateMachine] Rendered prompt for ${stateId}: ${prompt.slice(0, 300)}`);

          if (runStateRepository) {
            yield* Effect.promise(() => runStateRepository.save({
              executionId,
              stateId,
              skillId: skill.id,
              agentPrompt: prompt,
              status: "running",
              startedAt: new Date(),
            })).pipe(Effect.ignore);
          }

          const step = yield* executeLLMStep(provider, skill.id, state, stateId, prompt, toolRegistry, worktreePath, executionId);
          if (step.kind === "error") {
            return yield* fail(step.error);
          }
          if (step.kind === "noResponse") {
            return {
              executionId,
              success: false,
              output: `No LLM response for state ${stateId}`,
              logs: [`No LLM response for state ${stateId}`],
              startedAt,
              finishedAt: new Date(),
            };
          }

          const extracted = extractAndValidateOutput(
            step.llmResponse,
            step.emittedOutput,
            step.lastStructuredToolResult,
            state,
            outputPath,
            stateId
          );
          if (!extracted.ok) {
            return yield* fail(extracted.error);
          }
          const stateOutput = applyReviewRejection(stateId, extracted.output, outputs, inputs);

          outputs[stateId] = stateOutput;
          if (runStateRepository) {
            yield* Effect.promise(() => runStateRepository.save({
              executionId,
              stateId,
              skillId: skill.id,
              output: stateOutput as Record<string, unknown>,
              outputValidated: !!state.output_schema,
              status: "completed",
              startedAt: new Date(),
            })).pipe(Effect.ignore);
          }
          yield* Effect.log(`[StateMachine] State ${stateId} completed`);
          yield* persistStateContext(repository, executionId, stateId, outputs, inputs, implementReviewIterations);
          yield* persistImplementFileMetadata(fileMetadataRepository, stateId, stateOutput, inputs, executionId);
        }
      }

      // Check gate on transition
      const gate = yield* checkGateTransition(gateEngine, executionId, stateId, state);
      if (!gate.approved) {
        return yield* pauseForGate(state, stateId, gate.gateId);
      }

      // Evaluate transitions
      const nextState = evaluateNextState(state, outputs);
      if (!nextState) {
        yield* Effect.log(`[StateMachine] No matching transition from state ${stateId}`);
        return yield* fail(`No matching transition from state ${stateId}`);
      }

      // Track implement→review loop iterations
      if (stateId === "review" && nextState === "implement") {
        implementReviewIterations++;
        yield* Effect.log(`[StateMachine] implement→review iteration ${implementReviewIterations}/${maxImplementReviewIterations}`);
        if (implementReviewIterations > maxImplementReviewIterations) {
          const errMsg = `Max implement→review iterations (${maxImplementReviewIterations}) reached. Manual intervention required.`;
          yield* Effect.log(`[StateMachine] ${errMsg}`);
          return yield* fail(errMsg);
        }
      }

      stateId = nextState;
    }

    // Should not reach here
    return yield* fail("State machine exited without reaching terminal state");
  });

/**
 * Resolve the disk output path and the (possibly worktree-relative) template
 * path for a state, plus the active worktree path.
 */
export const resolveOutputPaths = (
  state: SkillStateMachineState,
  outputs: Record<string, unknown>,
  executionId: string,
  stateId: string
): { worktreePath: string | undefined; outputPath: string; templateOutputPath: string } => {
  const worktreePath = (outputs.create_worktree as { worktree?: { path?: string } } | undefined)?.worktree?.path;
  const outputPath = state.output_path ?? (worktreePath
    ? `${worktreePath}/.gates/outputs/${executionId}/${stateId}.output.yaml`
    : `.gates/outputs/${executionId}/${stateId}.output.yaml`);
  // In a worktree, hand write_file a path relative to cwd.
  const templateOutputPath = worktreePath && outputPath.startsWith(worktreePath)
    ? outputPath.slice(worktreePath.length + 1)
    : outputPath;
  return { worktreePath, outputPath, templateOutputPath };
};

/** Build the template context passed to renderTemplate. */
export const buildContext = (
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown>,
  outputPath: string
): TemplateContext => ({ inputs, outputs, output_path: outputPath });

/**
 * Run built-in auto-actions for specific states (commit_and_push, create_pr).
 * On success the state output is written into `outputs[stateId]`. Returns a
 * `blocked` reason when the commit gate-metadata check fails.
 */
export const runAutoActions = (
  stateId: string,
  worktreePath: string | undefined,
  outputs: Record<string, unknown>,
  inputs: Record<string, unknown>,
  toolRegistry: ToolRegistry | undefined,
  fileMetadataRepository: FileMetadataRepository | undefined
): Effect.Effect<{ succeeded: boolean; blocked?: string }, never> =>
  Effect.gen(function* () {
    let autoActionSucceeded = false;

    if (stateId === "commit_and_push" && worktreePath) {
      // Atomic-gates style: verify file metadata exists before committing
      if (fileMetadataRepository) {
        const implOutput = outputs.implement as { changes?: Array<{ file: string }> } | undefined;
        const changedFiles = implOutput?.changes?.map((c) => c.file) ?? [];
        for (const file of changedFiles) {
          const meta = yield* Effect.promise(() => fileMetadataRepository.findByPath(file));
          if (!meta || meta.status !== "complete") {
            yield* Effect.log(`[StateMachine] Gate-metadata: ${file} lacks complete metadata, blocking commit`);
            return { succeeded: false, blocked: `Gate-metadata blocked: ${file} has no complete metadata` };
          }
        }
      }

      const commitHandler = toolRegistry?.getHandler("git_commit_and_push");
      if (commitHandler && AUTO_ACTIONS_ENABLED) {
        yield* Effect.log(`[StateMachine] Auto-running git_commit_and_push for state ${stateId}`);
        try {
          const issueTitle = String((outputs.fetch_issue as any)?.issue?.title ?? "implement changes");
          const issueLabels = ((outputs.fetch_issue as any)?.issue?.labels ?? []) as Array<{ name: string }>;
          const isBug = issueLabels.some((l) => l.name === "bug") || /bug|fix|crash|error|race|leak/i.test(issueTitle);
          const prefix = isBug ? "fix" : "feat";
          const commitMessage = `${prefix}: ${issueTitle} (closes #${inputs.issue_number})`;
          const commitResult = yield* Effect.promise(() =>
            commitHandler({ cwd: worktreePath, message: commitMessage })
          );
          const parsed = JSON.parse(String(commitResult));
          if (parsed && !parsed.error) {
            outputs[stateId] = parsed;
            autoActionSucceeded = true;
            yield* Effect.log(`[StateMachine] Auto-commit succeeded: ${JSON.stringify(parsed).slice(0, 100)}`);
          }
        } catch (autoErr) {
          yield* Effect.log(`[StateMachine] Auto-commit failed: ${autoErr}`);
        }
      }
    }

    if (stateId === "create_pr" && AUTO_ACTIONS_ENABLED) {
      const branch = (outputs.commit_and_push as { commit?: { branch?: string } } | undefined)?.commit?.branch;
      if (branch) {
        const prHandler = toolRegistry?.getHandler("github_create_pull_request");
        if (prHandler) {
          yield* Effect.log(`[StateMachine] Auto-running github_create_pull_request for state ${stateId}`);
          try {
            const issueTitle = String((outputs.fetch_issue as any)?.issue?.title ?? "implement changes");
            const issueLabels = ((outputs.fetch_issue as any)?.issue?.labels ?? []) as Array<{ name: string }>;
            const isBug = issueLabels.some((l) => l.name === "bug") || /bug|fix|crash|error|race|leak/i.test(issueTitle);
            const prTitle = `${isBug ? "fix" : "feat"}: ${issueTitle}`;
            const prResult = yield* Effect.promise(() =>
              prHandler({ branch, title: prTitle, body: `Closes #${inputs.issue_number}` })
            );
            const parsed = JSON.parse(String(prResult));
            if (parsed && !parsed.error) {
              outputs[stateId] = parsed;
              autoActionSucceeded = true;
              yield* Effect.log(`[StateMachine] Auto-PR succeeded: ${JSON.stringify(parsed).slice(0, 100)}`);
            }
          } catch (autoErr) {
            yield* Effect.log(`[StateMachine] Auto-PR failed: ${autoErr}`);
          }
        }
        if (worktreePath) {
          const removeHandler = toolRegistry?.getHandler("git_remove_worktree");
          if (removeHandler) {
            yield* Effect.log(`[StateMachine] Auto-running git_remove_worktree for state ${stateId}`);
            try {
              yield* Effect.promise(() => removeHandler({ cwd: worktreePath, branch }));
              yield* Effect.log(`[StateMachine] Auto-remove worktree succeeded`);
            } catch (autoErr) {
              yield* Effect.log(`[StateMachine] Auto-remove worktree failed: ${autoErr}`);
            }
          }
        }
      }
    }

    return { succeeded: autoActionSucceeded };
  });

/**
 * Run the LLM in a ReAct tool-use loop for one state. Executes tool calls,
 * accumulates token usage, and stops on the special emit_output tool.
 */
export const executeLLMStep = (
  provider: Provider,
  skillId: string,
  state: SkillStateMachineState,
  stateId: string,
  prompt: string,
  toolRegistry: ToolRegistry | undefined,
  worktreePath: string | undefined,
  executionId: string
): Effect.Effect<LLMStepResult, never> =>
  Effect.gen(function* () {
    const hasTools = state.tools && state.tools.length > 0 && toolRegistry;
    let lastStructuredToolResult: unknown = undefined;
    let emittedOutput: string | undefined = undefined;
    const toolCallCounts = new Map<string, number>();
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    const messages: Message[] = [
      {
        role: "system",
        content: `You are executing the '${skillId}' skill. Current state: ${stateId}. Use the provided tools to complete the task. After completing all necessary work, you MUST call emit_output with the final YAML result. Do not call any other tool after emit_output.`,
      },
      { role: "user", content: prompt },
    ];

    let llmResponse: CompletionResponse | undefined;
    let toolIteration = 0;

    while (toolIteration < maxToolIterations) {
      toolIteration++;
      yield* Effect.log(`[StateMachine] LLM call ${toolIteration} for state ${stateId}`);

      // Remind agent to return final answer on last iteration
      if (toolIteration === maxToolIterations) {
        messages.push({
          role: "user",
          content: "You have reached the maximum number of tool calls. Please return your final answer now as YAML. Do not make any more tool calls.",
        });
      }

      const outcome: CompletionResponse | { _llmError: string } = yield* provider
        .complete({
          messages,
          temperature: 0.2,
          maxTokens: 4096,
          ...(hasTools
            ? { tools: state.tools!.map((name) => toolRegistry!.getDefinition(name)).filter((t): t is ToolDefinition => t !== undefined) }
            : {}),
        })
        .pipe(
          Effect.tapError((err) => Effect.logError(`[StateMachine] LLM error: ${err}`)),
          Effect.matchEffect({
            onFailure: (err): Effect.Effect<CompletionResponse | { _llmError: string }> =>
              Effect.succeed({ _llmError: err instanceof Error ? err.message : String(err) }),
            onSuccess: (value): Effect.Effect<CompletionResponse | { _llmError: string }> =>
              Effect.succeed(value),
          })
        );

      if ("_llmError" in outcome) {
        return { kind: "error", error: `LLM error in state ${stateId}: ${outcome._llmError}` };
      }

      llmResponse = outcome;
      promptTokens += llmResponse.usage?.promptTokens ?? 0;
      completionTokens += llmResponse.usage?.completionTokens ?? 0;
      totalTokens += llmResponse.usage?.totalTokens ?? 0;

      // If no tool calls, we're done with this state
      if (!llmResponse.toolCalls || llmResponse.toolCalls.length === 0) {
        yield* Effect.log(`[StateMachine] LLM ${toolIteration} returned final answer`);
        break;
      }

      yield* Effect.log(`[StateMachine] LLM ${toolIteration} returned ${llmResponse.toolCalls.length} tool call(s)`);
      messages.push({
        role: "assistant",
        content: llmResponse.content || "",
        toolCalls: llmResponse.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
      });

      const batch = yield* applyToolCalls(
        llmResponse.toolCalls,
        toolRegistry,
        stateId,
        worktreePath,
        executionId,
        messages,
        toolCallCounts
      );
      if (batch.lastStructuredToolResult !== undefined) {
        lastStructuredToolResult = batch.lastStructuredToolResult;
      }
      if (batch.emitOutputCalled) {
        emittedOutput = batch.emittedOutput;
        yield* Effect.log(`[StateMachine] emit_output was called, breaking tool loop for state ${stateId}`);
        break;
      }
    }

    if (!llmResponse) {
      return { kind: "noResponse" };
    }

    return {
      kind: "ok",
      llmResponse,
      emittedOutput,
      lastStructuredToolResult,
      usage: { promptTokens, completionTokens, totalTokens },
    };
  });

/**
 * Execute one batch of tool calls, appending results to the message history.
 * Enforces the per-tool repeat limit and captures the emit_output payload.
 */
export const applyToolCalls = (
  toolCalls: ToolCall[],
  toolRegistry: ToolRegistry | undefined,
  stateId: string,
  worktreePath: string | undefined,
  executionId: string,
  messages: Message[],
  toolCallCounts: Map<string, number>
): Effect.Effect<ToolBatchResult, never> =>
  Effect.gen(function* () {
    let emitOutputCalled = false;
    let emittedOutput: string | undefined = undefined;
    let lastStructuredToolResult: unknown = undefined;

    for (const toolCall of toolCalls) {
      const handler = toolRegistry?.getHandler(toolCall.name);
      if (!handler) {
        yield* Effect.log(`[StateMachine] Tool '${toolCall.name}' not found`);
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: `Tool '${toolCall.name}' not found` }),
          toolCallId: toolCall.id,
        });
        continue;
      }

      // Limit repeated tool calls
      const currentCount = toolCallCounts.get(toolCall.name) || 0;
      toolCallCounts.set(toolCall.name, currentCount + 1);
      yield* Effect.log(`[StateMachine] Tool '${toolCall.name}' call count: ${currentCount + 1}`);
      if (currentCount >= 2 && toolCall.name !== "emit_output") {
        const limitMsg = `Tool '${toolCall.name}' has already been used ${currentCount} times. Please call emit_output with your final YAML result or return your final answer.`;
        yield* Effect.log(`[StateMachine] ${limitMsg}`);
        messages.push({ role: "tool", content: JSON.stringify({ error: limitMsg }), toolCallId: toolCall.id });
        continue;
      }

      yield* Effect.log(`[StateMachine] Tool '${toolCall.name}' executing`);
      try {
        // Auto-inject cwd for filesystem tools when worktree is active
        const toolArgs: Record<string, unknown> = { ...toolCall.arguments, _executionId: executionId };
        const filesystemTools = ["read_file", "write_file", "edit_file", "run_shell"];
        if (worktreePath && filesystemTools.includes(toolCall.name) && !toolArgs.cwd) {
          toolArgs.cwd = worktreePath;
          yield* Effect.log(`[StateMachine] Auto-injected cwd: ${worktreePath} for ${toolCall.name}`);
        }
        const toolResult = yield* Effect.promise(() => handler(toolArgs));
        yield* Effect.log(`[StateMachine] Tool '${toolCall.name}' completed`);
        // Capture emitted output from emit_output tool
        if (toolCall.name === "emit_output" && toolArgs.content) {
          emittedOutput = String(toolArgs.content);
          emitOutputCalled = true;
          yield* Effect.log(`[StateMachine] Captured emitted output for state ${stateId}`);
        }
        // Capture structured result for auto-output fallback.
        // Skip emit_output — its {emitted:true,content:"..."} is not useful as fallback.
        if (toolCall.name !== "emit_output") {
          try {
            const resultStr = String(toolResult);
            yield* Effect.log(`[StateMachine] Tool result from ${toolCall.name}: ${resultStr.slice(0, 100)}`);
            const parsed = JSON.parse(resultStr);
            if (parsed && typeof parsed === "object" && !parsed.error) {
              lastStructuredToolResult = parsed;
              yield* Effect.log(`[StateMachine] Captured structured result from ${toolCall.name}`);
            } else {
              yield* Effect.log(`[StateMachine] Skipped structured result from ${toolCall.name}: has error or not object`);
            }
          } catch (parseErr) {
            yield* Effect.log(`[StateMachine] Failed to parse tool result from ${toolCall.name}: ${parseErr}`);
          }
        }
        messages.push({ role: "tool", content: String(toolResult), toolCallId: toolCall.id });
      } catch (toolErr) {
        const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
        yield* Effect.log(`[StateMachine] Tool '${toolCall.name}' failed: ${errMsg}`);
        messages.push({ role: "tool", content: JSON.stringify({ error: errMsg }), toolCallId: toolCall.id });
      }
    }

    return { emitOutputCalled, emittedOutput, lastStructuredToolResult };
  });

/**
 * Extract the state output (emitted output first, then LLM content, then the
 * last structured tool result as fallback) and validate it against the state's
 * output_schema when present.
 */
export const extractAndValidateOutput = (
  llmResponse: CompletionResponse,
  emittedOutput: string | undefined,
  lastStructuredToolResult: unknown,
  state: SkillStateMachineState,
  outputPath: string,
  stateId: string
): OutputResult => {
  let stateOutput: unknown;

  // Priority 1: emitted output from emit_output tool
  if (emittedOutput !== undefined) {
    try {
      stateOutput = extractOutput(emittedOutput);
    } catch {
      stateOutput = emittedOutput;
    }
  } else {
    try {
      stateOutput = extractOutput(llmResponse.content, outputPath);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Output extraction failed in state ${stateId}: ${errMsg}` };
    }
  }

  // Fallback: use structured tool result if no useful output was extracted
  const isStructured = stateOutput !== null && stateOutput !== undefined && typeof stateOutput === "object";
  if (!isStructured && lastStructuredToolResult !== undefined) {
    stateOutput = lastStructuredToolResult;
  }

  // Validate against schema
  if (state.output_schema) {
    try {
      const schemaContent = readFileSync(state.output_schema, "utf-8");
      const schema = JSON.parse(schemaContent) as JsonSchema;
      validate(stateOutput, schema);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Schema validation failed in state ${stateId}: ${errMsg}` };
    }
  }

  return { ok: true, output: stateOutput };
};

/**
 * Review state: reject when implement produced no changes and the issue is not
 * a no-op. Returns the (possibly rewritten) output; other states pass through.
 */
export const applyReviewRejection = (
  stateId: string,
  stateOutput: unknown,
  outputs: Record<string, unknown>,
  inputs: Record<string, unknown>
): unknown => {
  if (stateId !== "review") return stateOutput;

  const reviewOutput = stateOutput as { verdict?: string; changes?: unknown[] } | undefined;
  const implementOutput = outputs.implement as { changes?: unknown[] } | undefined;
  const implementChanges = implementOutput?.changes ?? [];
  const issueTitle = String(inputs.issue_title ?? "").toLowerCase();
  const isNoOp = issueTitle.includes("no-op") || issueTitle.includes("noop") || issueTitle.includes("no op");
  if (Array.isArray(implementChanges) && implementChanges.length === 0 && !isNoOp) {
    return {
      ...(typeof reviewOutput === "object" && reviewOutput !== null ? reviewOutput : {}),
      verdict: "rejected",
      note: "No files were modified by implement. The issue requires changes but none were produced. Please implement the requested changes.",
    };
  }
  return stateOutput;
};

/** Evaluate transitions and return the next state id, or undefined if none match. */
export const evaluateNextState = (
  state: SkillStateMachineState,
  outputs: Record<string, unknown>
): string | undefined => {
  for (const transition of state.transitions ?? []) {
    if (!transition.when || evaluateCondition(transition.when, outputs)) {
      return transition.to;
    }
  }
  return undefined;
};

/** Check the state's gate (if any) via the gate engine. No gate → approved. */
export const checkGateTransition = (
  gateEngine: GateEngine | undefined,
  executionId: string,
  stateId: string,
  state: SkillStateMachineState
): Effect.Effect<GateCheckResult, never> =>
  Effect.gen(function* () {
    if (gateEngine && state.gate) {
      yield* Effect.log(`[StateMachine] Checking gate '${state.gate}' for execution ${executionId}`);
      const gateResult = yield* Effect.promise(() => gateEngine.checkGate(executionId, state.gate!, stateId));
      yield* Effect.log(`[StateMachine] Gate check result: approved=${gateResult.approved}, gateId=${(gateResult as any).gateId ?? 'n/a'}`);
      return gateResult;
    }
    return { approved: true };
  });

/**
 * Persist file metadata for the implement state (PostgreSQL version of the
 * atomic-gates .metadata/summary.yaml audit trail).
 */
export const persistImplementFileMetadata = (
  fileMetadataRepository: FileMetadataRepository | undefined,
  stateId: string,
  stateOutput: unknown,
  inputs: Record<string, unknown>,
  executionId: string
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    if (!fileMetadataRepository || stateId !== "implement") return;
    const changes = (stateOutput as { changes?: Array<{ file: string; description: string }> })?.changes ?? [];
    for (const change of changes) {
      yield* Effect.promise(() =>
        fileMetadataRepository.save({
          path: change.file,
          executionId,
          issueNumber: Number(inputs.issue_number) || undefined,
          status: "complete",
          summary: `Modified ${change.file}: ${change.description}`,
          changes: [change],
          specialist: "backend",
          verifiedBy: `execution ${executionId}`,
        })
      ).pipe(Effect.ignore);
    }
    yield* Effect.log(`[StateMachine] File metadata persisted for ${changes.length} file(s)`);
  });

const persistExecution = (
  repository: ExecutionRepository,
  record: import("../persistence/types.js").ExecutionRecord
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => repository.save(record),
      catch: () => undefined,
    }).pipe(Effect.ignore);
  });

/** Persist the state machine context so a paused execution can resume. */
export const persistStateContext = (
  repository: ExecutionRepository,
  executionId: string,
  stateId: string,
  outputs: Record<string, unknown>,
  inputs: Record<string, unknown>,
  implementReviewIterations: number
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: async () => {
        const existing = await repository.findById(executionId);
        if (existing) {
          await repository.save({
            ...existing,
            metadata: {
              ...(existing.metadata || {}),
              stateMachineContext: { currentState: stateId, outputs, inputs, implementReviewIterations },
            },
          });
        }
      },
      catch: () => undefined,
    }).pipe(Effect.ignore);
  });
