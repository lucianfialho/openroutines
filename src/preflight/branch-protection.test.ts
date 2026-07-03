import { describe, it, expect, vi } from "vitest";
import { checkBranchProtection } from "./branch-protection.js";
import { run } from "../../scripts/check-branch-protection.js";

const fetchReturning = (status: number, body: unknown = {}) =>
  vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;

describe("checkBranchProtection", () => {
  it("AC1: 200 with required_pull_request_reviews in the body -> protected:true", async () => {
    const fetchImpl = fetchReturning(200, { required_pull_request_reviews: { required_approving_review_count: 1 } });

    const result = await checkBranchProtection({ token: "ghp_test", fetchImpl }, "acme", "widgets");

    expect(result).toEqual({ protected: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/widgets/branches/main/protection",
      expect.objectContaining({
        headers: { Authorization: "Bearer ghp_test", Accept: "application/vnd.github+json" },
      })
    );
  });

  it("fails closed when fetch rejects (network/DNS/timeout) — never true on a thrown error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch;

    const result = await checkBranchProtection({ token: "t", fetchImpl }, "acme", "widgets");

    expect(result.protected).toBe(false);
    expect(result.reason).toContain("falha ao consultar");
  });

  it("fails closed when the response body is malformed JSON (res.json throws)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    }) as unknown as typeof fetch;

    const result = await checkBranchProtection({ token: "t", fetchImpl }, "acme", "widgets");

    expect(result.protected).toBe(false);
  });

  it("AC2: 404 -> protected:false with a reason mentioning missing branch protection", async () => {
    const fetchImpl = fetchReturning(404);

    const result = await checkBranchProtection({ token: "ghp_test", fetchImpl }, "acme", "widgets");

    expect(result.protected).toBe(false);
    expect(result.reason).toContain("sem branch protection");
  });

  it("AC3: 500 -> protected:false, never true on error", async () => {
    const fetchImpl = fetchReturning(500);

    const result = await checkBranchProtection({ token: "ghp_test", fetchImpl }, "acme", "widgets");

    expect(result.protected).toBe(false);
  });

  it("AC4: 200 without required_pull_request_reviews (partial protection) -> protected:false", async () => {
    const fetchImpl = fetchReturning(200, { allow_force_pushes: { enabled: false } });

    const result = await checkBranchProtection({ token: "ghp_test", fetchImpl }, "acme", "widgets");

    expect(result).toEqual({ protected: false, reason: "protection ativa mas sem required_pull_request_reviews" });
  });

  it("defaults to the main branch when none is given", async () => {
    const fetchImpl = fetchReturning(200, { required_pull_request_reviews: {} });

    await checkBranchProtection({ token: "t", fetchImpl }, "acme", "widgets");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/widgets/branches/main/protection",
      expect.anything()
    );
  });
});

describe("check-branch-protection script (AC5)", () => {
  it("exits 0 and reports protected:true for a protected repo", async () => {
    const fetchImpl = fetchReturning(200, { required_pull_request_reviews: {} });

    const { result, exitCode } = await run(["acme/widgets"], { token: "ghp_test", fetchImpl });

    expect(result).toEqual({ protected: true });
    expect(exitCode).toBe(0);
  });

  it("exits 1 and reports protected:false for an unprotected repo", async () => {
    const fetchImpl = fetchReturning(404);

    const { result, exitCode } = await run(["acme/widgets"], { token: "ghp_test", fetchImpl });

    expect(result.protected).toBe(false);
    expect(exitCode).toBe(1);
  });

  it("rejects when owner/repo isn't given, before touching fetch", async () => {
    const fetchImpl = fetchReturning(200, { required_pull_request_reviews: {} });

    await expect(run([], { token: "ghp_test", fetchImpl })).rejects.toThrow(/Usage/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects when GITHUB_TOKEN is missing, before touching fetch", async () => {
    const fetchImpl = fetchReturning(200, { required_pull_request_reviews: {} });

    await expect(run(["acme/widgets"], { token: undefined, fetchImpl })).rejects.toThrow(/GITHUB_TOKEN/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
