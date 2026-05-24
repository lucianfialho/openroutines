# ADR 0002: Effect v4 Runtime

## Status
Accepted

## Context
The execution engine needs composable error handling, resource safety, and typed effects.

## Decision
Use Effect v4 (from the Effect-TS ecosystem) as the core runtime.

## Consequences
- **Pros**: Type-safe errors, excellent composability, matches effect-gates codebase.
- **Cons**: Learning curve for contributors unfamiliar with functional programming.
