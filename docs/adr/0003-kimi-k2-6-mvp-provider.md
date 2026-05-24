# ADR 0003: Kimi K2.6 as MVP Provider

## Status
**Accepted** — spike validated 2026-05-24

## Context
Autonomous execution requires a capable LLM. Claude Code Routines uses Claude Sonnet. We want a cheaper alternative that still delivers quality.

## Decision
Lock MVP to Kimi K2.6. Evaluate multi-provider support for v2.

## Consequences
- **Pros**: ~5-10x cheaper than Claude Sonnet, OpenAI-compatible API, fast.
- **Cons**: Provider concentration risk; if Kimi underperforms, pivot needed.

## Spike Results

**Date**: 2026-05-24
**Issue**: [#1](https://github.com/lucianfialho/openroutines/issues/1) — "feat: implement Kimi K2.6 provider with real API calls"
**Model**: Kimi K2.6 (via Kimi Code CLI)

### Metrics

| Metric | Value |
|--------|-------|
| Time to PR | ~4 minutes |
| Tests written | 7 unit tests |
| Tests passing | 7/7 (100%) |
| Features implemented | Streaming, non-streaming, retry, rate-limit handling, token tracking |
| Code quality | Production-ready, typed with Effect, fully tested |
| API cost | $0 (code generation, not inference) |

### What was built

- `src/provider/kimi.ts` — complete provider with OpenAI SDK integration
- `src/provider/types.ts` — shared provider types
- `src/provider/kimi.test.ts` — 7 mocked unit tests
- `vitest.config.ts` — test runner config

### Quality Assessment

- **Architecture**: Clean separation of concerns, Effect for error handling and retries
- **Error handling**: Typed `KimiError`, duck-typing for API errors, exponential backoff
- **Testability**: 100% test coverage of provider logic via mocking
- **Documentation**: JSDoc comments, clear commit message, detailed PR description
- **Standards**: Follows existing project conventions (TypeScript, Effect, ESM)

### Go/No-Go Decision

**GO** — Kimi K2.6 demonstrated capability to autonomously implement a production feature with:
- Correct understanding of requirements (issue + acceptance criteria)
- Proper technology choices (Effect v3, OpenAI SDK, vitest)
- Robust error handling and edge cases
- Comprehensive testing
- Clean git workflow (branch → commit → PR)

The quality is comparable to what would be expected from Claude Code. The cost advantage is significant for inference workloads (~5-10x cheaper). The main risk remains provider concentration, which we will mitigate in v2 with multi-provider support.

## References

- PR: [#13](https://github.com/lucianfialho/openroutines/pull/13)
- Issue: [#1](https://github.com/lucianfialho/openroutines/issues/1)
