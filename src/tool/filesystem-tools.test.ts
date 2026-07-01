import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeFilesystemTools } from "./filesystem-tools.js";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("filesystem-tools", () => {
  const tools = makeFilesystemTools();
  const editFile = tools.find((t) => t.definition.name === "edit_file")!;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "openroutines-fs-"));
    writeFileSync(
      join(tempDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "ESNext",
          target: "ES2022",
        },
        include: ["*.ts"],
      }),
      "utf-8"
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reverts TypeScript edits that break type checking", async () => {
    const validFile = join(tempDir, "valid.ts");
    writeFileSync(
      validFile,
      "export const foo = (): string => { return 'hello'; };\n",
      "utf-8"
    );

    const result = await editFile.handler({
      path: validFile,
      cwd: tempDir,
      operations: [
        {
          type: "replace",
          search: "string",
          content: "number",
        },
      ],
    });

    const parsed = JSON.parse(result);
    expect(parsed.edited).toBe(false);
    expect(parsed.error).toContain("TypeScript check failed");
    expect(readFileSync(validFile, "utf-8")).toContain("string");
  });

  it("keeps TypeScript edits that pass type checking", async () => {
    const file = join(tempDir, "ok.ts");
    writeFileSync(
      file,
      "export const foo = (): string => { return 'hello'; };\n",
      "utf-8"
    );

    const result = await editFile.handler({
      path: file,
      cwd: tempDir,
      operations: [
        {
          type: "replace",
          search: "hello",
          content: "world",
        },
      ],
    });

    const parsed = JSON.parse(result);
    expect(parsed.edited).toBe(true);
    expect(readFileSync(file, "utf-8")).toContain("world");
  });
});
