import { describe, it, expect } from "vitest";
import { pickEnv, BASE_ENV_VARS } from "./env.js";

describe("pickEnv", () => {
  it("copies only the named vars that are actually set", () => {
    process.env.__OR_TEST_A = "a";
    delete process.env.__OR_TEST_MISSING;
    try {
      expect(pickEnv(["__OR_TEST_A", "__OR_TEST_MISSING"])).toEqual({ __OR_TEST_A: "a" });
    } finally {
      delete process.env.__OR_TEST_A;
    }
  });

  it("excludes anything not named (no secret leak)", () => {
    process.env.__OR_SECRET = "shh";
    try {
      const env = pickEnv([...BASE_ENV_VARS]);
      expect(env.__OR_SECRET).toBeUndefined();
      expect(env.PATH).toBeDefined();
    } finally {
      delete process.env.__OR_SECRET;
    }
  });
});
