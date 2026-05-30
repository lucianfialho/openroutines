# Skill: pr-review

## Goal
Review open pull requests in the repository. For each PR, analyze the code changes, check for issues (bugs, style, security), and post a review comment with findings.

## Input
- `repo`: owner/repo slug

## Output
- Review comments posted on PRs
- Summary of findings

## Steps

1. **List open PRs** — Use `github_list_pull_requests` to find open PRs.
2. **Pick a PR** — Select the most critical or recently opened one.
3. **Fetch PR details** — Use `github_fetch_issue` with the PR number to get title, body, and labels.
4. **Read changed files** — Use `run_shell` with `gh pr view <number> --json files` or read the diff via `git`.
5. **Analyze code** — Read the relevant source files with `read_file`. Look for:
   - Bugs or logic errors
   - Missing error handling
   - Security issues (secrets, injections)
   - Type errors (run `npx tsc --noEmit`)
   - Missing tests
   - Code style issues
6. **Post review** — Use `github_add_comment` to post a structured review on the PR.

## Review Template

```markdown
## PR Review

### Summary
Brief description of what the PR does and overall assessment.

### Issues Found
- [ ] **Issue 1**: Description and severity (critical/warning/info)
- [ ] **Issue 2**: Description and severity

### Suggestions
- Suggestion 1
- Suggestion 2

### Tests
- [ ] Tests pass
- [ ] New code has test coverage

### Approval
- [ ] Approved
- [ ] Changes requested
- [ ] Comment only
```

## Constraints
- Be constructive and specific in feedback.
- Do not block PRs for minor style issues unless they violate project conventions.
- Always check TypeScript compilation before approving.
- Never approve PRs that introduce security vulnerabilities.
