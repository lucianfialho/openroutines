import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import type { CompletionRequest, CompletionResponse } from "./types.js";
import type { ProviderAdapter } from "./registry.js";
import { makeProviderRegistry } from "./registry.js";
import {
  makeArchitectureJudgeProvider,
  DEFAULT_JUDGE_MODEL,
  type ArchitectureVerdict,
} from "./architecture-judge.js";

interface RecordedCall {
  model: string;
  request: CompletionRequest;
  text: string;
}

type Responder = (call: RecordedCall) => string | { content: string; model?: string };

const flatten = (request: CompletionRequest): string =>
  [request.system ?? "", ...(request.messages ?? []).map((m) => m.content), request.prompt ?? ""].join("\n");

/** Builds the makeInnerProvider test seam: records every call, routes to `respond`. */
const mockInner = (respond: Responder, calls: RecordedCall[]) =>
  (config: { apiKey: string; baseURL?: string; model: string }): ProviderAdapter => ({
    complete: (request: CompletionRequest) =>
      Effect.sync((): CompletionResponse => {
        const call: RecordedCall = { model: config.model, request, text: flatten(request) };
        calls.push(call);
        const r = respond(call);
        const content = typeof r === "string" ? r : r.content;
        const model = typeof r === "string" ? config.model : (r.model ?? config.model);
        return {
          content,
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          model,
          finishReason: "stop",
        };
      }),
  });

const verdict = (over: Partial<ArchitectureVerdict> = {}): string =>
  JSON.stringify({ verdict: "aprovado", corrections: [], escalate: false, ...over });

const makeJudge = (respond: Responder, calls: RecordedCall[]) => {
  const judge = makeArchitectureJudgeProvider({
    claudeApi: { apiKey: "sk-test" },
    makeInnerProvider: mockInner(respond, calls),
  });
  const run = (prompt: string): Promise<ArchitectureVerdict> =>
    Effect.runPromise(judge.complete({ messages: [{ role: "user", content: prompt }] })).then(
      (resp) => JSON.parse(resp.content) as ArchitectureVerdict
    );
  return { judge, run };
};

const PLAN_PROMPT = "<card>Add validation</card>\n<plan>{\"summary\":\"...\"}</plan>";

describe("architecture-judge — escalate:false (Opus is terminal)", () => {
  it("makes exactly ONE call, and the final response is Opus's own", async () => {
    const calls: RecordedCall[] = [];
    const { run } = makeJudge(() => verdict({ verdict: "refutado", corrections: ["ajustar X"] }), calls);
    const out = await run(PLAN_PROMPT);

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(DEFAULT_JUDGE_MODEL);
    expect(out).toEqual({ verdict: "refutado", corrections: ["ajustar X"], escalate: false });
  });

  it("an aprovado verdict passes through unchanged", async () => {
    const calls: RecordedCall[] = [];
    const { run } = makeJudge(() => verdict({ verdict: "aprovado" }), calls);
    const out = await run(PLAN_PROMPT);
    expect(out.verdict).toBe("aprovado");
    expect(calls).toHaveLength(1);
  });
});

describe("architecture-judge — model anti-bypass", () => {
  it("accepts a versioned alias echo of the requested model (M1)", async () => {
    const calls: RecordedCall[] = [];
    const { run } = makeJudge(
      () => ({ content: verdict({ verdict: "aprovado" }), model: "claude-opus-4-8-20260101" }),
      calls
    );
    const out = await run(PLAN_PROMPT);
    expect(calls).toHaveLength(1);
    expect(out.verdict).toBe("aprovado");
  });

  it("rejects an Opus response answered by a different (weaker) model", async () => {
    const calls: RecordedCall[] = [];
    const { judge } = makeJudge(() => ({ content: verdict(), model: "claude-haiku-4" }), calls);
    await expect(
      Effect.runPromise(judge.complete({ messages: [{ role: "user", content: PLAN_PROMPT }] }))
    ).rejects.toThrow(/model mismatch/);
  });

});

describe("architecture-judge — output contract", () => {
  it("fails loudly on an unparseable/invalid Opus verdict", async () => {
    const calls: RecordedCall[] = [];
    const { judge } = makeJudge(() => "not json at all {{{", calls);
    await expect(
      Effect.runPromise(judge.complete({ messages: [{ role: "user", content: PLAN_PROMPT }] }))
    ).rejects.toThrow(/invalid opus verdict/);
  });

  it("reports the response's own model (Opus is terminal)", async () => {
    const calls: RecordedCall[] = [];
    const { judge } = makeJudge(() => verdict({ verdict: "aprovado" }), calls);
    const resp = await Effect.runPromise(judge.complete({ messages: [{ role: "user", content: PLAN_PROMPT }] }));
    expect(resp.model).toBe(DEFAULT_JUDGE_MODEL);
  });
});

describe("provider registry — architecture-judge", () => {
  it("resolves architecture-judge when claude-api credentials are configured", () => {
    const registry = makeProviderRegistry({ claudeApi: { apiKey: "sk-test" } });
    const provider = registry.resolve("architecture-judge", "claude-opus-4-8");
    expect(typeof provider.complete).toBe("function");
  });

  it("resolves CLI-first without an apiKey (Bloco 2 — API is opt-in, not required)", () => {
    const registry = makeProviderRegistry({ kimiCli: {}, claudeCli: {} });
    const provider = registry.resolve("architecture-judge");
    expect(typeof provider.complete).toBe("function");
  });
});
