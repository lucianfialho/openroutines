import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import type { CompletionRequest, CompletionResponse } from "./types.js";
import type { ProviderAdapter } from "./registry.js";
import { makeProviderRegistry } from "./registry.js";
import {
  makeArchitectureJudgeProvider,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_SECOND_JUDGE_MODEL,
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

const PLAN_PROMPT = "<card>Add validation</card>\n<plano>{\"summary\":\"...\"}</plano>";

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

describe("architecture-judge — escalate:true (handoff to Fable)", () => {
  it("triggers exactly a 2nd call to Fable with the SAME original request — Fable never sees Opus's verdict", async () => {
    const OPUS_MARKER = "OPUS_ONLY_MARKER_XYZ";
    const calls: RecordedCall[] = [];
    const { run } = makeJudge((c) => {
      if (c.model === DEFAULT_JUDGE_MODEL) {
        return verdict({ verdict: "refutado", escalate: true, corrections: [OPUS_MARKER] });
      }
      return verdict({ verdict: "aprovado" }); // Fable's own answer
    }, calls);
    const out = await run(PLAN_PROMPT);

    expect(calls).toHaveLength(2);
    const fableCall = calls.find((c) => c.model === DEFAULT_SECOND_JUDGE_MODEL);
    expect(fableCall).toBeDefined();
    // Isolation by construction: the 2nd request is the untouched original —
    // Opus's verdict/corrections/marker never appear in it.
    expect(fableCall!.text).not.toContain(OPUS_MARKER);
    expect(fableCall!.text).not.toContain("refutado");
    expect(fableCall!.text).toContain("Add validation");

    // The FINAL response is Fable's, not Opus's.
    expect(out).toEqual({ verdict: "aprovado", corrections: [], escalate: false });
  });

  it("Fable's response is final even when Fable itself sets escalate:true (no further handoff loop)", async () => {
    const calls: RecordedCall[] = [];
    const { run } = makeJudge((c) => {
      if (c.model === DEFAULT_JUDGE_MODEL) return verdict({ escalate: true });
      return verdict({ verdict: "refutado", escalate: true, corrections: ["fable also unsure"] });
    }, calls);
    const out = await run(PLAN_PROMPT);
    expect(calls).toHaveLength(2);
    expect(out).toEqual({ verdict: "refutado", corrections: ["fable also unsure"], escalate: true });
  });
});

describe("architecture-judge — model anti-bypass", () => {
  it("accepts a versioned alias echo of the requested model on both hops (M1)", async () => {
    const calls: RecordedCall[] = [];
    const { run } = makeJudge(
      (c) =>
        c.model === DEFAULT_JUDGE_MODEL
          ? { content: verdict({ escalate: true }), model: "claude-opus-4-8-20260101" }
          : { content: verdict({ verdict: "aprovado" }), model: "claude-fable-5-20260301" },
      calls
    );
    const out = await run(PLAN_PROMPT);
    expect(calls).toHaveLength(2);
    expect(out.verdict).toBe("aprovado");
  });

  it("rejects an Opus response answered by a different (weaker) model", async () => {
    const calls: RecordedCall[] = [];
    const { judge } = makeJudge(() => ({ content: verdict(), model: "claude-haiku-4" }), calls);
    await expect(
      Effect.runPromise(judge.complete({ messages: [{ role: "user", content: PLAN_PROMPT }] }))
    ).rejects.toThrow(/model mismatch/);
  });

  it("rejects a Fable response answered by the wrong model", async () => {
    const calls: RecordedCall[] = [];
    const { judge } = makeJudge(
      (c) =>
        c.model === DEFAULT_JUDGE_MODEL
          ? verdict({ escalate: true })
          : { content: verdict(), model: "claude-sonnet-4-5" },
      calls
    );
    await expect(
      Effect.runPromise(judge.complete({ messages: [{ role: "user", content: PLAN_PROMPT }] }))
    ).rejects.toThrow(/model mismatch/);
  });
});

describe("architecture-judge — output contract", () => {
  it("fails loudly on an unparseable/invalid Opus verdict instead of defaulting escalate to false", async () => {
    const calls: RecordedCall[] = [];
    const { judge } = makeJudge(() => "not json at all {{{", calls);
    await expect(
      Effect.runPromise(judge.complete({ messages: [{ role: "user", content: PLAN_PROMPT }] }))
    ).rejects.toThrow(/invalid opus verdict/);
  });

  it("reports the response's own model (Opus when terminal, Fable when escalated) and sums nothing extra", async () => {
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

  it("fails fast without an apiKey", () => {
    const registry = makeProviderRegistry({ kimiCli: {} });
    expect(() => registry.resolve("architecture-judge")).toThrowError(/architecture-judge.*apiKey|ANTHROPIC_API_KEY/);
  });
});
