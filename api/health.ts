/**
 * Health Check — Vercel Serverless Function
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getVercelApp } from "../src/vercel-bootstrap.js";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const { routines } = await getVercelApp();

  return res.status(200).json({
    status: "ok",
    routines: routines.length,
    provider: process.env.KIMI_API_KEY ? "kimi" : "stub",
    persistence: process.env.DATABASE_URL ? "neon" : "in-memory",
  });
}
