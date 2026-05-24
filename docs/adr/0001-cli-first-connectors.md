# ADR 0001: CLI-First Connectors

## Status
Accepted

## Context
Integrations with external services (GitHub, AWS, Vercel) need to be reliable, testable locally, and require minimal setup.

## Decision
Use CLI tools as the primary integration method. Only fall back to API SDKs when no CLI exists.

## Consequences
- **Pros**: Works offline, universally available, easy to audit, no dependency hell.
- **Cons**: Parsing CLI output is brittle; some operations may require APIs.
