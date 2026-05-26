/**
 * Health Check — Vercel Serverless Function
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const { getVercelApp } = await import("../src/vercel-bootstrap.js");
    const { routines } = await getVercelApp();

    return res.status(200).json({
      status: "ok",
      routines: routines.length,
      provider: process.env.KIMI_API_KEY ? "kimi" : "stub",
      persistence: process.env.DATABASE_URL ? "neon" : "in-memory",
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
    });
  } catch (err: any) {
    console.error("[Health] Bootstrap failed:", err);
    return res.status(500).json({
      error: "Bootstrap failed",
      message: err?.message ?? String(err),
      stack: err?.stack ?? undefined,
    });
  }
}
