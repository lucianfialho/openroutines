import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runSast, filterSastAgainstBaseline, emptySastResult, type ExecRunner, type SastResult } from "./sast.js";

type Recorded = { file: string; args: string[] };

/** A fake ExecRunner dispatching by binary name (and, for git, by subcommand),
 * recording every call so tests can assert on exact argv. */
const makeExec = (
  handlers: Partial<
    Record<"git-diff" | "git-show" | "semgrep" | "gitleaks" | "npm", (args: string[]) => { stdout: string; stderr: string }>
  >
): { exec: ExecRunner; calls: Recorded[] } => {
  const calls: Recorded[] = [];
  const exec: ExecRunner = async (file, args) => {
    calls.push({ file, args });
    if (file === "git" && args[0] === "diff") return (handlers["git-diff"] ?? (() => ({ stdout: "", stderr: "" })))(args);
    if (file === "git" && args[0] === "show") {
      const h = handlers["git-show"];
      if (!h) throw Object.assign(new Error("fatal: path not in tree"), {});
      return h(args);
    }
    if (file === "semgrep") return (handlers.semgrep ?? (() => ({ stdout: "", stderr: "" })))(args);
    if (file === "gitleaks") return (handlers.gitleaks ?? (() => ({ stdout: "", stderr: "" })))(args);
    if (file === "npm") return (handlers.npm ?? (() => ({ stdout: "", stderr: "" })))(args);
    return { stdout: "", stderr: "" };
  };
  return { exec, calls };
};

const withTempWorktree = (packageJson?: Record<string, unknown>): { dir: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "or-sast-test-"));
  if (packageJson) writeFileSync(join(dir, "package.json"), JSON.stringify(packageJson));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const semgrepJson = (results: unknown[]): string => JSON.stringify({ results });

describe("runSast", () => {
  it("AC1: a diff introducing prisma.$queryRawUnsafe surfaces a prisma-raw-unsafe semgrep finding", async () => {
    const { dir, cleanup } = withTempWorktree();
    try {
      const { exec } = makeExec({
        "git-diff": () => ({ stdout: "src/db.ts\n", stderr: "" }),
        semgrep: () =>
          ({
            stdout: semgrepJson([
              {
                check_id: "prisma-raw-unsafe",
                path: "src/db.ts",
                start: { line: 10 },
                end: { line: 10 },
                extra: { message: "unsafe raw query", severity: "ERROR" },
              },
            ]),
            stderr: "",
          }) as { stdout: string; stderr: string },
      });

      const result = await runSast(dir, "base-sha", { exec });

      expect(result.semgrepFindings).toEqual([
        { ruleId: "prisma-raw-unsafe", file: "src/db.ts", line: 10, endLine: 10, message: "unsafe raw query", severity: "ERROR" },
      ]);
    } finally {
      cleanup();
    }
  });

  it("restricts semgrep findings to files in the diff — a finding outside the diff is dropped", async () => {
    const { dir, cleanup } = withTempWorktree();
    try {
      const { exec } = makeExec({
        "git-diff": () => ({ stdout: "src/in-scope.ts\n", stderr: "" }),
        semgrep: () =>
          ({
            stdout: semgrepJson([
              { check_id: "r1", path: "src/in-scope.ts", start: { line: 1 }, extra: { message: "m", severity: "WARNING" } },
              { check_id: "r2", path: "src/out-of-scope.ts", start: { line: 1 }, extra: { message: "m", severity: "WARNING" } },
            ]),
            stderr: "",
          }) as { stdout: string; stderr: string },
      });

      const result = await runSast(dir, "base-sha", { exec });

      expect(result.semgrepFindings).toHaveLength(1);
      expect(result.semgrepFindings[0].file).toBe("src/in-scope.ts");
    } finally {
      cleanup();
    }
  });

  it("AC2: a planted secret is reported and matchRedacted never carries the raw secret", async () => {
    const { dir, cleanup } = withTempWorktree();
    const SYNTHETIC_SECRET = "sk-test-THIS-IS-A-KNOWN-SYNTHETIC-SECRET-VALUE-12345";
    try {
      const { exec } = makeExec({
        gitleaks: () =>
          ({
            stdout: JSON.stringify([
              {
                File: "src/config.ts",
                StartLine: 4,
                RuleID: "generic-api-key",
                Match: `const key = "${SYNTHETIC_SECRET}"`,
                Secret: SYNTHETIC_SECRET,
              },
            ]),
            stderr: "",
          }) as { stdout: string; stderr: string },
      });

      const result = await runSast(dir, "base-sha", { exec });

      expect(result.secretsFound).toHaveLength(1);
      expect(result.secretsFound[0]).toMatchObject({ file: "src/config.ts", line: 4, ruleId: "generic-api-key" });
      expect(result.secretsFound[0].matchRedacted).not.toContain(SYNTHETIC_SECRET);
      expect(JSON.stringify(result)).not.toContain(SYNTHETIC_SECRET);
    } finally {
      cleanup();
    }
  });

  it("gitleaks call is scoped to the diff's commit range via --log-opts", async () => {
    const { dir, cleanup } = withTempWorktree();
    try {
      const { exec, calls } = makeExec({});
      await runSast(dir, "abc123", { exec });
      const gitleaksCall = calls.find((c) => c.file === "gitleaks")!;
      expect(gitleaksCall.args).toContain("--log-opts");
      expect(gitleaksCall.args[gitleaksCall.args.indexOf("--log-opts") + 1]).toBe("abc123..HEAD");
    } finally {
      cleanup();
    }
  });

  it("AC3: a prod dependency with a high/critical advisory populates dependencyAudit.vulnerable", async () => {
    const { dir, cleanup } = withTempWorktree();
    try {
      const { exec } = makeExec({
        npm: () =>
          ({
            stdout: JSON.stringify({
              vulnerabilities: {
                "left-pad": {
                  name: "left-pad",
                  severity: "critical",
                  range: "<1.3.0",
                  via: [{ url: "https://github.com/advisories/GHSA-xxxx", title: "Prototype pollution" }],
                },
              },
            }),
            stderr: "",
          }) as { stdout: string; stderr: string },
      });

      const result = await runSast(dir, "base-sha", { exec });

      expect(result.dependencyAudit.vulnerable).toEqual([
        { name: "left-pad", version: "<1.3.0", severity: "critical", advisory: "https://github.com/advisories/GHSA-xxxx" },
      ]);
    } finally {
      cleanup();
    }
  });

  it("AC3b: the same CVE on a dev-only dependency never appears (real npm already omits it via --omit=dev)", async () => {
    const { dir, cleanup } = withTempWorktree();
    try {
      // --omit=dev means real npm never puts a dev-only package's vulnerability
      // into the JSON report at all — this fixture simulates exactly that.
      const { exec } = makeExec({ npm: () => ({ stdout: JSON.stringify({ vulnerabilities: {} }), stderr: "" }) });

      const result = await runSast(dir, "base-sha", { exec });

      expect(result.dependencyAudit.vulnerable).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("a low/moderate severity advisory is not reported as vulnerable", async () => {
    const { dir, cleanup } = withTempWorktree();
    try {
      const { exec } = makeExec({
        npm: () =>
          ({
            stdout: JSON.stringify({ vulnerabilities: { foo: { name: "foo", severity: "moderate", range: "<2.0.0" } } }),
            stderr: "",
          }) as { stdout: string; stderr: string },
      });

      const result = await runSast(dir, "base-sha", { exec });

      expect(result.dependencyAudit.vulnerable).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("dependencyAudit.new lists a package added since baseSha (package.json diff)", async () => {
    const { dir, cleanup } = withTempWorktree({ dependencies: { express: "^4.19.0", newpkg: "^1.0.0" } });
    try {
      const { exec } = makeExec({
        "git-show": () => ({ stdout: JSON.stringify({ dependencies: { express: "^4.19.0" } }), stderr: "" }),
      });

      const result = await runSast(dir, "base-sha", { exec });

      expect(result.dependencyAudit.new).toEqual([{ name: "newpkg", version: "^1.0.0" }]);
    } finally {
      cleanup();
    }
  });

  it("AC4/AC5: a missing binary (ENOENT) degrades to a note instead of throwing", async () => {
    const { dir, cleanup } = withTempWorktree();
    try {
      const exec: ExecRunner = async (file) => {
        if (file === "semgrep") throw Object.assign(new Error("spawn semgrep ENOENT"), { code: "ENOENT" });
        return { stdout: "", stderr: "" };
      };

      const result = await runSast(dir, "base-sha", { exec });

      expect(result.semgrepFindings).toEqual([]);
      expect(result.notes.some((n) => n.includes("semgrep"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("a tool crashing with a non-ENOENT error also degrades to a note, never throws", async () => {
    const { dir, cleanup } = withTempWorktree();
    try {
      const exec: ExecRunner = async (file) => {
        if (file === "gitleaks") throw new Error("segfault");
        return { stdout: "", stderr: "" };
      };

      await expect(runSast(dir, "base-sha", { exec })).resolves.toMatchObject({ secretsFound: [] });
    } finally {
      cleanup();
    }
  });

  it("AC6: every tool call is execFile-style argv — a malicious diff filename never reaches any exec call", async () => {
    const { dir, cleanup } = withTempWorktree();
    const MALICIOUS = '"; rm -rf ~ #.ts';
    try {
      const { exec, calls } = makeExec({
        "git-diff": () => ({ stdout: `${MALICIOUS}\n`, stderr: "" }),
        semgrep: () => ({ stdout: semgrepJson([]), stderr: "" }),
      });

      await runSast(dir, "base-sha", { exec });

      for (const call of calls) {
        expect(Array.isArray(call.args)).toBe(true);
        expect(call.args.some((a) => a.includes(MALICIOUS))).toBe(false);
      }
    } finally {
      cleanup();
    }
  });

  describe("full-repo scan (baseSha omitted — used by the nightly baseline capture)", () => {
    it("skips gitleaks --log-opts and keeps every semgrep finding (no diff scope to restrict to)", async () => {
      const { dir, cleanup } = withTempWorktree();
      try {
        const { exec, calls } = makeExec({
          semgrep: () => ({
            stdout: semgrepJson([{ check_id: "r1", path: "anything.ts", start: { line: 1 }, extra: { message: "m", severity: "INFO" } }]),
            stderr: "",
          }),
        });

        const result = await runSast(dir, undefined, { exec });

        const gitleaksCall = calls.find((c) => c.file === "gitleaks")!;
        expect(gitleaksCall.args).not.toContain("--log-opts");
        expect(result.semgrepFindings).toHaveLength(1);
        expect(result.dependencyAudit.new).toEqual([]);
        expect(calls.some((c) => c.file === "git" && c.args[0] === "diff")).toBe(false);
      } finally {
        cleanup();
      }
    });
  });
});

describe("filterSastAgainstBaseline", () => {
  const finding = (overrides: Partial<SastResult["semgrepFindings"][number]> = {}) => ({
    ruleId: "r1",
    file: "a.ts",
    line: 1,
    message: "m",
    severity: "ERROR" as const,
    ...overrides,
  });

  it("AC7: a finding already present in the baseline snapshot is not reported as new", () => {
    const baseline: SastResult = { ...emptySastResult(), semgrepFindings: [finding()] };
    const current: SastResult = { ...emptySastResult(), semgrepFindings: [finding(), finding({ ruleId: "r2" })] };

    const filtered = filterSastAgainstBaseline(current, baseline);

    expect(filtered.semgrepFindings).toEqual([finding({ ruleId: "r2" })]);
  });

  it("filters secretsFound and dependencyAudit.vulnerable against the baseline the same way", () => {
    const secret = { file: "a.ts", line: 1, ruleId: "s1", matchRedacted: "[REDACTED:4chars]" };
    const vuln = { name: "left-pad", version: "<1.3.0", severity: "high" as const, advisory: "GHSA-1" };
    const baseline: SastResult = { ...emptySastResult(), secretsFound: [secret], dependencyAudit: { new: [], vulnerable: [vuln] } };
    const current: SastResult = {
      ...emptySastResult(),
      secretsFound: [secret],
      dependencyAudit: { new: [{ name: "newpkg", version: "1.0.0" }], vulnerable: [vuln] },
    };

    const filtered = filterSastAgainstBaseline(current, baseline);

    expect(filtered.secretsFound).toEqual([]);
    expect(filtered.dependencyAudit.vulnerable).toEqual([]);
    // dependencyAudit.new is "added by this card", never filtered against the baseline.
    expect(filtered.dependencyAudit.new).toEqual([{ name: "newpkg", version: "1.0.0" }]);
  });

  it("treats a missing/old baseline (no sast key) as empty — nothing gets filtered out", () => {
    const current: SastResult = { ...emptySastResult(), semgrepFindings: [finding()] };

    expect(filterSastAgainstBaseline(current, undefined).semgrepFindings).toEqual([finding()]);
    expect(filterSastAgainstBaseline(current, null).semgrepFindings).toEqual([finding()]);
  });
});
