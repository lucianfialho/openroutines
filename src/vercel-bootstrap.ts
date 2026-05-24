/**
 * Vercel Bootstrap
 *
 * Initializes OpenRoutines components for serverless execution.
 * Uses module-level caching to reuse connections and loaded state
 * across warm invocations.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Effect } from "effect";
import { parseRoutine } from "./routine/parser.js";
import type { Routine } from "./routine/types.js";
import { makeEngine } from "./engine/engine.js";
import { makeKimiProvider } from "./provider/kimi.js";
import { makeInMemoryRepository } from "./persistence/in-memory.js";
import { makeNeonRepository } from "./persistence/neon.js";
import type { ExecutionRepository } from "./persistence/types.js";

interface CachedApp {
  routines: Routine[];
  engine: ReturnType<typeof makeEngine>;
  repository: ExecutionRepository;
}

let cached: CachedApp | null = null;

export const getVercelApp = async (): Promise<CachedApp> => {
  if (cached) {
    return cached;
  }

  const routinesDir = process.env.ROUTINES_DIR ?? "./routines";
  const skillsDir = process.env.SKILLS_DIR ?? "./.gates/skills";

  // 1. Load routines
  const routines: Routine[] = [];
  try {
    const files = readdirSync(routinesDir);
    for (const file of files) {
      if (file.endsWith(".yaml") || file.endsWith(".yml")) {
        const content = readFileSync(join(routinesDir, file), "utf-8");
        routines.push(parseRoutine(content));
      }
    }
  } catch {
    console.warn(`[VercelApp] No routines found in ${routinesDir}`);
  }

  // 2. Setup persistence (Neon serverless or in-memory)
  const persistence = process.env.DATABASE_URL
    ? makeNeonRepository({ connectionString: process.env.DATABASE_URL })
    : makeInMemoryRepository();

  if (process.env.DATABASE_URL && "migrate" in persistence) {
    await (persistence as { migrate: () => Promise<void> }).migrate();
  }

  // 3. Setup provider
  const provider = process.env.KIMI_API_KEY
    ? makeKimiProvider({
        apiKey: process.env.KIMI_API_KEY,
        model: process.env.KIMI_MODEL,
      })
    : {
        complete: (req: { prompt: string }) =>
          Effect.succeed({
            content: `[Stub Provider] Would process: ${req.prompt.slice(0, 50)}...`,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            model: "stub",
            finishReason: "stop",
          }),
      };

  // 4. Setup engine
  const engine = makeEngine({
    routines,
    skillsDir,
    provider: provider as Parameters<typeof makeEngine>[0]["provider"],
    repository: persistence,
  });

  cached = { routines, engine, repository: persistence };
  return cached;
};
