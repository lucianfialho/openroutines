import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { runPesquisaJudgment } from "./judgment.js";
import { OPUS_MODEL, type ResearchDeps } from "./index.js";
import type { CompletionRequest, CompletionResponse } from "../../provider/types.js";

const resp = (content: string, model: string): CompletionResponse => ({
  content,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  model,
  finishReason: "stop",
});

const aprovado = { verdict: "aprovado", corrections: [], securityOpinion: { exposesNewSurface: false, notes: "ok" } };
const escalate = {
  verdict: "escalate",
  corrections: ["decisão ambígua"],
  securityOpinion: { exposesNewSurface: true, notes: "nova superfície de webhook" },
  escalateReason: "decisão de arquitetura sem precedente",
};

const baseDeps = (makeCliProvider: ResearchDeps["makeCliProvider"]): ResearchDeps => ({
  registry: { repos: {} },
  githubToken: "gh",
  worktreeBase: "/tmp",
  taskSourceFor: () => undefined,
  makeCliProvider,
});

describe("card-research judgment (composite judge)", () => {
  it("Opus's escalate verdict stays final — no handoff (Opus is the apex)", async () => {
    const calls: Array<{ model: string; prompt: string }> = [];
    const deps = baseDeps((cfg) => ({
      complete: (req: CompletionRequest) => {
        const prompt = req.messages![req.messages!.length - 1].content;
        calls.push({ model: cfg.model, prompt });
        return Effect.succeed(resp(JSON.stringify(escalate), OPUS_MODEL));
      },
    }));

    const verdict = await runPesquisaJudgment(deps, "BASE_PROMPT");

    // exactly ONE call — Opus is the apex, no escalation
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(OPUS_MODEL);
    // Opus's verdict is returned as-is, "escalate" included (informational only)
    expect(verdict.verdict).toBe("escalate");
  });

  it("aprovado makes exactly ONE call and keeps securityOpinion (criterion 5)", async () => {
    const models: string[] = [];
    const deps = baseDeps((cfg) => ({
      complete: () => {
        models.push(cfg.model);
        return Effect.succeed(resp(JSON.stringify(aprovado), OPUS_MODEL));
      },
    }));

    const verdict = await runPesquisaJudgment(deps, "P");
    expect(models).toEqual([OPUS_MODEL]); // only Opus
    expect(verdict.verdict).toBe("aprovado");
    expect(verdict.securityOpinion).toEqual({ exposesNewSurface: false, notes: "ok" });
  });

  it("rejects a verdict missing securityOpinion (schema requires it even when aprovado)", async () => {
    const deps = baseDeps(() => ({
      complete: () => Effect.succeed(resp(JSON.stringify({ verdict: "aprovado", corrections: [] }), OPUS_MODEL)),
    }));
    await expect(runPesquisaJudgment(deps, "P")).rejects.toBeTruthy();
  });

  it("rejects a downgraded model answering for Opus (anti-bypass)", async () => {
    const deps = baseDeps(() => ({
      complete: () => Effect.succeed(resp(JSON.stringify(aprovado), "claude-haiku-4")),
    }));
    await expect(runPesquisaJudgment(deps, "P")).rejects.toThrow(/model mismatch/);
  });

  it("accepts a versioned model alias for Opus (M1: <model>-YYYYMMDD)", async () => {
    const deps = baseDeps(() => ({
      complete: () => Effect.succeed(resp(JSON.stringify(aprovado), `${OPUS_MODEL}-20260101`)),
    }));
    const verdict = await runPesquisaJudgment(deps, "P");
    expect(verdict.verdict).toBe("aprovado");
  });
});
