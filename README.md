# OpenRoutines

Open-source, self-hosted automation platform for engineering workflows.
**Bring your own model.** Start with [Kimi K2.6](https://platform.moonshot.cn/).

> Inspired by [Claude Code Routines](https://docs.anthropic.com/en/docs/claude-code/routines), [Oz for OSS](https://oz.flori.sh), and [Hermes](https://github.com/theredsix/hermes).

## Philosophy

- **Self-hosted**: Your code, your infra, your API keys.
- **CLI-first connectors**: If a service has a CLI, use it. API only as fallback.
- **Human-in-the-loop**: Quality gates block actions until a human approves.
- **Open-source**: MIT licensed. No proprietary black boxes.

## Quick Start

```bash
# 1. Clone
git clone https://github.com/lucianfialho/openroutines.git
cd openroutines

# 2. Configure
cp .env.example .env
# Edit .env with your KIMI_API_KEY and GITHUB_TOKEN

# 3. Run tests
npm install
npm test

# 4. Run with Docker Compose
docker-compose up
```

## Architecture

```
Trigger Layer (cron / GitHub webhook / API)
       ↓
Scheduler / Queue (BullMQ + Redis — issue #8)
       ↓
Execution Engine (Effect v3 runtime)
       ↓
Provider (Kimi K2.6) + Connectors (CLI) + Gates (human QA)
       ↓
Persistence (PostgreSQL — issue #7)
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for details.

## What's Working

| Feature | Status |
|---------|--------|
| Kimi K2.6 Provider | ✅ Streaming, retry, token tracking |
| Execution Engine | ✅ Routine resolution, skill loading, prompt building |
| Cron Scheduler | ✅ `node-cron` with timezone support |
| GitHub Webhook | ✅ HMAC-SHA256 verification |
| GitHub Connector | ✅ `gh issue/pr` commands |
| Zod Schema Validation | ✅ Strict YAML validation |
| Quality Gates | ✅ Manual approval, security review |
| CI/CD | ✅ GitHub Actions (test + type-check + Docker) |
| PostgreSQL Persistence | ✅ Migrations + upsert |

See [open issues](https://github.com/lucianfialho/openroutines/issues) for what's next.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT
