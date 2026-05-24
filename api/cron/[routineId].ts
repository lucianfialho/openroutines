/**
 * Cron Job Trigger — Vercel Serverless Function
 *
 * Called by Vercel Cron Jobs for each scheduled routine.
 * Executes the engine directly for the specified routine.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Effect } from "effect";
import { getVercelApp } from "../../../src/vercel-bootstrap.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { routineId } = req.query;
  if (!routineId || typeof routineId !== "string") {
    return res.status(400).json({ error: "Missing routineId" });
  }

  try {
    const { routines, engine } = await getVercelApp();

    const routine = routines.find((r) => r.id === routineId);
    if (!routine) {
      return res.status(404).json({ error: `Routine '${routineId}' not found` });
    }

    const cronTrigger = routine.triggers.find((t) => t.type === "schedule");
    if (!cronTrigger) {
      return res.status(400).json({
        error: `Routine '${routineId}' has no schedule trigger`,
      });
    }

    const result = await Effect.runPromise(
      engine.execute({
        type: "schedule",
        payload: { cron: cronTrigger.cron, routineId },
      })
    );

    return res.status(200).json({
      success: result.success,
      routineId,
      executionId: result.executionId,
      output: result.output,
    });
  } catch (err) {
    console.error("[Cron] Execution failed:", err);
    return res.status(500).json({ error: "Execution failed" });
  }
}
