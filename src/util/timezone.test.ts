import { describe, it, expect } from "vitest";
import { timezoneWarning, EXPECTED_TZ } from "./timezone.js";

describe("timezoneWarning", () => {
  it("returns null for the expected timezone", () => {
    expect(timezoneWarning(EXPECTED_TZ)).toBeNull();
  });

  it("warns when TZ is unset", () => {
    const w = timezoneWarning(undefined);
    expect(w).toContain("unset");
    expect(w).toContain(EXPECTED_TZ);
  });

  it("warns when TZ is a different zone", () => {
    const w = timezoneWarning("UTC");
    expect(w).toContain("UTC");
    expect(w).toContain(EXPECTED_TZ);
  });
});
