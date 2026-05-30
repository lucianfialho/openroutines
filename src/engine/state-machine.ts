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
  gateEngine?: GateEngine;
  toolRegistry?: ToolRegistry;
}

export interface StateMachineContext {
  currentState: string;
  outputs: Record<string, unknown>;
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
    const { provider, repository, runStateRepository, gateEngine, toolRegistry } = config;
    const startedAt = new Date();
    const outputs: Record<string, unknown> = {};

    // Build inputs from event payload
    const inputs = (event.payload as Record<string, unknown>) ?? {};

    yield* Effect.log(`[StateMachine] Starting execution ${executionId} for skill ${skill.id}`);

    let stateId = context?.currentState ?? skill.initial_state;
    if (context) {
      Object.assign(outputs, context.outputs);
      yield* Effect.log(`[StateMachine] Resuming execution ${executionId} at state ${stateId}`);
    }
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

      const outputPath = state.output_path ?? `.gates/outputs/${executionId}/${stateId}.output.yaml`;

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
        const context: TemplateContext = { inputs, outputs, output_path: outputPath };
        const prompt = renderTemplate(state.agent_prompt, context);

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

        const hasTools = state.tools && state.tools.length > 0 && toolRegistry;
        const maxToolIterations = 10;

        // Build message history for ReAct loop
        const messages: import("../provider/types.js").Message[] = [
          { role: "system", content: `You are executing the '${skill.id}' skill. Current state: ${stateId}. Produce structured YAML output.` },
          { role: "user", content: prompt },
        ];

        let llmResponse: import("../provider/types.js").CompletionResponse | undefined;
        let toolIteration = 0;

        while (toolIteration < maxToolIterations) {
          toolIteration++;
          yield* Effect.log(`[StateMachine] LLM call ${toolIteration} for state ${stateId}`);

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
              yield* Effect.log(`[StateMachine] Tool '${toolCall.name}' executing`);
              try {
                const toolResult = yield* Effect.promise(() => handler(toolCall.arguments));
                yield* Effect.log(`[StateMachine] Tool '${toolCall.name}' completed`);
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
        let stateOutput: unknown;
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
      yield* persistStateMachineContext(repository, executionId, stateId, outputs);
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
              stateMachineContext: { currentState: stateId, outputs },
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
  outputs: Record<string, unknown>
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
              stateMachineContext: { currentState: stateId, outputs },
            },
          });
        }
      },
      catch: () => undefined,
    }).pipe(Effect.ignore);
  });
