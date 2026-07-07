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

## How it works

Day-to-day, OpenRoutines runs as an unattended developer working off a Trello board — cards in, PRs out, no dashboard to babysit.

1. **Write a card**: title, description, and a project label (e.g. `Detect Water`, aliased in `repos.yaml`) — that's the minimum. No type label means "implementation"; `OpenRoutines: Pesquisa` / `Mapeamento` / `Update` route to the other pipelines.
2. **Name the repo, optionally**: a `## Repositório` line in the description is optional and wins over the label when present.
3. **Move the card to the queue** (`OpenRoutines — Fila`) — that move is the whole trigger. The two dedicated columns (queue/working) no longer require the `OpenRoutines` flag label; it's only needed to tell cards apart in the columns shared with the team (Backlog/Blocked/Review/Done).
4. **Triage** picks it up on the next cron tick (every 30 min, daytime) and comments the repo, type, complexity, its interpretation, acceptance criteria, and any blocking questions right on the card. Ready cards wait for the night run; cards needing input move to `Blocked` with what's missing.
5. **The night run** (01:00) turns every ready card into a pull request — implementation cards get code + tests, research cards get a written opinion, repo-mapping cards get a `REPO-PROFILE.md` PR. A card with no resolvable repo never sits silently: it gets a comment explaining why and moves to `Blocked`.

See [`LOCAL.md`](LOCAL.md) — **Local setup & day-to-day usage** — for the step-by-step setup and the full Trello workflow.

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

## Deploy Options

| Target | Best For | Docs |
|---|---|---|
| **Vercel + Neon** | Free serverless, always-on webhooks | [`VERCEL-DEPLOY.md`](VERCEL-DEPLOY.md) |
| **Tailscale + Local** | Private tailnet, self-hosted | [`TAILSCALE-DEPLOY.md`](TAILSCALE-DEPLOY.md) |
| **Docker Compose** | Local dev, full control | [`docker-compose.yml`](docker-compose.yml) |

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
