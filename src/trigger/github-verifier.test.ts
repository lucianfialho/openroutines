import { describe, it, expect } from "vitest";
import { verifySignature } from "./github-verifier.js";
import { createHmac } from "crypto";

const makeSignature = (secret: string, payload: string): string => {
  const hash = createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${hash}`;
};

describe("verifySignature", () => {
  const secret = "my-webhook-secret";
  const payload = '{"action":"opened"}';

  it("should return true for valid signature", () => {
    const signature = makeSignature(secret, payload);
    expect(verifySignature(secret, payload, signature)).toBe(true);
  });

  it("should return false for wrong secret", () => {
    const signature = makeSignature("wrong-secret", payload);
    expect(verifySignature(secret, payload, signature)).toBe(false);
  });

  it("should return false for tampered payload", () => {
    const signature = makeSignature(secret, payload);
    expect(verifySignature(secret, '{"action":"closed"}', signature)).toBe(false);
  });

  it("should return false for missing prefix", () => {
    const hash = createHmac("sha256", secret).update(payload).digest("hex");
    expect(verifySignature(secret, payload, hash)).toBe(false);
  });

  it("should return false for empty signature", () => {
    expect(verifySignature(secret, payload, "")).toBe(false);
  });

  it("should return false for signature with wrong length", () => {
    expect(verifySignature(secret, payload, "sha256=abc")).toBe(false);
  });
});
