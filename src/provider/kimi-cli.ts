import { Effect } from "effect";
import { spawn } from "child_process";
import type { CompletionRequest, CompletionResponse } from "./types.js";
import { pickEnv, BASE_ENV_VARS } from "../util/env.js";
import { withSupplyChainPath } from "../security/supply-chain-guard.js";

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

        // argv, no shell: the prompt carries untrusted issue/PR text — passing
        // it as a distinct argv element means it can never reach /bin/sh. stdin
        // is ignored (replaces the old `< /dev/null`).
        const args = ["--prompt", promptText, "--output-format", "stream-json"];
        if (model && model !== "kimi-latest") args.push("--model", model);

        return new Promise<CompletionResponse>((resolve, reject) => {
          const child = spawn("kimi", args, {
            // Run INSIDE the card's worktree when one is set (card-to-pr's
            // implementation) so the agent edits the card's checkout, not the
            // orchestrator's repo. Without this the Kimi ran in the orchestrator
            // cwd and produced an EMPTY diff — the review then had no code to
            // approve and the card looped to Blocked. Mirrors claude-cli.ts.
            cwd: request.workdir ?? process.cwd(),
            // Minimal env: kimi CLI needs only its API key + share dir, never
            // the orchestrator's GitHub/DB secrets. PATH is prefixed with
            // supplyChainShimDir() (F4 #156) so any npm/pnpm/npx the agent's
            // Bash tool runs resolves to the supply-chain guard shims (Kimi
            // has no native hooks, so this PATH boundary is load-bearing for it).
            env: withSupplyChainPath({ ...pickEnv([...BASE_ENV_VARS, "KIMI_API_KEY"]), KIMI_SHARE_DIR: process.env.KIMI_SHARE_DIR || "/home/lucian/.kimi-code" }),
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 300_000, // 5 minutes
          });

          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (d) => { stdout += String(d); });
          child.stderr?.on("data", (d) => { stderr += String(d); });
          child.on("error", (err) => reject(new Error(`kimi CLI failed: ${err.message}`)));
          child.on("close", (code) => {
            if (code !== 0) {
              reject(new Error(`kimi CLI failed (code=${code}). stderr: ${stderr.slice(0, 500)}`));
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
