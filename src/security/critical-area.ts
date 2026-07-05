/**
 * Critical-security-area heuristic (F4 #154)
 *
 * Deterministic, path-based decision (11-SEGURANCA.md bloco C): auth, payment,
 * webhook, RLS/policy code or PII-touching migrations. Surfaced on the
 * SecurityVerdict as an informational `criticalArea` flag (the morning report /
 * risk score can weigh it). Deliberately over-triggers rather than under-
 * triggers; never reads file contents, only the diff's paths plus flags the
 * verify phase already derived from the real diff.
 */

export interface CriticalAreaFlags {
  touchesAuth: boolean;
  touchesPayment: boolean;
  touchesPII: boolean;
  touchesWebhook: boolean;
  touchesRLS: boolean;
}

// Matches a path SEGMENT (extension stripped): "auth"/"rls" exact plus their
// common derivatives; payment/webhook/policy anywhere in the segment. Exact
// "auth" avoids flagging "authors.ts" while still catching "authorization.ts".
const AUTH_SEGMENT_RE = /^auth(z|n|entic\w*|oriz\w*)?$/;
const CRITICAL_SEGMENT_RE = /payment|webhook|polic|^rls$/; // "polic" catches policy/policies
const PII_TOKEN_RE = /email|cpf|cnpj|ssn|passport|phone|address|birth|document/;
const MIGRATION_PATH_RE = /(^|\/)migrations?\//;
const DATA_FILE_RE = /\.(sql|prisma)$/;

const segments = (path: string): string[] =>
  path
    .toLowerCase()
    .split("/")
    .filter(Boolean)
    .map((seg) => seg.replace(/\.[^.]+$/, ""));

const isCriticalPath = (path: string): boolean =>
  segments(path).some((seg) => AUTH_SEGMENT_RE.test(seg) || CRITICAL_SEGMENT_RE.test(seg));

// ponytail: PII detection off file paths only — column-level detection needs
// diff content and comes via the verify-phase flags (touchesPII), not this
// heuristic. Migration paths scan the whole path (Prisma names the FOLDER,
// e.g. migrations/20260101_add_email_to_users/migration.sql); loose .sql/
// .prisma files scan only their own name.
const isPIIMigration = (path: string): boolean => {
  const lower = path.toLowerCase();
  if (MIGRATION_PATH_RE.test(lower)) return PII_TOKEN_RE.test(lower);
  if (DATA_FILE_RE.test(lower)) return PII_TOKEN_RE.test(lower.split("/").pop() ?? "");
  return false;
};

export const isCriticalSecurityArea = (files: string[], dataChanges: CriticalAreaFlags): boolean =>
  dataChanges.touchesAuth ||
  dataChanges.touchesPayment ||
  dataChanges.touchesPII ||
  dataChanges.touchesWebhook ||
  dataChanges.touchesRLS ||
  files.some((f) => isCriticalPath(f) || isPIIMigration(f));
