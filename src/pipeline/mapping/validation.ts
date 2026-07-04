/**
 * card-mapping / validation (F5 #162)
 *
 * DETERMINISTIC audit of the 8-section auditable core (06-KNOWLEDGE-BASE
 * "Núcleo mantido vs. apêndice"): the two checks that are mechanically
 * verifiable —
 *   1. every arquivo-chave path listed in the profile exists in the worktree;
 *   2. every canonical command that names an npm/pnpm/yarn script or a Makefile
 *      target actually exists in package.json / Makefile.
 * A reprovado (issues.length > 0) loops ONE bounded round back to scan
 * with the gap list.
 *
 * ponytail: the mechanical core needs no LLM — "does package.json have this
 * script" and "does this file exist" are exact checks an LLM would only make
 * flakier. The issue lists validation as "(Kimi)" and adds a third check ("cada
 * rota dourada responde no sandbox"); that route-probe is assigned to the
 * SUNDAY maintenance routine in 06-KNOWLEDGE-BASE (F6, out of scope here), and
 * visual_capture already renders every golden route, so re-booting compose in
 * validation would duplicate that boot for zero added coverage. Add a Kimi seam
 * / route-probe here if the auditable core ever needs semantic judgment.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { ScriptHandler } from "../../script/registry.js";
import type { MappingDeps } from "./index.js";
import type { MappingPreparationOutput } from "./preparation.js";
import type { ScanOutput } from "./scan.js";

export interface ValidationOutput {
  passed: boolean;
  issues: string[];
}

/** Injectable worktree probes (default: real fs) so tests need no temp repo. */
export interface ValidationProbes {
  fileExists: (worktree: string, relPath: string) => boolean;
  readScripts: (worktree: string) => Record<string, string>;
  readMakeTargets: (worktree: string) => Set<string>;
}

const readJsonFile = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
};

export const defaultProbes: ValidationProbes = {
  fileExists: (worktree, relPath) => existsSync(join(worktree, relPath)),
  readScripts: (worktree) => {
    const pkg = readJsonFile(join(worktree, "package.json")) as { scripts?: Record<string, string> } | undefined;
    return pkg?.scripts ?? {};
  },
  readMakeTargets: (worktree) => {
    try {
      const mk = readFileSync(join(worktree, "Makefile"), "utf-8");
      const targets = new Set<string>();
      for (const m of mk.matchAll(/^([\w.-]+):/gm)) targets.add(m[1]);
      return targets;
    } catch {
      return new Set();
    }
  },
};

/**
 * Extract file paths from the "Arquivos-chave" section. Only backtick-wrapped
 * tokens that look like a path (contain `/` or a file extension) are taken —
 * markdown's path convention — so a prose word with a slash ("e/ou") is never
 * mistaken for a missing file (that would cause a false reprovado).
 */
export const extractKeyFiles = (section: string | undefined): string[] => {
  if (!section) return [];
  const files = new Set<string>();
  for (const m of section.matchAll(/`([^`]+)`/g)) {
    const t = m[1].trim();
    if (/\//.test(t) || /\.\w{1,5}$/.test(t)) {
      if (/^[\w.@/-]+$/.test(t)) files.add(t.replace(/^\.\//, ""));
    }
  }
  return [...files];
};

/** package-manager subcommands that are NOT scripts (so they are never audited). */
const NON_SCRIPT = new Set([
  "install", "ci", "i", "add", "remove", "rm", "exec", "dlx", "create", "init",
  "publish", "link", "unlink", "audit", "update", "upgrade", "outdated", "why",
  "info", "list", "ls", "cache", "config", "prune",
]);

export interface CommandRef {
  raw: string;
  kind: "npm-script" | "make-target";
  name: string;
}

/**
 * Extract auditable command references from the "Comandos canônicos" section:
 * npm/pnpm/yarn script invocations (resolving the script name) and `make`
 * targets. Infra commands (docker compose, prisma, ...) are not mechanically
 * auditable and are ignored.
 */
export const extractCommands = (section: string | undefined): CommandRef[] => {
  if (!section) return [];
  const refs: CommandRef[] = [];
  const seen = new Set<string>();
  const add = (kind: CommandRef["kind"], name: string, raw: string): void => {
    const key = `${kind}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ kind, name, raw });
  };
  for (const m of section.matchAll(/\b(npm|pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)/g)) {
    const name = m[2];
    if (!NON_SCRIPT.has(name)) add("npm-script", name, m[0]);
  }
  for (const m of section.matchAll(/\bmake\s+([\w:.-]+)/g)) {
    add("make-target", m[1], m[0]);
  }
  return refs;
};

export const makeValidation = (deps: MappingDeps): ScriptHandler => async (ctx) => {
  const prep = ctx.outputs.preparation as MappingPreparationOutput;
  const scan = ctx.outputs.scan as ScanOutput;
  const worktree = prep.worktree.path;
  const profile = scan.profile ?? {};
  const probes = deps.validation ?? defaultProbes;

  const issues: string[] = [];

  if (scan.coreSectionsComplete === false) {
    issues.push("núcleo auditável incompleto: scan marcou coreSectionsComplete=false");
  }

  // 1. Arquivos-chave existem?
  for (const file of extractKeyFiles(profile["Arquivos-chave"])) {
    if (!probes.fileExists(worktree, file)) {
      issues.push(`arquivo-chave listado não existe no repo: ${file}`);
    }
  }

  // 2. Comandos canônicos existem (npm scripts / Makefile targets)?
  const commands = extractCommands(profile["Comandos canônicos"]);
  if (commands.length > 0) {
    const scripts = probes.readScripts(worktree);
    const makeTargets = probes.readMakeTargets(worktree);
    for (const cmd of commands) {
      if (cmd.kind === "npm-script" && !(cmd.name in scripts)) {
        issues.push(`comando canônico ausente: script "${cmd.name}" não existe em package.json (${cmd.raw})`);
      }
      if (cmd.kind === "make-target" && !makeTargets.has(cmd.name)) {
        issues.push(`comando canônico ausente: target "${cmd.name}" não existe no Makefile (${cmd.raw})`);
      }
    }
  }

  return { passed: issues.length === 0, issues } satisfies ValidationOutput as unknown as Record<string, unknown>;
};
