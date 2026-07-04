/**
 * Work generation tests (F5 #164, D26) — acceptance criteria from the issue,
 * plus focused unit coverage for the pure helpers underneath.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { RepoConfig, RepoRegistry } from "../repo-registry/schema.js";
import type { CreateCardInput, CreateCardResult } from "../connector/trello.js";
import {
  proposeWeeklyCards,
  propagateSiblingFix,
  computeFingerprint,
  isMajorBump,
  aggregateDebtSignals,
  extractDebtOccurrences,
  extractSearchNeedle,
  checkOutdated,
  checkCriticalVulnerabilities,
  fetchChangelogViaCtx7,
  makeFindExistingFingerprints,
  BACKLOG_LIST_NAME,
  QUEUE_LIST_NAME,
  AUTO_PROPOSED_LABEL,
  type ExecutionSignalRow,
  type ProposedCard,
  type MergedPrInfo,
} from "./work-generation.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- fixtures ----------------------------------------------------------------

const makeRepoConfig = (overrides: Partial<RepoConfig> & { clonePath: string }): RepoConfig => ({
  githubRepo: "acme/repo",
  baseBranch: "development",
  verify: { build: "npm run build", test: "npm test" },
  compose: null,
  critical: false,
  ...overrides,
});

const makeRegistry = (repos: Record<string, RepoConfig>): RepoRegistry => ({ repos });

const makeFakeCreateCard = () => {
  const calls: CreateCardInput[] = [];
  let counter = 0;
  const createCard = async (input: CreateCardInput): Promise<CreateCardResult> => {
    calls.push(input);
    counter += 1;
    return { cardId: `card-${counter}`, url: `https://trello.com/c/card-${counter}` };
  };
  return { createCard, calls };
};

const makeFakeDedupe = (existing: Set<string> = new Set()) => {
  const calls: string[][] = [];
  const findExistingFingerprints = async (fingerprints: string[]): Promise<Set<string>> => {
    calls.push(fingerprints);
    return new Set(fingerprints.filter((fp) => existing.has(fp)));
  };
  return { findExistingFingerprints, calls };
};

const noOutdated = async (): Promise<never[]> => [];
const noCritical = async (): Promise<never[]> => [];

// --- pure helpers --------------------------------------------------------------

describe("computeFingerprint", () => {
  it("is deterministic for the same (repo, tipo, chave)", () => {
    expect(computeFingerprint("acme", "cve", "lodash:GHSA-1")).toBe(computeFingerprint("acme", "cve", "lodash:GHSA-1"));
  });

  it("differs when any component differs", () => {
    const base = computeFingerprint("acme", "cve", "lodash:GHSA-1");
    expect(computeFingerprint("other", "cve", "lodash:GHSA-1")).not.toBe(base);
    expect(computeFingerprint("acme", "dep-update", "lodash:GHSA-1")).not.toBe(base);
    expect(computeFingerprint("acme", "cve", "lodash:GHSA-2")).not.toBe(base);
  });
});

describe("isMajorBump", () => {
  it("is false for a minor/patch bump", () => {
    expect(isMajorBump("1.2.0", "1.3.0")).toBe(false);
    expect(isMajorBump("1.2.0", "1.2.5")).toBe(false);
  });

  it("is true when the leading version number changes", () => {
    expect(isMajorBump("2.0.0", "3.0.0")).toBe(true);
  });
});

describe("extractDebtOccurrences", () => {
  it("reads blockReason, low-confidence semgrep, vulnerable deps, and knownFailures from the persisted state-machine outputs", () => {
    const row: ExecutionSignalRow = {
      repo: "acme-widgets",
      metadata: {
        stateMachineContext: {
          outputs: {
            bloqueado: { blockReason: "verify-falhou" },
            verify: {
              semgrepFindings: [
                { ruleId: "rule-1", file: "src/a.ts", confidence: 5 }, // below 8 -> counts
                { ruleId: "rule-2", file: "src/b.ts", confidence: 9 }, // above 8 -> ignored
              ],
              dependencyAudit: { vulnerable: [{ name: "lodash", advisory: "GHSA-1" }] },
              knownFailures: ["suite > flaky test"],
            },
          },
        },
      },
    };

    const occurrences = extractDebtOccurrences(row);
    expect(occurrences).toContainEqual(expect.objectContaining({ tipo: "block-reason", chave: "verify-falhou" }));
    expect(occurrences).toContainEqual(expect.objectContaining({ tipo: "semgrep", chave: "rule-1:src/a.ts" }));
    expect(occurrences.some((o) => o.chave.startsWith("rule-2"))).toBe(false);
    expect(occurrences).toContainEqual(expect.objectContaining({ tipo: "dependency-vulnerable", chave: "lodash:GHSA-1" }));
    expect(occurrences).toContainEqual(expect.objectContaining({ tipo: "flaky", chave: "suite > flaky test" }));
  });

  it("returns nothing for a row with no metadata", () => {
    expect(extractDebtOccurrences({ repo: "x", metadata: null })).toEqual([]);
  });
});

describe("aggregateDebtSignals — recurrence thresholds", () => {
  it("keeps a blockReason seen 2x but drops one seen once", () => {
    const rows: ExecutionSignalRow[] = [
      { repo: "acme", metadata: { stateMachineContext: { outputs: { bloqueado: { blockReason: "verify-falhou" } } } } },
      { repo: "acme", metadata: { stateMachineContext: { outputs: { bloqueado: { blockReason: "verify-falhou" } } } } },
      { repo: "acme", metadata: { stateMachineContext: { outputs: { bloqueado: { blockReason: "orcamento" } } } } },
    ];
    const signals = aggregateDebtSignals(rows);
    expect(signals).toEqual([expect.objectContaining({ tipo: "block-reason", chave: "verify-falhou", count: 2 })]);
  });

  it("requires 3 occurrences for flaky but only 1 for a vulnerable dependency", () => {
    const flakyOnceRow: ExecutionSignalRow = {
      repo: "acme",
      metadata: { stateMachineContext: { outputs: { verify: { knownFailures: ["flaky test"] } } } },
    };
    const vulnOnceRow: ExecutionSignalRow = {
      repo: "acme",
      metadata: { stateMachineContext: { outputs: { verify: { dependencyAudit: { vulnerable: [{ name: "x", advisory: "GHSA-9" }] } } } } },
    };
    expect(aggregateDebtSignals([flakyOnceRow])).toEqual([]);
    expect(aggregateDebtSignals([flakyOnceRow, flakyOnceRow, flakyOnceRow])).toHaveLength(1);
    expect(aggregateDebtSignals([vulnOnceRow])).toHaveLength(1);
  });
});

describe("extractSearchNeedle", () => {
  it("picks the first added line long enough to be a specific search needle", () => {
    const diff = "+++ b/src/foo.ts\n+x\n+const sanitizeInput = (s: string) => s.trim();\n-old line here\n";
    expect(extractSearchNeedle(diff)).toBe("const sanitizeInput = (s: string) => s.trim();");
  });

  it("returns undefined when no added line is long enough", () => {
    expect(extractSearchNeedle("+++ b/x\n+ok\n")).toBeUndefined();
  });
});

// --- argv-safety: exec is always called with an argv array, never a shell string ---

describe("external command invocations are argv-safe (execFile, no shell interpolation)", () => {
  it("checkOutdated calls npm outdated --json with cwd=clonePath", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    await checkOutdated(makeRepoConfig({ clonePath: "/repos/acme" }), exec);
    expect(exec).toHaveBeenCalledWith("npm", ["outdated", "--json"], { cwd: "/repos/acme" });
  });

  it("checkCriticalVulnerabilities calls npm audit --json with cwd=clonePath", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    await checkCriticalVulnerabilities(makeRepoConfig({ clonePath: "/repos/acme" }), exec);
    expect(exec).toHaveBeenCalledWith("npm", ["audit", "--omit=dev", "--json"], { cwd: "/repos/acme" });
  });

  it("fetchChangelogViaCtx7 calls npx ctx7@latest docs <pkg> <query> as separate argv elements", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "changelog text", stderr: "" });
    const changelog = await fetchChangelogViaCtx7("lodash", "4.0.0", "4.1.0", exec);
    expect(exec).toHaveBeenCalledWith("npx", ["ctx7@latest", "docs", "lodash", "changelog de 4.0.0 para 4.1.0"]);
    expect(changelog).toBe("changelog text");
  });

  it("fetchChangelogViaCtx7 degrades to undefined instead of throwing", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("ctx7 unavailable"));
    await expect(fetchChangelogViaCtx7("lodash", "4.0.0", "4.1.0", exec)).resolves.toBeUndefined();
  });
});

describe("checkOutdated / checkCriticalVulnerabilities — JSON parsing", () => {
  it("checkOutdated maps npm outdated's shape and drops entries without current/latest", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        "pkg-a": { current: "1.2.0", wanted: "1.2.5", latest: "1.3.0" },
        "pkg-b": { latest: "2.0.0" }, // no `current` (not installed) — dropped
      }),
      stderr: "",
    });
    const result = await checkOutdated(makeRepoConfig({ clonePath: "/x" }), exec);
    expect(result).toEqual([{ name: "pkg-a", current: "1.2.0", latest: "1.3.0" }]);
  });

  it("checkCriticalVulnerabilities keeps only severity=critical", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        vulnerabilities: {
          lodash: { name: "lodash", severity: "critical", via: [{ url: "GHSA-1", title: "t" }] },
          minimist: { name: "minimist", severity: "high", via: ["some-other-pkg"] },
        },
      }),
      stderr: "",
    });
    const result = await checkCriticalVulnerabilities(makeRepoConfig({ clonePath: "/x" }), exec);
    expect(result).toEqual([{ name: "lodash", advisory: "GHSA-1" }]);
  });
});

// --- AC 1: 2 recurring blockReasons -> 1 Backlog card; rerun does not duplicate ---

describe("proposeWeeklyCards — general debt aggregation (AC: recurring blockReason)", () => {
  it("2 blockReason occurrences in the same repo produce exactly 1 Backlog card citing the evidence", async () => {
    const registry = makeRegistry({ acme: makeRepoConfig({ clonePath: "/repos/acme" }) });
    const rows: ExecutionSignalRow[] = [
      { repo: "acme", metadata: { stateMachineContext: { outputs: { bloqueado: { blockReason: "verify-falhou" } } } } },
      { repo: "acme", metadata: { stateMachineContext: { outputs: { bloqueado: { blockReason: "verify-falhou" } } } } },
    ];
    const { createCard, calls } = makeFakeCreateCard();
    const { findExistingFingerprints } = makeFakeDedupe();

    const created = await proposeWeeklyCards({
      registry,
      createCard,
      findExistingFingerprints,
      fetchExecutionRows: async () => rows,
      checkOutdated: noOutdated,
      checkCriticalVulnerabilities: noCritical,
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ repo: "acme", type: "debt-block-reason", listName: BACKLOG_LIST_NAME });
    expect(calls[0].listName).toBe(BACKLOG_LIST_NAME);
    expect(calls[0].labels).toEqual([AUTO_PROPOSED_LABEL]);
    expect(calls[0].description).toContain("verify-falhou");
    expect(calls[0].description).toContain("2x"); // evidence cites the occurrence count
  });

  it("rerunning over the same dataset does not duplicate the card (fingerprint dedupe)", async () => {
    const registry = makeRegistry({ acme: makeRepoConfig({ clonePath: "/repos/acme" }) });
    const rows: ExecutionSignalRow[] = [
      { repo: "acme", metadata: { stateMachineContext: { outputs: { bloqueado: { blockReason: "verify-falhou" } } } } },
      { repo: "acme", metadata: { stateMachineContext: { outputs: { bloqueado: { blockReason: "verify-falhou" } } } } },
    ];
    const first = makeFakeCreateCard();
    const firstRun = await proposeWeeklyCards({
      registry,
      createCard: first.createCard,
      findExistingFingerprints: makeFakeDedupe().findExistingFingerprints,
      fetchExecutionRows: async () => rows,
      checkOutdated: noOutdated,
      checkCriticalVulnerabilities: noCritical,
    });
    expect(firstRun).toHaveLength(1);

    const second = makeFakeCreateCard();
    const secondRun = await proposeWeeklyCards({
      registry,
      createCard: second.createCard,
      findExistingFingerprints: makeFakeDedupe(new Set([firstRun[0].fingerprint])).findExistingFingerprints,
      fetchExecutionRows: async () => rows,
      checkOutdated: noOutdated,
      checkCriticalVulnerabilities: noCritical,
    });

    expect(secondRun).toHaveLength(0);
    expect(second.calls).toHaveLength(0);
  });

  it("caps general-debt cards at 3 per round even with more qualifying signals", async () => {
    const registry = makeRegistry({ acme: makeRepoConfig({ clonePath: "/repos/acme" }) });
    const rows: ExecutionSignalRow[] = [];
    for (const reason of ["r1", "r2", "r3", "r4"]) {
      rows.push({ repo: "acme", metadata: { stateMachineContext: { outputs: { bloqueado: { blockReason: reason } } } } });
      rows.push({ repo: "acme", metadata: { stateMachineContext: { outputs: { bloqueado: { blockReason: reason } } } } });
    }
    const { createCard } = makeFakeCreateCard();
    const created = await proposeWeeklyCards({
      registry,
      createCard,
      findExistingFingerprints: makeFakeDedupe().findExistingFingerprints,
      fetchExecutionRows: async () => rows,
      checkOutdated: noOutdated,
      checkCriticalVulnerabilities: noCritical,
    });
    expect(created).toHaveLength(3);
  });
});

// --- AC 2: 1 minor dep + 1 major dep -> 1 Update card + 1 Pesquisa card ---

describe("proposeWeeklyCards — dependency wave (AC: minor -> Update, major -> Pesquisa)", () => {
  it("produces exactly 1 Update card and 1 Pesquisa card for a repo with both", async () => {
    const registry = makeRegistry({ acme: makeRepoConfig({ clonePath: "/repos/acme" }) });
    const { createCard, calls } = makeFakeCreateCard();

    const created = await proposeWeeklyCards({
      registry,
      createCard,
      findExistingFingerprints: makeFakeDedupe().findExistingFingerprints,
      checkOutdated: async () => [
        { name: "pkg-minor", current: "1.2.0", latest: "1.3.0" },
        { name: "pkg-major", current: "2.0.0", latest: "3.0.0" },
      ],
      checkCriticalVulnerabilities: noCritical,
      fetchChangelog: async () => undefined,
    });

    expect(created).toHaveLength(2);
    expect(created.map((c) => c.type).sort()).toEqual(["dep-research", "dep-update"]);
    expect(created.every((c) => c.listName === BACKLOG_LIST_NAME)).toBe(true);

    const updateCall = calls.find((c) => c.labels?.includes("OpenRoutines: Update"));
    const researchCall = calls.find((c) => c.labels?.includes("OpenRoutines: Pesquisa"));
    expect(updateCall?.description).toContain("pkg-minor");
    expect(researchCall?.description).toContain("pkg-major");
    expect(updateCall?.labels).toContain(AUTO_PROPOSED_LABEL);
  });
});

// --- AC 3: CVE critical -> Backlog + alert; with AUTO_QUEUE_SECURITY_PATCHES=true -> queued directly ---

describe("proposeWeeklyCards — CVE wave (AC: critical severity)", () => {
  it("without the opt-in flag: card lands in Backlog and the Telegram alert always fires", async () => {
    const registry = makeRegistry({ acme: makeRepoConfig({ clonePath: "/repos/acme" }) });
    const { createCard } = makeFakeCreateCard();
    const alerts: string[] = [];

    const created = await proposeWeeklyCards({
      registry,
      createCard,
      findExistingFingerprints: makeFakeDedupe().findExistingFingerprints,
      checkOutdated: noOutdated,
      checkCriticalVulnerabilities: async () => [{ name: "lodash", advisory: "GHSA-1" }],
      sendAlert: async (text) => {
        alerts.push(text);
      },
      autoQueueSecurityPatches: false,
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ type: "cve", listName: BACKLOG_LIST_NAME });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("lodash");
  });

  it("with AUTO_QUEUE_SECURITY_PATCHES=true: card is queued directly, bypassing Backlog", async () => {
    const registry = makeRegistry({ acme: makeRepoConfig({ clonePath: "/repos/acme" }) });
    const { createCard } = makeFakeCreateCard();

    const created = await proposeWeeklyCards({
      registry,
      createCard,
      findExistingFingerprints: makeFakeDedupe().findExistingFingerprints,
      checkOutdated: noOutdated,
      checkCriticalVulnerabilities: async () => [{ name: "lodash", advisory: "GHSA-1" }],
      sendAlert: async () => {},
      autoQueueSecurityPatches: true,
    });

    expect(created).toHaveLength(1);
    expect(created[0].listName).toBe(QUEUE_LIST_NAME);
  });

  it("a critical CVE card bypasses an exhausted weekly cap; a debt card does not", async () => {
    const registry = makeRegistry({ acme: makeRepoConfig({ clonePath: "/repos/acme" }) });
    const { createCard } = makeFakeCreateCard();
    const rows: ExecutionSignalRow[] = [
      { repo: "acme", metadata: { stateMachineContext: { outputs: { bloqueado: { blockReason: "verify-falhou" } } } } },
      { repo: "acme", metadata: { stateMachineContext: { outputs: { bloqueado: { blockReason: "verify-falhou" } } } } },
    ];

    const created = await proposeWeeklyCards({
      registry,
      createCard,
      findExistingFingerprints: makeFakeDedupe().findExistingFingerprints,
      fetchExecutionRows: async () => rows,
      checkOutdated: noOutdated,
      checkCriticalVulnerabilities: async () => [{ name: "lodash", advisory: "GHSA-1" }],
      sendAlert: async () => {},
      maxWeeklyCards: 0,
    });

    expect(created).toHaveLength(1);
    expect(created[0].type).toBe("cve");
  });
});

// --- Weekly cap resolved from policy.yaml (D32, closes #164 pt7 / #168 knob consumption) ---

describe("proposeWeeklyCards — weekly cap from policy.yaml (D32)", () => {
  it("with deps.maxWeeklyCards absent, the cap is read from this repo's real policy.yaml (day.max_auto_proposed_cards_per_week=3): 4 qualifying repos yield only 3 cards", async () => {
    const registry = makeRegistry({
      "repo-1": makeRepoConfig({ clonePath: "/repos/repo-1" }),
      "repo-2": makeRepoConfig({ clonePath: "/repos/repo-2" }),
      "repo-3": makeRepoConfig({ clonePath: "/repos/repo-3" }),
      "repo-4": makeRepoConfig({ clonePath: "/repos/repo-4" }),
    });
    const { createCard } = makeFakeCreateCard();

    const created = await proposeWeeklyCards({
      registry,
      createCard,
      findExistingFingerprints: makeFakeDedupe().findExistingFingerprints,
      // Every repo has exactly 1 qualifying minor/patch update -> 4 independent
      // candidates, none of them capped by MAX_DEBT_CARDS_PER_ROUND (that cap
      // only applies to the debt-aggregation wave) — the ONLY thing that can
      // cut 4 down to 3 here is the weekly cap itself.
      checkOutdated: async () => [{ name: "pkg-a", current: "1.0.0", latest: "1.0.1" }],
      checkCriticalVulnerabilities: noCritical,
      fetchChangelog: async () => undefined,
      // maxWeeklyCards deliberately omitted -> must resolve from policy.yaml
    });

    expect(created).toHaveLength(3);
  });
});

// --- Invariant: no general-debt/dep card ever leaves Backlog by default ---

describe("proposeWeeklyCards — Backlog invariant (D26)", () => {
  it("every card except an opted-in CVE lands in Backlog", async () => {
    const registry = makeRegistry({ acme: makeRepoConfig({ clonePath: "/repos/acme" }) });
    const rows: ExecutionSignalRow[] = [
      { repo: "acme", metadata: { stateMachineContext: { outputs: { bloqueado: { blockReason: "verify-falhou" } } } } },
      { repo: "acme", metadata: { stateMachineContext: { outputs: { bloqueado: { blockReason: "verify-falhou" } } } } },
    ];

    const created = await proposeWeeklyCards({
      registry,
      createCard: makeFakeCreateCard().createCard,
      findExistingFingerprints: makeFakeDedupe().findExistingFingerprints,
      fetchExecutionRows: async () => rows,
      checkOutdated: async () => [{ name: "pkg-minor", current: "1.0.0", latest: "1.0.1" }],
      checkCriticalVulnerabilities: async () => [{ name: "lodash", advisory: "GHSA-1" }],
      fetchChangelog: async () => undefined,
      sendAlert: async () => {},
      // autoQueueSecurityPatches deliberately omitted -> defaults to false
    });

    expect(created.length).toBeGreaterThan(0);
    expect(created.every((c: ProposedCard) => c.listName === BACKLOG_LIST_NAME)).toBe(true);
  });
});

// --- AC 4: sibling propagation only within the same family ---

describe("propagateSiblingFix (AC: same-family propagation)", () => {
  const registry = makeRegistry({
    "repo-a": makeRepoConfig({ clonePath: "/repos/repo-a", family: "whatsapp-agent" }),
    "repo-b": makeRepoConfig({ clonePath: "/repos/repo-b", family: "whatsapp-agent" }),
    "repo-c": makeRepoConfig({ clonePath: "/repos/repo-c", family: "whatsapp-agent" }),
    "repo-d": makeRepoConfig({ clonePath: "/repos/repo-d", family: "dashboard" }),
  });
  const mergedPr: MergedPrInfo = {
    repo: "repo-a",
    title: "Fix XSS in input handler",
    diff: "+++ b/src/sanitize.ts\n+const sanitizeInput = (s: string) => s.replace(/</g, '');\n",
  };

  it("creates exactly 2 cards for the 2 matching siblings, none for the repo in a different family", async () => {
    const { createCard } = makeFakeCreateCard();
    const exec = vi.fn().mockResolvedValue({ stdout: "src/sanitize.ts:3:matched", stderr: "" });
    const judgedRepos: string[] = [];
    const judgeSameProblem = vi.fn(async ({ repo }: { repo: string }) => {
      judgedRepos.push(repo);
      return { matches: repo === "repo-b" || repo === "repo-c", location: `${repo}/src/sanitize.ts:3` };
    });

    const created = await propagateSiblingFix(
      { registry, createCard, findExistingFingerprints: makeFakeDedupe().findExistingFingerprints, judgeSameProblem, exec },
      mergedPr
    );

    expect(created).toHaveLength(2);
    expect(created.map((c) => c.repo).sort()).toEqual(["repo-b", "repo-c"]);
    expect(created.every((c) => c.listName === BACKLOG_LIST_NAME && c.type === "sibling-fix")).toBe(true);
    // repo-d is a different family — never even asked.
    expect(judgedRepos).not.toContain("repo-d");
    expect(judgeSameProblem).toHaveBeenCalledTimes(2);
  });

  it("a repo declaring no family propagates to nothing", async () => {
    const registryNoFamily = makeRegistry({
      "repo-a": makeRepoConfig({ clonePath: "/repos/repo-a" }),
      "repo-b": makeRepoConfig({ clonePath: "/repos/repo-b", family: "whatsapp-agent" }),
    });
    const created = await propagateSiblingFix(
      {
        registry: registryNoFamily,
        createCard: makeFakeCreateCard().createCard,
        findExistingFingerprints: makeFakeDedupe().findExistingFingerprints,
        judgeSameProblem: async () => ({ matches: true }),
      },
      mergedPr
    );
    expect(created).toEqual([]);
  });

  it("rerunning over the same merged PR does not duplicate sibling cards", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "src/sanitize.ts:3:matched", stderr: "" });
    const first = makeFakeCreateCard();
    const firstRun = await propagateSiblingFix(
      {
        registry,
        createCard: first.createCard,
        findExistingFingerprints: makeFakeDedupe().findExistingFingerprints,
        judgeSameProblem: async ({ repo }) => ({ matches: repo === "repo-b", location: "src/sanitize.ts:3" }),
        exec,
      },
      mergedPr
    );
    expect(firstRun).toHaveLength(1);

    const second = makeFakeCreateCard();
    const secondRun = await propagateSiblingFix(
      {
        registry,
        createCard: second.createCard,
        findExistingFingerprints: makeFakeDedupe(new Set([firstRun[0].fingerprint])).findExistingFingerprints,
        judgeSameProblem: async ({ repo }) => ({ matches: repo === "repo-b", location: "src/sanitize.ts:3" }),
        exec,
      },
      mergedPr
    );
    expect(secondRun).toHaveLength(0);
  });
});

// --- makeFindExistingFingerprints (real Trello raw-fetch default) ---

describe("makeFindExistingFingerprints", () => {
  const jsonResponse = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  it("scans only the configured lists and matches fingerprints by substring in desc", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, [
          { id: "list-backlog", name: "Backlog" },
          { id: "list-fila", name: "OpenRoutines — Fila" },
          { id: "list-review", name: "Review" }, // not a dedupe-scanned list
        ])
      )
      .mockResolvedValueOnce(jsonResponse(200, [{ desc: "...<!-- openroutines:fingerprint:abc123 -->" }]))
      .mockResolvedValueOnce(jsonResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);

    const find = makeFindExistingFingerprints({ apiKey: "k", apiToken: "t", boardId: "board-1", listNames: ["Backlog", "OpenRoutines — Fila"] });
    const result = await find(["abc123", "def456"]);

    expect(result).toEqual(new Set(["abc123"]));
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 list resolution + 2 card fetches (Review skipped)
  });

  it("returns an empty set without any network call when given no fingerprints", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const find = makeFindExistingFingerprints({ apiKey: "k", apiToken: "t", boardId: "board-1" });
    expect(await find([])).toEqual(new Set());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
