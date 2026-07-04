/**
 * Autonomous work generation (F5 #164, D26).
 *
 * Three independent write-effects, all funneling through the same
 * fingerprint-dedupe + card-template plumbing:
 *
 *   1. `proposeWeeklyCards()` — the Sunday-maintenance job (cron wiring is
 *      F6; this delivers the callable logic + the Trello write). Runs, in
 *      order: (a) the CVE wave (`npm audit` critical, always alerts via
 *      Telegram, bypasses the weekly cap — a critical vuln is never silently
 *      dropped because an unrelated debt card used up the budget first),
 *      (b) general-debt aggregation (blockReason/semgrep/dependencyAudit/flaky
 *      recurrence mined from `executions.metadata`, capped at
 *      MAX_DEBT_CARDS_PER_ROUND), (c) the dependency wave (`npm outdated`,
 *      minor/patch -> Update, major -> Pesquisa). Every card lands in
 *      **Backlog** (never OpenRoutines — Fila) except an opt-in CVE with
 *      `AUTO_QUEUE_SECURITY_PATCHES=true`.
 *   2. `propagateSiblingFix()` — triggered separately (by whoever detects a
 *      merge, out of scope here) once a PR merges: greps the repo's `family`
 *      siblings (repos.yaml) for the same pattern and proposes 1 card per
 *      affected sibling.
 *
 * Design notes (decisions worth documenting, not re-litigating):
 *  - Debt signals are read from `executions.metadata.stateMachineContext.
 *    outputs` — the EXACT same field morning-report.ts already reads
 *    blockReason from (state-machine.ts persists it there at every state
 *    completion). `run_states` is not queried separately: by the time a card
 *    finishes, everything run_states would have is already folded into this
 *    one column, and a second query/join would just re-derive the same
 *    facts. semgrepFindings/dependencyAudit/knownFailures live under
 *    `outputs.verify` (card-to-pr/verify.ts's VerifyOutput).
 *  - Fingerprint dedupe (`sha256(repo:tipo:chave)`) is stored as a trailing
 *    HTML comment in the card description (invisible when Trello renders the
 *    markdown, still present in the raw `desc` field `findExistingFingerprints`
 *    reads back) — the "custom field" alternative in the issue would need a
 *    new board-level field definition, heavier than a body marker for what's
 *    an internal bookkeeping detail.
 *  - `findExistingFingerprints`'s real implementation is a small raw-`fetch`
 *    helper living HERE (not added to connector/trello.ts, which is
 *    deliberately left alone) — same "ad hoc export, not a TaskSource method"
 *    precedent trello.ts's own makeTrelloCreateCard/makeTrelloLinkCards
 *    already set for capabilities the TaskSource contract doesn't cover.
 *  - Sibling propagation runs `git grep` ITSELF (execFile, argv-safe) rather
 *    than handing an agentic Kimi session unrestricted Bash — the read-only
 *    guarantee the issue asks for is enforced by construction (my code is
 *    the only thing touching the sibling's filesystem), not by trusting a
 *    tool-use allowlist no available Kimi provider here actually supports.
 *    Kimi (injected as `judgeSameProblem`) only ever sees pre-fetched text.
 */
import { createHash } from "crypto";
import type { Pool } from "pg";
import type { RepoConfig, RepoRegistry } from "../repo-registry/schema.js";
import type { CreateCardInput, CreateCardResult, TrelloAuthConfig } from "../connector/trello.js";
import { loadPolicy } from "../config/policy.js";
import { sendTelegramAlert } from "../notify/telegram.js";
import { defaultExec, type ExecRunner } from "../verify/sast.js";

// --- shared constants --------------------------------------------------------

export const BACKLOG_LIST_NAME = "Backlog";
export const QUEUE_LIST_NAME = "OpenRoutines — Fila";
export const WORKING_LIST_NAME = "OpenRoutines — Working";
/** Lists scanned for an existing fingerprint before a new card is created (D26). */
export const DEDUPE_SCAN_LISTS = [BACKLOG_LIST_NAME, QUEUE_LIST_NAME, WORKING_LIST_NAME];

export const AUTO_PROPOSED_LABEL = "OpenRoutines: Auto-proposto";
const UPDATE_LABEL = "OpenRoutines: Update";
const RESEARCH_LABEL = "OpenRoutines: Pesquisa";

/** "Máximo 3 cards de dívida geral por rodada" (D26) — a fixed number, unlike the weekly cap. */
const MAX_DEBT_CARDS_PER_ROUND = 3;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const SIGNAL_THRESHOLDS = {
  blockReason: 2, // "recorrente (>=2 ocorrências)" (D26)
  semgrep: 2, // "recorrentes" — same bar as blockReason, no separate number given
  dependencyVulnerable: 1, // "novo" — a single sighting of a real high/critical vuln is already worth flagging
  flaky: 3, // "persistente (>=3 ocorrências)" (D26)
} as const;
/** "semgrep<8" (D26/D29) — a finding's own 1-10 confidence below this counts as low-confidence. */
const LOW_SEMGREP_CONFIDENCE = 8;

export const computeFingerprint = (repo: string, tipo: string, chave: string): string =>
  createHash("sha256").update(`${repo}:${tipo}:${chave}`).digest("hex");

export type ProposedCardType =
  | `debt-${"block-reason" | "semgrep" | "dependency-vulnerable" | "flaky"}`
  | "dep-update"
  | "dep-research"
  | "cve"
  | "sibling-fix";

export interface ProposedCard {
  cardId: string;
  url: string;
  repo: string;
  type: ProposedCardType;
  listName: string;
  fingerprint: string;
}

const parseJsonSafe = <T,>(raw: string, fallback: T): T => {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null") return fallback;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return fallback;
  }
};

// --- card template (.openroutines/02-FLUXO-TRELLO.md) -----------------------

interface CardBodyInput {
  conceito: string;
  repo: string;
  objetivo: string;
  escopoIncluido: string[];
  criterios: string[];
  notasTecnicas: string;
  fingerprint: string;
}

const buildCardBody = (input: CardBodyInput): string =>
  [
    "# Conceito",
    input.conceito,
    "",
    "## Repositório",
    input.repo,
    "",
    "## Objetivo",
    input.objetivo,
    "",
    "## Escopo",
    "- Incluído:",
    ...input.escopoIncluido.map((s) => `  - ${s}`),
    "- Fora de escopo:",
    "  - Qualquer coisa além do listado acima",
    "",
    "## Critérios de aceite",
    ...input.criterios.map((c) => `- [ ] ${c}`),
    "",
    "## Notas técnicas",
    input.notasTecnicas,
    "",
    // Dedupe marker (D26) — an HTML comment so it stays invisible in Trello's
    // rendered markdown view but survives in the raw `desc` field that
    // findExistingFingerprints reads back.
    `<!-- openroutines:fingerprint:${input.fingerprint} -->`,
  ].join("\n");

// --- Trello fingerprint lookup (raw fetch — trello.ts stays untouched) ------

export interface TrelloFingerprintLookupConfig extends TrelloAuthConfig {
  boardId: string;
  listNames?: string[]; // defaults to DEDUPE_SCAN_LISTS
}

/**
 * Real default for `findExistingFingerprints`. Resolves the target lists
 * once, then fetches every open card's `desc` in each and checks which of
 * the given fingerprint markers appear as a substring anywhere.
 *
 * ponytail: no pagination — Trello returns up to 1000 cards per list call in
 * one page, ample for the Backlog/Fila/Working volume this system runs at.
 * Add paging if a list ever grows past that (same ceiling class as trello.ts's
 * own "no client-side rate-limit backoff" note).
 */
export const makeFindExistingFingerprints =
  (cfg: TrelloFingerprintLookupConfig) =>
  async (fingerprints: string[]): Promise<Set<string>> => {
    const found = new Set<string>();
    if (fingerprints.length === 0) return found;

    const auth = `key=${encodeURIComponent(cfg.apiKey)}&token=${encodeURIComponent(cfg.apiToken)}`;
    const listsRes = await fetch(
      `https://api.trello.com/1/boards/${encodeURIComponent(cfg.boardId)}/lists?filter=open&fields=id,name&${auth}`
    );
    if (!listsRes.ok) throw new Error(`trello: failed to resolve lists (${listsRes.status})`);
    const lists = (await listsRes.json()) as Array<{ id: string; name: string }>;
    const targetNames = new Set(cfg.listNames ?? DEDUPE_SCAN_LISTS);
    const targetIds = lists.filter((l) => targetNames.has(l.name)).map((l) => l.id);

    for (const listId of targetIds) {
      const cardsRes = await fetch(
        `https://api.trello.com/1/lists/${encodeURIComponent(listId)}/cards?filter=open&fields=desc&${auth}`
      );
      if (!cardsRes.ok) throw new Error(`trello: failed to list cards (${cardsRes.status})`);
      const cards = (await cardsRes.json()) as Array<{ desc?: string }>;
      for (const card of cards) {
        if (!card.desc) continue;
        for (const fp of fingerprints) {
          if (card.desc.includes(fp)) found.add(fp);
        }
      }
    }
    return found;
  };

// --- general debt aggregation (executions.metadata, last 7 days) -----------

export interface ExecutionSignalRow {
  repo: string;
  metadata: Record<string, unknown> | null;
}

/** Real default for `fetchExecutionRows` — mirrors morning-report.ts's exact metadata-reading shape, scoped by date instead of nightId. */
export const makeFetchExecutionRows =
  (pool: Pool) =>
  async (since: Date): Promise<ExecutionSignalRow[]> => {
    const { rows } = await pool.query(
      `SELECT repo, metadata FROM executions WHERE started_at >= $1 AND repo IS NOT NULL`,
      [since]
    );
    return rows.map((r) => ({
      repo: r.repo as string,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    }));
  };

type DebtTipo = "block-reason" | "semgrep" | "dependency-vulnerable" | "flaky";

interface StateMachineOutputsShape {
  stateMachineContext?: {
    outputs?: {
      bloqueado?: { blockReason?: string };
      verify?: {
        semgrepFindings?: Array<{ ruleId?: string; file?: string; confidence?: number }>;
        dependencyAudit?: { vulnerable?: Array<{ name?: string; advisory?: string }> };
        knownFailures?: string[];
      };
    };
  };
}

interface DebtOccurrence {
  repo: string;
  tipo: DebtTipo;
  chave: string;
  evidence: string;
}

/** Pure extraction of every debt occurrence a single execution row carries — 0, 1, or several. */
export const extractDebtOccurrences = (row: ExecutionSignalRow): DebtOccurrence[] => {
  const outputs = (row.metadata as StateMachineOutputsShape | null)?.stateMachineContext?.outputs;
  if (!outputs) return [];
  const occurrences: DebtOccurrence[] = [];

  const blockReason = outputs.bloqueado?.blockReason;
  if (blockReason) {
    occurrences.push({ repo: row.repo, tipo: "block-reason", chave: blockReason, evidence: `blockReason="${blockReason}"` });
  }

  for (const finding of outputs.verify?.semgrepFindings ?? []) {
    if (typeof finding.confidence === "number" && finding.confidence < LOW_SEMGREP_CONFIDENCE && finding.ruleId && finding.file) {
      occurrences.push({
        repo: row.repo,
        tipo: "semgrep",
        chave: `${finding.ruleId}:${finding.file}`,
        evidence: `semgrep ${finding.ruleId} em ${finding.file} (confidence ${finding.confidence})`,
      });
    }
  }

  for (const vuln of outputs.verify?.dependencyAudit?.vulnerable ?? []) {
    if (vuln.name && vuln.advisory) {
      occurrences.push({
        repo: row.repo,
        tipo: "dependency-vulnerable",
        chave: `${vuln.name}:${vuln.advisory}`,
        evidence: `dependência vulnerável ${vuln.name} — ${vuln.advisory}`,
      });
    }
  }

  for (const failure of outputs.verify?.knownFailures ?? []) {
    occurrences.push({ repo: row.repo, tipo: "flaky", chave: failure, evidence: `falha conhecida recorrente: ${failure}` });
  }

  return occurrences;
};

const DEBT_THRESHOLDS: Record<DebtTipo, number> = {
  "block-reason": SIGNAL_THRESHOLDS.blockReason,
  semgrep: SIGNAL_THRESHOLDS.semgrep,
  "dependency-vulnerable": SIGNAL_THRESHOLDS.dependencyVulnerable,
  flaky: SIGNAL_THRESHOLDS.flaky,
};

export interface DebtSignal {
  repo: string;
  tipo: DebtTipo;
  chave: string;
  count: number;
  evidence: string;
}

/** Groups occurrences by (repo, tipo, chave), keeps only those meeting that tipo's recurrence threshold. */
export const aggregateDebtSignals = (rows: ExecutionSignalRow[]): DebtSignal[] => {
  const groups = new Map<string, DebtSignal>();
  for (const row of rows) {
    for (const occ of extractDebtOccurrences(row)) {
      const key = `${occ.repo}::${occ.tipo}::${occ.chave}`;
      const existing = groups.get(key);
      if (existing) existing.count += 1;
      else groups.set(key, { repo: occ.repo, tipo: occ.tipo, chave: occ.chave, count: 1, evidence: occ.evidence });
    }
  }
  return [...groups.values()].filter((g) => g.count >= DEBT_THRESHOLDS[g.tipo]);
};

const DEBT_COPY: Record<DebtTipo, { titulo: string; conceito: string; objetivo: string; criterio: string }> = {
  "block-reason": {
    titulo: "bloqueio recorrente",
    conceito: "O agente foi bloqueado pelo mesmo motivo mais de uma vez nos últimos 7 dias.",
    objetivo: "Investigar e eliminar a causa raiz do bloqueio recorrente.",
    criterio: "O motivo do bloqueio não se repete nas próximas execuções do repositório.",
  },
  semgrep: {
    titulo: "achado de segurança recorrente (baixa confiança)",
    conceito: "O mesmo achado de SAST (semgrep) abaixo do limiar de bloqueio automático apareceu mais de uma vez.",
    objetivo: "Avaliar o achado: corrigir o código ou documentá-lo como falso positivo conhecido.",
    criterio: "O achado deixa de aparecer ou passa a constar no arquivo de falsos positivos.",
  },
  "dependency-vulnerable": {
    titulo: "dependência vulnerável",
    conceito: "Uma dependência com vulnerabilidade alta/crítica apareceu na verificação de um card recente.",
    objetivo: "Atualizar a dependência para uma versão sem a vulnerabilidade.",
    criterio: "`npm audit` deixa de reportar a vulnerabilidade.",
  },
  flaky: {
    titulo: "teste instável recorrente",
    conceito: "O mesmo teste apareceu como falha conhecida (pré-existente) repetidas vezes na baseline de verificação.",
    objetivo: "Estabilizar ou remover o teste instável.",
    criterio: "O teste para de aparecer como falha conhecida na baseline.",
  },
};

const buildDebtCardBody = (signal: DebtSignal, fingerprint: string): string => {
  const copy = DEBT_COPY[signal.tipo];
  return buildCardBody({
    conceito: copy.conceito,
    repo: signal.repo,
    objetivo: copy.objetivo,
    escopoIncluido: [copy.objetivo],
    criterios: [copy.criterio],
    notasTecnicas: `Evidência: ${signal.evidence} (visto ${signal.count}x nos últimos 7 dias).`,
    fingerprint,
  });
};

const debtCardTitle = (signal: DebtSignal): string => `Dívida técnica: ${DEBT_COPY[signal.tipo].titulo} em ${signal.repo}`;

// --- dependency wave (npm outdated / npm audit / ctx7) ----------------------

export interface OutdatedDependency {
  name: string;
  current: string;
  latest: string;
}

interface RawOutdatedEntry {
  current?: string;
  wanted?: string;
  latest?: string;
}

/** `npm outdated --json` (read-only). Exits non-zero when packages ARE outdated — defaultExec already tolerates that and still returns stdout. */
export const checkOutdated = async (
  repoConfig: RepoConfig,
  exec: ExecRunner = defaultExec
): Promise<OutdatedDependency[]> => {
  const { stdout } = await exec("npm", ["outdated", "--json"], { cwd: repoConfig.clonePath });
  const parsed = parseJsonSafe<Record<string, RawOutdatedEntry>>(stdout, {});
  const result: OutdatedDependency[] = [];
  for (const [name, info] of Object.entries(parsed)) {
    if (info.current && info.latest) result.push({ name, current: info.current, latest: info.latest });
  }
  return result;
};

const parseMajorVersion = (version: string): number | undefined => {
  const match = /(\d+)/.exec(version);
  return match ? Number(match[1]) : undefined;
};

/** True when the leading numeric segment differs — semver-major without pulling in a semver dependency. */
export const isMajorBump = (current: string, latest: string): boolean => {
  const currentMajor = parseMajorVersion(current);
  const latestMajor = parseMajorVersion(latest);
  return currentMajor !== undefined && latestMajor !== undefined && currentMajor !== latestMajor;
};

interface RawNpmAuditVia {
  url?: string;
  title?: string;
}
interface RawNpmAuditEntry {
  name?: string;
  severity?: string;
  via?: Array<string | RawNpmAuditVia>;
}
interface RawNpmAudit {
  vulnerabilities?: Record<string, RawNpmAuditEntry>;
}
const isViaObject = (v: string | RawNpmAuditVia): v is RawNpmAuditVia => typeof v === "object" && v !== null;

export interface CriticalVulnerability {
  name: string;
  advisory: string;
}

/**
 * `npm audit --json`, severity=critical only (read-only).
 *
 * ponytail: duplicates ~15 lines of verify/sast.ts's private runNpmAudit
 * instead of reusing the exported `runSast` composite. Reusing runSast would
 * force every test through semgrep+gitleaks+npm-audit's combined exec
 * surface for what's actually just "filter one field" — narrower, smaller to
 * test, at the cost of this small duplication. Revisit if sast.ts ever
 * exports runNpmAudit on its own.
 */
export const checkCriticalVulnerabilities = async (
  repoConfig: RepoConfig,
  exec: ExecRunner = defaultExec
): Promise<CriticalVulnerability[]> => {
  const { stdout } = await exec("npm", ["audit", "--omit=dev", "--json"], { cwd: repoConfig.clonePath });
  const parsed = parseJsonSafe<RawNpmAudit>(stdout, {});
  const critical: CriticalVulnerability[] = [];
  for (const [key, entry] of Object.entries(parsed.vulnerabilities ?? {})) {
    if (entry.severity !== "critical") continue;
    const advisory = (entry.via ?? []).find(isViaObject);
    critical.push({ name: entry.name ?? key, advisory: advisory?.url ?? advisory?.title ?? key });
  }
  return critical;
};

/**
 * Changelog evidence via the ctx7 CLI (best-effort — never blocks card
 * creation on failure).
 *
 * ponytail: skips ctx7's own 2-step `library <name>` -> `docs <libraryId>`
 * resolution (~/.claude/rules/context7.md) and calls `docs` with the bare
 * package name directly, matching this issue's own literal command shape.
 * Fine for popular unscoped packages; a scoped/ambiguous name may resolve to
 * nothing — degrades to `undefined`, same as any other ctx7 failure.
 */
export const fetchChangelogViaCtx7 = async (
  pkg: string,
  from: string,
  to: string,
  exec: ExecRunner = defaultExec
): Promise<string | undefined> => {
  try {
    const { stdout } = await exec("npx", ["ctx7@latest", "docs", pkg, `changelog de ${from} para ${to}`]);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
};

const buildDepEvidenceLines = async (
  outdated: OutdatedDependency[],
  fetchChangelog: (pkg: string, from: string, to: string) => Promise<string | undefined>
): Promise<string[]> => {
  const withChangelogs = await Promise.all(
    outdated.map(async (d) => ({ d, changelog: await fetchChangelog(d.name, d.current, d.latest) }))
  );
  return withChangelogs.map(({ d, changelog }) => `- ${d.name}: ${d.current} → ${d.latest}${changelog ? ` — ${changelog}` : ""}`);
};

const buildDepCardBody = (repo: string, kind: "update" | "major", lines: string[], fingerprint: string): string =>
  buildCardBody({
    conceito:
      kind === "update"
        ? `Dependências desatualizadas (minor/patch) detectadas em ${repo} via \`npm outdated\`.`
        : `Dependências com bump major disponível em ${repo} via \`npm outdated\` — mudança de contrato exige julgamento antes de atualizar.`,
    repo,
    objetivo:
      kind === "update"
        ? "Atualizar as dependências listadas para a versão mais recente compatível (minor/patch)."
        : "Avaliar o changelog de cada dependência e propor um plano de migração para a versão major mais recente.",
    escopoIncluido: lines,
    criterios:
      kind === "update"
        ? ["`npm outdated` não lista mais essas dependências", "build/lint/test continuam passando"]
        : ["A proposta cita as breaking changes relevantes do changelog de cada dependência"],
    notasTecnicas: `Evidência (\`npm outdated --json\`):\n${lines.join("\n")}`,
    fingerprint,
  });

// --- CVE card body -----------------------------------------------------------

const buildCveCardBody = (repo: string, vuln: CriticalVulnerability, fingerprint: string): string =>
  buildCardBody({
    conceito: `\`npm audit\` encontrou uma vulnerabilidade de severidade **crítica** em ${repo}.`,
    repo,
    objetivo: `Atualizar ${vuln.name} para uma versão sem a vulnerabilidade ${vuln.advisory}.`,
    escopoIncluido: [`Atualizar ${vuln.name} (e dependências que a exigem) para uma versão corrigida`],
    criterios: [`\`npm audit\` deixa de reportar ${vuln.advisory} para ${vuln.name}`],
    notasTecnicas: `Evidência: \`npm audit --json\` (severidade critical) — ${vuln.name}, advisory ${vuln.advisory}.`,
    fingerprint,
  });

// --- proposeWeeklyCards ------------------------------------------------------

export interface ProposeWeeklyCardsDeps {
  registry: RepoRegistry;
  createCard: (input: CreateCardInput) => Promise<CreateCardResult>;
  findExistingFingerprints: (fingerprints: string[]) => Promise<Set<string>>;
  /** Debt-aggregation source. Absent = no debt signals this round ("no-DB mode", mirrors CardToPrDeps's `pool?`). */
  pool?: Pool;
  /** Overrides the pool-backed query — the seam tests inject fixture rows through, bypassing SQL entirely. */
  fetchExecutionRows?: (since: Date) => Promise<ExecutionSignalRow[]>;
  checkOutdated?: (repoConfig: RepoConfig) => Promise<OutdatedDependency[]>;
  checkCriticalVulnerabilities?: (repoConfig: RepoConfig) => Promise<CriticalVulnerability[]>;
  fetchChangelog?: (pkg: string, from: string, to: string) => Promise<string | undefined>;
  /** Telegram alert seam (D22) — defaults to the real sender; tests inject a mock. */
  sendAlert?: (text: string) => Promise<void>;
  now?: () => Date;
  /** Overrides the weekly cap for tests. Absent -> resolved from policy.yaml's day.max_auto_proposed_cards_per_week (D32, same POLICY_PATH as app.ts). */
  maxWeeklyCards?: number;
  /** Env AUTO_QUEUE_SECURITY_PATCHES === "true" by default — false means every CVE card lands in Backlog like everything else. */
  autoQueueSecurityPatches?: boolean;
}

export const proposeWeeklyCards = async (deps: ProposeWeeklyCardsDeps): Promise<ProposedCard[]> => {
  const now = deps.now ?? (() => new Date());
  const since = new Date(now().getTime() - SEVEN_DAYS_MS);
  const maxWeeklyCards =
    deps.maxWeeklyCards ?? loadPolicy(process.env.POLICY_PATH ?? "policy.yaml").day.max_auto_proposed_cards_per_week;
  const autoQueueSecurity = deps.autoQueueSecurityPatches ?? process.env.AUTO_QUEUE_SECURITY_PATCHES === "true";
  const sendAlert = deps.sendAlert ?? sendTelegramAlert;
  const checkOutdatedFn = deps.checkOutdated ?? checkOutdated;
  const checkCriticalFn = deps.checkCriticalVulnerabilities ?? checkCriticalVulnerabilities;
  const fetchChangelogFn = deps.fetchChangelog ?? fetchChangelogViaCtx7;
  const fetchRows = deps.fetchExecutionRows ?? (deps.pool ? makeFetchExecutionRows(deps.pool) : undefined);

  const created: ProposedCard[] = [];
  let weeklyBudget = maxWeeklyCards;

  // --- 1) CVE wave — alert is unconditional; only card creation is deduped and capped-exempt ---
  const criticalFindings: Array<{ repo: string; vuln: CriticalVulnerability }> = [];
  for (const [repoName, repoConfig] of Object.entries(deps.registry.repos)) {
    for (const vuln of await checkCriticalFn(repoConfig)) {
      criticalFindings.push({ repo: repoName, vuln });
    }
  }
  for (const { repo, vuln } of criticalFindings) {
    await sendAlert(`🛡️ [${repo}] CVE crítico: ${vuln.name} (${vuln.advisory})`);
  }
  if (criticalFindings.length > 0) {
    const cveFingerprints = criticalFindings.map((f) => computeFingerprint(f.repo, "cve", `${f.vuln.name}:${f.vuln.advisory}`));
    const existingCve = await deps.findExistingFingerprints(cveFingerprints);
    const listName = autoQueueSecurity ? QUEUE_LIST_NAME : BACKLOG_LIST_NAME;
    for (let i = 0; i < criticalFindings.length; i++) {
      const fingerprint = cveFingerprints[i];
      if (existingCve.has(fingerprint)) continue;
      const { repo, vuln } = criticalFindings[i];
      const result = await deps.createCard({
        listName,
        title: `🛡️ CVE crítico: ${vuln.name} em ${repo}`,
        description: buildCveCardBody(repo, vuln, fingerprint),
        labels: [AUTO_PROPOSED_LABEL],
      });
      created.push({ cardId: result.cardId, url: result.url, repo, type: "cve", listName, fingerprint });
    }
  }

  // --- 2) General debt aggregation — Backlog only, capped at MAX_DEBT_CARDS_PER_ROUND, counts toward the weekly cap ---
  if (fetchRows) {
    const rows = await fetchRows(since);
    const signals = aggregateDebtSignals(rows)
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_DEBT_CARDS_PER_ROUND);

    if (signals.length > 0) {
      const debtFingerprints = signals.map((s) => computeFingerprint(s.repo, s.tipo, s.chave));
      const existingDebt = await deps.findExistingFingerprints(debtFingerprints);
      for (let i = 0; i < signals.length; i++) {
        if (weeklyBudget <= 0) break;
        const fingerprint = debtFingerprints[i];
        if (existingDebt.has(fingerprint)) continue;
        const signal = signals[i];
        const result = await deps.createCard({
          listName: BACKLOG_LIST_NAME,
          title: debtCardTitle(signal),
          description: buildDebtCardBody(signal, fingerprint),
          labels: [AUTO_PROPOSED_LABEL],
        });
        created.push({
          cardId: result.cardId,
          url: result.url,
          repo: signal.repo,
          type: `debt-${signal.tipo}`,
          listName: BACKLOG_LIST_NAME,
          fingerprint,
        });
        weeklyBudget -= 1;
      }
    }
  }

  // --- 3) Dependency wave — 1 Update card + 1 Pesquisa card per repo, Backlog only, counts toward the weekly cap ---
  interface DepCandidate {
    repo: string;
    kind: "update" | "major";
    deps: OutdatedDependency[];
  }
  const depCandidates: DepCandidate[] = [];
  for (const [repoName, repoConfig] of Object.entries(deps.registry.repos)) {
    const outdated = await checkOutdatedFn(repoConfig);
    const minorPatch = outdated.filter((d) => !isMajorBump(d.current, d.latest));
    const major = outdated.filter((d) => isMajorBump(d.current, d.latest));
    if (minorPatch.length > 0) depCandidates.push({ repo: repoName, kind: "update", deps: minorPatch });
    if (major.length > 0) depCandidates.push({ repo: repoName, kind: "major", deps: major });
  }

  if (depCandidates.length > 0) {
    const depFingerprints = depCandidates.map((c) =>
      computeFingerprint(
        c.repo,
        c.kind === "update" ? "dep-update" : "dep-major",
        [...c.deps].map((d) => `${d.name}@${d.latest}`).sort().join(",")
      )
    );
    const existingDep = await deps.findExistingFingerprints(depFingerprints);
    for (let i = 0; i < depCandidates.length; i++) {
      if (weeklyBudget <= 0) break;
      const fingerprint = depFingerprints[i];
      if (existingDep.has(fingerprint)) continue;
      const candidate = depCandidates[i];
      const lines = await buildDepEvidenceLines(candidate.deps, fetchChangelogFn);
      const title =
        candidate.kind === "update"
          ? `Update de dependências em ${candidate.repo}`
          : `Pesquisa: bump major de dependências em ${candidate.repo}`;
      const labels = [AUTO_PROPOSED_LABEL, candidate.kind === "update" ? UPDATE_LABEL : RESEARCH_LABEL];
      const result = await deps.createCard({
        listName: BACKLOG_LIST_NAME,
        title,
        description: buildDepCardBody(candidate.repo, candidate.kind, lines, fingerprint),
        labels,
      });
      created.push({
        cardId: result.cardId,
        url: result.url,
        repo: candidate.repo,
        type: candidate.kind === "update" ? "dep-update" : "dep-research",
        listName: BACKLOG_LIST_NAME,
        fingerprint,
      });
      weeklyBudget -= 1;
    }
  }

  return created;
};

// --- propagateSiblingFix -----------------------------------------------------

export interface MergedPrInfo {
  /** Registry key (slug) of the repo whose PR just merged — same "repo" convention as PrLink/RiskScoreInput. */
  repo: string;
  title: string;
  /** Unified diff text of the merged PR. */
  diff: string;
}

export interface SiblingVerdict {
  matches: boolean;
  location?: string;
}

export interface PropagateSiblingFixDeps {
  registry: RepoRegistry;
  createCard: (input: CreateCardInput) => Promise<CreateCardResult>;
  findExistingFingerprints: (fingerprints: string[]) => Promise<Set<string>>;
  /** Kimi (or any judge) call — receives only pre-fetched text, never touches the sibling's filesystem itself. */
  judgeSameProblem: (args: { repo: string; prTitle: string; diff: string; grepOutput: string }) => Promise<SiblingVerdict>;
  exec?: ExecRunner;
}

/**
 * Naive first-added-line heuristic for what to `git grep` siblings for.
 * ponytail: a real diff can touch several unrelated hunks — this picks only
 * the first sufficiently-specific added line. Upgrade path: have
 * judgeSameProblem itself propose additional candidate needles when the
 * first one greps empty everywhere.
 */
const MIN_NEEDLE_LENGTH = 12;
export const extractSearchNeedle = (diff: string): string | undefined =>
  diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1).trim())
    .find((l) => l.length >= MIN_NEEDLE_LENGTH);

const buildSiblingFixCardBody = (mergedPr: MergedPrInfo, siblingRepo: string, location: string, fingerprint: string): string =>
  buildCardBody({
    conceito: `O PR "${mergedPr.title}" mergeado em ${mergedPr.repo} corrigiu um padrão que também existe em ${siblingRepo} (mesma família de repositórios).`,
    repo: siblingRepo,
    objetivo: `Aplicar o mesmo fix em ${siblingRepo}.`,
    escopoIncluido: [`Replicar a correção do PR original (${mergedPr.repo}: ${mergedPr.title})`],
    criterios: [`O mesmo padrão corrigido em ${mergedPr.repo} não está mais presente em ${siblingRepo}`],
    notasTecnicas: `Evidência: git grep localizou o padrão em ${location}. PR original: ${mergedPr.title} (${mergedPr.repo}).`,
    fingerprint,
  });

export const propagateSiblingFix = async (deps: PropagateSiblingFixDeps, mergedPr: MergedPrInfo): Promise<ProposedCard[]> => {
  const source = deps.registry.repos[mergedPr.repo];
  const family = source?.family;
  if (!family) return []; // no family declared = nothing to propagate to (D26: only siblings of the SAME family)

  const siblings = Object.entries(deps.registry.repos).filter(([key, cfg]) => key !== mergedPr.repo && cfg.family === family);
  if (siblings.length === 0) return [];

  const exec = deps.exec ?? defaultExec;
  const needle = extractSearchNeedle(mergedPr.diff);

  const matches: Array<{ repo: string; location: string }> = [];
  for (const [siblingKey, siblingCfg] of siblings) {
    const grepOutput = needle ? (await exec("git", ["grep", "-n", "-F", needle], { cwd: siblingCfg.clonePath })).stdout : "";
    const verdict = await deps.judgeSameProblem({ repo: siblingKey, prTitle: mergedPr.title, diff: mergedPr.diff, grepOutput });
    if (verdict.matches) matches.push({ repo: siblingKey, location: verdict.location ?? "ver diff do PR original" });
  }
  if (matches.length === 0) return [];

  const fingerprints = matches.map((m) => computeFingerprint(m.repo, "sibling-fix", `${mergedPr.repo}:${needle ?? mergedPr.title}`));
  const existing = await deps.findExistingFingerprints(fingerprints);

  const created: ProposedCard[] = [];
  for (let i = 0; i < matches.length; i++) {
    const fingerprint = fingerprints[i];
    if (existing.has(fingerprint)) continue;
    const { repo: siblingRepo, location } = matches[i];
    const result = await deps.createCard({
      listName: BACKLOG_LIST_NAME,
      title: `Propagar fix de ${mergedPr.repo} (${mergedPr.title}) para ${siblingRepo}`,
      description: buildSiblingFixCardBody(mergedPr, siblingRepo, location, fingerprint),
      labels: [AUTO_PROPOSED_LABEL],
    });
    created.push({ cardId: result.cardId, url: result.url, repo: siblingRepo, type: "sibling-fix", listName: BACKLOG_LIST_NAME, fingerprint });
  }
  return created;
};
