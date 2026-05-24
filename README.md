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

# 3. Run
docker-compose up
```

## Architecture

```
Trigger Layer (cron / GitHub webhook / API)
       ↓
Scheduler / Queue (BullMQ + Redis)
       ↓
Execution Engine (Effect v4 runtime)
       ↓
Provider (Kimi K2.6) + Connectors (CLI) + Gates (human QA)
       ↓
Persistence (PostgreSQL)
```

## Project Status

🚧 **Early development** — bootstrapping the core engine.

See [open issues](https://github.com/lucianfialho/openroutines/issues) for what's being built.

## License

MIT
