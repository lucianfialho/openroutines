# Skill: self-improve

## Goal
Improve the OpenRoutines codebase by picking an open issue, understanding it, reading relevant code, implementing the fix, running tests, and creating a pull request.

## Input
- `repo`: owner/repo slug
- `issue_number`: integer (optional — if not provided, list open issues and pick the most relevant one)

## Output
- Branch name
- Files modified
- Test results
- PR number and URL

## Steps

1. **List open issues** — Use `github_list_issues` to find open issues. Pick the most actionable one (not blocked, has clear description).
2. **Fetch issue details** — Use `github_fetch_issue` to read the full body, labels, and comments.
3. **Analyze scope** — Determine which files need to change. Read them with `read_file`.
4. **Implement fix** — Write the corrected code with `write_file`. Follow existing patterns.
5. **Run tests** — Use `run_shell` with `npm test` or `npx tsc --noEmit` to verify.
6. **Run lint** — Use `run_shell` with `npm run lint` if available.
7. **Commit & PR** — Use `run_shell` with `git checkout -b`, `git add`, `git commit`, and `gh pr create`.
8. **Report** — Summarize what was done, link the PR, and note any follow-up needed.

## Constraints
- NEVER modify files outside the project root (paths are sandboxed).
- ALWAYS run tests before creating a PR. If tests fail, fix them.
- NEVER commit directly to main — always create a branch.
- If an issue is unclear, comment on it asking for clarification rather than guessing.
- Keep changes minimal. One issue = one focused PR.

## Quality Gates
- Tests must pass (`npm test` exit code 0)
- TypeScript must compile (`npx tsc --noEmit` exit code 0)
- No secrets or API keys in committed code
- PR must reference the issue number
