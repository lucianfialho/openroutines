# Skill: solve-issue

## Goal
Take a GitHub issue, understand it, delegate to the right specialist, and produce a verified Pull Request.

## Input
- `repo`: owner/repo slug
- `issue_number`: integer

## Output
- Branch name
- Commit message
- PR title and description
- Diffs (if applicable)

## Steps

1. **Fetch issue** — Read title, body, labels, comments.
2. **Classify domain** — backend | frontend | qa | ux | security
3. **Create branch** — `feat/issue-{number}-{slug}`
4. **Research codebase** — List files to read based on issue context.
5. **Implement** — Write code changes as unified diffs.
6. **Write tests** — Cover new code with tests.
7. **Verify** — Lint, type-check, run tests.
8. **Self-review** — Security + coverage validation.
9. **Commit & PR** — Push branch and open PR.

## Quality Gates
- Must have tests
- Must pass lint/type-check
- Must not expose secrets
- Must reference issue in PR body
