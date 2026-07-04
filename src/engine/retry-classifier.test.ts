/**
 * F4 #159: retry taxonomy classification, stall signatures, tier ladder.
 */
import { describe, it, expect } from "vitest";
import {
  classifyFailure,
  failureSignature,
  isSameFailureSignature,
  nextTier,
} from "./retry-classifier.js";

describe("classifyFailure", () => {
  it("schema validation failure is 'format'", () => {
    expect(classifyFailure({ schemaValidationFailed: true })).toBe("format");
    // format wins even when the message also looks transient
    expect(classifyFailure({ schemaValidationFailed: true, message: "429" })).toBe("format");
  });

  it("throttling/network statuses and messages are 'transient'", () => {
    expect(classifyFailure({ httpStatus: 429 })).toBe("transient");
    expect(classifyFailure({ httpStatus: 529 })).toBe("transient");
    expect(classifyFailure({ httpStatus: 503 })).toBe("transient");
    expect(classifyFailure({ message: "LLM error: request timed out" })).toBe("transient");
    expect(classifyFailure({ message: "fetch failed: ECONNRESET" })).toBe("transient");
    expect(classifyFailure({ message: "HTTP 429 too many requests" })).toBe("transient");
    expect(classifyFailure({ message: "api overloaded, retry later" })).toBe("transient");
  });

  it("everything else defaults to 'logic'", () => {
    expect(classifyFailure({})).toBe("logic");
    expect(classifyFailure({ httpStatus: 401 })).toBe("logic");
    expect(classifyFailure({ message: "verify failed: 3 new test failures" })).toBe("logic");
  });
});

describe("failureSignature / isSameFailureSignature", () => {
  it("is deterministic and distinguishes check and message", () => {
    const a = failureSignature({ checkName: "test", message: "assert x" });
    expect(a).toBe(failureSignature({ checkName: "test", message: "assert x" }));
    expect(a).not.toBe(failureSignature({ checkName: "build", message: "assert x" }));
    expect(a).not.toBe(failureSignature({ checkName: "test", message: "assert y" }));
  });

  it("never matches undefined or empty signatures", () => {
    expect(isSameFailureSignature(undefined, "abc")).toBe(false);
    expect(isSameFailureSignature("abc", undefined)).toBe(false);
    expect(isSameFailureSignature(undefined, undefined)).toBe(false);
    expect(isSameFailureSignature("", "")).toBe(false);
    expect(isSameFailureSignature("abc", "abc")).toBe(true);
  });
});

describe("nextTier", () => {
  it("climbs kimi → sonnet → opus → null", () => {
    expect(nextTier("kimi")).toBe("sonnet");
    expect(nextTier("sonnet")).toBe("opus");
    expect(nextTier("opus")).toBeNull();
  });
});
