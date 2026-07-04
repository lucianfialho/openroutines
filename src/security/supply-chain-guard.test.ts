import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { ensureIgnoreScripts, supplyChainShimDir, withSupplyChainPath, DEFAULT_ALLOWLIST_PATH } from "./supply-chain-guard.js";

const execFileAsync = promisify(execFile);

describe("supplyChainShimDir", () => {
  it("points at a real directory containing the npm/pnpm/npx guard shims", () => {
    const dir = supplyChainShimDir();
    expect(existsSync(join(dir, "npm"))).toBe(true);
    expect(existsSync(join(dir, "pnpm"))).toBe(true);
    expect(existsSync(join(dir, "npx"))).toBe(true);
  });

  it("prefixed onto PATH makes `command -v npm` resolve to the shim, not any real system npm (acceptance criterion)", async () => {
    const dir = supplyChainShimDir();
    const nodeDir = dirname(process.execPath);
    const { stdout } = await execFileAsync("/bin/sh", ["-c", "command -v npm"], {
      env: { PATH: `${dir}:${nodeDir}:/usr/bin:/bin` },
    });
    expect(stdout.trim()).toBe(join(dir, "npm"));
  });
});

describe("DEFAULT_ALLOWLIST_PATH", () => {
  it("resolves to the real config file declaring allow_lifecycle_scripts", () => {
    expect(existsSync(DEFAULT_ALLOWLIST_PATH)).toBe(true);
    expect(readFileSync(DEFAULT_ALLOWLIST_PATH, "utf-8")).toContain("allow_lifecycle_scripts");
  });
});

describe("withSupplyChainPath", () => {
  it("prefixes the shim dir onto an existing PATH and leaves other vars untouched", () => {
    const env = withSupplyChainPath({ PATH: "/usr/bin:/bin", HOME: "/home/x" });
    expect(env.PATH).toBe(`${supplyChainShimDir()}:/usr/bin:/bin`);
    expect(env.HOME).toBe("/home/x");
  });

  it("sets PATH to just the shim dir when no PATH was present on the input env", () => {
    const env = withSupplyChainPath({ HOME: "/home/x" });
    expect(env.PATH).toBe(supplyChainShimDir());
  });
});

describe("ensureIgnoreScripts", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), "or-supply-chain-guard-"));
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  it("creates .npmrc with ignore-scripts=true when none exists yet", () => {
    ensureIgnoreScripts({ worktree });
    expect(readFileSync(join(worktree, ".npmrc"), "utf-8")).toBe("ignore-scripts=true\n");
  });

  it("merges into a pre-existing .npmrc, preserving its other lines (acceptance criterion)", () => {
    writeFileSync(join(worktree, ".npmrc"), "registry=https://registry.example.com/\nsave-exact=true\n");

    ensureIgnoreScripts({ worktree });

    const content = readFileSync(join(worktree, ".npmrc"), "utf-8");
    expect(content).toContain("registry=https://registry.example.com/");
    expect(content).toContain("save-exact=true");
    expect(content).toContain("ignore-scripts=true");
  });

  it("rewrites an existing ignore-scripts=false line to true instead of duplicating it", () => {
    writeFileSync(join(worktree, ".npmrc"), "ignore-scripts=false\nregistry=https://registry.example.com/\n");

    ensureIgnoreScripts({ worktree });

    const lines = readFileSync(join(worktree, ".npmrc"), "utf-8").trim().split("\n");
    expect(lines.filter((l) => l.startsWith("ignore-scripts"))).toEqual(["ignore-scripts=true"]);
    expect(lines).toContain("registry=https://registry.example.com/");
  });

  it("is idempotent: a second call leaves the file byte-for-byte the same", () => {
    ensureIgnoreScripts({ worktree });
    const first = readFileSync(join(worktree, ".npmrc"), "utf-8");

    ensureIgnoreScripts({ worktree });
    const second = readFileSync(join(worktree, ".npmrc"), "utf-8");

    expect(second).toBe(first);
  });

  it("creates the worktree directory itself when it doesn't exist yet", () => {
    const freshPath = join(worktree, "not-yet-created");

    ensureIgnoreScripts({ worktree: freshPath });

    expect(readFileSync(join(freshPath, ".npmrc"), "utf-8")).toBe("ignore-scripts=true\n");
  });
});

// Shim behavior (scripts/supply-chain/{npm,pnpm,npx}) via execFile, per the
// issue's explicit test guidance: inspect stdout/exit code, cover both
// branches (blocked/allowed) with a fake checker script on the test's PATH.
// The real npm/npq/socket binaries are never invoked — fully hermetic, no
// network, no real install.
describe("scripts/supply-chain shims", () => {
  const shimDir = supplyChainShimDir();
  let worktree: string;
  let fakeBinDir: string;
  let fakeCheckerDir: string;
  let npmLog: string;
  let testPath: string;

  const writeExecutable = (path: string, script: string): void => {
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  };

  const runShim = (
    tool: "npm" | "pnpm" | "npx",
    args: string[],
    envOverrides: Record<string, string> = {}
  ): Promise<{ code: number; stdout: string; stderr: string }> =>
    execFileAsync(join(shimDir, tool), args, { cwd: worktree, env: { PATH: testPath, ...envOverrides } }).then(
      (r) => ({ code: 0, ...r }),
      (err: { code?: number; stdout?: string; stderr?: string }) => ({
        code: err.code ?? 1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
      })
    );

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), "or-shim-worktree-"));
    fakeBinDir = mkdtempSync(join(tmpdir(), "or-shim-fakebin-"));
    fakeCheckerDir = mkdtempSync(join(tmpdir(), "or-shim-fakechecker-"));
    npmLog = join(worktree, "fake-real-bin.log");

    // Fake "real" npm/pnpm/npx: records its argv and never touches disk
    // otherwise, so a blocked install leaves genuinely nothing behind.
    const fakeRealBin = `#!/usr/bin/env bash\necho "FAKE_REAL_BIN_CALLED $*"\necho "$*" >> "${npmLog}"\nexit 0\n`;
    for (const tool of ["npm", "pnpm", "npx"]) writeExecutable(join(fakeBinDir, tool), fakeRealBin);

    // Fake checker (stands in for npq/socket): flags any package whose spec
    // contains "evil", passes everything else. Deterministic, no network.
    writeExecutable(
      join(fakeCheckerDir, "npq"),
      `#!/usr/bin/env bash\necho "FAKE_CHECKER_CALLED $*"\nfor a in "$@"; do case "$a" in *evil*) exit 1 ;; esac; done\nexit 0\n`
    );
    writeExecutable(
      join(fakeCheckerDir, "socket"),
      `#!/usr/bin/env bash\necho "FAKE_SOCKET_CALLED $*"\nexit 0\n`
    );

    writeFileSync(join(worktree, "package.json"), JSON.stringify({ name: "fixture", dependencies: { lodash: "^4.17.21" } }, null, 2));

    const nodeDir = dirname(process.execPath);
    testPath = `${fakeBinDir}:${fakeCheckerDir}:${nodeDir}:/usr/bin:/bin`;
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(fakeCheckerDir, { recursive: true, force: true });
  });

  it("aborts and never invokes the real binary when the checker flags an unknown package (acceptance criterion)", async () => {
    const packageJsonBefore = readFileSync(join(worktree, "package.json"), "utf-8");

    const result = await runShim("npm", ["install", "evil-pkg"]);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("FAKE_CHECKER_CALLED evil-pkg");
    expect(result.stdout).toContain("BLOCKED");
    expect(result.stdout).not.toContain("FAKE_REAL_BIN_CALLED");
    expect(existsSync(npmLog)).toBe(false); // the real binary's own log was never written
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
    expect(readFileSync(join(worktree, "package.json"), "utf-8")).toBe(packageJsonBefore);
  });

  it("delegates with --ignore-scripts when the checker passes an unknown package (acceptance criterion)", async () => {
    const result = await runShim("npm", ["install", "good-new-pkg"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("FAKE_CHECKER_CALLED good-new-pkg");
    expect(readFileSync(npmLog, "utf-8").trim()).toBe("install good-new-pkg --ignore-scripts");
  });

  it("never runs the checker for a package already declared in package.json", async () => {
    const result = await runShim("npm", ["install", "lodash"]);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("FAKE_CHECKER_CALLED");
    expect(readFileSync(npmLog, "utf-8").trim()).toBe("install lodash --ignore-scripts");
  });

  it("never runs the checker for a bare install/ci naming no new package (acceptance criterion)", async () => {
    const result = await runShim("npm", ["ci"]);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("FAKE_CHECKER_CALLED");
    expect(readFileSync(npmLog, "utf-8").trim()).toBe("ci --ignore-scripts");
  });

  it("passes through non-install subcommands untouched (no checker, no injected flag)", async () => {
    const result = await runShim("npm", ["run", "build"]);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("FAKE_CHECKER_CALLED");
    expect(readFileSync(npmLog, "utf-8").trim()).toBe("run build");
  });

  it("skips --ignore-scripts (passes =false) for a package on an overridden lifecycle-scripts allowlist", async () => {
    const allowlistPath = join(worktree, "custom-allowlist.yaml");
    writeFileSync(allowlistPath, "allow_lifecycle_scripts: [allowed-thing]\n");

    const result = await runShim("npm", ["install", "allowed-thing"], { SUPPLY_CHAIN_ALLOWLIST_PATH: allowlistPath });

    expect(result.code).toBe(0);
    expect(readFileSync(npmLog, "utf-8").trim()).toBe("install allowed-thing --ignore-scripts=false");
  });

  it("resolves the allowlist from the real config/supply-chain-allowlist.yaml by default (prisma)", async () => {
    const result = await runShim("npm", ["install", "prisma"]);

    expect(result.code).toBe(0);
    expect(readFileSync(npmLog, "utf-8").trim()).toBe("install prisma --ignore-scripts=false");
  });

  it("selects the checker binary via SUPPLY_CHAIN_GUARD", async () => {
    const result = await runShim("npm", ["install", "good-new-pkg"], { SUPPLY_CHAIN_GUARD: "socket" });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("FAKE_SOCKET_CALLED good-new-pkg");
  });

  it("fails closed when the configured checker binary isn't on PATH at all", async () => {
    const result = await runShim("npm", ["install", "good-new-pkg"], { SUPPLY_CHAIN_GUARD: "no-such-checker" });

    expect(result.code).not.toBe(0);
    expect(existsSync(npmLog)).toBe(false);
  });

  it("does not recurse into itself when its own directory is also on PATH ahead of the real binary", async () => {
    const result = await runShim("npm", ["install", "lodash"], { PATH: `${shimDir}:${testPath}` });

    expect(result.code).toBe(0);
    expect(readFileSync(npmLog, "utf-8").trim()).toBe("install lodash --ignore-scripts");
  });

  it("pnpm shim shares the same guard logic", async () => {
    const result = await runShim("pnpm", ["install", "lodash"]);

    expect(result.code).toBe(0);
    expect(readFileSync(npmLog, "utf-8").trim()).toBe("install lodash --ignore-scripts");
  });

  it("npx shim checks its ad-hoc target package the same way", async () => {
    const result = await runShim("npx", ["cowsay", "hello"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("FAKE_CHECKER_CALLED cowsay");
    expect(readFileSync(npmLog, "utf-8").trim()).toBe("--ignore-scripts cowsay hello");
  });
});
