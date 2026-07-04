import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseFalsePositives, matchFalsePositive } from "./fp-file.js";

const FP_DOC = `# Falsos-positivos de segurança — exemplo

Prosa explicando o formato — deve ser ignorada pelo parser | mesmo com pipes.

| Padrão (arquivo/regra) | Justificativa | Adicionado em |
|---|---|---|
| \`src/webhooks/*.ts\` — "missing rate limit" | Rate limit já aplicado no proxy Tailscale | 2026-03-10 |
| \`scripts/**\` | Scripts internos, sem input externo | 2026-04-01 |
`;

const writeDoc = (content: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "fp-file-"));
  const path = join(dir, "security-fp.md");
  writeFileSync(path, content, "utf-8");
  return path;
};

describe("parseFalsePositives", () => {
  it("returns an empty list when the file is absent (not an error)", () => {
    expect(parseFalsePositives("/nonexistent/dir/security-fp.md")).toEqual([]);
  });

  it("parses table rows, skipping header, separator, and prose", () => {
    const entries = parseFalsePositives(writeDoc(FP_DOC));
    expect(entries).toEqual([
      {
        filePattern: "src/webhooks/*.ts",
        rule: "missing rate limit",
        justification: "Rate limit já aplicado no proxy Tailscale",
        addedOn: "2026-03-10",
      },
      {
        filePattern: "scripts/**",
        justification: "Scripts internos, sem input externo",
        addedOn: "2026-04-01",
      },
    ]);
  });

  it("parses the orchestrator's own living doc (format example ships in-repo)", () => {
    const entries = parseFalsePositives(join(process.cwd(), "docs/openroutines/security-fp.md"));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].filePattern).toBe("src/webhooks/*.ts");
    expect(entries[0].rule).toBe("missing rate limit");
  });
});

describe("matchFalsePositive", () => {
  const entries = parseFalsePositives(writeDoc(FP_DOC));

  it("matches glob + rule fragment (case-insensitive) against the finding text", () => {
    const hit = matchFalsePositive(entries, "src/webhooks/stripe.ts", "Missing Rate Limit on webhook endpoint");
    expect(hit?.filePattern).toBe("src/webhooks/*.ts");
  });

  it("does not match when the rule fragment is absent from the finding text", () => {
    expect(matchFalsePositive(entries, "src/webhooks/stripe.ts", "SQL injection via query param")).toBeUndefined();
  });

  it("does not match a file outside the glob (single * stays within a segment)", () => {
    expect(matchFalsePositive(entries, "src/webhooks/nested/deep.ts", "missing rate limit")).toBeUndefined();
  });

  it("matches any depth with ** and no rule constraint", () => {
    const hit = matchFalsePositive(entries, "scripts/supply-chain/npm", "anything at all");
    expect(hit?.filePattern).toBe("scripts/**");
  });
});
