/**
 * First-run onboarding (Bloco 3)
 *
 * Called at boot: if config is incomplete AND a terminal is attached, an
 * interactive wizard collects Trello creds, the board, the column->state map,
 * and REPOS_BASE_DIR, writes task-sources.yaml / connector.yaml / .env, and the
 * boot continues wired.
 *
 * When the base config is already present, the boot still validates the Trello
 * board columns: dedicated columns (queued/working) are created idempotently,
 * and reused columns (backlog/blocked/review/done) whose mapped name does not
 * exist on the board trigger a remap wizard (TTY) or a clear error (no TTY).
 *
 * No terminal (systemd/cron) -> a clear error, never a hang.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline/promises";
import { parse } from "yaml";
import { parseTaskSourcesFile, parseConnectorManifest } from "../task-source/parser.js";
import type { ConnectorManifest } from "../task-source/schema.js";
import {
  DEFAULT_LABEL_NAME,
  type SharedColumnMismatch,
  type TrelloCreds,
  type TrelloList,
  validateAndEnsureBoardColumns,
} from "./trello-board.js";

export const CANONICAL_STATES = ["backlog", "queued", "working", "blocked", "review", "done"] as const;
export type CanonicalState = (typeof CANONICAL_STATES)[number];

export const DEFAULT_COLUMNS: Record<CanonicalState, string> = {
  backlog: "Backlog",
  queued: "OpenRoutines — Fila",
  working: "OpenRoutines — Working",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
};

export interface OnboardingPaths {
  taskSources: string;
  connector: string;
  env: string;
}

export const defaultPaths = (): OnboardingPaths => ({
  taskSources: process.env.TASK_SOURCES_FILE ?? "./task-sources.yaml",
  connector: "./.gates/connectors/trello/connector.yaml",
  env: "./.env",
});

// --- completeness check (pure) ----------------------------------------------

export interface NeedsOnboardingDeps {
  fileExists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  env?: NodeJS.ProcessEnv;
}

interface TaskSourcesShape {
  sources?: Array<{ type?: string; containers?: { board?: string }; auth?: { key?: string; token?: string } }>;
}

/** A missing file, no trello source, or unresolved key/token env vars all need onboarding. */
export const needsOnboarding = (
  paths: OnboardingPaths,
  deps: NeedsOnboardingDeps = {}
): { needed: boolean; reasons: string[] } => {
  const fileExists = deps.fileExists ?? existsSync;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const env = deps.env ?? process.env;

  if (!fileExists(paths.taskSources)) return { needed: true, reasons: ["task-sources.yaml ausente"] };

  let sources: TaskSourcesShape;
  try {
    sources = (parse(readFile(paths.taskSources)) ?? {}) as TaskSourcesShape;
  } catch {
    return { needed: true, reasons: ["task-sources.yaml inválido"] };
  }
  const trello = (sources.sources ?? []).find((s) => s?.type === "trello");
  if (!trello) return { needed: true, reasons: ["nenhuma fonte trello em task-sources.yaml"] };

  const reasons: string[] = [];
  if (!trello.containers?.board) reasons.push("board do Trello não configurado");
  if (!trello.auth?.key || !env[trello.auth.key]) reasons.push("TRELLO_API_KEY ausente no ambiente");
  if (!trello.auth?.token || !env[trello.auth.token]) reasons.push("TRELLO_API_TOKEN ausente no ambiente");
  return { needed: reasons.length > 0, reasons };
};

// --- board column validation --------------------------------------------------

export interface ValidateBoardColumnsDeps {
  readFile?: (p: string) => string;
  env?: NodeJS.ProcessEnv;
  validate?: (
    boardId: string,
    stateMap: Record<CanonicalState, string>,
    labelName: string,
    creds: TrelloCreds
  ) => Promise<{
    ok: boolean;
    createdLists: string[];
    createdLabel?: string;
    missingShared: SharedColumnMismatch[];
    existingLists: TrelloList[];
  }>;
}

export interface BoardValidation {
  ok: boolean;
  createdLists: string[];
  createdLabel?: string;
  missingShared: SharedColumnMismatch[];
  existingLists: TrelloList[];
}

interface ParsedConfig {
  boardId: string;
  creds: TrelloCreds;
  manifestPath: string;
  manifest: ConnectorManifest;
  manifestRaw: string;
}

const parseOnboardingConfig = (
  paths: OnboardingPaths,
  readFile: (p: string) => string,
  env: NodeJS.ProcessEnv
): ParsedConfig => {
  const sources = parseTaskSourcesFile(readFile(paths.taskSources));
  const entry = sources.sources.find((s) => s.type === "trello");
  if (!entry) throw new Error("nenhuma fonte trello em task-sources.yaml");

  const boardId = entry.containers.board;
  if (!boardId) throw new Error("board do Trello não configurado");

  const keyName = entry.auth.key;
  const tokenName = entry.auth.token;
  const key = keyName ? env[keyName] : undefined;
  const token = tokenName ? env[tokenName] : undefined;
  if (!key || !token) throw new Error("TRELLO_API_KEY/TRELLO_API_TOKEN ausente no ambiente");

  const manifestPath = entry.manifest ?? paths.connector;
  const manifestRaw = readFile(manifestPath);
  const manifest = parseConnectorManifest(manifestRaw);

  return { boardId, creds: { key, token }, manifestPath, manifest, manifestRaw };
};

export const validateBoardColumns = async (
  paths: OnboardingPaths = defaultPaths(),
  deps: ValidateBoardColumnsDeps = {}
): Promise<BoardValidation> => {
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const env = deps.env ?? process.env;
  const cfg = parseOnboardingConfig(paths, readFile, env);

  const stateMap = cfg.manifest.state as Record<CanonicalState, string>;
  const labelName = cfg.manifest.container?.flag?.kind === "label" ? cfg.manifest.container.flag.name : DEFAULT_LABEL_NAME;

  const validate =
    deps.validate ??
    (async (boardId, map, lbl, creds) =>
      validateAndEnsureBoardColumns(boardId, map, lbl, {
        fetchLists: (id) =>
          fetch(`https://api.trello.com/1/boards/${encodeURIComponent(id)}/lists?filter=open&fields=id,name&key=${encodeURIComponent(creds.key)}&token=${encodeURIComponent(creds.token)}`).then(
            async (res) => {
              if (!res.ok) throw new Error(`Trello API ${res.status} on GET /boards/${id}/lists`);
              return res.json() as Promise<TrelloList[]>;
            }
          ),
        createList: (id, name) =>
          fetch(`https://api.trello.com/1/lists?key=${encodeURIComponent(creds.key)}&token=${encodeURIComponent(creds.token)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, idBoard: id, pos: "bottom" }),
          }).then(async (res) => {
            if (!res.ok) throw new Error(`Trello API ${res.status} on POST /lists`);
            return res.json() as Promise<TrelloList>;
          }),
        fetchLabels: (id) =>
          fetch(
            `https://api.trello.com/1/boards/${encodeURIComponent(id)}/labels?filter=open&fields=id,name&key=${encodeURIComponent(creds.key)}&token=${encodeURIComponent(creds.token)}`
          ).then(async (res) => {
            if (!res.ok) throw new Error(`Trello API ${res.status} on GET /boards/${id}/labels`);
            return res.json() as Promise<Array<{ id: string; name: string }>>;
          }),
        createLabel: (id, name, color) =>
          fetch(
            `https://api.trello.com/1/boards/${encodeURIComponent(id)}/labels?key=${encodeURIComponent(creds.key)}&token=${encodeURIComponent(creds.token)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name, color }),
            }
          ).then(async (res) => {
            if (!res.ok) throw new Error(`Trello API ${res.status} on POST /boards/${id}/labels`);
            return res.json() as Promise<{ id: string; name: string }>;
          }),
      }));

  return validate(cfg.boardId, stateMap, labelName, cfg.creds);
};

// --- file builders (pure) ----------------------------------------------------

export const buildTaskSourcesYaml = (boardId: string): string =>
  [
    "# Generated by OpenRoutines onboarding.",
    "sources:",
    "  - id: trello-main",
    "    type: trello",
    "    pollIntervalMinutes: 30",
    "    containers:",
    `      board: "${boardId}"`,
    "    auth:",
    "      key: TRELLO_API_KEY",
    "      token: TRELLO_API_TOKEN",
    "",
  ].join("\n");

/** Rewrite the `  <state>: <column>` lines of connector.yaml in place, preserving comments. */
export const updateConnectorState = (content: string, stateMap: Record<string, string>): string => {
  let out = content;
  for (const [state, column] of Object.entries(stateMap)) {
    const re = new RegExp(`^(\\s{2}${state}:\\s*).*$`, "m");
    const quoted = /[\s—:]/.test(column) ? `"${column}"` : column;
    if (re.test(out)) out = out.replace(re, `  ${state}: ${quoted}`);
  }
  return out;
};

/** Append only the env vars not already declared, under a clearly-marked block. */
export const appendMissingEnv = (content: string, vars: Record<string, string>): string => {
  let out = content === "" || content.endsWith("\n") ? content : content + "\n";
  const additions: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    if (!v) continue;
    if (new RegExp(`^${k}=`, "m").test(out)) continue;
    additions.push(`${k}=${v}`);
  }
  if (additions.length) out += "\n# Added by OpenRoutines onboarding\n" + additions.join("\n") + "\n";
  return out;
};

// --- interactive wizard ------------------------------------------------------

interface Named {
  id: string;
  name: string;
}

const trelloGet = async (path: string, key: string, token: string): Promise<unknown> => {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`https://api.trello.com/1/${path}${sep}key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(`Trello API ${res.status} on ${path}`);
  return res.json();
};

export const runOnboarding = async (paths: OnboardingPaths = defaultPaths()): Promise<void> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string): Promise<string> => (await rl.question(q)).trim();
  try {
    console.log("\n🧭 OpenRoutines — configuração inicial\n");
    const key = await ask("Trello API key: ");
    const token = await ask("Trello API token: ");

    const boards = (await trelloGet("members/me/boards?fields=name", key, token)) as Named[];
    console.log("\nBoards:");
    boards.forEach((b, i) => console.log(`  ${i + 1}) ${b.name}`));
    const board = boards[parseInt(await ask("Escolha o board (número): "), 10) - 1];
    if (!board) throw new Error("board inválido");

    const lists = (await trelloGet(`boards/${board.id}/lists?fields=name`, key, token)) as Named[];
    console.log("\nColunas do board:");
    lists.forEach((l, i) => console.log(`  ${i + 1}) ${l.name}`));

    const stateMap = {} as Record<CanonicalState, string>;
    for (const state of CANONICAL_STATES) {
      const guess = lists.find((l) => l.name === DEFAULT_COLUMNS[state])?.name ?? DEFAULT_COLUMNS[state];
      stateMap[state] = (await ask(`Coluna para "${state}" [${guess}]: `)) || guess;
    }

    const baseDir = (await ask("\nDiretório base dos repositórios (REPOS_BASE_DIR) [/Volumes/programacao]: ")) || "/Volumes/programacao";

    writeFileSync(paths.taskSources, buildTaskSourcesYaml(board.id));
    if (existsSync(paths.connector)) {
      writeFileSync(paths.connector, updateConnectorState(readFileSync(paths.connector, "utf-8"), stateMap));
    }
    const envContent = existsSync(paths.env) ? readFileSync(paths.env, "utf-8") : "";
    writeFileSync(paths.env, appendMissingEnv(envContent, { TRELLO_API_KEY: key, TRELLO_API_TOKEN: token, REPOS_BASE_DIR: baseDir }));

    // Reflect into the running process so the boot continues fully wired.
    process.env.TRELLO_API_KEY = key;
    process.env.TRELLO_API_TOKEN = token;
    process.env.REPOS_BASE_DIR = baseDir;
    console.log("\n✅ Salvo (task-sources.yaml, connector.yaml, .env). Iniciando o OpenRoutines...\n");
  } finally {
    rl.close();
  }
};

const runRemapWizard = async (
  paths: OnboardingPaths,
  missingShared: SharedColumnMismatch[],
  existingLists: TrelloList[]
): Promise<void> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string): Promise<string> => (await rl.question(q)).trim();
  try {
    console.log("\n🧭 OpenRoutines — remapear colunas do Trello\n");
    console.log("As seguintes colunas reaproveitadas não existem no board com o nome mapeado:\n");
    for (const m of missingShared) {
      console.log(`  - ${m.state}: "${m.mappedName}"${m.similar ? ` (similar: "${m.similar}")` : ""}`);
    }

    console.log("\nColunas disponíveis no board:");
    existingLists.forEach((l, i) => console.log(`  ${i + 1}) ${l.name}`));

    const stateMap: Partial<Record<CanonicalState, string>> = {};
    for (const m of missingShared) {
      const suggestion = m.similar ?? existingLists.find((l) => l.name === DEFAULT_COLUMNS[m.state])?.name ?? "";
      const answer = await ask(`\nColuna para "${m.state}" [${suggestion || "escolha"}]: `);
      const pick = answer || suggestion;
      const chosen = existingLists.find((l) => l.name === pick || `${existingLists.indexOf(l) + 1}` === pick);
      if (!chosen) throw new Error(`coluna inválida para "${m.state}"`);
      stateMap[m.state] = chosen.name;
    }

    const cfg = parseOnboardingConfig(paths, (p) => readFileSync(p, "utf-8"), process.env);
    writeFileSync(cfg.manifestPath, updateConnectorState(cfg.manifestRaw, stateMap as Record<string, string>));
    console.log("\n✅ State map atualizado no connector.yaml. Iniciando o OpenRoutines...\n");
  } finally {
    rl.close();
  }
};

export const maybeRunOnboarding = async (paths: OnboardingPaths = defaultPaths()): Promise<void> => {
  const check = needsOnboarding(paths);
  if (check.needed) {
    if (!process.stdin.isTTY) {
      console.error(
        `[Onboarding] Config incompleta (${check.reasons.join("; ")}) e sem terminal interativo. ` +
          "Configure task-sources.yaml + .env manualmente, ou rode uma vez em um terminal."
      );
      return;
    }
    await runOnboarding(paths);
    return;
  }

  let validation: BoardValidation;
  try {
    validation = await validateBoardColumns(paths);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Onboarding] Falha ao validar colunas do board do Trello: ${message}`);
    return;
  }

  if (validation.createdLists.length) {
    console.log(`[Onboarding] Colunas dedicadas criadas: ${validation.createdLists.join(", ")}`);
  }
  if (validation.createdLabel) {
    console.log(`[Onboarding] Label criada: ${validation.createdLabel}`);
  }

  if (validation.ok) return;

  const mismatchLines = validation.missingShared
    .map((m) => `  - ${m.state}: mapeado para "${m.mappedName}"${m.similar ? ` (similar no board: "${m.similar}")` : ""}`)
    .join("\n");

  if (!process.stdin.isTTY) {
    console.error(
      `[Onboarding] State map do Trello não bate com as colunas do board:\n${mismatchLines}\n` +
        "Ajuste .gates/connectors/trello/connector.yaml manualmente, ou rode em um terminal interativo."
    );
    return;
  }

  await runRemapWizard(paths, validation.missingShared, validation.existingLists);
};
