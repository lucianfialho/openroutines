# Skill & Routine Templates

Use these templates to create new automation workflows without reading the source code.

---

## Skill Template

Create a file at `.gates/skills/<skill-name>.md`:

```markdown
# Skill: <skill-name>

## Goal
One-sentence description of what this skill accomplishes.

## Input
- `repo`: owner/repo slug (e.g., `octocat/Hello-World`)
- `issue_number`: integer

## Output
- Expected deliverable 1
- Expected deliverable 2

## Steps

1. **Fetch data** — Use available tools to gather context.
2. **Analyze** — Process the information.
3. **Act** — Perform the main task.
4. **Verify** — Confirm the result is correct.

## Quality Gates
- Must not expose secrets
- Must reference the issue number
- Must include tests (if code changes)
```

### Skill Guidelines

- Keep it under 50 lines for readability
- Use numbered steps (the LLM follows them better)
- List required inputs explicitly
- Define quality gates the LLM should self-check

---

## Routine Template

Create a file at `routines/<routine-name>.yaml`:

```yaml
id: <routine-name>
name: Human-readable name
description: What this routine does and when it runs

triggers:
  # Trigger 1: API call (manual or programmatic)
  - type: api

  # Trigger 2: Cron schedule
  # - type: cron
  #   schedule: "0 9 * * 1-5"  # 9am, Monday-Friday

  # Trigger 3: GitHub webhook
  # - type: github_issue_opened
  #   filters:
  #     labels: ["bug", "help wanted"]

gates:
  # Human approval required before execution
  - security_review
  # - deploy_approval

connectors:
  # External services this routine can use
  - name: github
    source: .gates/connectors/github/connector.yaml

pipeline:
  skill: <skill-name>  # Must match a .md file in .gates/skills/
```

### Routine Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | ✅ | Unique identifier (used in API `/trigger/:id`) |
| `name` | ❌ | Human-readable name |
| `description` | ❌ | What this routine does |
| `triggers` | ✅ | List of triggers that activate this routine |
| `gates` | ❌ | Human approval checkpoints |
| `connectors` | ❌ | External services available to the skill |
| `pipeline.skill` | ✅ | Which skill to execute |

### Trigger Types

| Type | Example | Description |
|------|---------|-------------|
| `api` | `type: api` | Manual trigger via `POST /trigger/:routineId` |
| `cron` | `type: cron`<br>`schedule: "0 9 * * 1-5"` | Scheduled execution (cron syntax) |
| `github_issue_opened` | `type: github_issue_opened`<br>`filters: {labels: ["bug"]}` | GitHub webhook trigger |
| `github_pr_opened` | `type: github_pr_opened` | Triggered when a PR is opened |

### Gate Types

| Gate | Description |
|------|-------------|
| `security_review` | Requires human approval for security-sensitive actions |
| `deploy_approval` | Requires approval before deploying |
| `budget_review` | Requires approval for expensive operations |

---

## Connector Configuration

Create `.gates/connectors/<name>/connector.yaml`:

```yaml
name: <connector-name>
description: What this connector does
operations:
  - fetchIssue
  - listPullRequests
  - createPullRequest
  - addComment
```

Tools are implemented in `src/tool/<connector>-tools.ts` and registered automatically.

---

## Examples

### Example 1: Daily PR Review

**Skill** (`.gates/skills/review-prs.md`):
```markdown
# Skill: review-prs

## Goal
Review all open PRs and provide feedback.

## Input
- `repo`: owner/repo slug

## Output
- Review comments for each PR

## Steps
1. List all open PRs
2. For each PR, analyze the diff
3. Check for: tests, docs, security issues
4. Add review comments
```

**Routine** (`routines/daily-pr-review.yaml`):
```yaml
id: daily-pr-review
triggers:
  - type: cron
    schedule: "0 9 * * 1-5"
gates:
  - security_review
connectors:
  - name: github
    source: .gates/connectors/github/connector.yaml
pipeline:
  skill: review-prs
```

### Example 2: Auto-fix Bug Issues

**Skill** (`.gates/skills/fix-bug.md`):
```markdown
# Skill: fix-bug

## Goal
Fix a reported bug and open a PR.

## Input
- `repo`: owner/repo slug
- `issue_number`: integer

## Steps
1. Fetch the issue details
2. Understand the bug from title + description
3. Find the relevant code
4. Implement the fix
5. Write a test for the fix
6. Create a branch and PR
```

**Routine** (`routines/auto-fix-bug.yaml`):
```yaml
id: auto-fix-bug
triggers:
  - type: github_issue_opened
    filters:
      labels: ["bug", "auto-fix"]
gates:
  - security_review
connectors:
  - name: github
    source: .gates/connectors/github/connector.yaml
pipeline:
  skill: fix-bug
```

---

## Hot Reload

Routines and skills are **loaded at startup**. After creating or modifying a routine or skill, restart the server:

```bash
# If running with npm run dev, save any .ts file to trigger reload
# Or manually restart:
Ctrl+C && npm run dev
```
