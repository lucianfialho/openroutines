/**
 * Execution Engine
 *
 * Orchestrates trigger → routine → skill → provider → persistence.
 */

import { Effect } from "effect";
import { randomUUID } from "crypto";
import type { Routine } from "../routine/types.js";
import type { Skill } from "../skill/types.js";
import {
  EngineError,
  type ExecutionResult,
  type TriggerEvent,
} from "./types.js";
import type {
  CompletionRequest,
  CompletionResponse,
} from "../provider/types.js";
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
}

export const makeEngine = (config: EngineConfig) => {
  const { routines, provider, repository } = config;

  const resolveRoutine = (
    event: TriggerEvent
  ): Effect.Effect<Routine, EngineError> =>
    Effect.gen(function* () {
      const matches = routines.filter((r) =>
        r.triggers.some((t) => {
          if (t.type !== event.type) return false;
          if (t.type === "github" && t.events && Array.isArray(t.events)) {
            const payload = event.payload as { event?: string } | undefined;
            const eventName = payload?.event;
            if (!eventName) return true;
            return t.events.includes(eventName);
          }
          return true;
        })
      );

      if (matches.length === 0) {
        return yield* Effect.fail(
          new EngineError(`No routine matches trigger type: ${event.type}`)
        );
      }
      if (matches.length > 1) {
        return yield* Effect.fail(
          new EngineError(
            `Ambiguous trigger: ${matches.length} routines match type ${event.type}`
          )
        );
      }
      return matches[0];
    });

  const loadSkill = (
    skillName: string
  ): Effect.Effect<Skill, EngineError> =>
    Effect.gen(function* () {
      const { loadSkill: loadSkillFile } = yield* Effect.tryPromise({
        try: () => import("../skill/loader.js"),
        catch: (err) => new EngineError("Failed to import skill loader", err),
      });

      return yield* Effect.try({
        try: () => loadSkillFile(config.skillsDir, skillName),
        catch: (err) =>
          new EngineError(`Failed to load skill '${skillName}'`, err),
      });
    });

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
  ): Effect.Effect<ExecutionResult, EngineError> =>
    Effect.gen(function* () {
      const executionId = randomUUID();
      const startedAt = new Date();

      yield* Effect.log(`[Engine] Execution ${executionId} started`);

      // 1. Resolve routine
      const routine = yield* resolveRoutine(event);
      yield* Effect.log(`[Engine] Matched routine: ${routine.id}`);

      // 2. Load skill
      const skill = yield* loadSkill(routine.pipeline.skill);
      yield* Effect.log(`[Engine] Loaded skill: ${skill.name}`);

      // 3. Persist initial state
      yield* persistState({
        id: executionId,
        routineId: routine.id,
        triggerType: event.type,
        skillName: skill.name,
        status: "running",
        startedAt,
      });

      // 4. Build prompt from skill + trigger context
      const prompt = buildPrompt(skill, event);

      // 5. Run provider
      const response = yield* provider
        .complete({
          prompt,
          system: `You are an autonomous agent executing the '${skill.name}' skill. Follow the steps carefully.`,
          temperature: 0.2,
          maxTokens: 4096,
        })
        .pipe(
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
        success: true,
        output: response.content,
        usage: response.usage,
        logs: [`Routine: ${routine.id}`, `Skill: ${skill.name}`],
        startedAt,
        finishedAt,
      };
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Effect.log(`[Engine] Execution failed: ${error.message}`);
          const finishedAt = new Date();
          return {
            success: false,
            output: error.message,
            logs: [error.message],
            startedAt: new Date(),
            finishedAt,
          };
        })
      )
    );

  return { execute, resolveRoutine, loadSkill };
};

/** Build the execution prompt from skill content + trigger context. */
const buildPrompt = (skill: Skill, event: TriggerEvent): string => {
  const context = JSON.stringify(event.payload, null, 2);
  return `## Skill: ${skill.name}

${skill.content}

## Trigger Context

Type: ${event.type}
Payload:
\`\`\`json
${context}
\`\`\`

Execute the skill using the provided context.`;
};
