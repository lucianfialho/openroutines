/**
 * GitHub Webhook Signature Verifier
 *
 * Validates X-Hub-Signature-256 header using HMAC-SHA256.
 */

import { createHmac, timingSafeEqual } from "crypto";

export class SignatureMismatchError extends Error {
  constructor() {
    super("GitHub webhook signature mismatch");
    this.name = "SignatureMismatchError";
  }
}

export const verifySignature = (
  secret: string,
  payload: string,
  signatureHeader: string
): boolean => {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const actual = signatureHeader.slice(7); // remove "sha256=" prefix

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
};
