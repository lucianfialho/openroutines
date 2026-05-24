/**
 * Execution Engine
 *
 * Orchestrates trigger → routine → skill → provider → persistence.
 */

import { Effect } from "effect";
import { randomUUID } from "crypto";
import type { Routine } from "../routine/types.js";
import type { Skill } from "../skill/types.js";
import { resolveRoutine, type TriggerEvent } from "../routine/matcher.js";
import { loadSkill } from "../skill/loader.js";
import { EngineError, type ExecutionResult } from "./types.js";
import type { CompletionRequest, CompletionResponse } from "../provider/types.js";
import type { ExecutionRecord, ExecutionRepository } from "../persistence/types.js";

export interface ProviderAdapter {
  complete: (
    request: CompletionRequest
  ) => Effect.Effect<CompletionResponse, Error>;
}

export interface EngineConfig {
  routines: Routine[];
  skillsDir: string;
  provider: ProviderAdapter;
  repository: ExecutionRepository;
  /** Injected for testability. Defaults to crypto.randomUUID. */
  generateId?: () => string;
}

export const makeEngine = (config: EngineConfig) => {
  const { routines, skillsDir, provider, repository } = config;
  const generateId = config.generateId ?? randomUUID;

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

  const execute = (
    event: TriggerEvent
  ): Effect.Effect<ExecutionResult, never> => {
    const startedAt = new Date();
    const executionId = generateId();

    const run = Effect.gen(function* () {
      yield* Effect.log(`[Engine] Execution ${executionId} started`);

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
        Effect.tap((s) => Effect.log(`[Engine] Loaded skill: ${s.name}`))
      );

      // 3. Persist running state
      yield* persistState({
        id: executionId,
        routineId: routine.id,
        triggerType: event.type,
        skillName: skill.name,
        status: "running",
        startedAt,
      });

      // 4. Build prompt from skill + trigger context + connectors
      const prompt = buildPrompt(skill, routine, event);

      // 5. Run provider
      const response = yield* provider.complete({
        prompt,
        system: `You are an autonomous agent executing the '${skill.name}' skill. Follow the steps carefully.`,
        temperature: 0.2,
        maxTokens: 4096,
      }).pipe(
        Effect.mapError(
          (err) => new EngineError("Provider completion failed", err)
        )
      );

      yield* Effect.log(
        `[Engine] Provider responded. Tokens: ${response.usage.totalTokens}`
      );

      // 6. Persist completion
      const finishedAt = new Date();
      yield* persistState({
        id: executionId,
        routineId: routine.id,
        triggerType: event.type,
        skillName: skill.name,
        status: "completed",
        output: response.content,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
        startedAt,
        finishedAt,
      });

      yield* Effect.log(`[Engine] Execution ${executionId} completed`);

      return {
        executionId,
        success: true,
        output: response.content,
        usage: response.usage,
        logs: [`Routine: ${routine.id}`, `Skill: ${skill.name}`],
        startedAt,
        finishedAt,
      };
    });

    return run.pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Effect.log(`[Engine] Execution failed: ${error.message}`);
          const finishedAt = new Date();

          // Persist failure if we have a routine context; otherwise skip
          // to avoid cascading errors from missing routineId/skillName.
          if (error instanceof EngineError && executionId) {
            yield* Effect.ignore(
              persistState({
                id: executionId,
                routineId: "unknown",
                triggerType: event.type,
                skillName: "unknown",
                status: "failed",
                error: error.message,
                startedAt,
                finishedAt,
              })
            );
          }

          return {
            executionId,
            success: false,
            output: error.message,
            logs: [error.message],
            startedAt,
            finishedAt,
          };
        })
      )
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
const buildPrompt = (skill: Skill, routine: Routine, event: TriggerEvent): string => {
  const safePayload = escapePromptContent(
    JSON.stringify(event.payload, null, 2)
  );

  const connectorsSection = routine.connectors?.length
    ? `## Connectors

${routine.connectors
  .map((c) => `- ${c.name}: ${c.source}`)
  .join("\n")}

`
    : "";

  return `## Skill: ${skill.name}

${skill.content}

## Trigger Context

Type: ${event.type}
Payload:
\`\`\`json
${safePayload}
\`\`\`

${connectorsSection}Execute the skill using the provided context.`;
};
