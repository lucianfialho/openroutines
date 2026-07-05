import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { makeBlocked } from "./blocked.js";
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
    worktreeBase: "/tmp/or-blocked-test-worktrees",
    ledger: makeInMemoryActionLedgerRepository(),
    prLinks: makeInMemoryPrLinkRepository(),
    taskSourceFor: () => taskSource,
    sendAlert,
  };
  return { deps, moveTo, comment, sendAlert };
};

describe("makeBlocked", () => {
  it("AC3: reads blockReason from outputs.preparation.blockReason, moves the card to blocked and comments the mapped detail", async () => {
    const { deps, moveTo, comment } = makeDeps();
    const outputs = { preparation: { branchProtected: false, blockReason: "no-branch-protection" } };

    const r = await makeBlocked(deps)({ inputs, outputs, executionId: "exec1", stateId: "blocked" });

    expect(r).toEqual({ blocked: true, blockReason: "no-branch-protection" });
    expect(moveTo).toHaveBeenCalledTimes(1);
    expect(moveTo).toHaveBeenCalledWith("card1", "blocked");
    expect(comment).toHaveBeenCalledTimes(1);
    const [cardId, body] = comment.mock.calls[0] as [string, string];
    expect(cardId).toBe("card1");
    expect(body).toContain("⛔ [Bloqueio]");
    expect(body).toContain("Motivo: no-branch-protection");
    expect(body).toContain(
      "O que falta: a branch principal do repositório não tem branch protection (required_pull_request_reviews) configurada"
    );
    expect(body).toContain("Próximo passo: configurar branch protection no GitHub e mover o card de volta para a Fila");
  });

  it("AC3: falls back to outputs.verify.blockReason when preparation carries none, mapping 'verify-failed' detail", async () => {
    const { deps, moveTo, comment } = makeDeps();
    const outputs = {
      preparation: { branchProtected: true },
      verify: { passed: false, blockReason: "verify-failed" },
    };

    const r = await makeBlocked(deps)({ inputs, outputs, executionId: "exec1", stateId: "blocked" });

    expect(r).toEqual({ blocked: true, blockReason: "verify-failed" });
    expect(moveTo).toHaveBeenCalledWith("card1", "blocked");
    const body = comment.mock.calls[0][1] as string;
    expect(body).toContain("Motivo: verify-failed");
    expect(body).toContain(
      "O que falta: o verify continua falhando após a tentativa de retry (mesma falha nas duas rodadas)"
    );
    expect(body).toContain("Próximo passo: revisar os logs de verify, ajustar a implementação manualmente e reabrir o card");
  });

  it("F4 #153: derives blockReason 'security' from a reproved outputs.review.securityVerdict", async () => {
    const { deps } = makeDeps();
    const outputs = { preparation: { branchProtected: true }, review: { approved: false, gaps: [], securityVerdict: { approved: false, findings: [], criticalArea: false } } };

    const r = await makeBlocked(deps)({ inputs, outputs, executionId: "exec1", stateId: "blocked" });

    expect(r).toEqual({ blocked: true, blockReason: "security" });
  });

  it("F4 #153: an approved (or absent) securityVerdict never derives a security blockReason", async () => {
    const { deps } = makeDeps();
    const outputs = {
      preparation: { branchProtected: true },
      review: { approved: true, gaps: [], securityVerdict: { approved: true, findings: [], criticalArea: false } },
    };

    const r = await makeBlocked(deps)({ inputs, outputs, executionId: "exec1", stateId: "blocked" });

    expect(r).toEqual({ blocked: true, blockReason: "desconhecido" });
  });

  it("F4 #185: derives blockReason 'plan-refuted-2x' from outputs.gate_plan.exhausted", async () => {
    const { deps } = makeDeps();
    const outputs = { preparation: { branchProtected: true }, gate_plan: { verdict: "refutado", exhausted: true } };

    const r = await makeBlocked(deps)({ inputs, outputs, executionId: "exec1", stateId: "blocked" });

    expect(r).toEqual({ blocked: true, blockReason: "plan-refuted-2x" });
  });

  it("F4 #185: a non-exhausted gate_plan output never derives a blockReason from it", async () => {
    const { deps } = makeDeps();
    const outputs = { preparation: { branchProtected: true }, gate_plan: { verdict: "refutado" } };

    const r = await makeBlocked(deps)({ inputs, outputs, executionId: "exec1", stateId: "blocked" });

    expect(r).toEqual({ blocked: true, blockReason: "desconhecido" });
  });

  it("H3/#186: review.exhausted with a remaining security gap derives 'security-exhausted'", async () => {
    const { deps } = makeDeps();
    const outputs = {
      preparation: { branchProtected: true },
      review: {
        approved: false,
        gaps: [{ lens: "security", description: "achado ainda aberto", contestable: true }],
        securityVerdict: null,
        exhausted: true,
      },
    };

    const r = await makeBlocked(deps)({ inputs, outputs, executionId: "exec1", stateId: "blocked" });

    expect(r).toEqual({ blocked: true, blockReason: "security-exhausted" });
  });

  it("H3/#186: review.exhausted with no remaining security gap derives 'review-exhausted'", async () => {
    const { deps } = makeDeps();
    const outputs = {
      preparation: { branchProtected: true },
      review: {
        approved: false,
        gaps: [{ lens: "correctness", description: "gap não resolvido", contestable: true }],
        securityVerdict: null,
        exhausted: true,
      },
    };

    const r = await makeBlocked(deps)({ inputs, outputs, executionId: "exec1", stateId: "blocked" });

    expect(r).toEqual({ blocked: true, blockReason: "review-exhausted" });
  });

  it("H3/#186: a non-exhausted review output never derives a blockReason from it", async () => {
    const { deps } = makeDeps();
    const outputs = {
      preparation: { branchProtected: true },
      review: {
        approved: false,
        gaps: [{ lens: "security", description: "achado", contestable: true }],
        securityVerdict: null,
      },
    };

    const r = await makeBlocked(deps)({ inputs, outputs, executionId: "exec1", stateId: "blocked" });

    expect(r).toEqual({ blocked: true, blockReason: "desconhecido" });
  });

  it("H3/#186: 'security-exhausted' starts with 'security' — fires the Telegram alert like the other security reasons", async () => {
    const { deps, sendAlert } = makeDeps();
    const securityInputs = { source_id: "trello-main", task_id: "card1", title: "T", repo: "r" };
    const outputs = {
      preparation: { branchProtected: true },
      review: {
        approved: false,
        gaps: [{ lens: "security", description: "achado", contestable: true }],
        securityVerdict: null,
        exhausted: true,
      },
    };

    await makeBlocked(deps)({ inputs: securityInputs, outputs, executionId: "exec1", stateId: "blocked" });

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert.mock.calls[0][0]).toContain("blockReason=security-exhausted");
  });

  it("F4 #185: preparation/verify/security blockReason still win over gate_plan.exhausted (order preserved)", async () => {
    const { deps } = makeDeps();
    const outputs = {
      preparation: { branchProtected: true },
      verify: { passed: false, blockReason: "verify-failed" },
      gate_plan: { verdict: "refutado", exhausted: true },
    };

    const r = await makeBlocked(deps)({ inputs, outputs, executionId: "exec1", stateId: "blocked" });

    expect(r).toEqual({ blocked: true, blockReason: "verify-failed" });
  });

  it("AC3: defaults blockReason to 'desconhecido' (unmapped detail) when neither preparation nor verify carry one", async () => {
    const { deps, comment } = makeDeps();

    const r = await makeBlocked(deps)({ inputs, outputs: {}, executionId: "exec1", stateId: "blocked" });

    expect(r).toEqual({ blocked: true, blockReason: "desconhecido" });
    const body = comment.mock.calls[0][1] as string;
    expect(body).toContain("Motivo: desconhecido");
    expect(body).toContain("O que falta: motivo não mapeado");
    expect(body).toContain("Próximo passo: revisar a execução manualmente");
  });

  it("AC3: idempotent — a second call for the same executionId short-circuits on the action_ledger and never re-fires moveTo/comment", async () => {
    const { deps, moveTo, comment } = makeDeps();
    const outputs = { preparation: { branchProtected: false, blockReason: "no-branch-protection" } };
    const handler = makeBlocked(deps);

    const r1 = await handler({ inputs, outputs, executionId: "exec1", stateId: "blocked" });
    const r2 = await handler({ inputs, outputs, executionId: "exec1", stateId: "blocked" });

    expect(r1).toEqual(r2);
    expect(moveTo).toHaveBeenCalledTimes(1);
    expect(comment).toHaveBeenCalledTimes(1);
  });

  describe("D22/F4 #186: Telegram alert on blockReason: security*", () => {
    const securityInputs = { source_id: "trello-main", task_id: "card1", title: "Vazamento de segredo", repo: "acme-widgets" };

    it("fires sendTelegramAlert once with source_id/task_id/blockReason/title/repo when blockReason is 'security'", async () => {
      const { deps, sendAlert } = makeDeps();
      const outputs = { preparation: { branchProtected: true, blockReason: "security" } };

      const r = await makeBlocked(deps)({ inputs: securityInputs, outputs, executionId: "exec1", stateId: "blocked" });

      expect(r).toEqual({ blocked: true, blockReason: "security" });
      expect(sendAlert).toHaveBeenCalledTimes(1);
      const [text] = sendAlert.mock.calls[0] as [string];
      expect(text).toContain("trello-main/card1");
      expect(text).toContain("blockReason=security");
      expect(text).toContain("Vazamento de segredo");
      expect(text).toContain("acme-widgets");
    });

    it("negative: does NOT call sendTelegramAlert when blockReason is 'verify-failed'", async () => {
      const { deps, sendAlert } = makeDeps();
      const outputs = { verify: { passed: false, blockReason: "verify-failed" } };

      await makeBlocked(deps)({ inputs: securityInputs, outputs, executionId: "exec1", stateId: "blocked" });

      expect(sendAlert).not.toHaveBeenCalled();
    });

    it("idempotent: re-running for the same executionId (post-crash resume) sends the alert only once", async () => {
      const { deps, sendAlert } = makeDeps();
      const outputs = { preparation: { branchProtected: true, blockReason: "security" } };
      const handler = makeBlocked(deps);

      await handler({ inputs: securityInputs, outputs, executionId: "exec1", stateId: "blocked" });
      await handler({ inputs: securityInputs, outputs, executionId: "exec1", stateId: "blocked" });

      expect(sendAlert).toHaveBeenCalledTimes(1);
    });
  });

  describe("M3/D24: rework-exhausted cap on pr_links", () => {
    const reworkInputs = { ...inputs, rework: true, branch: "openroutines/card1" };
    const outputs = { verify: { passed: false, blockReason: "verify-failed" } };

    it("a blocked reached via the rework flow (ctx.inputs.rework===true) marks the pr_link reviewState:'rework-exhausted'", async () => {
      const { deps } = makeDeps();
      await deps.prLinks.create({
        sourceId: "trello-main",
        taskId: "card1",
        repo: "acme-widgets",
        branch: "openroutines/card1",
        status: "open",
        reviewState: "changes_requested",
      });

      await makeBlocked(deps)({ inputs: reworkInputs, outputs, executionId: "exec1", stateId: "blocked" });

      const [link] = await deps.prLinks.findByTask("trello-main", "card1");
      expect(link.reviewState).toBe("rework-exhausted");
    });

    it("a normal (non-rework) blocked never touches pr_links", async () => {
      const { deps } = makeDeps();
      await deps.prLinks.create({
        sourceId: "trello-main",
        taskId: "card1",
        repo: "acme-widgets",
        branch: "openroutines/card1",
        status: "open",
        reviewState: "changes_requested",
      });

      await makeBlocked(deps)({ inputs, outputs, executionId: "exec1", stateId: "blocked" });

      const [link] = await deps.prLinks.findByTask("trello-main", "card1");
      expect(link.reviewState).toBe("changes_requested");
    });

    it("idempotent: re-running for the same executionId keeps the terminal reviewState (no crash, no double-effect)", async () => {
      const { deps } = makeDeps();
      await deps.prLinks.create({
        sourceId: "trello-main",
        taskId: "card1",
        repo: "acme-widgets",
        branch: "openroutines/card1",
        status: "open",
        reviewState: "changes_requested",
      });
      const handler = makeBlocked(deps);

      await handler({ inputs: reworkInputs, outputs, executionId: "exec1", stateId: "blocked" });
      await handler({ inputs: reworkInputs, outputs, executionId: "exec1", stateId: "blocked" });

      const [link] = await deps.prLinks.findByTask("trello-main", "card1");
      expect(link.reviewState).toBe("rework-exhausted");
    });
  });
});
