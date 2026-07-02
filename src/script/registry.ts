/**
 * Script Registry
 *
 * Registry of deterministic (non-LLM) handlers for `type: script` states.
 * Mirrors the tool registry shape (register/get). A handler returns a result
 * object on success, or a string interpreted as an error message by the runner.
 */

import { execFile } from "child_process";

export interface ScriptContext {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  executionId: string;
  stateId: string;
}

export type ScriptHandler = (
  ctx: ScriptContext
) => Promise<Record<string, unknown> | string>;

export interface ScriptRegistry {
  register: (name: string, handler: ScriptHandler) => void;
  get: (name: string) => ScriptHandler | undefined;
}

export const makeScriptRegistry = (): ScriptRegistry => {
  const handlers = new Map<string, ScriptHandler>();
  return {
    register: (name, handler) => {
      handlers.set(name, handler);
    },
    get: (name) => handlers.get(name),
  };
};

export interface ShellSequenceResult {
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  commands: string[];
}

/**
 * Run each command via execFile (argv, no `/bin/sh -c`, no shell interpolation),
 * stopping at the first non-zero exit. `cmd.split(" ")` separates program/args —
 * this handler is for skill-authored verify commands, not untrusted input.
 */
export const runShellSequence = (
  commands: string[],
  cwd?: string
): Promise<ShellSequenceResult> =>
  new Promise((resolve) => {
    let idx = 0;
    let aggStdout = "";
    let aggStderr = "";
    const runNext = (): void => {
      if (idx >= commands.length) {
        resolve({ passed: true, exitCode: 0, stdout: aggStdout, stderr: aggStderr, commands });
        return;
      }
      const parts = commands[idx].split(" ").filter((p) => p.length > 0);
      const [program, ...args] = parts;
      execFile(program, args, { cwd }, (err, stdout, stderr) => {
        aggStdout += stdout ?? "";
        aggStderr += stderr ?? "";
        const code = (err as { code?: unknown } | null)?.code;
        const exitCode = typeof code === "number" ? code : err ? 1 : 0;
        if (exitCode !== 0) {
          resolve({ passed: false, exitCode, stdout: aggStdout, stderr: aggStderr, commands });
          return;
        }
        idx++;
        runNext();
      });
    };
    runNext();
  });
