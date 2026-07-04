/**
 * Default security-lens exclusions (F4 #154)
 *
 * Finding classes the security judge must NOT report (11-SEGURANCA.md /
 * anthropics/claude-code-security-review): they are real concerns but never
 * card-blocking here — they drown the signal of the findings that are.
 * Injected verbatim into every judge prompt (round 1, round 2, adjudication)
 * alongside the per-repo false-positive file (fp-file.ts).
 */

export const DEFAULT_SECURITY_EXCLUSIONS: string[] = [
  "Denial of service / missing rate limiting (volumetric abuse, brute-force throttling)",
  "Resource exhaustion (unbounded memory/CPU/disk growth without a concrete attacker-controlled trigger)",
  "Input validation on non-critical fields with no concrete exploit path (format/length nits)",
  "Missing security headers or hardening best-practices with no demonstrated vulnerability",
  "Theoretical timing side-channels without a practical, reachable attack",
];
