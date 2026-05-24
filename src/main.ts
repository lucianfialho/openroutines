#!/usr/bin/env node
/**
 * OpenRoutines — Entry Point
 *
 * Self-hosted automation platform for engineering workflows.
 * Bring your own model. Start with Kimi K2.6.
 */

import { Effect } from "effect";

const program = Effect.gen(function* () {
  yield* Effect.log("OpenRoutines starting...");
  yield* Effect.log("TODO: initialize trigger layer, engine, and providers");
  yield* Effect.sleep("1 second");
  yield* Effect.log("OpenRoutines ready.");
});

Effect.runPromise(program).catch(console.error);
