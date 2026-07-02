import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { makeRequireAuth, checkHealth, createApp } from "./app.js";

// ── #187: auth middleware ────────────────────────────────────────────────────

const mockReq = (headers: Record<string, string>) =>
  ({ header: (n: string) => headers[n] }) as any;

const mockRes = () => {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return res;
};

describe("makeRequireAuth", () => {
  const TOKEN = "s3cr3t-token";

  it("401s with no credentials", () => {
    const res = mockRes();
    let nexted = false;
    makeRequireAuth(TOKEN)(mockReq({}), res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("allows a valid bearer token", () => {
    const res = mockRes();
    let nexted = false;
    makeRequireAuth(TOKEN)(mockReq({ Authorization: `Bearer ${TOKEN}` }), res, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it("401s on a wrong bearer token", () => {
    const res = mockRes();
    let nexted = false;
    makeRequireAuth(TOKEN)(mockReq({ Authorization: "Bearer wrong" }), res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("allows a non-empty Tailscale identity header", () => {
    const res = mockRes();
    let nexted = false;
    makeRequireAuth(undefined)(mockReq({ "Tailscale-User-Login": "op@example.com" }), res, () => { nexted = true; });
    expect(nexted).toBe(true);
  });

  it("401s when no token is configured and no Tailscale header (fail closed)", () => {
    const res = mockRes();
    let nexted = false;
    makeRequireAuth(undefined)(mockReq({ Authorization: "Bearer anything" }), res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});

// ── #131: detailed health ────────────────────────────────────────────────────

describe("checkHealth", () => {
  it("reports in-memory when no probes are provided", async () => {
    const { checks, healthy } = await checkHealth({ cronOk: true });
    expect(checks).toEqual({ postgres: "in-memory", redis: "in-memory", cron: "ok" });
    expect(healthy).toBe(true);
  });

  it("reports ok when probes resolve", async () => {
    const { checks, healthy } = await checkHealth({
      pg: async () => undefined,
      redis: async () => undefined,
      cronOk: true,
    });
    expect(checks).toEqual({ postgres: "ok", redis: "ok", cron: "ok" });
    expect(healthy).toBe(true);
  });

  it("marks postgres error and degrades when the pg probe rejects", async () => {
    const { checks, healthy } = await checkHealth({
      pg: async () => { throw new Error("down"); },
      redis: async () => undefined,
      cronOk: true,
    });
    expect(checks.postgres).toBe("error");
    expect(healthy).toBe(false);
  });

  it("marks redis error and degrades when the redis probe rejects", async () => {
    const { checks, healthy } = await checkHealth({
      redis: async () => { throw new Error("down"); },
      cronOk: true,
    });
    expect(checks.redis).toBe("error");
    expect(healthy).toBe(false);
  });

  it("degrades when cron is not ok", async () => {
    const { healthy, checks } = await checkHealth({ cronOk: false });
    expect(checks.cron).toBe("error");
    expect(healthy).toBe(false);
  });
});

// ── #189: legacy tools gated off by default ─────────────────────────────────

describe("createApp — legacy tool gating", () => {
  const created: Array<{ stop: () => void }> = [];
  afterEach(() => {
    for (const c of created) c.stop();
    created.length = 0;
    delete process.env.OPENROUTINES_LEGACY_TOOLS;
  });

  const emptyConfig = () => {
    const dir = mkdtempSync(join(tmpdir(), "or-app-"));
    return { dir, config: { routinesDir: dir, skillsDir: dir, port: 0 } };
  };

  it("does NOT register run_shell without OPENROUTINES_LEGACY_TOOLS", async () => {
    const { dir, config } = emptyConfig();
    try {
      const app = await createApp(config);
      created.push(app.cronScheduler);
      expect(app.toolRegistry.has("run_shell")).toBe(false);
      expect(app.toolRegistry.has("git_create_worktree")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers run_shell when OPENROUTINES_LEGACY_TOOLS=1", async () => {
    process.env.OPENROUTINES_LEGACY_TOOLS = "1";
    const { dir, config } = emptyConfig();
    try {
      const app = await createApp(config);
      created.push(app.cronScheduler);
      expect(app.toolRegistry.has("run_shell")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
