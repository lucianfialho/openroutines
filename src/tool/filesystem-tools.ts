/**
 * Filesystem Tools
 *
 * Allows the agent to read, write, and execute commands on the local filesystem.
 * Used for self-improvement — the agent modifies its own codebase.
 *
 * SECURITY: All paths are restricted to the project root.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, relative, dirname } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import type { Tool } from "./types.js";

const execAsync = promisify(exec);

const PROJECT_ROOT = resolve(process.cwd());

const sanitizePath = (inputPath: string): string => {
  const resolved = resolve(PROJECT_ROOT, inputPath);
  const rel = relative(PROJECT_ROOT, resolved);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`Path traversal blocked: ${inputPath}`);
  }
  return resolved;
};

export const makeFilesystemTools = (): Tool[] => [
  {
    definition: {
      name: "read_file",
      description:
        "Read the contents of a file in the project. Returns the file content as a string. Use for reading source code, configs, docs, etc.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file (e.g. 'src/app.ts', '.gates/skills/solve-issue.md')",
          },
        },
        required: ["path"],
      },
    },
    handler: async (args) => {
      const filePath = sanitizePath(String(args.path));
      if (!existsSync(filePath)) {
        return JSON.stringify({ error: `File not found: ${args.path}` });
      }
      const content = readFileSync(filePath, "utf-8");
      return JSON.stringify({ path: args.path, content });
    },
  },
  {
    definition: {
      name: "write_file",
      description:
        "Write content to a file in the project. Creates the file if it doesn't exist. Overwrites existing content. Use for implementing fixes, creating new files, updating configs.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file (e.g. 'src/new-feature.ts')",
          },
          content: {
            type: "string",
            description: "The full content to write to the file",
          },
        },
        required: ["path", "content"],
      },
    },
    handler: async (args) => {
      const filePath = sanitizePath(String(args.path));
      const dir = dirname(filePath);
      if (dir && dir !== "." && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(filePath, String(args.content), "utf-8");
      return JSON.stringify({ path: args.path, written: true, bytes: String(args.content).length });
    },
  },
  {
    definition: {
      name: "run_shell",
      description:
        "Run a shell command in the project root. Use for running tests, linting, building, installing dependencies, or git commands. Returns stdout and stderr.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to run (e.g. 'npm test', 'git status', 'npx tsc --noEmit')",
          },
          timeout: {
            type: "integer",
            description: "Timeout in milliseconds (default 60000)",
          },
        },
        required: ["command"],
      },
    },
    handler: async (args) => {
      const command = String(args.command);
      const timeout = Number(args.timeout) || 60_000;
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: PROJECT_ROOT,
          timeout,
          env: process.env,
        });
        return JSON.stringify({
          command,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: 0,
        });
      } catch (err: any) {
        return JSON.stringify({
          command,
          stdout: err.stdout?.trim?.() || "",
          stderr: err.stderr?.trim?.() || "",
          exitCode: err.code || 1,
          error: err.message,
        });
      }
    },
  },
];
