# Contributing to OpenRoutines

## Development Setup

```bash
git clone https://github.com/lucianfialho/openroutines.git
cd openroutines
npm install
```

## Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npx vitest run src/engine/engine.test.ts

# Watch mode
npx vitest
```

## Type Checking

```bash
npx tsc --noEmit
```

## Docker

```bash
# Build image
docker build -t openroutines .

# Run with compose (includes postgres + redis)
docker-compose up
```

## Project Conventions

### Code Style

- **TypeScript strict mode**: No implicit any
- **Effect v3**: All async operations return `Effect.Effect<A, E>`
- **No dynamic imports** inside business logic (import at module level)
- **One concept, one type**: No duplicate type definitions

### Testing

- Every module must have a `.test.ts` file
- Mock external dependencies (filesystem, network, child_process)
- Test error paths, not just happy path
- Use `Effect.runPromise` / `Effect.runPromiseExit` for Effect-based code

### Error Handling

- Use typed errors (extend `Error` or use `Data.TaggedError`)
- Capture `stderr` from CLI commands
- Persist `failed` state, don't just log

### Pull Request Checklist

Before marking PR ready:

- [ ] `npx tsc --noEmit` passes
- [ ] `npx vitest run` passes (all tests)
- [ ] No dead exports
- [ ] External inputs sanitized (if entering prompts)
- [ ] Business logic not duplicated

## Adding a New Connector

1. Create `src/connector/<name>.ts`
2. Export a factory function that returns Effect-based operations
3. Add tests with mocked CLI commands
4. Update `docs/ARCHITECTURE.md`

## Adding a New Skill

1. Create `.gates/skills/<name>.md`
2. Follow the skill template (Goal, Input, Output, Steps)
3. Reference the skill in a routine YAML

## Architecture Decisions

See `docs/adr/` for recorded decisions.
