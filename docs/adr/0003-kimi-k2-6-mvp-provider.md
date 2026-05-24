# ADR 0003: Kimi K2.6 as MVP Provider

## Status
Proposed (pending spike validation)

## Context
Autonomous execution requires a capable LLM. Claude Code Routines uses Claude Sonnet. We want a cheaper alternative that still delivers quality.

## Decision
Lock MVP to Kimi K2.6. Evaluate multi-provider support for v2.

## Consequences
- **Pros**: ~5-10x cheaper than Claude Sonnet, OpenAI-compatible API, fast.
- **Cons**: Provider concentration risk; if Kimi underperforms, pivot needed.

## Open Question
Spike test must validate quality/cost ratio before committing.
