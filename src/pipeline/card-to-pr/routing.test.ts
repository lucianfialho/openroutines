import { describe, it, expect } from "vitest";
import {
  resolveImplementationTier,
  resolveCardToPrProvider,
  resolveEscalatedProvider,
} from "./routing.js";

describe("resolveImplementationTier (D9)", () => {
  it("lowest/low -> kimi", () => {
    expect(resolveImplementationTier({ complexity: "lowest" })).toBe("kimi");
    expect(resolveImplementationTier({ complexity: "low" })).toBe("kimi");
  });

  it("medium/high/not_sure (sem altaImpl) -> sonnet", () => {
    expect(resolveImplementationTier({ complexity: "medium" })).toBe("sonnet");
    expect(resolveImplementationTier({ complexity: "high" })).toBe("sonnet");
    expect(resolveImplementationTier({ complexity: "not_sure" })).toBe("sonnet");
  });

  it("highest -> opus", () => {
    expect(resolveImplementationTier({ complexity: "highest" })).toBe("opus");
  });

  it("altaImpl:true domina a complexidade — mesmo em medium vai pra opus", () => {
    expect(resolveImplementationTier({ complexity: "medium", altaImpl: true })).toBe("opus");
    expect(resolveImplementationTier({ complexity: "lowest", altaImpl: true })).toBe("opus");
  });

  it("altaImpl:false explícito não força opus — comportamento normal por complexidade", () => {
    expect(resolveImplementationTier({ complexity: "lowest", altaImpl: false })).toBe("kimi");
  });

  it("complexidade ausente (card não triado) -> sonnet, nunca kimi", () => {
    expect(resolveImplementationTier({})).toBe("sonnet");
  });
});

describe("resolveCardToPrProvider", () => {
  it("plano é sempre claude-cli/claude-sonnet-5, para qualquer complexity/altaImpl", () => {
    expect(resolveCardToPrProvider("plano", {})).toEqual({ provider: "claude-cli", model: "claude-sonnet-5" });
    expect(resolveCardToPrProvider("plano", { complexity: "highest", altaImpl: true })).toEqual({
      provider: "claude-cli",
      model: "claude-sonnet-5",
    });
  });

  it("gate_plano é sempre architecture-judge/claude-opus-4-8, para qualquer complexity/altaImpl", () => {
    expect(resolveCardToPrProvider("gate_plano", {})).toEqual({
      provider: "architecture-judge",
      model: "claude-opus-4-8",
    });
    expect(resolveCardToPrProvider("gate_plano", { complexity: "lowest" })).toEqual({
      provider: "architecture-judge",
      model: "claude-opus-4-8",
    });
  });

  it("implementacao roteia por tier: kimi/sonnet/opus -> provider+model correspondentes", () => {
    expect(resolveCardToPrProvider("implementacao", { complexity: "low" })).toEqual({
      provider: "kimi-cli",
      model: "kimi-k2.6",
    });
    expect(resolveCardToPrProvider("implementacao", { complexity: "medium" })).toEqual({
      provider: "claude-cli",
      model: "claude-sonnet-5",
    });
    expect(resolveCardToPrProvider("implementacao", { complexity: "highest" })).toEqual({
      provider: "claude-cli",
      model: "claude-opus-4-8",
    });
    expect(resolveCardToPrProvider("implementacao", { complexity: "low", altaImpl: true })).toEqual({
      provider: "claude-cli",
      model: "claude-opus-4-8",
    });
  });

  it("rework (F4 #157, D24) roteia pelo tier ORIGINAL do card — idêntico à implementacao para as mesmas entradas", () => {
    for (const input of [
      { complexity: "low" as const },
      { complexity: "medium" as const },
      { complexity: "highest" as const },
      { complexity: "low" as const, altaImpl: true },
      {},
    ]) {
      expect(resolveCardToPrProvider("rework", input)).toEqual(resolveCardToPrProvider("implementacao", input));
    }
  });
});

describe("resolveEscalatedProvider (F4 #159 ladder over D9 tiers)", () => {
  it("kimi escala pra sonnet", () => {
    expect(resolveEscalatedProvider("kimi")).toEqual({ provider: "claude-cli", model: "claude-sonnet-5" });
  });

  it("sonnet escala pra opus", () => {
    expect(resolveEscalatedProvider("sonnet")).toEqual({ provider: "claude-cli", model: "claude-opus-4-8" });
  });

  it("opus já está no teto — sem escalada (undefined)", () => {
    expect(resolveEscalatedProvider("opus")).toBeUndefined();
  });
});
