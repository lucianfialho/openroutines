# OpenRoutines Architecture

> Overview of how the system works.

## High-Level Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Triggers   │────→│   Engine    │────→│  Provider   │
│             │     │             │     │             │
│ • Cron      │     │ • Resolve   │     │ • Kimi K2.6 │
│ • Webhook   │     │ • Load Skill│     │             │
│ • API       │     │ • Execute   │     │             │
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │
                    ┌──────┴──────┐
                    │  Connector  │
                    │             │
                    │ • GitHub    │
                    │   (gh CLI)  │
                    └─────────────┘
```

## Components

### Triggers (`src/trigger/`)

Convert external events into `TriggerEvent` objects.

| Trigger | Source | Status |
|---------|--------|--------|
| `CronScheduler` | `node-cron` | ✅ |
| `GitHubWebhook` | Express endpoint | ✅ |
| API | Manual call | Implicit |

### Routine (`src/routine/`)

- **Parser**: YAML → typed `Routine` object (Zod validated)
- **Matcher**: Matches `TriggerEvent` to `Routine` definitions

### Engine (`src/engine/`)

The execution orchestrator.

1. **Resolve** routine from trigger
2. **Load** skill from `.gates/skills/`
3. **Build** prompt (skill + trigger context + connectors)
4. **Run** provider completion
5. **Persist** execution state

### Provider (`src/provider/`)

LLM adapter. Currently supports Kimi K2.6 via Moonshot API.

Features:
- Streaming & non-streaming
- Retry with exponential backoff
- Token usage tracking
- Configurable timeout

### Connector (`src/connector/`)

CLI-first integrations. Currently GitHub via `gh` CLI.

Operations:
- `fetchIssue`
- `listPullRequests`
- `createPullRequest`
- `addComment`

### Persistence (`src/persistence/`)

- **In-Memory**: For testing
- **PostgreSQL**: Production (migrations + ON CONFLICT upsert)

### Queue (`src/queue/`)

- **In-Memory**: For testing
- **BullMQ**: Production (issue #8)

### Quality Gates (`src/gate/`)

Human-in-the-loop approval before critical actions.

- `manual_approval`
- `security_review`
- `test_pass`

## Data Flow

```
TriggerEvent
    ↓
Routine Matcher
    ↓
Engine
    ├─→ Skill Loader
    ├─→ Provider.complete()
    ├─→ Connector (if needed)
    └─→ Persistence.save()
```

## Error Handling

All async operations use Effect v3 for:
- Typed errors (no thrown exceptions)
- Composable retry policies
- Resource safety

## Directory Structure

```
src/
  connector/     # External service integrations
  engine/        # Execution orchestrator
  gate/          # Human-in-the-loop approval
  persistence/   # Execution state storage
  provider/      # LLM provider adapters
  queue/         # Job queue abstraction
  routine/       # YAML routine parsing & matching
  skill/         # Skill loading from filesystem
  trigger/       # Trigger implementations
```
