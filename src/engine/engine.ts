/**
 * Execution Engine
 *
 * Orchestrates trigger → routine → skill → provider → tools → persistence.
 * Supports ReAct-style tool-use loops for multi-step automation.
 */

import { Effect } from "effect";
import { randomUUID } from "crypto";
import type { Routine } from "../routine/types.js";
import type { Skill } from "../skill/types.js";
import { resolveRoutine, type TriggerEvent } from "../routine/matcher.js";
import { loadSkill } from "../skill/loader.js";
import { EngineError, type ExecutionResult } from "./types.js";
import type { CompletionRequest, Message } from "../provider/types.js";
import type { ExecutionRecord, ExecutionRepository, SpanRepository } from "../persistence/types.js";
import type { ToolRegistry } from "../tool/registry.js";
import type { GateEngine } from "../gate/gate.js";
import { runStateMachine } from "./state-machine.js";

export interface ProviderAdapter {
  complete: (
    request: CompletionRequest
  ) => Effect.Effect<
    import("../provider/types.js").CompletionResponse,
    Error
  >;
}

export interface EngineConfig {
  routines: Routine[];
  skillsDir: string;
  provider: ProviderAdapter;
  repository: ExecutionRepository;
  toolRegistry?: ToolRegistry;
  gateEngine?: GateEngine;
  spanRepository?: SpanRepository;
  runStateRepository?: import("../persistence/types.js").RunStateRepository;
  /** Injected for testability. Defaults to crypto.randomUUID. */
  generateId?: () => string;
  /** Max tool-use iterations to prevent infinite loops. */
  maxToolIterations?: number;
}

export const makeEngine = (config: EngineConfig) => {
  const { routines, skillsDir, provider, repository, toolRegistry, gateEngine, spanRepository } = config;
  const generateId = config.generateId ?? randomUUID;
  const maxToolIterations = config.maxToolIterations ?? 10;

  const persistState = (
    record: ExecutionRecord
  ): Effect.Effect<void, EngineError> =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => repository.save(record),
        catch: (err) =>
          new EngineError(`Failed to persist execution ${record.id}`, err),
      });
    });

  const createSpan = (span: {
    executionId: string;
    type: import("../persistence/types.js").SpanType;
    name?: string;
    status: import("../persistence/types.js").SpanStatus;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    error?: string;
    durationMs?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    model?: string;
    startedAt: Date;
    finishedAt?: Date;
  }): void => {
    if (!spanRepository) return;
    Effect.runPromise(
      Effect.tryPromise({
        try: () => spanRepository.save(span as import("../persistence/types.js").ExecutionSpan),
        catch: () => undefined,
      }).pipe(Effect.ignore)
    ).catch(() => {});
  };

  const execute = (
    event: TriggerEvent
  ): Effect.Effect<ExecutionResult, never> => {
    const startedAt = new Date();
    const executionId = event.executionId ?? generateId();

    const run = Effect.gen(function* () {
      yield* Effect.log(`[Engine] Execution ${executionId} started`);
      createSpan({
        executionId,
        type: "execution_start",
        name: "execution",
        status: "started",
        input: { event },
        startedAt: new Date(),
      });

      // 1. Resolve routine
      const resolution = resolveRoutine(routines, event);
      if ("error" in resolution) {
        const message =
          resolution.error === "none"
            ? `No routine matches trigger type: ${event.type}`
            : `Ambiguous trigger: ${resolution.count} routines match type ${event.type}`;
        yield* Effect.log(`[Engine] ${message}`);
        return yield* Effect.fail(new EngineError(message));
      }

      const routine = resolution.matched;
      yield* Effect.log(`[Engine] Matched routine: ${routine.id}`);

      // 2. Load skill
      const skill = yield* Effect.try({
        try: () => loadSkill(skillsDir, routine.pipeline.skill),
        catch: (err) =>
          new EngineError(
            `Failed to load skill '${routine.pipeline.skill}'`,
            err
          ),
      }).pipe(
        Effect.tap((s) => Effect.log(`[Engine] Loaded skill: ${s.name} (${s.format})`))
      );

      // Check if this is a resume from a paused state machine before persisting
      let smContext: import("./state-machine.js").StateMachineContext | undefined;
      const isResume = event.executionId
        ? (yield* Effect.promise(() => repository.findById(event.executionId!)))?.status === "paused"
        : false;

      // 3. Persist initial state (required before gate FK)
      // If resuming, preserve existing record instead of overwriting with pending
      if (!isResume) {
        yield* persistState({
          id: executionId,
          routineId: routine.id,
          triggerType: event.type,
          skillName: skill.name,
          status: "pending",
          startedAt,
        });
      }

      // State machine skills use their own runner
      if (skill.format === "state-machine") {
        yield* Effect.log(`[Engine] Running state-machine skill: ${skill.name}`);

        if (event.executionId && isResume) {
          const existing = yield* Effect.promise(() => repository.findById(event.executionId!));
          if (existing?.metadata?.stateMachineContext) {
            smContext = existing.metadata.stateMachineContext as import("./state-machine.js").StateMachineContext;
            yield* Effect.log(`[Engine] Resuming state machine at state ${smContext.currentState}`);
          }
        }

        return yield* runStateMachine({
          provider,
          repository,
          runStateRepository: config.runStateRepository,
          gateEngine,
          toolRegistry,
        })(skill.stateMachine, routine, event, executionId, smContext);
      }

      // 4. Check gates (human-in-the-loop)
      if (gateEngine && routine.gates && routine.gates.length > 0) {
        for (const gateType of routine.gates) {
          const gateCheckStart = new Date();
          const gateResult = yield* Effect.promise(() =>
            gateEngine.checkGate(executionId, gateType)
          );
          createSpan({
            executionId,
            type: "gate_check",
            name: gateType,
            status: "completed",
            output: { approved: gateResult.approved, gateId: "gateId" in gateResult ? gateResult.gateId : undefined },
            durationMs: new Date().getTime() - gateCheckStart.getTime(),
            startedAt: gateCheckStart,
            finishedAt: new Date(),
          });
          if (!gateResult.approved) {
            yield* Effect.log(
              `[Engine] Gate '${gateType}' blocked execution ${executionId}. Gate ID: ${gateResult.gateId}`
            );
            yield* persistState({
              id: executionId,
              routineId: routine.id,
              triggerType: event.type,
              skillName: skill.name,
              status: "paused",
              output: `Waiting for gate approval: ${gateType}`,
              startedAt,
            });
            return {
              executionId,
              success: false,
              output: `Waiting for gate approval: ${gateType}`,
              logs: [`Gate blocked: ${gateType}`, `Gate ID: ${gateResult.gateId}`],
              startedAt,
              finishedAt: new Date(),
              paused: true,
              gateId: gateResult.gateId,
            };
          }
        }
        yield* Effect.log(`[Engine] All gates approved for ${executionId}`);
      }

      // 5. Persist running state
      yield* persistState({
        id: executionId,
        routineId: routine.id,
        triggerType: event.type,
        skillName: skill.name,
        status: "running",
        startedAt,
      });

      // 6. Build initial prompt (markdown skills only)
      const systemPrompt = `You are an autonomous agent executing the '${skill.name}' skill. Follow the steps carefully.`;
      const userPrompt = buildPrompt(skill, routine, event);

      const messages: Message[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ];

      // 7. ReAct loop: provider → tool calls → execution → repeat
      let finalContent = "";
      let totalUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };

      for (let iteration = 0; iteration < maxToolIterations; iteration++) {
        const hasTools =
          toolRegistry && toolRegistry.listDefinitions().length > 0;

        const llmStart = new Date();
        const llmInput = {
          messages: messages.map((m) => ({ role: m.role, content: m.content?.slice(0, 500) })),
          temperature: 0.2,
          maxTokens: 4096,
          hasTools,
        };

        const response = yield* provider
          .complete({
            messages,
            temperature: 0.2,
            maxTokens: 4096,
            ...(hasTools
              ? { tools: toolRegistry!.listDefinitions() }
              : {}),
          })
          .pipe(
            Effect.tapError((err) =>
              Effect.logError(`[Engine] Provider error: ${err}`)
            ),
            Effect.mapError(
              (err) => new EngineError("Provider completion failed", err)
            )
          );

        createSpan({
          executionId,
          type: "llm_call",
          name: `iteration-${iteration}`,
          status: "completed",
          input: llmInput,
          output: {
            content: response.content?.slice(0, 500),
            toolCalls: response.toolCalls?.map((t) => t.name),
            finishReason: response.finishReason,
          },
          durationMs: new Date().getTime() - llmStart.getTime(),
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          model: response.model,
          startedAt: llmStart,
          finishedAt: new Date(),
        });

        totalUsage.promptTokens += response.usage.promptTokens;
        totalUsage.completionTokens += response.usage.completionTokens;
        totalUsage.totalTokens += response.usage.totalTokens;

        // No tool calls — we're done
        if (!response.toolCalls || response.toolCalls.length === 0) {
          finalContent = response.content;
          yield* Effect.log(
            `[Engine] Provider responded (final). Tokens: ${response.usage.totalTokens}`
          );
          break;
        }

        yield* Effect.log(
          `[Engine] Provider requested ${response.toolCalls.length} tool call(s)`
        );

        // Add assistant message with tool calls
        messages.push({
          role: "assistant",
          content: response.content,
          toolCalls: response.toolCalls,
        });

        // Execute each tool call
        for (const call of response.toolCalls) {
          if (!toolRegistry || !toolRegistry.has(call.name)) {
            const errMsg = `Tool '${call.name}' not found in registry`;
            yield* Effect.log(`[Engine] ${errMsg}`);
            messages.push({
              role: "tool",
              content: JSON.stringify({ error: errMsg }),
              toolCallId: call.id,
            });
            continue;
          }

          const handler = toolRegistry.getHandler(call.name)!;
          const toolStart = new Date();
          const result = yield* Effect.tryPromise({
            try: () => handler(call.arguments),
            catch: (err) => {
              const msg =
                err instanceof Error ? err.message : String(err);
              return JSON.stringify({ error: msg });
            },
          }).pipe(
            Effect.tap((output) =>
              Effect.log(
                `[Engine] Tool '${call.name}' executed. Output: ${String(output).slice(0, 200)}...`
              )
            )
          );

          createSpan({
            executionId,
            type: "tool_call",
            name: call.name,
            status: result.startsWith('{"error"') ? "failed" : "completed",
            input: call.arguments,
            output: { result: result.slice(0, 500) },
            error: result.startsWith('{"error"') ? result : undefined,
            durationMs: new Date().getTime() - toolStart.getTime(),
            startedAt: toolStart,
            finishedAt: new Date(),
          });

          messages.push({
            role: "tool",
            content: result,
            toolCallId: call.id,
          });
        }
      }

      // 8. Persist completion
      const finishedAt = new Date();
      yield* persistState({
        id: executionId,
        routineId: routine.id,
        triggerType: event.type,
        skillName: skill.name,
        status: "completed",
        output: finalContent,
        promptTokens: totalUsage.promptTokens,
        completionTokens: totalUsage.completionTokens,
        totalTokens: totalUsage.totalTokens,
        startedAt,
        finishedAt,
      });

      yield* Effect.log(`[Engine] Execution ${executionId} completed`);
      createSpan({
        executionId,
        type: "execution_end",
        name: "execution",
        status: "completed",
        output: { success: true, outputLength: finalContent.length },
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        promptTokens: totalUsage.promptTokens,
        completionTokens: totalUsage.completionTokens,
        totalTokens: totalUsage.totalTokens,
        startedAt: finishedAt,
        finishedAt,
      });

      return {
        executionId,
        success: true,
        output: finalContent,
        usage: totalUsage,
        logs: [`Routine: ${routine.id}`, `Skill: ${skill.name}`],
        startedAt,
        finishedAt,
      };
    });

    return run.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.gen(function* () {
            const errMsg = error instanceof Error ? error.message : String(error);
            yield* Effect.log(`[Engine] Execution failed: ${errMsg}`);
            const finishedAt = new Date();

            // Persist failure if we have a routine context; otherwise skip
            if (executionId) {
              yield* Effect.ignore(
                persistState({
                  id: executionId,
                  routineId: "unknown",
                  triggerType: event.type,
                  skillName: "unknown",
                  status: "failed",
                  error: errMsg,
                  startedAt,
                  finishedAt,
                })
              );
            }

            return {
              executionId,
              success: false,
              output: errMsg,
              logs: [errMsg],
              startedAt,
              finishedAt,
            };
          }),
        onSuccess: (value) => Effect.succeed(value),
      })
    );
  };

  return { execute };
};

/** Escape user-controlled content to prevent prompt injection. */
const escapePromptContent = (content: string): string => {
  // Escape triple backticks that could break markdown fences
  return content.replace(/```/g, "\\`\\`\\`");
};

/** Build the execution prompt from skill content + trigger context. */
const buildPrompt = (
  skill: Extract<Skill, { format: "markdown" }>,
  routine: Routine,
  event: TriggerEvent
): string => {
  const safePayload = escapePromptContent(
    JSON.stringify(event.payload, null, 2)
  );

  const connectorsSection = routine.connectors?.length
    ? `## Connectors\n\n${routine.connectors
        .map((c) => `- ${c.name}: ${c.source}`)
        .join("\n")}\n\n`
    : "";

  return `## Skill: ${skill.name}\n\n${skill.content}\n\n## Trigger Context\n\nType: ${event.type}\nPayload:\n\`\`\`json\n${safePayload}\n\`\`\`\n\n${connectorsSection}Execute the skill using the provided context.`;
};
