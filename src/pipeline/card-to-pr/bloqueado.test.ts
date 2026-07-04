import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { makeBloqueado } from "./bloqueado.js";
import type { CardToPrDeps } from "./index.js";
import { makeInMemoryActionLedgerRepository } from "../../persistence/action-ledger-in-memory.js";
import { makeInMemoryPrLinkRepository } from "../../persistence/pr-links-in-memory.js";
import type { TaskSource } from "../../task-source/types.js";

const inputs = { source_id: "trello-main", task_id: "card1" };

const makeDeps = (): {
  deps: CardToPrDeps;
  moveTo: ReturnType<typeof vi.fn>;
  comment: ReturnType<typeof vi.fn>;
  sendAlert: ReturnType<typeof vi.fn>;
} => {
  const moveTo = vi.fn(() => Effect.succeed(undefined));
  const comment = vi.fn(() => Effect.succeed(undefined));
  const sendAlert = vi.fn(async () => {});
  const taskSource = { moveTo, comment } as unknown as TaskSource;
  const deps: CardToPrDeps = {
    registry: { repos: {} },
    githubToken: "gh_test",
    worktreeBase: "/tmp/or-bloqueado-test-worktrees",
    ledger: makeInMemoryActionLedgerRepository(),
    prLinks: makeInMemoryPrLinkRepository(),
    taskSourceFor: () => taskSource,
    sendAlert,
  };
  return { deps, moveTo, comment, sendAlert };
};

describe("makeBloqueado", () => {
  it("AC3: reads blockReason from outputs.preparacao.blockReason, moves the card to blocked and comments the mapped detail", async () => {
    const { deps, moveTo, comment } = makeDeps();
    const outputs = { preparacao: { branchProtected: false, blockReason: "sem-branch-protection" } };

    const r = await makeBloqueado(deps)({ inputs, outputs, executionId: "exec1", stateId: "bloqueado" });

    expect(r).toEqual({ blocked: true, blockReason: "sem-branch-protection" });
    expect(moveTo).toHaveBeenCalledTimes(1);
    expect(moveTo).toHaveBeenCalledWith("card1", "blocked");
    expect(comment).toHaveBeenCalledTimes(1);
    const [cardId, body] = comment.mock.calls[0] as [string, string];
    expect(cardId).toBe("card1");
    expect(body).toContain("⛔ [Bloqueio]");
    expect(body).toContain("Motivo: sem-branch-protection");
    expect(body).toContain(
      "O que falta: a branch principal do repositório não tem branch protection (required_pull_request_reviews) configurada"
    );
    expect(body).toContain("Próximo passo: configurar branch protection no GitHub e mover o card de volta para a Fila");
  });

  it("AC3: falls back to outputs.verify.blockReason when preparacao carries none, mapping 'verify-falhou' detail", async () => {
    const { deps, moveTo, comment } = makeDeps();
    const outputs = {
      preparacao: { branchProtected: true },
      verify: { passed: false, blockReason: "verify-falhou" },
    };

    const r = await makeBloqueado(deps)({ inputs, outputs, executionId: "exec1", stateId: "bloqueado" });

    expect(r).toEqual({ blocked: true, blockReason: "verify-falhou" });
    expect(moveTo).toHaveBeenCalledWith("card1", "blocked");
    const body = comment.mock.calls[0][1] as string;
    expect(body).toContain("Motivo: verify-falhou");
    expect(body).toContain(
      "O que falta: o verify continua falhando após a tentativa de retry (mesma falha nas duas rodadas)"
    );
    expect(body).toContain("Próximo passo: revisar os logs de verify, ajustar a implementação manualmente e reabrir o card");
  });

  it("F4 #153: derives blockReason 'seguranca' from a reproved outputs.revisao.securityVerdict", async () => {
    const { deps } = makeDeps();
    const outputs = { preparacao: { branchProtected: true }, revisao: { approved: false, gaps: [], securityVerdict: { approved: false, findings: [], criticalArea: false } } };

    const r = await makeBloqueado(deps)({ inputs, outputs, executionId: "exec1", stateId: "bloqueado" });

    expect(r).toEqual({ blocked: true, blockReason: "seguranca" });
  });

  it("F4 #153: derives blockReason 'seguranca-divergente' when securityVerdict.secondJudge.diverged is true", async () => {
    const { deps } = makeDeps();
    const outputs = {
      preparacao: { branchProtected: true },
      revisao: {
        approved: false,
        gaps: [],
        securityVerdict: { approved: false, findings: [], criticalArea: true, secondJudge: { diverged: true } },
      },
    };

    const r = await makeBloqueado(deps)({ inputs, outputs, executionId: "exec1", stateId: "bloqueado" });

    expect(r).toEqual({ blocked: true, blockReason: "seguranca-divergente" });
  });

  it("F4 #153: an approved (or absent) securityVerdict never derives a security blockReason", async () => {
    const { deps } = makeDeps();
    const outputs = {
      preparacao: { branchProtected: true },
      revisao: { approved: true, gaps: [], securityVerdict: { approved: true, findings: [], criticalArea: false } },
    };

    const r = await makeBloqueado(deps)({ inputs, outputs, executionId: "exec1", stateId: "bloqueado" });

    expect(r).toEqual({ blocked: true, blockReason: "desconhecido" });
  });

  it("F4 #185: derives blockReason 'plano-refutado-2x' from outputs.gate_plano.exhausted", async () => {
    const { deps } = makeDeps();
    const outputs = { preparacao: { branchProtected: true }, gate_plano: { verdict: "refutado", exhausted: true } };

    const r = await makeBloqueado(deps)({ inputs, outputs, executionId: "exec1", stateId: "bloqueado" });

    expect(r).toEqual({ blocked: true, blockReason: "plano-refutado-2x" });
  });

  it("F4 #185: a non-exhausted gate_plano output never derives a blockReason from it", async () => {
    const { deps } = makeDeps();
    const outputs = { preparacao: { branchProtected: true }, gate_plano: { verdict: "refutado" } };

    const r = await makeBloqueado(deps)({ inputs, outputs, executionId: "exec1", stateId: "bloqueado" });

    expect(r).toEqual({ blocked: true, blockReason: "desconhecido" });
  });

  it("F4 #185: preparacao/verify/security blockReason still win over gate_plano.exhausted (order preserved)", async () => {
    const { deps } = makeDeps();
    const outputs = {
      preparacao: { branchProtected: true },
      verify: { passed: false, blockReason: "verify-falhou" },
      gate_plano: { verdict: "refutado", exhausted: true },
    };

    const r = await makeBloqueado(deps)({ inputs, outputs, executionId: "exec1", stateId: "bloqueado" });

    expect(r).toEqual({ blocked: true, blockReason: "verify-falhou" });
  });

  it("AC3: defaults blockReason to 'desconhecido' (unmapped detail) when neither preparacao nor verify carry one", async () => {
    const { deps, comment } = makeDeps();

    const r = await makeBloqueado(deps)({ inputs, outputs: {}, executionId: "exec1", stateId: "bloqueado" });

    expect(r).toEqual({ blocked: true, blockReason: "desconhecido" });
    const body = comment.mock.calls[0][1] as string;
    expect(body).toContain("Motivo: desconhecido");
    expect(body).toContain("O que falta: motivo não mapeado");
    expect(body).toContain("Próximo passo: revisar a execução manualmente");
  });

  it("AC3: idempotent — a second call for the same executionId short-circuits on the action_ledger and never re-fires moveTo/comment", async () => {
    const { deps, moveTo, comment } = makeDeps();
    const outputs = { preparacao: { branchProtected: false, blockReason: "sem-branch-protection" } };
    const handler = makeBloqueado(deps);

    const r1 = await handler({ inputs, outputs, executionId: "exec1", stateId: "bloqueado" });
    const r2 = await handler({ inputs, outputs, executionId: "exec1", stateId: "bloqueado" });

    expect(r1).toEqual(r2);
    expect(moveTo).toHaveBeenCalledTimes(1);
    expect(comment).toHaveBeenCalledTimes(1);
  });

  describe("D22/F4 #186: Telegram alert on blockReason: seguranca*", () => {
    const securityInputs = { source_id: "trello-main", task_id: "card1", title: "Vazamento de segredo", repo: "acme-widgets" };

    it("fires sendTelegramAlert once with source_id/task_id/blockReason/title/repo when blockReason is 'seguranca'", async () => {
      const { deps, sendAlert } = makeDeps();
      const outputs = { preparacao: { branchProtected: true, blockReason: "seguranca" } };

      const r = await makeBloqueado(deps)({ inputs: securityInputs, outputs, executionId: "exec1", stateId: "bloqueado" });

      expect(r).toEqual({ blocked: true, blockReason: "seguranca" });
      expect(sendAlert).toHaveBeenCalledTimes(1);
      const [text] = sendAlert.mock.calls[0] as [string];
      expect(text).toContain("trello-main/card1");
      expect(text).toContain("blockReason=seguranca");
      expect(text).toContain("Vazamento de segredo");
      expect(text).toContain("acme-widgets");
    });

    it("fires sendTelegramAlert once when blockReason is 'seguranca-divergente'", async () => {
      const { deps, sendAlert } = makeDeps();
      const outputs = { verify: { passed: false, blockReason: "seguranca-divergente" } };

      await makeBloqueado(deps)({ inputs: securityInputs, outputs, executionId: "exec1", stateId: "bloqueado" });

      expect(sendAlert).toHaveBeenCalledTimes(1);
      expect(sendAlert.mock.calls[0][0]).toContain("blockReason=seguranca-divergente");
    });

    it("negative: does NOT call sendTelegramAlert when blockReason is 'verify-falhou'", async () => {
      const { deps, sendAlert } = makeDeps();
      const outputs = { verify: { passed: false, blockReason: "verify-falhou" } };

      await makeBloqueado(deps)({ inputs: securityInputs, outputs, executionId: "exec1", stateId: "bloqueado" });

      expect(sendAlert).not.toHaveBeenCalled();
    });

    it("idempotent: re-running for the same executionId (post-crash resume) sends the alert only once", async () => {
      const { deps, sendAlert } = makeDeps();
      const outputs = { preparacao: { branchProtected: true, blockReason: "seguranca" } };
      const handler = makeBloqueado(deps);

      await handler({ inputs: securityInputs, outputs, executionId: "exec1", stateId: "bloqueado" });
      await handler({ inputs: securityInputs, outputs, executionId: "exec1", stateId: "bloqueado" });

      expect(sendAlert).toHaveBeenCalledTimes(1);
    });
  });
});
