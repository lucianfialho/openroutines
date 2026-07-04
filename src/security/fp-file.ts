/**
 * Per-repo security false-positive file (F4 #154)
 *
 * `docs/openroutines/security-fp.md` is a living doc in the REVIEWED repo
 * (same pattern as REPO-PROFILE.md, D6/D18): a markdown table of finding
 * patterns the repo owner has already adjudicated as false positives. The
 * security judge (a) feeds the raw file to the LLM as delimited low-confidence
 * data and (b) deterministically demotes findings matching an entry to
 * blocking:false without spending a verification call.
 *
 * Format (fixed, one row per pattern):
 *   | `src/webhooks/*.ts` — "missing rate limit" | Rate limit no proxy | 2026-03-10 |
 */

import { readFileSync } from "fs";

export interface FalsePositiveEntry {
  /** Glob over the finding's file path (`*` = within a segment, `**` = any depth). */
  filePattern: string;
  /** Optional rule/description fragment (the quoted part of the pattern cell). */
  rule?: string;
  justification: string;
  addedOn: string;
}

/** Relative path of the FP file inside a reviewed repo/worktree. */
export const SECURITY_FP_FILE_PATH = "docs/openroutines/security-fp.md";

const SEPARATOR_CELL_RE = /^:?-{3,}:?$/;
const BACKTICK_RE = /`([^`]+)`/;
const QUOTED_RULE_RE = /["“]([^"”]+)["”]/;

/**
 * Parse the FP table from `path`. A missing/unreadable file is NOT an error —
 * it just means the repo has no adjudicated false positives yet (empty list).
 */
export const parseFalsePositives = (path: string): FalsePositiveEntry[] => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const entries: FalsePositiveEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    // ponytail: split on "|" — escaped pipes inside cells are not supported.
    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 3) continue;
    if (cells.every((c) => SEPARATOR_CELL_RE.test(c))) continue; // |---|---|---|
    if (/padr[aã]o/i.test(cells[0])) continue; // header row
    const patternCell = cells[0];
    const filePattern = BACKTICK_RE.exec(patternCell)?.[1]?.trim() ?? patternCell;
    if (!filePattern) continue;
    const rule = QUOTED_RULE_RE.exec(patternCell)?.[1]?.trim();
    entries.push({
      filePattern,
      ...(rule ? { rule } : {}),
      justification: cells[1],
      addedOn: cells[2],
    });
  }
  return entries;
};

/** Minimal glob → RegExp: `**` any depth, `*` within a segment, `?` one char. */
const globToRegExp = (glob: string): RegExp => {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
};

/**
 * First entry matching a finding, or undefined. The file must match the glob;
 * when the entry carries a rule fragment, it must also appear (case-insensitive)
 * in the finding's text (id + description + category).
 */
export const matchFalsePositive = (
  entries: FalsePositiveEntry[],
  file: string,
  findingText: string
): FalsePositiveEntry | undefined => {
  const haystack = findingText.toLowerCase();
  return entries.find((e) => {
    try {
      if (!globToRegExp(e.filePattern).test(file)) return false;
    } catch {
      return false; // malformed pattern never matches — fail closed
    }
    return !e.rule || haystack.includes(e.rule.toLowerCase());
  });
};
