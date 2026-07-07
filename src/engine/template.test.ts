import { describe, it, expect } from "vitest";
import { renderTemplate } from "./template.js";

describe("renderTemplate", () => {
  it("interpolates scalar inputs/outputs as plain strings", () => {
    const out = renderTemplate("t={{inputs.title}} p={{outputs.verify.passed}} n={{outputs.verify.count}}", {
      inputs: { title: "Fix login" },
      outputs: { verify: { passed: true, count: 3 } },
    });
    expect(out).toBe("t=Fix login p=true n=3");
  });

  it("renders objects and arrays as JSON so downstream parsers can consume them (H1)", () => {
    const verify = { changedFiles: ["src/auth/login.ts"], dataChanges: false };
    const out = renderTemplate("<verify>\n{{outputs.verify}}\n</verify>", {
      inputs: {},
      outputs: { verify },
    });
    const body = out.replace("<verify>", "").replace("</verify>", "").trim();
    expect(JSON.parse(body)).toEqual(verify);
  });

  it("renders an array of gap objects as parseable JSON", () => {
    const gaps = [{ lens: "security", description: "SSRF", file: "src/a.ts", line: 3, contestable: true }];
    const out = renderTemplate("{{outputs.review.gaps}}", { inputs: {}, outputs: { review: { gaps } } });
    expect(JSON.parse(out)).toEqual(gaps);
  });

  it("renders an absent output path as empty string, not a literal token (round-1: refutation not yet produced)", () => {
    const out = renderTemplate("a{{outputs.refutation}}b", { inputs: {}, outputs: {} });
    expect(out).toBe("ab");
  });

  it("output_path falls back to the default", () => {
    expect(renderTemplate("{{output_path}}", { inputs: {}, outputs: {} })).toBe(".gates/outputs/output.yaml");
  });
});
