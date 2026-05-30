/**
 * GitHub Webhook — Vercel Serverless Function
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Effect } from "effect";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      return res.status(500).json({ error: "GITHUB_WEBHOOK_SECRET not configured" });
    }

    const { verifySignature } = await import("../../src/trigger/github-verifier.js");
    const { getVercelApp } = await import("../../src/vercel-bootstrap.js");

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

    const { engine } = await getVercelApp();

    // Compose full event name: e.g. "issues.opened", "pull_request.opened"
    const action = req.body?.action ?? "";
    const fullEvent = action ? `${eventType}.${action}` : eventType;

    const result = await Effect.runPromise(
      engine.execute({
        type: "github",
        payload: { event: fullEvent, body: req.body },
      })
    );

    return res.status(202).json({
      accepted: true,
      event: eventType,
      success: result.success,
      executionId: result.executionId,
    });
  } catch (err: any) {
    console.error("[Webhook] Error:", err);
    return res.status(500).json({
      error: "Execution failed",
      message: err?.message ?? String(err),
      stack: err?.stack ?? undefined,
    });
  }
}
