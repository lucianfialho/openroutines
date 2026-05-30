import { Effect } from "effect";
import { exec } from "child_process";
import type { CompletionRequest, CompletionResponse } from "./types.js";

export interface KimiCliConfig {
  model?: string;
}

export const makeKimiCliProvider = (config: KimiCliConfig) => {
  const model = config.model ?? "kimi-latest";

  const complete = (request: CompletionRequest): Effect.Effect<CompletionResponse, Error> =>
    Effect.tryPromise({
      try: async () => {
        const promptText = request.messages
          ?.map((m) => {
            if (m.role === "tool") return `[tool result: ${m.content}]`;
            if (m.role === "assistant" && m.toolCalls)
              return `[assistant tools: ${m.toolCalls.map((t) => t.name).join(", ")}]`;
            return `${m.role}: ${m.content}`;
          })
          .join("\n\n") ?? request.prompt ?? "";

        const promptEscaped = promptText.replace(/'/g, "'\"'\"'");
        const modelFlag = model && model !== "kimi-latest" ? `--model '${model.replace(/'/g, "'\"'\"'")}'` : "";

        const cmd = `kimi --prompt '${promptEscaped}' --output-format stream-json ${modelFlag} < /dev/null`;

        return new Promise<CompletionResponse>((resolve, reject) => {
          exec(cmd, {
            cwd: process.cwd(),
            env: { ...process.env, KIMI_SHARE_DIR: process.env.KIMI_SHARE_DIR || "/home/lucian/.kimi-code" },
            maxBuffer: 10 * 1024 * 1024,
            timeout: 300_000, // 5 minutes
          }, (error, stdout, stderr) => {
            console.log("[KimiCli] exec callback. error:", error ? `${error.message} (code=${error.code})` : "none", "stdout bytes:", stdout.length, "stderr:", stderr.slice(0, 200));
            if (error) {
              reject(new Error(`kimi CLI failed: ${error.message}. stderr: ${stderr}`));
              return;
            }

            let fullText = "";
            const lines = stdout.split("\n").filter((l) => l.trim());
            for (const line of lines) {
              try {
                const event = JSON.parse(line);
                if (event.role === "assistant" && typeof event.content === "string") {
                  fullText += event.content;
                }
              } catch {
                // ignore non-JSON lines
              }
            }

            resolve({
              content: fullText,
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              model,
              finishReason: "stop",
            });
          });
        });
      },
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });

  return { complete };
};
