# OpenRoutines

> Self-hosted Claude Code Routines. Automate your engineering workflows with any LLM, keep your code on-prem, and approve every critical step.

OpenRoutines is an open-source, self-hosted automation platform for engineering workflows. Define routines as YAML, load skills from Markdown, and let an LLM agent execute them — with human approval gates blocking every critical action.

**Inspired by** [Claude Code Routines](https://docs.anthropic.com/en/docs/claude-code/routines), [Oz for OSS](https://oz.flori.sh), and [Hermes](https://github.com/theredsix/hermes).

## Philosophy

- **Self-hosted**: Your code, your infra, your API keys. Nothing leaves your network.
- **Bring your own model**: Kimi Coding, OpenAI, Anthropic — plug in any provider.
- **Human-in-the-loop**: Quality gates block actions until a human approves.
- **CLI-first connectors**: If a service has a CLI, use it. API only as fallback.
- **Open-source**: MIT licensed. No proprietary black boxes.

## Quick Start

```bash
# 1. Clone
git clone https://github.com/lucianfialho/openroutines.git
cd openroutines

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your KIMI_API_KEY (from https://www.kimi.com/code/console)
# and GITHUB_TOKEN (from https://github.com/settings/tokens)

# 4. Run tests
npm test

# 5. Start the server
npm run dev
# Server runs on http://localhost:3000 (or PORT from .env)

# 6. Trigger a routine
curl -X POST http://localhost:3000/trigger/daily-pr-review \
  -H "Content-Type: application/json" \
  -d '{"repo": "owner/repo", "issue_number": 42}'
```

See [`docs/QUICKSTART.md`](docs/QUICKSTART.md) for the full walkthrough.

## What's Working

| Feature | Status |
|---------|--------|
| Kimi Coding Provider (Anthropic API) | ✅ Streaming, retry, token tracking |
| Execution Engine (ReAct loop) | ✅ Provider → tool calls → execution |
| Quality Gates | ✅ Manual approval, security review |
| GitHub Connector | ✅ `gh issue/pr/comment` commands |
| Cron Scheduler | ✅ `node-cron` with timezone support |
| GitHub Webhook | ✅ HMAC-SHA256 verification |
| Zod Schema Validation | ✅ Strict YAML validation |
| PostgreSQL Persistence | ✅ Migrations + upsert |
| BullMQ Queue | ✅ Redis-backed job queue |
| CI/CD | ✅ GitHub Actions (test + type-check + Docker) |

## Architecture

```
Trigger Layer (cron / GitHub webhook / API)
       ↓
Scheduler / Queue (BullMQ + Redis)
       ↓
Execution Engine (Effect v3 runtime)
       ↓
Provider (Kimi Coding / any LLM) + Connectors + Gates
       ↓
Persistence (PostgreSQL)
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for details.

## Project Structure

```
routines/              # YAML routine definitions
.gates/
  skills/              # Markdown skill definitions
  connectors/          # Connector configurations
src/
  engine/              # Execution orchestrator
  provider/            # LLM adapters
  tool/                # Tool registry + implementations
  trigger/             # Cron, webhook, API triggers
  routine/             # YAML parser + matcher
  skill/               # Skill loader
  gate/                # Approval engine
  persistence/         # In-memory + PostgreSQL
  queue/               # In-memory + BullMQ
```

## Adding a Routine

1. Create `routines/<name>.yaml` (see [`docs/TEMPLATES.md`](docs/TEMPLATES.md))
2. Create `.gates/skills/<skill>.md` (see [`docs/TEMPLATES.md`](docs/TEMPLATES.md))
3. Restart the server (`routines are loaded at startup`)

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Service health check |
| POST | `/trigger/:routineId` | Manually trigger a routine |
| GET | `/executions` | List all executions |
| GET | `/executions/:id` | Get execution by ID |
| GET | `/gates/:executionId` | Get gate status |
| POST | `/gates/:executionId/approve` | Approve a gate |
| POST | `/gates/:executionId/reject` | Reject a gate |
| POST | `/webhooks/github` | GitHub webhook endpoint |

## Docker

```bash
# Run with PostgreSQL + Redis
docker-compose up

# Or build the image
docker build -t openroutines .
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT
