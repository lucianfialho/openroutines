import { describe, it, expect } from "vitest";
import { validate, ValidationError } from "./schema-validate.js";

describe("validate", () => {
  it("accepts a whole number against type:number (integer is a valid number)", () => {
    // Regression: an LLM emitting estimatedLoc: 42 against {type:'number'} must not fail.
    expect(() => validate({ estimatedLoc: 42 }, {
      type: "object",
      properties: { estimatedLoc: { type: "number" } },
    })).not.toThrow();
  });

  it("accepts a float against type:number", () => {
    expect(() => validate(3.14, { type: "number" })).not.toThrow();
  });

  it("still accepts an integer against type:integer", () => {
    expect(() => validate(7, { type: "integer" })).not.toThrow();
  });

  it("rejects a float against type:integer", () => {
    expect(() => validate(3.14, { type: "integer" })).toThrow(ValidationError);
  });

  it("rejects a string against type:number", () => {
    expect(() => validate("42", { type: "number" })).toThrow(ValidationError);
  });

  it("enforces required fields and enum membership", () => {
    expect(() => validate({}, { type: "object", required: ["a"], properties: { a: { type: "string" } } })).toThrow(/Missing required/);
    expect(() => validate("z", { enum: ["x", "y"] })).toThrow(/must be one of/);
  });
});
