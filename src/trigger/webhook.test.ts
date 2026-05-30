import { describe, it, expect, vi } from "vitest";
import { createGitHubWebhookHandler } from "./webhook.js";
import { createHmac } from "crypto";
import type { Request, Response } from "express";
import type { JobQueue } from "../queue/types.js";

const makeSignature = (secret: string, payload: string): string => {
  const hash = createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${hash}`;
};

const makeMockReq = (overrides?: {
  body?: unknown;
  signature?: string;
  event?: string;
}): Request =>
  ({
    headers: {
      "x-hub-signature-256": overrides?.signature,
      "x-github-event": overrides?.event,
    },
    body: overrides?.body ?? {},
  }) as unknown as Request;

const makeMockRes = (): Response => {
  const res = {
    statusCode: 200,
    jsonBody: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      return this;
    },
  };
  return res as unknown as Response;
};

const makeQueue = (): JobQueue & { jobs: unknown[] } => {
  const jobs: unknown[] = [];
  return {
    jobs,
    enqueue: vi.fn(async (job) => {
      jobs.push(job);
    }),
  };
};

describe("createGitHubWebhookHandler", () => {
  const secret = "webhook-secret";

  it("should accept valid webhook and enqueue job", async () => {
    const queue = makeQueue();
    const handler = createGitHubWebhookHandler({ secret, queue });
    const body = { action: "opened", number: 42 };
    const payload = JSON.stringify(body);
    const req = makeMockReq({
      body,
      signature: makeSignature(secret, payload),
      event: "pull_request",
    });
    const res = makeMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(202);
    expect(res.jsonBody).toEqual({ accepted: true, event: "pull_request" });
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({
      trigger: {
        type: "github",
        payload: { event: "pull_request.opened", body },
      },
    });
  });

  it("should reject missing signature", async () => {
    const queue = makeQueue();
    const handler = createGitHubWebhookHandler({ secret, queue });
    const req = makeMockReq({ body: {}, event: "push" });
    const res = makeMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: "Missing signature" });
    expect(queue.jobs).toHaveLength(0);
  });

  it("should reject invalid signature", async () => {
    const queue = makeQueue();
    const handler = createGitHubWebhookHandler({ secret, queue });
    const req = makeMockReq({
      body: {},
      signature: "sha256=invalidhash1234567890abcdef1234567890abcdef1234567890abcdef12345678",
      event: "push",
    });
    const res = makeMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: "Invalid signature" });
    expect(queue.jobs).toHaveLength(0);
  });

  it("should reject missing event type", async () => {
    const queue = makeQueue();
    const handler = createGitHubWebhookHandler({ secret, queue });
    const body = {};
    const payload = JSON.stringify(body);
    const req = makeMockReq({
      body,
      signature: makeSignature(secret, payload),
    });
    const res = makeMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: "Missing event type" });
    expect(queue.jobs).toHaveLength(0);
  });

  it("should handle queue enqueue failure", async () => {
    const queue: JobQueue = {
      enqueue: vi.fn(() => Promise.reject(new Error("Queue down"))),
    };
    const handler = createGitHubWebhookHandler({ secret, queue });
    const body = { action: "opened" };
    const payload = JSON.stringify(body);
    const req = makeMockReq({
      body,
      signature: makeSignature(secret, payload),
      event: "issues",
    });
    const res = makeMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.jsonBody).toEqual({ error: "Failed to enqueue job" });
  });

  it("should handle issue opened event", async () => {
    const queue = makeQueue();
    const handler = createGitHubWebhookHandler({ secret, queue });
    const body = { action: "opened", issue: { number: 1 } };
    const payload = JSON.stringify(body);
    const req = makeMockReq({
      body,
      signature: makeSignature(secret, payload),
      event: "issues",
    });
    const res = makeMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(202);
    expect(queue.jobs[0]).toMatchObject({
      trigger: {
        payload: { event: "issues.opened", body },
      },
    });
  });

  it("should handle push event", async () => {
    const queue = makeQueue();
    const handler = createGitHubWebhookHandler({ secret, queue });
    const body = { ref: "refs/heads/main", commits: [] };
    const payload = JSON.stringify(body);
    const req = makeMockReq({
      body,
      signature: makeSignature(secret, payload),
      event: "push",
    });
    const res = makeMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(202);
    expect(queue.jobs[0]).toMatchObject({
      trigger: {
        payload: { event: "push", body },
      },
    });
  });
});
