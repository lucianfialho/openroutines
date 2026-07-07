# Quick Start

Complete walkthrough from zero to your first automated execution, using the raw `/trigger` API directly — the generic path for any routine. For the real day-to-day workflow (a Trello board, cards in, PRs out), see [`../LOCAL.md`](../LOCAL.md) instead.

## Prerequisites

- Node.js >= 20
- Git
- (Optional) Docker + Docker Compose
- A logged-in [Claude Code](https://claude.com/claude-code) CLI (`claude setup-token` for headless/subscription auth) — no API key required for the default CLI-first providers
- A [GitHub Personal Access Token](https://github.com/settings/tokens)

## 1. Clone & Install

```bash
git clone https://github.com/lucianfialho/openroutines.git
cd openroutines
npm install
```

## 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Providers run CLI-first: the pipeline drives the logged-in `claude`/`kimi`
# CLIs headless — no API key required. Run `claude setup-token` once (or log
# in interactively) and paste the printed token here for headless/subscription
# auth:
CLAUDE_CODE_OAUTH_TOKEN=your-claude-code-oauth-token

# Optional opt-in upgrades: switch a provider to the billed API instead of the
# subscription CLI (see .env.example for what each one changes)
# KIMI_API_KEY=sk-your-kimi-code-key
# ANTHROPIC_API_KEY=sk-ant-...

# Required for GitHub tools
GITHUB_TOKEN=ghp-your-github-token
GITHUB_REPO=your-org/your-repo

# Optional: GitHub webhook secret (for receiving webhooks)
# GITHUB_WEBHOOK_SECRET=your-webhook-secret

# Optional: PostgreSQL (defaults to in-memory) — see ../LOCAL.md for the
# Docker setup used by the real day-to-day (Trello) workflow
# DATABASE_URL=postgresql://openroutines:openroutines@localhost:5432/openroutines

# Optional: Redis (defaults to in-memory queue)
# REDIS_URL=redis://localhost:6379

# Server port (default: 3000)
PORT=3000
```

> **Note:** `KIMI_MODEL` defaults to `kimi-coding/k2p5` (Kimi Code's Anthropic-compatible API at `https://api.kimi.com/coding` — different from the Kimi Platform at `api.moonshot.cn`). Only relevant if you opt into `KIMI_API_KEY`.

## 3. Run Tests

```bash
npm test
```

All tests should pass.

## 4. Start the Server

### Local Development

```bash
npm run dev
```

The server starts on `http://localhost:3000` (or your `PORT`).

> Logs go to stdout. The server watches for TypeScript changes and auto-reloads.

### With Docker Compose

```bash
docker-compose up
```

This starts:
- OpenRoutines app on port 3003
- PostgreSQL on port 5432
- Redis on port 6379

## 5. Verify It's Running

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "routines": 2,
  "provider": "kimi-cli",
  "persistence": "in-memory",
  "queue": "in-memory",
  "tools": 4,
  "gates": "in-memory"
}
```

## 6. Trigger Your First Routine

The project comes with sample routines. Let's trigger `daily-pr-review`:

```bash
curl -X POST http://localhost:3000/trigger/daily-pr-review \
  -H "Content-Type: application/json" \
  -d '{"repo": "your-org/your-repo", "issue_number": 1}'
```

### What happens:

1. The engine matches the trigger to the `daily-pr-review` routine
2. Loads the `solve-issue` skill
3. Checks the `security_review` gate (blocks until approved)
4. You approve the gate:
   ```bash
   curl -X POST http://localhost:3000/gates/<execution-id>/approve \
     -H "Content-Type: application/json" \
     -d '{"reason": "LGTM"}'
   ```
5. The engine sends the prompt to Kimi Coding
6. The LLM may request tool calls (e.g., `github_fetch_issue`)
7. Tools execute and results are fed back to the LLM
8. Final response is persisted and returned

## 7. View the Execution

```bash
# List all executions
curl http://localhost:3000/executions

# Get specific execution
curl http://localhost:3000/executions/<execution-id>
```

## 8. Create Your Own Routine

### Create a Skill

Create `.gates/skills/my-skill.md`:

```markdown
# Skill: my-skill

## Goal
Describe what this skill does.

## Input
- `param1`: description
- `param2`: description

## Output
Describe the expected output.

## Steps
1. Step one
2. Step two
3. Step three
```

### Create a Routine

Create `routines/my-routine.yaml`:

```yaml
id: my-routine
triggers:
  - type: api
gates:
  - security_review
connectors:
  - name: github
    source: .gates/connectors/github/connector.yaml
pipeline:
  skill: my-skill
```

### Trigger It

```bash
curl -X POST http://localhost:3000/trigger/my-routine \
  -H "Content-Type: application/json" \
  -d '{"param1": "value1"}'
```

> **Note:** Routines are loaded at startup. Restart the server after adding new routines.

## Troubleshooting

### "Provider completion failed"

- Default CLI-first path: confirm `claude`/`kimi` are logged in on this machine (`claude setup-token`'s output goes in `CLAUDE_CODE_OAUTH_TOKEN`) and the subscription is active
- If you opted into `KIMI_API_KEY` / `ANTHROPIC_API_KEY`: check the key is correct and not expired
- Check logs for the specific error

### "Tool 'github_fetch_issue' executed. Output: error"

- Verify `GITHUB_TOKEN` is valid
- Ensure `GITHUB_REPO` is set correctly (`owner/repo` format)
- The token needs `repo` scope

### "Gate not found"

- Gates are created when a routine is triggered
- Check the execution ID from the trigger response

### Port already in use

```bash
# Find and kill process on port 3000
lsof -ti:3000 | xargs kill -9
```

## Next Steps

- Read [`../LOCAL.md`](../LOCAL.md) for the real day-to-day workflow: a Trello board, the first-run wizard, and what happens when you move a card
- Read [`ARCHITECTURE.md`](ARCHITECTURE.md) to understand the system
- Read [`TEMPLATES.md`](TEMPLATES.md) for skill and routine templates
- Check [`CONTRIBUTING.md`](../CONTRIBUTING.md) to contribute
