import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { makeVisualCapture, type VisualCaptureOutput } from "./visual-capture.js";
import type { MappingDeps } from "./index.js";
import type { ProviderAdapter } from "../../provider/registry.js";
import type { ComposeHandle } from "../../orchestrator/compose-lifecycle.js";
import type { CompletionResponse } from "../../provider/types.js";

const resp = (content: string): CompletionResponse => ({
  content,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  model: "kimi",
  finishReason: "stop",
});

const prep = { worktree: { path: "/wt", branch: "b" }, repo: { slug: "acme" }, baseSha: "s" };
const ctx = (scan: unknown) => ({
  inputs: { title: "t", description: "d", source_id: "s", task_id: "c" },
  outputs: { preparation: prep, scan },
  executionId: "exec1",
  stateId: "visual_capture",
});

describe("card-mapping visual_capture (#162)", () => {
  it("criterion 2: boots compose, captures >=1 shot per golden route + README, tears down", async () => {
    const events: string[] = [];
    const agentJson = JSON.stringify({
      screenshots: ["docs/visual/01-login.png", "docs/visual/02-pedidos.png"],
      readmeWritten: true,
    });
    const agentProvider: ProviderAdapter = {
      complete: (req) => {
        events.push(`agent:${req.workdir}`);
        return Effect.succeed(resp(agentJson));
      },
    };
    const deps = {
      taskSourceFor: () => undefined,
      visual: {
        agentProvider,
        composeUp: async (): Promise<ComposeHandle> => {
          events.push("up");
          return { baseUrl: "http://127.0.0.1:4000", project: "or-exec1" };
        },
        composeDown: async () => {
          events.push("down");
        },
      },
    } as unknown as MappingDeps;

    const goldenRoutes = ["/login", "/pedidos"];
    const out = (await makeVisualCapture(deps)(ctx({ goldenRoutes }))) as unknown as VisualCaptureOutput;

    expect(out.readmeWritten).toBe(true);
    expect(out.screenshots.length).toBeGreaterThanOrEqual(goldenRoutes.length);
    expect(events).toEqual(["up", "agent:/wt", "down"]);
  });

  it("ALWAYS tears the compose down, even when the agent call throws", async () => {
    const events: string[] = [];
    const agentProvider: ProviderAdapter = {
      complete: () => Effect.fail(new Error("kimi boom")),
    };
    const deps = {
      taskSourceFor: () => undefined,
      visual: {
        agentProvider,
        composeUp: async (): Promise<ComposeHandle> => {
          events.push("up");
          return { baseUrl: "http://127.0.0.1:4000", project: "p" };
        },
        composeDown: async () => {
          events.push("down");
        },
      },
    } as unknown as MappingDeps;

    await expect(makeVisualCapture(deps)(ctx({ goldenRoutes: ["/login"] }))).rejects.toThrow(/boom/);
    expect(events).toEqual(["up", "down"]); // down ran in finally despite the failure
  });

  it("throws when deps.visual is absent (misconfiguration, not a silent skip)", async () => {
    const deps = { taskSourceFor: () => undefined } as unknown as MappingDeps;
    await expect(makeVisualCapture(deps)(ctx({ goldenRoutes: [] }))).rejects.toThrow(/not configured/);
  });
});
