#!/usr/bin/env bash
#
# scripts/supply-chain/_guard.sh
#
# Shared logic sourced by the npm/pnpm/npx shims in this directory (F4 #156,
# .openroutines/05-GUARDRAILS-SEGURANCA.md Camada 5 "supply chain de
# dependências"). Not an entrypoint itself -- no execute bit needed, kept out
# of the 3 binaries the guard installs so the logic exists exactly once
# instead of tripled across near-identical wrappers.
#
# Contract: for install/add/ci (or an npx target) touching a package that is
# NOT yet in this worktree's package.json/lockfile, run a supply-chain
# checker (npq|socket, SUPPLY_CHAIN_GUARD env, default npq) in non-interactive
# mode before ever calling the real binary. Checker exit != 0 (including "not
# installed on this box") aborts -- the real binary is never invoked, and the
# decision is logged so a card's handoff/comment can cite it. Otherwise
# delegate to the real binary with --ignore-scripts, unless every package
# this invocation touches is on the lifecycle-scripts allowlist
# (config/supply-chain-allowlist.yaml), in which case delegate with
# --ignore-scripts=false (a CLI flag always wins over the worktree's
# .npmrc -- see src/security/supply-chain-guard.ts's ensureIgnoreScripts).
#
# Golden rule (05): no guardrail depends on an instruction in a prompt -- this
# boundary is the PATH the executor's subprocess gets (src/provider/
# claude-cli.ts, kimi-cli.ts prefix supplyChainShimDir() onto it), never a
# request to the model to "be careful with installs".

set -euo pipefail

SHIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SHIM_DIR/../.." && pwd)"
DEFAULT_ALLOWLIST_PATH="$REPO_ROOT/config/supply-chain-allowlist.yaml"

# Resolve the REAL binary for $1 by searching PATH with this shim's own
# directory removed first -- otherwise `command -v` would just resolve back
# to this same shim (the classic self-recursive-shim bug).
find_real_bin() {
  local name="$1" dir stripped=""
  local IFS=:
  for dir in $PATH; do
    [ "$dir" = "$SHIM_DIR" ] && continue
    stripped="${stripped:+$stripped:}$dir"
  done
  ( PATH="$stripped" command -v "$name" )
}

# Bare package name from a `name` / `name@version` / `@scope/name` /
# `@scope/name@version` spec.
bare_name() {
  printf '%s' "$1" | sed -E 's/^(@[^@]+\/[^@]+|[^@]+).*/\1/'
}

# Every dependency name currently declared in ./package.json (any of the 4
# dependency fields) -- used when a command names no explicit package: a bare
# `install`/`ci` only refreshes what's already declared, nothing "new".
all_package_json_deps() {
  node -e '
    const fs = require("fs");
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); } catch { pkg = {}; }
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies);
    for (const name of Object.keys(deps)) console.log(name);
  ' 2>/dev/null || true
}

# ponytail: package.json/lockfile membership is a best-effort text/JSON check,
# not real dependency resolution -- a false "unknown" just costs one extra
# checker call (the safe direction); it can never falsely mark a package
# "known" and skip the checker.
is_known_package() {
  local name="$1"
  if SC_GUARD_PKG_NAME="$name" node -e '
    const fs = require("fs");
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); } catch { pkg = {}; }
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies);
    process.exit(Object.prototype.hasOwnProperty.call(deps, process.env.SC_GUARD_PKG_NAME) ? 0 : 1);
  ' 2>/dev/null; then
    return 0
  fi
  if [ -f package-lock.json ] && grep -qF "\"$name\"" package-lock.json 2>/dev/null; then return 0; fi
  if [ -f pnpm-lock.yaml ] && grep -qF "$name" pnpm-lock.yaml 2>/dev/null; then return 0; fi
  return 1
}

allowlist_path() {
  printf '%s' "${SUPPLY_CHAIN_ALLOWLIST_PATH:-$DEFAULT_ALLOWLIST_PATH}"
}

# The config is kept to a single-line flow-style YAML list on purpose (see
# config/supply-chain-allowlist.yaml) so it can be parsed here with grep/sed
# instead of pulling a YAML library into a plain shell script.
is_allowlisted() {
  local name="$1" path line items item
  path="$(allowlist_path)"
  [ -f "$path" ] || return 1
  line="$(grep -E '^[[:space:]]*allow_lifecycle_scripts[[:space:]]*:' "$path" | head -n1)"
  [ -n "$line" ] || return 1
  items="${line#*[}"
  items="${items%]*}"
  items="${items//\"/}"
  local IFS=,
  for item in $items; do
    item="$(printf '%s' "$item" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
    [ "$item" = "$name" ] && return 0
  done
  return 1
}

all_allowlisted() {
  [ "$#" -eq 0 ] && return 1
  local name
  for name in "$@"; do
    is_allowlisted "$name" || return 1
  done
  return 0
}

# Sets global CHECKER_BIN so callers can log which checker decided, whether or
# not it was actually found. Runs non-interactively: stdin from /dev/null
# (works regardless of the checker's own flag surface) plus CI=1 (the common
# ecosystem convention for "skip interactive prompts").
run_checker() {
  CHECKER_BIN="${SUPPLY_CHAIN_GUARD:-npq}"
  local bin
  bin="$(command -v "$CHECKER_BIN" 2>/dev/null)" || {
    echo "[supply-chain-guard] checker '$CHECKER_BIN' not found on PATH -- treating as blocked"
    return 1
  }
  CI=1 "$bin" "$@" < /dev/null
}

# Args after the subcommand that aren't flags -- i.e. explicit package specs.
# ponytail: doesn't special-case flags that take a separate value arg (e.g.
# `--registry <url>`) -- upgrade to a real argv grammar if that bites.
collect_positional() {
  local a
  for a in "$@"; do
    case "$a" in
      -*) continue ;;
      *) printf '%s\n' "$a" ;;
    esac
  done
}

handle_npm_like() {
  local tool="$1" real_bin="$2"
  shift 2
  local sub="${1:-}"
  case "$sub" in
    install|i|add|ci) : ;;
    *) exec "$real_bin" "$@" ;; # not install-like -- pure passthrough, no guard logic
  esac

  local rest=("${@:2}")
  local positional=()
  while IFS= read -r line; do [ -n "$line" ] && positional+=("$line"); done < <(collect_positional "${rest[@]:-}")

  local involved=()
  if [ "${#positional[@]}" -eq 0 ]; then
    # Bare install/ci: "involved" = everything already declared, so it can
    # never be "unknown" below -- matches the accept criterion that a plain
    # `npm ci`/`install` never triggers the checker.
    while IFS= read -r line; do [ -n "$line" ] && involved+=("$line"); done < <(all_package_json_deps)
  else
    local spec
    for spec in "${positional[@]}"; do involved+=("$(bare_name "$spec")"); done
  fi

  local unknown=()
  if [ "${#positional[@]}" -gt 0 ]; then
    local name
    for name in "${involved[@]}"; do
      is_known_package "$name" || unknown+=("$name")
    done
  fi

  if [ "${#unknown[@]}" -gt 0 ]; then
    if ! run_checker "${unknown[@]}"; then
      echo "[supply-chain-guard] BLOCKED: $CHECKER_BIN flagged ${unknown[*]} -- $tool $sub aborted, real binary never invoked"
      exit 1
    fi
    echo "[supply-chain-guard] $CHECKER_BIN OK: ${unknown[*]}"
  fi

  local extra_flag="--ignore-scripts"
  if [ "${#involved[@]}" -gt 0 ] && all_allowlisted "${involved[@]}"; then
    extra_flag="--ignore-scripts=false"
    echo "[supply-chain-guard] allowlist: running $tool $sub with lifecycle scripts enabled for ${involved[*]}"
  fi

  exec "$real_bin" "$@" "$extra_flag"
}

handle_npx() {
  local real_bin="$1"
  shift
  local args=("$@")
  local target="" extra_pkgs=() skip_next=0 i n a

  # ponytail: covers `npx <pkg>` and `npx -p/--package <pkg> <cmd>` -- the
  # common cases. Doesn't parse the full npx flag grammar (-c, --shell, ...);
  # upgrade if agents start using exotic npx invocations.
  n=${#args[@]}
  for ((i = 0; i < n; i++)); do
    a="${args[$i]}"
    if [ "$skip_next" = "1" ]; then
      skip_next=0
      extra_pkgs+=("$a")
      continue
    fi
    case "$a" in
      -p|--package) skip_next=1 ;;
      --package=*) extra_pkgs+=("${a#--package=}") ;;
      -*) : ;;
      *) [ -z "$target" ] && target="$a" ;;
    esac
  done

  local involved=()
  [ -n "$target" ] && involved+=("$(bare_name "$target")")
  local p
  for p in "${extra_pkgs[@]:-}"; do [ -n "$p" ] && involved+=("$(bare_name "$p")"); done

  local unknown=()
  local name
  for name in "${involved[@]:-}"; do
    [ -n "$name" ] || continue
    is_known_package "$name" || unknown+=("$name")
  done

  if [ "${#unknown[@]}" -gt 0 ]; then
    if ! run_checker "${unknown[@]}"; then
      echo "[supply-chain-guard] BLOCKED: $CHECKER_BIN flagged ${unknown[*]} -- npx aborted, real binary never invoked"
      exit 1
    fi
    echo "[supply-chain-guard] $CHECKER_BIN OK: ${unknown[*]}"
  fi

  local extra_flag="--ignore-scripts"
  if [ "${#involved[@]}" -gt 0 ] && all_allowlisted "${involved[@]}"; then
    extra_flag="--ignore-scripts=false"
    echo "[supply-chain-guard] allowlist: running npx with lifecycle scripts enabled for ${involved[*]}"
  fi

  exec "$real_bin" "$extra_flag" "${args[@]}"
}

run_guarded_shim() {
  local tool="$1"
  shift
  local real_bin
  real_bin="$(find_real_bin "$tool")" || {
    echo "[supply-chain-guard] real '$tool' binary not found on PATH (outside $SHIM_DIR)"
    exit 127
  }

  if [ "$tool" = "npx" ]; then
    handle_npx "$real_bin" "$@"
  else
    handle_npm_like "$tool" "$real_bin" "$@"
  fi
}
