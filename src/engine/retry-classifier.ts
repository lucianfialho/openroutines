/**
 * Retry taxonomy (F4 #159): three failure classes with distinct treatment.
 *
 *   transient — 429/529/network timeout: absorbed by provider backoff; the
 *               runner retries a small fixed number of residual ones.
 *   format    — output failed the phase schema: 1 immediate fresh retry with a
 *               format reminder, never consuming the logic cap.
 *   logic     — verify failed / review gap: consumes the declarative
 *               `max_retries:` cap on the edge (F1), with stall detection.
 */

import { createHash } from "crypto";

export type FailureClass = "transient" | "format" | "logic";

export interface ClassifiableFailure {
  errorName?: string;
  httpStatus?: number;
  schemaValidationFailed?: boolean;
  message?: string;
}

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 529]);
const TRANSIENT_MESSAGE = /\b(429|500|502|503|529)\b|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|overloaded/i;

/** Residual transient retries at the runner after provider backoff is exhausted. */
export const TRANSIENT_RETRY_CAP = 3;
/** Immediate fresh retries with a format reminder for schema-invalid outputs. */
export const FORMAT_RETRY_CAP = 1;

export const classifyFailure = (f: ClassifiableFailure): FailureClass => {
  if (f.schemaValidationFailed === true) return "format";
  if (f.httpStatus !== undefined && TRANSIENT_STATUSES.has(f.httpStatus)) return "transient";
  if (f.message !== undefined && TRANSIENT_MESSAGE.test(f.message)) return "transient";
  return "logic";
};

/**
 * Stable signature of a failing check. Same check + same signature after the
 * first correction = stall → Blocked directly, without burning the 2nd retry.
 */
export const failureSignature = (f: { checkName: string; message: string }): string =>
  createHash("sha256").update(`${f.checkName}\n${f.message}`).digest("hex").slice(0, 16);

export const isSameFailureSignature = (prev: string | undefined, curr: string | undefined): boolean =>
  prev !== undefined && curr !== undefined && prev !== "" && prev === curr;

/** Tier escalation ladder (doc 03): 2 logic failures in a tier → next tier up. */
export const nextTier = (current: "kimi" | "sonnet" | "opus"): "sonnet" | "opus" | null => {
  if (current === "kimi") return "sonnet";
  if (current === "sonnet") return "opus";
  return null;
};
