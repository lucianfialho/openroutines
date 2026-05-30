/**
 * GitHub Webhook Trigger Receiver
 *
 * Express endpoint that receives GitHub webhooks, verifies signatures,
 * and enqueues matching routines.
 */

import type { Request, Response, Express } from "express";
import express from "express";
import { randomUUID } from "crypto";
import { verifySignature } from "./github-verifier.js";
import type { JobQueue } from "../queue/types.js";

export interface WebhookConfig {
  secret: string;
  queue: JobQueue;
}

export const createGitHubWebhookHandler = (config: WebhookConfig) => {
  const { secret, queue } = config;

  return async (req: Request, res: Response): Promise<void> => {
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    const eventType = req.headers["x-github-event"] as string | undefined;
    const payload = JSON.stringify(req.body);

    if (!signature) {
      res.status(401).json({ error: "Missing signature" });
      return;
    }

    const valid = verifySignature(secret, payload, signature);
    if (!valid) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    if (!eventType) {
      res.status(400).json({ error: "Missing event type" });
      return;
    }

    // Build full event name: e.g. "issues.opened", "pull_request.opened"
    const action = req.body?.action;
    const fullEvent = action ? `${eventType}.${action}` : eventType;

    const job = {
      id: randomUUID(),
      trigger: {
        type: "github" as const,
        payload: { event: fullEvent, body: req.body },
      },
    };

    try {
      await queue.enqueue(job);
      res.status(202).json({ accepted: true, event: eventType });
    } catch (err) {
      console.error("[Webhook] Failed to enqueue job:", err);
      res.status(500).json({ error: "Failed to enqueue job" });
    }
  };
};

export const setupGitHubWebhook = (
  app: Express,
  config: WebhookConfig
): void => {
  app.use(express.json());
  app.post("/webhooks/github", createGitHubWebhookHandler(config));
};
