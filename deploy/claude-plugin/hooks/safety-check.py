#!/usr/bin/env python3
"""OpenRoutines guardrail hook -- Camada 4 (.openroutines/05-GUARDRAILS-SEGURANCA.md).

PreToolUse ALLOWLIST for Bash (not a denylist -- glob-matching against a
Turing-complete shell loses to `bash -c`, aliases, and generated scripts; see
05, "Hook 1 -- Bash como ALLOWLIST"), plus a path-deny for Edit|Write ("Hook 2").

Registered for both matchers by hooks.json; this single script dispatches on
`tool_name` from the hook's stdin JSON.

Contract (Claude Code PreToolUse hooks):
  stdin  = JSON object with at least {"tool_name": str, "tool_input": {...}}
           (also cwd, session_id, etc. -- see hook-development docs)
  exit 0 = allow
  exit 2 = block; stderr is fed back to Claude as the reason
Fails closed: anything malformed or unrecognized is a block, never an allow.
"""

import json
import os
import shlex
import sys
from datetime import datetime, timezone

BLOCKED_LOG = "/var/log/openroutines/blocked.log"

# npm/pnpm "install family" verbs that only ever pull what's already declared
# in package.json / the lockfile (no bare package name allowed after them --
# see check_npm_like).
NPM_LIKE = {"npm", "pnpm"}

# Starter allowlist for `npx <bin>` -- binaries this project's own verify
# pipeline shells out to (see repos.yaml: "npx tsc --noEmit").
# ponytail: fixed list, not derived from package.json bin/ -- good enough for
# the pilot repos; extend per repo profile if another CLI is needed.
NPX_ALLOWLIST = {"tsc", "vitest", "eslint", "prettier", "tsx"}

# Shell metacharacters/operators that turn one allowed verb into an arbitrary
# shell program (chaining, substitution, redirection, backgrounding). This is
# the actual "allowlist beats denylist" boundary from 05: even a fully-allowed
# verb (e.g. `git commit -m`) is rejected outright if the raw string contains
# any of these, because Claude Code's Bash tool runs the string through a real
# shell -- `$(...)`/backticks substitute even inside double-quoted strings.
DANGEROUS_SUBSTRINGS = (";", "|", "&", "`", "$(", "<(", ">(", "\n", "\r", ">", "<")

SHELL_DOTFILES = {
    ".bashrc", ".bash_profile", ".bash_login", ".bash_logout",
    ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout",
    ".profile",
}


def log_blocked(tool_name, reason, detail):
    try:
        os.makedirs(os.path.dirname(BLOCKED_LOG), exist_ok=True)
        with open(BLOCKED_LOG, "a", encoding="utf-8") as fh:
            fh.write(
                json.dumps(
                    {
                        "ts": datetime.now(timezone.utc).isoformat(),
                        "tool_name": tool_name,
                        "reason": reason,
                        "detail": detail,
                    }
                )
                + "\n"
            )
    except OSError:
        pass  # best-effort logging only; the block decision never depends on this.


def deny(tool_name, reason, detail=""):
    log_blocked(tool_name, reason, detail)
    sys.stderr.write(f"[openroutines guardrail] blocked: {reason}\n")
    sys.exit(2)


def allow():
    sys.exit(0)


def is_dangerous_command(command):
    return any(sub in command for sub in DANGEROUS_SUBSTRINGS)


def _safe_relative_path(token):
    """True if `token` is a plain path that stays inside the worktree."""
    if token.startswith("-") or token in (".", "*"):
        return False  # no flags (-A/--all/-f/--force), no "add everything"
    if token.startswith("~"):
        return False  # shlex does not expand `~`; a real shell would
    normalized = os.path.normpath(token)
    if os.path.isabs(normalized) or normalized.startswith(".."):
        return False
    return True


def check_git(tokens):
    """tokens[0] == 'git'. Returns True if the whole command is allowed."""
    if len(tokens) < 2:
        return False
    sub = tokens[1]

    if sub == "add":
        paths = tokens[2:]
        return bool(paths) and all(_safe_relative_path(p) for p in paths)

    if sub == "commit":
        return len(tokens) == 4 and tokens[2] == "-m"  # `git commit -m <message>`

    if sub == "status":
        return len(tokens) == 2  # bare `git status`, no extra args

    if sub in ("diff", "log"):
        return True  # `diff*` / `log*` -- read-only, any extra args allowed

    return False


def load_package_scripts(cwd):
    try:
        with open(os.path.join(cwd, "package.json"), encoding="utf-8") as fh:
            data = json.load(fh)
        scripts = data.get("scripts")
        return scripts if isinstance(scripts, dict) else {}
    except (OSError, ValueError):
        return {}


def check_npm_like(tokens, cwd):
    """tokens[0] in {'npm', 'pnpm'}. Returns True if allowed."""
    if len(tokens) < 2:
        return False
    sub = tokens[1]

    if sub in ("ci", "install"):
        # Only flags after `install`/`ci` -- a bare positional token is a
        # package name being added outside package.json (the exact
        # supply-chain hole Camada 5 names: `npm install left-pad`).
        return all(t.startswith("-") for t in tokens[2:])

    scripts = load_package_scripts(cwd)

    if sub == "run":
        return len(tokens) >= 3 and tokens[2] in scripts

    if sub in ("test", "start", "stop", "restart"):
        return sub in scripts  # npm's built-in script-name shortcuts

    return False


def check_npx(tokens):
    return len(tokens) >= 2 and tokens[1] in NPX_ALLOWLIST


def check_bash(tool_input, cwd):
    command = tool_input.get("command")
    if not isinstance(command, str) or not command.strip():
        return False, "missing/non-string Bash command"

    command = command.strip()
    if is_dangerous_command(command):
        return False, "shell metacharacter/operator not allowed (chaining, substitution, redirection, backgrounding)"

    try:
        tokens = shlex.split(command)
    except ValueError as exc:
        return False, f"unparsable command ({exc})"

    if not tokens:
        return False, "empty command"

    verb = tokens[0]
    if verb == "git":
        ok = check_git(tokens)
    elif verb in NPM_LIKE:
        ok = check_npm_like(tokens, cwd)
    elif verb == "npx":
        ok = check_npx(tokens)
    else:
        ok = False

    if not ok:
        return False, f"command not on the allowlist: {command!r}"
    return True, ""


def check_edit_write(tool_input):
    file_path = tool_input.get("file_path")
    if not isinstance(file_path, str) or not file_path:
        return False, "missing/non-string file_path"

    normalized = os.path.normpath(file_path).replace(os.sep, "/")
    anchored = "/" + normalized.lstrip("/")  # treat relative & absolute paths alike

    if anchored.endswith("/.git") or "/.git/" in anchored:
        return False, f"path under .git/: {file_path}"
    if "/.github/workflows/" in anchored:
        return False, f"path under .github/workflows/: {file_path}"
    if os.path.basename(normalized) in SHELL_DOTFILES:
        return False, f"shell rc/profile dotfile: {file_path}"

    return True, ""


def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except ValueError:
        deny("unknown", "malformed hook input (invalid JSON)", raw[:200])

    if not isinstance(data, dict):
        deny("unknown", "malformed hook input (not a JSON object)")

    tool_name = data.get("tool_name")
    tool_input = data.get("tool_input")
    if not isinstance(tool_name, str) or not isinstance(tool_input, dict):
        deny(str(tool_name), "malformed hook input (missing tool_name/tool_input)")

    cwd_raw = data.get("cwd")
    cwd = cwd_raw if isinstance(cwd_raw, str) and cwd_raw else os.getcwd()

    if tool_name == "Bash":
        ok, reason = check_bash(tool_input, cwd)
        if not ok:
            deny(tool_name, reason, tool_input.get("command", ""))
        allow()

    elif tool_name in ("Edit", "Write"):
        ok, reason = check_edit_write(tool_input)
        if not ok:
            deny(tool_name, reason, tool_input.get("file_path", ""))
        allow()

    else:
        # Only wired to the Bash and Edit|Write matchers (see hooks.json); any
        # other tool_name reaching this hook is out of its scope -- allow.
        allow()


if __name__ == "__main__":
    main()
