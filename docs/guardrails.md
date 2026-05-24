# OpenRoutines Guardrails

> Lessons learned from building the engine. Rules to prevent recurring mistakes.

## 1. One Concept, One Type, One Place

**Problem**: `TriggerEvent` was defined in both `routine/matcher.ts` and `engine/types.ts`.  
**Impact**: Silent divergence, type-safety holes.  
**Rule**: A domain concept gets exactly one type definition. Import it everywhere else.

## 2. No Dynamic Imports Inside Effect.gen

**Problem**: `loadSkill` used `import("../skill/loader.js")` inside `Effect.gen`.  
**Impact**: Unmockable in tests, unnecessary Promise overhead.  
**Rule**: Import at module top-level. Inject dependencies via constructor/config.

## 3. Dead Code is a Red Flag

**Problem**: `ExecutionContext` was exported but never used by the engine.  
**Impact**: Confusion about intended design.  
**Rule**: If a type/function is exported, something must consume it. Unused exports = PR block.

## 4. Failures Must Persist State

**Problem**: The engine logged errors but only persisted "running" state on failure.  
**Impact**: Observability gap — executions appeared hanging.  
**Rule**: Every execution path ends with a persisted state: `pending → running → completed|failed`.

## 5. Metric Variables Need Closure Scope

**Problem**: `startedAt` was re-created inside `catchAll`, breaking duration metrics.  
**Impact**: False metrics, impossible to debug latency.  
**Rule**: Capture timestamps in closure scope *before* `Effect.gen`, so failure handlers see the real value.

## 6. Declarative Config Must Be Consumed

**Problem**: Routine YAML declared `connectors:` but the engine ignored them.  
**Impact**: Users configure things that silently do nothing.  
**Rule**: If a config field exists in the schema, the runtime must read and act on it (or reject as unsupported).

## 7. Sanitize All External Input

**Problem**: Trigger payload was interpolated raw into the LLM prompt.  
**Impact**: Prompt injection vulnerability.  
**Rule**: Any user/webhook-controlled data entering a prompt must be escaped or validated.

## 8. Test Every Layer Directly

**Problem**: `skill/loader.ts` and `persistence/in-memory.ts` had zero direct tests.  
**Impact**: Bugs only surfaced through integration tests, making root-cause harder.  
**Rule**: Every module gets its own unit test file. Integration tests are additive, not替代.

## 9. tapError is Not Error Recovery

**Problem**: Used `Effect.tapError` to persist failure, then expected the flow to continue.  
**Impact**: `tapError` runs a side-effect but the error still propagates.  
**Rule**: Use `Effect.catchAll` / `Effect.catchTag` to recover. Use `tapError` only for logging/telemetry.

## 10. DRY for Business Logic

**Problem**: Trigger matching logic was duplicated between `matcher.ts` and `engine.ts`.  
**Impact**: Fix one, forget the other.  
**Rule**: Business rules live in one module. Other modules import and compose.

## PR Checklist (Self-Review)

Before marking PR ready:

- [ ] No dead exports (types, functions, variables)
- [ ] No dynamic imports inside business logic
- [ ] All external inputs sanitized/validated
- [ ] Every module has direct unit tests
- [ ] Error paths persist correct state
- [ ] Business logic not duplicated
- [ ] Config schema fields are consumed by runtime
- [ ] Timestamps/metrics preserved in failure paths
