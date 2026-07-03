/**
 * Verify command runner (F3 #150).
 *
 * Runs each configured verify command via execFile with a separate argv —
 * never a shell string (F0: no exec of shell-interpolated input). Commands
 * come from repos.yaml (trusted config, see repo-registry), so a whitespace
 * split that also respects "double-quoted" tokens is enough — no need for a
 * real shell-parsing library.
 */
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const NOTES_TAIL_CHARS = 2000;
const MAX_BUFFER = 10 * 1024 * 1024; // build/test logs can exceed Node's 1MB execFile default
// A single hung verify command must not stall the unattended overnight baseline
// forever (same class the codebase caps elsewhere: kimi-cli 300s, filesystem 60s).
// A killed process rejects → runOne reports passed:false, which is the safe direction.
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

export interface VerifyCommands {
  install?: string;
  build: string;
  typecheck?: string;
  lint?: string;
  test: string;
}

export type VerifyStepResult = { passed: boolean; notes?: string };

export type VerifyResults = Record<"build" | "typecheck" | "lint" | "test", VerifyStepResult | undefined>;

/** The 4 tracked verify categories, in run order — shared with compare.ts. */
export const VERIFY_STEP_KEYS = ["build", "typecheck", "lint", "test"] as const;

/**
 * Split a command string into argv, treating a "double-quoted" span as one
 * token (e.g. `echo "sem testes"` -> ["echo", "sem testes"]). No escaping, no
 * single quotes — a minimal shell-like split, not a real shell parser; safe
 * only because these strings are trusted repos.yaml config, never card/issue
 * text.
 */
export const splitCommand = (command: string): string[] => {
  const tokens = command.match(/"[^"]*"|\S+/g) ?? [];
  return tokens.map((t) => (t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t));
};

const tail = (s: string): string | undefined => (s ? s.slice(-NOTES_TAIL_CHARS) : undefined);

const runOne = async (cwd: string, command: string): Promise<VerifyStepResult> => {
  const [program, ...args] = splitCommand(command);
  if (!program) return { passed: false, notes: "empty verify command" };
  try {
    const { stdout, stderr } = await execFileAsync(program, args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      timeout: COMMAND_TIMEOUT_MS,
    });
    return { passed: true, notes: tail(stdout + stderr) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message || String(err);
    return { passed: false, notes: tail(output) };
  }
};

export const runVerifyCommands = async (cwd: string, commands: VerifyCommands): Promise<VerifyResults> => {
  if (commands.install) await runOne(cwd, commands.install); // setup step only, not tracked in VerifyResults

  const results = {} as VerifyResults;
  for (const key of VERIFY_STEP_KEYS) {
    const command = commands[key];
    results[key] = command ? await runOne(cwd, command) : undefined;
  }
  return results;
};
