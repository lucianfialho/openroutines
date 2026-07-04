import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isSecurityBlockReason, sendTelegramAlert } from "./telegram.js";

describe("isSecurityBlockReason", () => {
  it("matches the 'seguranca' prefix, not exact equality", () => {
    expect(isSecurityBlockReason("seguranca")).toBe(true);
    expect(isSecurityBlockReason("seguranca-divergente")).toBe(true);
    expect(isSecurityBlockReason("seguranca-outra-coisa")).toBe(true);
  });

  it("returns false for every other blockReason and for undefined", () => {
    expect(isSecurityBlockReason("verify-falhou")).toBe(false);
    expect(isSecurityBlockReason("plano-refutado-2x")).toBe(false);
    expect(isSecurityBlockReason("retrabalho-esgotado")).toBe(false);
    expect(isSecurityBlockReason(undefined)).toBe(false);
  });
});

describe("sendTelegramAlert", () => {
  const jsonResponse = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "bot123:ABC";
    process.env.TELEGRAM_CHAT_ID = "999";
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    vi.unstubAllGlobals();
  });

  it("posts exactly once to the Bot API sendMessage endpoint with chat_id/text in the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await sendTelegramAlert("⛔ card bloqueado");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botbot123:ABC/sendMessage");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: "999", text: "⛔ card bloqueado" });
  });

  it("does not throw, does not call fetch, and just warns when TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are missing", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(sendTelegramAlert("test")).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("never throws when the Bot API responds non-ok — logs and returns", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { description: "Unauthorized" })));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendTelegramAlert("test")).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("never throws when fetch itself rejects (network failure) — logs and returns", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendTelegramAlert("test")).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
