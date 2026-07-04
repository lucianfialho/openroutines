/**
 * SAST (F4 #155): deterministic security scan feeding the verify phase and,
 * downstream, the security lens — cheap CPU signal ahead of any LLM call
 * ("SAST antes dos juízes", 03-PIPELINE-EXECUCAO.md).
 *
 * Three tools, all invoked via execFile/argv (never a shell string, F0):
 *   - semgrep:   p/owasp-top-ten + this repo's own .semgrep/openroutines-rules.yml
 *   - gitleaks:  secret scanning, restricted to the diff's commit range
 *   - npm audit: --omit=dev, prod dependency vulnerabilities
 *
 * Any one of the three may be missing from a dev machine's PATH, or otherwise
 * fail (bad JSON, timeout, non-zero exit for reasons unrelated to findings).
 * That must never crash the verify phase — each tool call is individually
 * caught and degrades to an empty result plus a note (see `notes`).
 *
 * `runSast(worktree, baseSha)` is the diff-scoped call card-to-pr/verify.ts
 * makes for a card. `runSast(worktree)` (baseSha omitted) is a full-repo scan
 * with no "added by a card" concept — used once per night by
 * verify/baseline.ts to snapshot what already exists on the base branch, so
 * that filterSastAgainstBaseline can tell a pre-existing finding from a new
 * one (same "known flaky" principle already applied to build/test).
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 10 * 1024 * 1024; // semgrep/npm audit JSON on a big diff can be large
// A hung security tool must not stall verify forever — same class of cap the
// codebase already applies elsewhere (verify commands: 10min, git ops: 60s).
const TOOL_TIMEOUT_MS = 5 * 60 * 1000;

export interface SemgrepFinding {
  ruleId: string;
  file: string;
  line: number;
  endLine?: number;
  message: string;
  severity: "ERROR" | "WARNING" | "INFO";
}

export interface GitleaksFinding {
  file: string;
  line: number;
  ruleId: string;
  matchRedacted: string;
}

export interface DependencyInfo {
  name: string;
  version: string;
}

export interface VulnerableDependency extends DependencyInfo {
  severity: "high" | "critical";
  advisory: string;
}

export interface SastResult {
  semgrepFindings: SemgrepFinding[];
  secretsFound: GitleaksFinding[];
  dependencyAudit: { new: DependencyInfo[]; vulnerable: VulnerableDependency[] };
  // Tool-unavailable / parse-failure notes — informational only, never gates
  // `passed` (that's card-to-pr/verify.ts's call, and it never reproves on a
  // missing tool, only on an actual finding).
  notes: string[];
}

export const emptySastResult = (): SastResult => ({
  semgrepFindings: [],
  secretsFound: [],
  dependencyAudit: { new: [], vulnerable: [] },
  notes: [],
});

export type ExecRunner = (
  file: string,
  args: string[],
  options?: { cwd?: string }
) => Promise<{ stdout: string; stderr: string }>;

export interface SastOptions {
  /** Injectable seam for tests — same pattern as preparation.ts's runGit/checkProtection. */
  exec?: ExecRunner;
}

export const defaultExec: ExecRunner = (file, args, options) =>
  execFileAsync(file, args, { maxBuffer: MAX_BUFFER, timeout: TOOL_TIMEOUT_MS, ...options }).catch((err) => {
    const e = err as { code?: string; killed?: boolean; signal?: string | null; stdout?: string; stderr?: string };
    // Binary missing from PATH, or execFile's OWN timeout killing the child
    // (killed/signal set — the tool never actually finished) must both reach
    // the caller so it degrades to a note (M7/#155): swallowing a kill as
    // `{stdout: ''}` used to read as "scan ran clean", silently persisting an
    // empty baseline snapshot instead of flagging the tool as unavailable.
    if (e.code === "ENOENT" || e.killed || e.signal) throw e;
    // A non-zero exit (semgrep --error on findings, gitleaks on a leak, npm
    // audit on a vulnerability) still carries the JSON report on stdout.
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  });

const PROJECT_ROOT = process.env.PROJECT_ROOT ? resolve(process.env.PROJECT_ROOT) : resolve(process.cwd());
// Versioned in THIS repo (the orchestrator), never in the target repo being scanned.
const OPENROUTINES_RULES_PATH = join(PROJECT_ROOT, ".semgrep", "openroutines-rules.yml");

// matchRedacted must never carry the secret in clear — not even a prefix (a
// short synthetic secret could be fully reconstructed from a "safe-looking"
// partial reveal). File + line + ruleId already tell the security lens where
// to look; the length is the only thing worth keeping from the match itself.
const redactSecret = (raw: string): string => {
  const len = raw.trim().length;
  return len > 0 ? `[REDACTED:${len}chars]` : "[REDACTED]";
};

const describeUnavailable = (tool: string, err: unknown): string => {
  const e = err as { code?: string; message?: string };
  return e?.code === "ENOENT" ? `${tool} indisponível no PATH — etapa ignorada` : `${tool} falhou: ${e?.message ?? String(err)}`;
};

const parseJson = <T,>(stdout: string, fallback: T): T => {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === "null") return fallback;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return fallback;
  }
};

const getChangedFiles = async (exec: ExecRunner, worktree: string, baseSha: string): Promise<string[]> => {
  const { stdout } = await exec("git", ["diff", "--name-only", baseSha, "HEAD"], { cwd: worktree });
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
};

// --- semgrep -----------------------------------------------------------------

interface RawSemgrepResult {
  check_id?: string;
  path?: string;
  start?: { line?: number };
  end?: { line?: number };
  extra?: { message?: string; severity?: string };
}

const normalizeSeverity = (s: unknown): SemgrepFinding["severity"] =>
  s === "ERROR" || s === "WARNING" || s === "INFO" ? s : "INFO";

const runSemgrep = async (
  exec: ExecRunner,
  worktree: string,
  scopeFiles: string[] | undefined // undefined = full scan (baseline capture), keep every finding
): Promise<{ findings: SemgrepFinding[]; note?: string }> => {
  try {
    const { stdout } = await exec(
      "semgrep",
      ["--config", "p/owasp-top-ten", "--config", OPENROUTINES_RULES_PATH, "--json", "--error"],
      { cwd: worktree }
    );
    const parsed = parseJson<{ results?: RawSemgrepResult[] }>(stdout, {});
    const scope = scopeFiles ? new Set(scopeFiles) : undefined;
    const findings = (parsed.results ?? [])
      .filter((r) => !scope || (r.path !== undefined && scope.has(r.path)))
      .map((r) => ({
        ruleId: r.check_id ?? "unknown",
        file: r.path ?? "",
        line: r.start?.line ?? 0,
        endLine: r.end?.line,
        message: r.extra?.message ?? "",
        severity: normalizeSeverity(r.extra?.severity),
      }));
    return { findings };
  } catch (err) {
    return { findings: [], note: describeUnavailable("semgrep", err) };
  }
};

// --- gitleaks ------------------------------------------------------------------

interface RawGitleaksFinding {
  File?: string;
  StartLine?: number;
  RuleID?: string;
  Match?: string;
  Secret?: string;
}

const runGitleaks = async (
  exec: ExecRunner,
  worktree: string,
  logOpts: string | undefined // undefined = full scan (baseline capture), no --log-opts range restriction
): Promise<{ findings: GitleaksFinding[]; note?: string }> => {
  try {
    const args = ["detect", "--source", worktree, "--report-format", "json", "--report-path", "-"];
    if (logOpts) args.push("--log-opts", logOpts);
    const { stdout } = await exec("gitleaks", args, { cwd: worktree });
    const parsed = parseJson<RawGitleaksFinding[]>(stdout, []);
    const findings = parsed.map((g) => ({
      file: g.File ?? "",
      line: g.StartLine ?? 0,
      ruleId: g.RuleID ?? "unknown",
      // Secret (the raw value) over Match (value + surrounding line context) —
      // whichever is present, it is redacted, never returned in clear.
      matchRedacted: redactSecret(g.Secret ?? g.Match ?? ""),
    }));
    return { findings };
  } catch (err) {
    return { findings: [], note: describeUnavailable("gitleaks", err) };
  }
};

// --- npm audit -------------------------------------------------------------------

interface RawNpmAuditVia {
  url?: string;
  title?: string;
}
interface RawNpmAuditEntry {
  name?: string;
  severity?: string;
  range?: string;
  via?: (string | RawNpmAuditVia)[];
}
interface RawNpmAudit {
  vulnerabilities?: Record<string, RawNpmAuditEntry>;
}

const isViaObject = (v: string | RawNpmAuditVia): v is RawNpmAuditVia => typeof v === "object" && v !== null;

const runNpmAudit = async (
  exec: ExecRunner,
  worktree: string
): Promise<{ vulnerable: VulnerableDependency[]; note?: string }> => {
  try {
    // --audit-level only affects npm's own exit code / non-JSON summary, never
    // the JSON report's contents — this module does its OWN high/critical
    // filtering below. --omit=dev is what actually excludes devDependencies.
    const { stdout } = await exec("npm", ["audit", "--omit=dev", "--audit-level=high", "--json"], { cwd: worktree });
    const parsed = parseJson<RawNpmAudit>(stdout, {});
    const vulnerable: VulnerableDependency[] = [];
    for (const [key, entry] of Object.entries(parsed.vulnerabilities ?? {})) {
      if (entry.severity !== "high" && entry.severity !== "critical") continue;
      const advisory = (entry.via ?? []).find(isViaObject);
      vulnerable.push({
        name: entry.name ?? key,
        // ponytail: the vulnerable version RANGE npm audit itself reports
        // stands in for the exact installed version — getting that needs a
        // 2nd read (package-lock.json/node_modules), not worth it for what's
        // a pre-triage signal for the security lens, not an exact pin.
        version: entry.range ?? "unknown",
        severity: entry.severity,
        advisory: advisory?.url ?? advisory?.title ?? key,
      });
    }
    return { vulnerable };
  } catch (err) {
    return { vulnerable: [], note: describeUnavailable("npm audit", err) };
  }
};

// --- dependencyAudit.new[] (package.json diff vs baseSha) -----------------------

type DepMap = Record<string, string>;

const readPackageDeps = (raw: string): DepMap => {
  try {
    const pkg = JSON.parse(raw) as { dependencies?: DepMap; devDependencies?: DepMap };
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return {};
  }
};

const getNewDependencies = async (
  exec: ExecRunner,
  worktree: string,
  baseSha: string | undefined
): Promise<DependencyInfo[]> => {
  if (!baseSha) return []; // full scan (baseline capture): no "added by a card" to diff against.

  let current: DepMap;
  try {
    current = readPackageDeps(readFileSync(join(worktree, "package.json"), "utf-8"));
  } catch {
    return []; // no package.json in the worktree — nothing to report as a new dependency.
  }

  let base: DepMap = {};
  try {
    const { stdout } = await exec("git", ["show", `${baseSha}:package.json`], { cwd: worktree });
    base = readPackageDeps(stdout);
  } catch {
    base = {}; // no package.json at baseSha (new file/repo) — every current dep reads as new.
  }

  return Object.entries(current)
    .filter(([name]) => !(name in base))
    .map(([name, version]) => ({ name, version }));
};

// --- entry point -------------------------------------------------------------------

export const runSast = async (worktree: string, baseSha?: string, opts: SastOptions = {}): Promise<SastResult> => {
  const exec = opts.exec ?? defaultExec;

  let scopeFiles: string[] | undefined;
  let scopeNote: string | undefined;
  if (baseSha) {
    try {
      scopeFiles = await getChangedFiles(exec, worktree, baseSha);
    } catch (err) {
      // Can't determine the diff scope — fail closed (report nothing "in
      // scope" this run) rather than crash the whole verify phase over it.
      scopeFiles = [];
      scopeNote = describeUnavailable("git diff", err);
    }
  }

  const [semgrep, gitleaks, audit, newDeps] = await Promise.all([
    runSemgrep(exec, worktree, scopeFiles),
    runGitleaks(exec, worktree, baseSha ? `${baseSha}..HEAD` : undefined),
    runNpmAudit(exec, worktree),
    getNewDependencies(exec, worktree, baseSha),
  ]);

  const notes = [scopeNote, semgrep.note, gitleaks.note, audit.note].filter((n): n is string => Boolean(n));

  return {
    semgrepFindings: semgrep.findings,
    secretsFound: gitleaks.findings,
    dependencyAudit: { new: newDeps, vulnerable: audit.vulnerable },
    notes,
  };
};

// --- baseline filtering (pure — no process spawning, needs no mocking to test) ----

const onlyNew = <T,>(current: T[], baseline: T[], key: (t: T) => string): T[] => {
  const known = new Set(baseline.map(key));
  return current.filter((item) => !known.has(key(item)));
};

/**
 * Same "known flaky" principle already applied to build/test (compare.ts):
 * a finding already present in the night's baseline snapshot is pre-existing,
 * not something this card introduced — never a reason to reprove it.
 * `dependencyAudit.new[]` is untouched: it's "added by this card" by
 * definition, a different sense of "new" than "new vs. baseline".
 *
 * ponytail: identity is ruleId+file+line, so an unrelated edit earlier in the
 * same file that shifts line numbers can make a pre-existing finding look
 * "new". Semgrep's own `extra.fingerprint` (content-based, shift-resistant)
 * would fix this; skipped because it's not confirmed present on every OSS CLI
 * run (unauthenticated vs. logged-in output can differ) — upgrade to it if
 * line-shift false positives show up in practice.
 */
export const filterSastAgainstBaseline = (current: SastResult, baseline?: SastResult | null): SastResult => {
  const base = baseline ?? emptySastResult();
  return {
    semgrepFindings: onlyNew(current.semgrepFindings, base.semgrepFindings, (f) => `${f.ruleId}:${f.file}:${f.line}`),
    secretsFound: onlyNew(current.secretsFound, base.secretsFound, (f) => `${f.ruleId}:${f.file}:${f.line}`),
    dependencyAudit: {
      new: current.dependencyAudit.new,
      vulnerable: onlyNew(
        current.dependencyAudit.vulnerable,
        base.dependencyAudit.vulnerable,
        (v) => `${v.name}:${v.advisory}`
      ),
    },
    notes: current.notes,
  };
};
