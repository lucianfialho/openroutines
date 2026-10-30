# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev                              # tsx watch src/main.ts — local dev server
npm run build                            # tsc -> dist/
npm start                                # node dist/main.js
npm test                                 # vitest (all tests)
npx vitest run src/engine/engine.test.ts # single test file
npx vitest                               # watch mode
npx tsc --noEmit                         # type check only
npm run lint                             # eslint src --ext .ts
npm run format                           # prettier --write src/**/*.ts
```

Docker: `docker-compose up` (Postgres + Redis + app). `docker build -t openroutines .`

Vercel: `npm run vercel:generate` regenerates `vercel.json` from routines; `npm run vercel:dev` / `vercel:build`.

Before marking any PR ready: `npx tsc --noEmit` and `npx vitest run` must both pass (see `CONTRIBUTING.md`).

## What this is

OpenRoutines is a self-hosted automation platform: YAML routines + Markdown/YAML skills are executed by an LLM agent (default: Kimi K2.6 via Moonshot), with human-approval gates blocking critical actions. It is explicitly self-referential — one of its own routines (`routines/self-improve.yaml`) uses the engine to modify this very codebase (create worktree, implement, review, commit, open PR).

## Execution flow

```
Trigger (cron | GitHub webhook | manual API call)
  -> Routine Matcher (src/routine/matcher.ts) resolves a Routine from the TriggerEvent
  -> Engine (src/engine/engine.ts) loads the routine's Skill (src/skill/loader.ts)
  -> Quality Gates checked (src/gate/gate.ts) — execution pauses to "paused" status if unapproved
  -> Provider.complete() (src/provider/*) — ReAct loop: LLM response -> tool calls -> execute -> repeat
  -> Tool Registry (src/tool/registry.ts) executes tool calls (GitHub, filesystem, git worktree)
  -> Persistence (src/persistence/*) saves ExecutionRecord; spans/feedback recorded for observability
```

Two completely different skill execution paths exist in `src/engine/engine.ts` and must not be conflated:

- **Markdown skills** (`.gates/skills/<name>.md`): a single prompt is built (`buildPrompt`) and run through the generic ReAct tool-use loop in `engine.ts`.
- **State-machine skills** (`.gates/skills/<name>/skill.yaml` or flat `.yaml`): executed by a dedicated interpreter, `src/engine/state-machine.ts` (ported from `atomic-gates/lib/runner.py`). Each state has `agent_prompt`, `tools`, optional `gate`, `output_schema`/`output_path`, and `transitions` with `when` conditions evaluated by `src/engine/condition.ts`. State machines support pause/resume via `StateMachineContext` (`currentState`, `outputs`, persisted in `execution.metadata.stateMachineContext`) and `delegate_to` for sub-skill delegation.

Resuming a paused execution (gate approval, or `/executions/:id/resume`) re-enqueues the job with the saved `executionId`; `src/app.ts`'s queue handler reloads `stateMachineContext` from the persisted record before calling `engine.execute()` again.

## Key architectural rules (from `docs/guardrails.md` — read before refactoring)

These are hard-won rules, not style preferences — violating them has caused real regressions in this project:

1. **One concept, one type, one place.** A domain concept (e.g. `TriggerEvent`) gets exactly one type definition; everything else imports it.
2. **No dynamic imports inside `Effect.gen`/business logic.** Import at module top-level; inject dependencies via config objects (see every `make*` factory in `src/*/`).
3. **No dead exports.** If something is exported, something must consume it — unused exports block a PR.
4. **Every execution path must persist state.** The lifecycle is `pending -> running -> completed|failed` (or `paused` at a gate); a caught error that only logs without persisting `failed` creates an invisible hang.
5. **Capture timestamps in closure scope before `Effect.gen`**, so failure handlers see the real `startedAt`, not a recreated one.
6. **Every schema field must be consumed by the runtime** (or explicitly rejected) — a routine's `connectors:` field declared but ignored is a bug, not a no-op.
7. **Sanitize all external/webhook input before it enters an LLM prompt.** See `escapePromptContent` in `engine.ts` — this exists specifically to block prompt injection via trigger payloads.
8. **Every module gets a direct `.test.ts`**, not just integration coverage.
9. **`Effect.tapError` is not recovery** — it fires a side effect but the error still propagates; use `Effect.catchAll`/`catchTag` to actually recover.
10. **Business logic lives in exactly one module** (e.g. routine-matching logic belongs in `matcher.ts`, not duplicated in `engine.ts`).

## Error handling

All async operations in `src/` return `Effect.Effect<A, E>` (Effect v3/v4) with typed errors — no bare `throw` in business logic. Persistence/gate/queue each have in-memory (test/dev) and production (`postgres.ts`/`bullmq.ts`) implementations behind the same interface; `src/app.ts` picks one based on whether `DATABASE_URL`/`REDIS_URL` are set.

## Adding things

- **New connector/tool**: `src/tool/<name>-tools.ts` exporting `make<Name>Tools(config)` returning `ToolDefinition[]`; register via `toolRegistry.registerMany()` in `src/app.ts`; add mocked-CLI tests; update `docs/ARCHITECTURE.md`.
- **New routine**: YAML in `routines/`, validated by `src/routine/schema.ts` (`RoutineSchema`); references a skill by name.
- **New skill**: Markdown in `.gates/skills/<name>.md` (Goal/Input/Output/Steps) or state-machine YAML validated by `src/skill/schema.ts`. Templates in `docs/TEMPLATES.md`.
- **Architecture decisions**: recorded in `docs/adr/`.

## Known sharp edge

Recent commit history and `docs/ROADMAP-2026-06-STABILIZATION.md` document that the self-improve routine (LLM-driven worktree -> implement -> review -> commit -> PR pipeline) has a low real success rate and has previously committed stray artifacts directly into `src/` (the state machine marks a step "completed" without verifying the LLM's output). If you see unexplained/garbled code fragments mid-file, check whether it originated from an automated self-improve run before assuming it's intentional.
