/**
 * State Machine Runner
 *
 * Executes YAML state-machine skills step by step.
 * Ported from atomic-gates/lib/runner.py to TypeScript/Effect v4.
 */

import { Effect } from "effect";
import type { SkillStateMachine } from "../skill/schema.js";
import type { CompletionRequest } from "../provider/types.js";
import type { ExecutionResult } from "./types.js";
import type { TriggerEvent } from "../routine/matcher.js";
import type { Routine } from "../routine/types.js";
import type { GateEngine } from "../gate/gate.js";
import type { ToolRegistry } from "../tool/registry.js";
import type { ExecutionRepository, RunStateRepository } from "../persistence/types.js";
import { renderTemplate, type TemplateContext } from "./template.js";
import { extractOutput } from "./output.js";
import { evaluateCondition } from "./condition.js";
import { validate, type JsonSchema } from "./schema-validate.js";
import { readFileSync } from "fs";

export interface StateMachineConfig {
  provider: {
    complete: (request: CompletionRequest) => Effect.Effect<
      import("../provider/types.js").CompletionResponse,
      Error
    >;
  };
  repository: ExecutionRepository;
  runStateRepository?: RunStateRepository;
  fileMetadataRepository?: import("../persistence/types.js").FileMetadataRepository;
  gateEngine?: GateEngine;
  toolRegistry?: ToolRegistry;
}

export interface StateMachineContext {
  currentState: string;
  outputs: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  implementReviewIterations?: number;
}

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
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    while (stateId) {
      iterations++;
      if (iterations > maxIterations) {
        yield* Effect.log(`[StateMachine] Max iterations exceeded`);
        const finishedAt = new Date();
        yield* persistExecution(repository, {
          id: executionId,
          routineId: routine.id,
          triggerType: event.type,
          skillName: skill.id,
          status: "failed",
          error: "Max iterations exceeded",
          startedAt,
          finishedAt,
        });
        return {
          executionId,
          success: false,
          output: "Max iterations exceeded",
          logs: ["Max iterations exceeded"],
          startedAt,
          finishedAt,
        };
      }

      const state = skill.states[stateId];
      if (!state) {
        yield* Effect.log(`[StateMachine] Unknown state: ${stateId}`);
        const finishedAt = new Date();
        yield* persistExecution(repository, {
          id: executionId,
          routineId: routine.id,
          triggerType: event.type,
          skillName: skill.id,
          status: "failed",
          error: `Unknown state: ${stateId}`,
          startedAt,
          finishedAt,
        });
        return {
          executionId,
          success: false,
          output: `Unknown state: ${stateId}`,
          logs: [`Unknown state: ${stateId}`],
          startedAt,
          finishedAt,
        };
      }

      yield* Effect.log(`[StateMachine] State: ${stateId}`);

      // Terminal state
      if (state.terminal) {
        yield* Effect.log(`[StateMachine] Reached terminal state: ${stateId}`);
        const finishedAt = new Date();
        const finalOutput = outputs[stateId] ?? "";
        yield* persistExecution(repository, {
          id: executionId,
          routineId: routine.id,
          triggerType: event.type,
          skillName: skill.id,
          status: "completed",
          output: typeof finalOutput === "string" ? finalOutput : JSON.stringify(finalOutput),
          startedAt,
          finishedAt,
        });
        return {
          executionId,
          success: true,
          output: typeof finalOutput === "string" ? finalOutput : JSON.stringify(finalOutput),
          logs: [`Reached terminal state: ${stateId}`],
          startedAt,
          finishedAt,
        };
      }

      // Use worktree path as base for output if available
      const worktreePath = (outputs.create_worktree as { worktree?: { path?: string } } | undefined)?.worktree?.path;
      const outputPath = state.output_path ?? (worktreePath
        ? `${worktreePath}/.gates/outputs/${executionId}/${stateId}.output.yaml`
        : `.gates/outputs/${executionId}/${stateId}.output.yaml`);

      // For template context, use relative path when in worktree so write_file can use cwd
      const templateOutputPath = worktreePath && outputPath.startsWith(worktreePath)
        ? outputPath.slice(worktreePath.length + 1) // relative to worktree
        : outputPath;

      // Gate-only state (no agent_prompt, just gate check + transition)
      if (!state.agent_prompt && state.gate) {
        yield* Effect.log(`[StateMachine] State ${stateId} is gate-only, skipping LLM`);
      } else if (!state.agent_prompt) {
        yield* Effect.log(`[StateMachine] State ${stateId} has no agent_prompt and no gate`);
        const finishedAt = new Date();
        yield* persistExecution(repository, {
          id: executionId,
          routineId: routine.id,
          triggerType: event.type,
          skillName: skill.id,
          status: "failed",
          error: `State ${stateId} has no agent_prompt and no gate`,
          startedAt,
          finishedAt,
        });
        return {
          executionId,
          success: false,
          output: `State ${stateId} has no agent_prompt and no gate`,
          logs: [`State ${stateId} has no agent_prompt and no gate`],
          startedAt,
          finishedAt,
        };
      } else {
        // Normal state with agent_prompt — run LLM
        // Ensure output directory exists in worktree
        if (worktreePath && !state.output_path) {
          const outputDir = `${worktreePath}/.gates/outputs/${executionId}`;
          try {
            require("fs").mkdirSync(outputDir, { recursive: true });
          } catch {
            // ignore
          }
        }

        // Auto-actions for specific states
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
                const finishedAt = new Date();
                yield* persistExecution(repository, {
                  id: executionId,
                  routineId: routine.id,
                  triggerType: event.type,
                  skillName: skill.id,
                  status: "failed",
                  error: `Gate-metadata blocked: ${file} has no complete metadata`,
                  startedAt,
                  finishedAt,
                });
                return {
                  executionId,
                  success: false,
                  output: `Gate-metadata blocked: ${file} has no complete metadata`,
                  logs: [`Gate-metadata blocked: ${file} has no complete metadata`],
                  startedAt,
                  finishedAt,
                };
              }
            }
          }

          const commitHandler = toolRegistry?.getHandler("git_commit_and_push");
          if (commitHandler) {
            yield* Effect.log(`[StateMachine] Auto-running git_commit_and_push for state ${stateId}`);
            try {
              const commitResult = yield* Effect.promise(() =>
                commitHandler({ cwd: worktreePath, message: `feat: implement changes (closes #${inputs.issue_number})` })
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

        if (stateId === "create_pr") {
          const branch = (outputs.commit_and_push as { commit?: { branch?: string } } | undefined)?.commit?.branch;
          if (branch) {
            const prHandler = toolRegistry?.getHandler("github_create_pull_request");
            if (prHandler) {
              yield* Effect.log(`[StateMachine] Auto-running github_create_pull_request for state ${stateId}`);
              try {
                const prResult = yield* Effect.promise(() =>
                  prHandler({ branch, title: `feat: implement changes`, body: `Closes #${inputs.issue_number}` })
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

        // Skip LLM loop if auto-actions already succeeded
        if (autoActionSucceeded) {
          yield* Effect.log(`[StateMachine] Auto-action succeeded for ${stateId}, skipping LLM loop`);
        } else {
        const context: TemplateContext = { inputs, outputs, output_path: templateOutputPath };
        const prompt = renderTemplate(state.agent_prompt, context);
        yield* Effect.log(`[StateMachine] Rendered prompt for ${stateId}: ${prompt.slice(0, 300)}`);

        // Persist state start
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

        let stateOutput: unknown;

        if (!autoActionSucceeded) {
        const hasTools = state.tools && state.tools.length > 0 && toolRegistry;
        const maxToolIterations = 10;
        let lastStructuredToolResult: unknown = undefined;
        let emittedOutput: string | undefined = undefined;
        let emitOutputCalled = false;
        const toolCallCounts = new Map<string, number>();

        // Build message history for ReAct loop
        const messages: import("../provider/types.js").Message[] = [
          { role: "system", content: `You are executing the '${skill.id}' skill. Current state: ${stateId}. Use the provided tools to complete the task. After completing all necessary work, you MUST call emit_output with the final YAML result. Do not call any other tool after emit_output.` },
          { role: "user", content: prompt },
        ];

        let llmResponse: import("../provider/types.js").CompletionResponse | undefined;
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

          const response = yield* provider
            .complete({
              messages,
              temperature: 0.2,
              maxTokens: 4096,
              ...(hasTools
                ? { tools: state.tools!.map((name) => toolRegistry!.getDefinition(name)).filter((t): t is import("../tool/types.js").ToolDefinition => t !== undefined) }
                : {}),
            })
            .pipe(
              Effect.tapError((err) => Effect.logError(`[StateMachine] LLM error: ${err}`)),
              Effect.matchEffect({
                onFailure: (err) =>
                  Effect.gen(function* () {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    yield* Effect.log(`[StateMachine] LLM call failed for state ${stateId}: ${errMsg}`);
                    const finishedAt = new Date();
                    yield* persistExecution(repository, {
                      id: executionId,
                      routineId: routine.id,
                      triggerType: event.type,
                      skillName: skill.id,
                      status: "failed",
                      error: `LLM error in state ${stateId}: ${errMsg}`,
                      startedAt,
                      finishedAt,
                    });
                    return {
                      executionId,
                      success: false,
                      output: `LLM error in state ${stateId}: ${errMsg}`,
                      logs: [`LLM error in state ${stateId}: ${errMsg}`],
                      startedAt,
                      finishedAt,
                    } as ExecutionResult;
                  }),
                onSuccess: (value) => Effect.succeed(value),
              })
            );

          // If we got an ExecutionResult (from onFailure), return it
          if ("success" in response && typeof response.success === "boolean") {
            return response as ExecutionResult;
          }

          llmResponse = response as import("../provider/types.js").CompletionResponse;
          promptTokens += llmResponse.usage?.promptTokens ?? 0;
          completionTokens += llmResponse.usage?.completionTokens ?? 0;
          totalTokens += llmResponse.usage?.totalTokens ?? 0;

          // If no tool calls, we're done with this state
          if (!llmResponse.toolCalls || llmResponse.toolCalls.length === 0) {
            yield* Effect.log(`[StateMachine] LLM ${toolIteration} returned final answer`);
            break;
          }

          // Execute tool calls and add results to message history
          yield* Effect.log(`[StateMachine] LLM ${toolIteration} returned ${llmResponse.toolCalls.length} tool call(s)`);

          messages.push({
            role: "assistant",
            content: llmResponse.content || "",
            toolCalls: llmResponse.toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            })),
          });

          for (const toolCall of llmResponse.toolCalls) {
            const handler = toolRegistry?.getHandler(toolCall.name);
            if (handler) {
              // Limit repeated tool calls
              const currentCount = toolCallCounts.get(toolCall.name) || 0;
              toolCallCounts.set(toolCall.name, currentCount + 1);
              yield* Effect.log(`[StateMachine] Tool '${toolCall.name}' call count: ${currentCount + 1}`);
              if (currentCount >= 2 && toolCall.name !== "emit_output") {
                const limitMsg = `Tool '${toolCall.name}' has already been used ${currentCount} times. Please call emit_output with your final YAML result or return your final answer.`;
                yield* Effect.log(`[StateMachine] ${limitMsg}`);
                messages.push({
                  role: "tool",
                  content: JSON.stringify({ error: limitMsg }),
                  toolCallId: toolCall.id,
                });
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
                const toolResult = yield* Effect.promise(() =>
                  handler(toolArgs)
                );
                yield* Effect.log(`[StateMachine] Tool '${toolCall.name}' completed`);
                // Capture emitted output from emit_output tool
                if (toolCall.name === "emit_output" && toolArgs.content) {
                  emittedOutput = String(toolArgs.content);
                  emitOutputCalled = true;
                  yield* Effect.log(`[StateMachine] Captured emitted output for state ${stateId}`);
                }
                // Try to capture structured result for auto-output fallback
                // Skip emit_output — its result {emitted:true, content:"..."} is not useful as fallback
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
                messages.push({
                  role: "tool",
                  content: String(toolResult),
                  toolCallId: toolCall.id,
                });
              } catch (toolErr) {
                const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
                yield* Effect.log(`[StateMachine] Tool '${toolCall.name}' failed: ${errMsg}`);
                messages.push({
                  role: "tool",
                  content: JSON.stringify({ error: errMsg }),
                  toolCallId: toolCall.id,
                });
              }
            } else {
              yield* Effect.log(`[StateMachine] Tool '${toolCall.name}' not found`);
              messages.push({
                role: "tool",
                content: JSON.stringify({ error: `Tool '${toolCall.name}' not found` }),
                toolCallId: toolCall.id,
              });
            }
          }

          // If emit_output was called, stop the tool loop and use the emitted output
          if (emitOutputCalled) {
            yield* Effect.log(`[StateMachine] emit_output was called, breaking tool loop for state ${stateId}`);
            break;
          }
        }

        if (!llmResponse) {
          return {
            executionId,
            success: false,
            output: `No LLM response for state ${stateId}`,
            logs: [`No LLM response for state ${stateId}`],
            startedAt,
            finishedAt: new Date(),
          };
        }

        // Extract output from final response
        // Priority 1: emitted output from emit_output tool
        if (emittedOutput !== undefined) {
          try {
            stateOutput = extractOutput(emittedOutput);
            yield* Effect.log(`[StateMachine] Using emitted output for state ${stateId}`);
          } catch {
            stateOutput = emittedOutput;
          }
        } else {
          try {
            stateOutput = extractOutput(llmResponse.content, outputPath);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            yield* Effect.log(`[StateMachine] Output extraction failed for state ${stateId}: ${errMsg}`);
            const finishedAt = new Date();
            yield* persistExecution(repository, {
              id: executionId,
              routineId: routine.id,
              triggerType: event.type,
              skillName: skill.id,
              status: "failed",
              error: `Output extraction failed in state ${stateId}: ${errMsg}`,
              startedAt,
              finishedAt,
            });
            return {
              executionId,
              success: false,
              output: `Output extraction failed in state ${stateId}: ${errMsg}`,
              logs: [`Output extraction failed in state ${stateId}: ${errMsg}`],
              startedAt,
              finishedAt,
            };
          }
        }

        // Fallback: use structured tool result if no useful output was extracted
        const isStructured = stateOutput !== null && stateOutput !== undefined && typeof stateOutput === "object";
        if (!isStructured) {
          yield* Effect.log(`[StateMachine] Output for state ${stateId} is not structured: ${typeof stateOutput}. Content: ${String(llmResponse.content).slice(0, 200)}`);
          if (lastStructuredToolResult !== undefined) {
            yield* Effect.log(`[StateMachine] Using tool result as fallback output for state ${stateId}`);
            stateOutput = lastStructuredToolResult;
          }
        }
        }

        // If auto-action succeeded, use its output directly
        if (autoActionSucceeded) {
          stateOutput = outputs[stateId];
          yield* Effect.log(`[StateMachine] Using auto-action output for state ${stateId}`);
        }

      // Validate against schema
      if (state.output_schema) {
        try {
          const schemaContent = readFileSync(state.output_schema, "utf-8");
          const schema = JSON.parse(schemaContent) as JsonSchema;
          validate(stateOutput, schema);
          yield* Effect.log(`[StateMachine] Output validated for state ${stateId}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          yield* Effect.log(`[StateMachine] Schema validation failed for state ${stateId}: ${errMsg}`);
          const finishedAt = new Date();
          yield* persistExecution(repository, {
            id: executionId,
            routineId: routine.id,
            triggerType: event.type,
            skillName: skill.id,
            status: "failed",
            error: `Schema validation failed in state ${stateId}: ${errMsg}`,
            startedAt,
            finishedAt,
          });
          return {
            executionId,
            success: false,
            output: `Schema validation failed in state ${stateId}: ${errMsg}`,
            logs: [`Schema validation failed in state ${stateId}: ${errMsg}`],
            startedAt,
            finishedAt,
          };
        }
      }

      // Review state: reject if implement produced no changes and issue is not a no-op
      if (stateId === "review") {
        const reviewOutput = stateOutput as { verdict?: string; changes?: unknown[] } | undefined;
        const implementOutput = outputs.implement as { changes?: unknown[] } | undefined;
        const implementChanges = implementOutput?.changes ?? [];
        const issueTitle = String(inputs.issue_title ?? "").toLowerCase();
        const isNoOp = issueTitle.includes("no-op") || issueTitle.includes("noop") || issueTitle.includes("no op");
        if (Array.isArray(implementChanges) && implementChanges.length === 0 && !isNoOp) {
          stateOutput = {
            ...(typeof reviewOutput === "object" && reviewOutput !== null ? reviewOutput : {}),
            verdict: "rejected",
            note: "No files were modified by implement. The issue requires changes but none were produced. Please implement the requested changes.",
          };
          yield* Effect.log(`[StateMachine] Review rejected: implement produced no changes for a non-no-op issue`);
        }
      }

      outputs[stateId] = stateOutput;
      // Persist state completion
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
      // Persist state machine context for resume
      yield* persistStateMachineContext(repository, executionId, stateId, outputs, inputs, implementReviewIterations);

      // Persist file metadata for atomic-gates audit trail (PostgreSQL version of .metadata/summary.yaml)
      if (fileMetadataRepository && stateId === "implement") {
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
      }
      }

      }

      // Check gate on transition
      if (gateEngine && state.gate) {
        const gateResult = yield* Effect.promise(() =>
          gateEngine.checkGate(executionId, state.gate!)
        );
        if (!gateResult.approved) {
          yield* Effect.log(
            `[StateMachine] Gate '${state.gate}' blocked at state ${stateId}`
          );
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
              gateId: gateResult.gateId,
              gateType: state.gate,
              gateStatus: "pending",
            },
          });
          return {
            executionId,
            success: false,
            output: `Waiting for gate approval: ${state.gate} at state ${stateId}`,
            logs: [`Gate blocked: ${state.gate} at state ${stateId}`, `Gate ID: ${gateResult.gateId}`],
            startedAt,
            finishedAt: new Date(),
            paused: true,
            gateId: gateResult.gateId,
          };
        }
      }

      // Evaluate transitions
      let nextState: string | undefined;
      const transitions = state.transitions ?? [];
      for (const transition of transitions) {
        if (!transition.when || evaluateCondition(transition.when, outputs)) {
          nextState = transition.to;
          break;
        }
      }

      if (!nextState) {
        yield* Effect.log(`[StateMachine] No matching transition from state ${stateId}`);
        const finishedAt = new Date();
        yield* persistExecution(repository, {
          id: executionId,
          routineId: routine.id,
          triggerType: event.type,
          skillName: skill.id,
          status: "failed",
          error: `No matching transition from state ${stateId}`,
          startedAt,
          finishedAt,
        });
        return {
          executionId,
          success: false,
          output: `No matching transition from state ${stateId}`,
          logs: [`No matching transition from state ${stateId}`],
          startedAt,
          finishedAt,
        };
      }

      // Track implement→review loop iterations
      if (stateId === "review" && nextState === "implement") {
        implementReviewIterations++;
        yield* Effect.log(`[StateMachine] implement→review iteration ${implementReviewIterations}/${maxImplementReviewIterations}`);
        if (implementReviewIterations > maxImplementReviewIterations) {
          const errMsg = `Max implement→review iterations (${maxImplementReviewIterations}) reached. Manual intervention required.`;
          yield* Effect.log(`[StateMachine] ${errMsg}`);
          const finishedAt = new Date();
          yield* persistExecution(repository, {
            id: executionId,
            routineId: routine.id,
            triggerType: event.type,
            skillName: skill.id,
            status: "failed",
            error: errMsg,
            startedAt,
            finishedAt,
          });
          return {
            executionId,
            success: false,
            output: errMsg,
            logs: [errMsg],
            startedAt,
            finishedAt,
          };
        }
      }

      stateId = nextState;
    }

    // Should not reach here
    const finishedAt = new Date();
    yield* persistExecution(repository, {
      id: executionId,
      routineId: routine.id,
      triggerType: event.type,
      skillName: skill.id,
      status: "failed",
      error: "State machine exited without reaching terminal state",
      startedAt,
      finishedAt,
    });
    return {
      executionId,
      success: false,
      output: "State machine exited without reaching terminal state",
      logs: ["State machine exited without reaching terminal state"],
      startedAt,
      finishedAt,
    };
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

const persistStateMachineContext = (
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
