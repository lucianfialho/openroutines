/**
 * GitHub Webhook — Vercel Serverless Function
 *
 * Receives GitHub webhooks, verifies HMAC signature, and executes
 * the engine directly (synchronous, no queue in serverless).
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Effect } from "effect";
import { getVercelApp } from "../../src/vercel-bootstrap.js";
import { verifySignature } from "../../src/trigger/github-verifier.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(500).json({ error: "GITHUB_WEBHOOK_SECRET not configured" });
  }

  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  const eventType = req.headers["x-github-event"] as string | undefined;

  if (!signature) {
    return res.status(401).json({ error: "Missing signature" });
  }

  const payload = JSON.stringify(req.body);
  const valid = verifySignature(secret, payload, signature);
  if (!valid) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  if (!eventType) {
    return res.status(400).json({ error: "Missing event type" });
  }

  try {
    const { engine } = await getVercelApp();

    const result = await Effect.runPromise(
      engine.execute({
        type: "github",
        payload: { event: eventType, body: req.body },
      })
    );

    return res.status(202).json({
      accepted: true,
      event: eventType,
      success: result.success,
      executionId: result.executionId,
    });
  } catch (err) {
    console.error("[Webhook] Execution failed:", err);
    return res.status(500).json({ error: "Execution failed" });
  }
}
