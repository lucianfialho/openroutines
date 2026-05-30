/**
 * Filesystem Tools
 *
 * Allows the agent to read, write, and execute commands on the local filesystem.
 * Supports optional cwd for git worktree isolation.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, relative, dirname } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import type { Tool } from "./types.js";

const execAsync = promisify(exec);

const PROJECT_ROOT = process.env.PROJECT_ROOT
  ? resolve(process.env.PROJECT_ROOT)
  : resolve(process.cwd());

const sanitizePath = (inputPath: string, cwd?: string): string => {
  const base = cwd ? resolve(cwd) : PROJECT_ROOT;
  const resolved = resolve(base, inputPath);
  // When cwd is provided, allow paths within cwd even if outside PROJECT_ROOT
  const rel = cwd ? relative(base, resolved) : relative(PROJECT_ROOT, resolved);
  if (rel.startsWith("..") || rel === "") {
    // Allow absolute paths that are within cwd
    if (cwd && inputPath.startsWith("/")) {
      const cwdRel = relative(cwd, inputPath);
      if (!cwdRel.startsWith("..") && cwdRel !== "") {
        return inputPath;
      }
    }
    throw new Error(`Path traversal blocked: ${inputPath}`);
  }
  return resolved;
};

export const makeFilesystemTools = (): Tool[] => [
  {
    definition: {
      name: "emit_output",
      description:
        "Emit the structured YAML output for the current state. Call this when you are done with all other work. The content must be valid YAML matching the expected output schema.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The YAML output content. Must be valid YAML.",
          },
        },
        required: ["content"],
      },
    },
    handler: async (args) => {
      return JSON.stringify({ emitted: true, content: String(args.content) });
    },
  },
  {
    definition: {
      name: "read_file",
      description:
        "Read the contents of a file. If cwd is provided, path is relative to cwd. Otherwise relative to project root.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file (e.g. 'src/app.ts')",
          },
          cwd: {
            type: "string",
            description: "Optional working directory (for git worktree)",
          },
        },
        required: ["path"],
      },
    },
    handler: async (args) => {
      const cwd = args.cwd ? String(args.cwd) : undefined;
      const filePath = sanitizePath(String(args.path), cwd);
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
        "Write content to a file. Creates the file if it doesn't exist. If cwd is provided, path is relative to cwd.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file",
          },
          content: {
            type: "string",
            description: "The full content to write to the file",
          },
          cwd: {
            type: "string",
            description: "Optional working directory (for git worktree)",
          },
        },
        required: ["path", "content"],
      },
    },
    handler: async (args) => {
      const cwd = args.cwd ? String(args.cwd) : undefined;
      const filePath = sanitizePath(String(args.path), cwd);
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
      name: "edit_file",
      description:
        "Edit a file by inserting or replacing specific content. Use this instead of write_file when you only need to change part of a file. Operations are applied in order.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file",
          },
          operations: {
            type: "array",
            description: "List of edit operations to apply",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["insert_after", "replace"],
                  description: "insert_after: insert content after the search string. replace: replace the search string with content.",
                },
                search: {
                  type: "string",
                  description: "String to search for in the file. Must match exactly.",
                },
                content: {
                  type: "string",
                  description: "Content to insert or replace with",
                },
              },
              required: ["type", "search", "content"],
            },
          },
          cwd: {
            type: "string",
            description: "Optional working directory (for git worktree)",
          },
        },
        required: ["path", "operations"],
      },
    },
    handler: async (args) => {
      const cwd = args.cwd ? String(args.cwd) : undefined;
      const filePath = sanitizePath(String(args.path), cwd);
      if (!existsSync(filePath)) {
        return JSON.stringify({ error: `File not found: ${args.path}` });
      }

      let content = readFileSync(filePath, "utf-8");
      const operations = args.operations as Array<{ type: string; search: string; content: string }>;
      const applied: Array<{ type: string; search: string; applied: boolean; reason?: string }> = [];

      for (const op of operations) {
        const search = String(op.search);
        const replacement = String(op.content);
        const index = content.indexOf(search);

        if (index === -1) {
          applied.push({ type: op.type, search, applied: false, reason: "search not found" });
          continue;
        }

        // Prevent duplicate insertions
        if (op.type === "insert_after" && content.includes(replacement)) {
          applied.push({ type: op.type, search, applied: false, reason: "content already exists" });
          continue;
        }

        if (op.type === "insert_after") {
          content = content.slice(0, index + search.length) + replacement + content.slice(index + search.length);
        } else if (op.type === "replace") {
          content = content.slice(0, index) + replacement + content.slice(index + search.length);
        }

        applied.push({ type: op.type, search, applied: true });
      }

      writeFileSync(filePath, content, "utf-8");
      return JSON.stringify({ path: args.path, edited: true, operations: applied, bytes: content.length });
    },
  },
  {
    definition: {
      name: "run_shell",
      description:
        "Run a shell command. If cwd is provided, runs in that directory. Otherwise runs in project root.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to run",
          },
          timeout: {
            type: "integer",
            description: "Timeout in milliseconds (default 60000)",
          },
          cwd: {
            type: "string",
            description: "Optional working directory (for git worktree)",
          },
        },
        required: ["command"],
      },
    },
    handler: async (args) => {
      const command = String(args.command);
      const timeout = Number(args.timeout) || 60_000;
      const cwd = args.cwd ? String(args.cwd) : PROJECT_ROOT;
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
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
