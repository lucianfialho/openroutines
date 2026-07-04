import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { runPesquisaJudgment } from "./julgamento.js";
import { OPUS_MODEL, FABLE_MODEL, type PesquisaDeps } from "./index.js";
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

const baseDeps = (makeApiProvider: PesquisaDeps["makeApiProvider"]): PesquisaDeps => ({
  registry: { repos: {} },
  githubToken: "gh",
  worktreeBase: "/tmp",
  taskSourceFor: () => undefined,
  claudeApiKey: "sk",
  makeApiProvider,
});

describe("card-pesquisa julgamento (composite judge)", () => {
  it("escalate triggers ONE second Fable call that SEES the Opus parecer (criterion 3)", async () => {
    const calls: Array<{ model: string; prompt: string }> = [];
    const deps = baseDeps((cfg) => ({
      complete: (req: CompletionRequest) => {
        const prompt = req.messages![req.messages!.length - 1].content;
        calls.push({ model: cfg.model, prompt });
        return Effect.succeed(
          cfg.model === OPUS_MODEL
            ? resp(JSON.stringify(escalate), OPUS_MODEL)
            : resp(JSON.stringify(aprovado), FABLE_MODEL)
        );
      },
    }));

    const verdict = await runPesquisaJudgment(deps, "BASE_PROMPT_OPUS_MARKER");

    // exactly two distinct calls, Opus then Fable
    expect(calls).toHaveLength(2);
    expect(calls[0].model).toBe(OPUS_MODEL);
    expect(calls[1].model).toBe(FABLE_MODEL);
    // the 2nd (Fable) prompt carries the base prompt AND the verbatim Opus parecer
    expect(calls[1].prompt).toContain("BASE_PROMPT_OPUS_MARKER");
    expect(calls[1].prompt).toContain("PARECER DO JUIZ PRIMÁRIO (Opus 4.8)");
    expect(calls[1].prompt).toContain("decisão de arquitetura sem precedente"); // a field from the Opus escalate verdict
    // Fable's verdict is the final one
    expect(verdict.verdict).toBe("aprovado");
  });

  it("aprovado without escalate makes exactly ONE call and keeps securityOpinion (criterion 5)", async () => {
    const models: string[] = [];
    const deps = baseDeps((cfg) => ({
      complete: () => {
        models.push(cfg.model);
        return Effect.succeed(resp(JSON.stringify(aprovado), OPUS_MODEL));
      },
    }));

    const verdict = await runPesquisaJudgment(deps, "P");
    expect(models).toEqual([OPUS_MODEL]); // Fable is never called
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

  it("rejects a Fable escalation answered by the wrong model (anti-bypass on the 2nd hop too)", async () => {
    const deps = baseDeps((cfg) => ({
      complete: () =>
        Effect.succeed(
          cfg.model === OPUS_MODEL
            ? resp(JSON.stringify(escalate), OPUS_MODEL)
            : resp(JSON.stringify(aprovado), "claude-sonnet-5") // Fable slot answered by Sonnet
        ),
    }));
    await expect(runPesquisaJudgment(deps, "P")).rejects.toThrow(/model mismatch/);
  });
});
