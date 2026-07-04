/**
 * Revisao aggregator (F4 #153)
 *
 * Pure function wired as `cardToPrFanoutAggregators.aggregateReview`
 * (src/pipeline/card-to-pr/index.ts) into the `review` `type: fanout` state's
 * `aggregate:`. Called by the runner's `runFanout` (src/engine/state-machine.ts)
 * with the raw per-lens results — `{name, output?, error?}` per lens; a lens
 * skipped by `when:` is simply absent, an errored lens carries `error` instead
 * of `output`. Combines whatever lenses ran into one envelope.
 *
 * Rules:
 *  - `gaps` = union of every CONTESTABLE gap from every lens present, including
 *    security findings still `status:"open"` AND `blocking:true` (a
 *    low-confidence note never forces refutation) — they take the same
 *    refutation/adjudication path as any other gap, never a shortcut straight
 *    to blocked.
 *  - `securityVerdict.approved` is trusted as-is: the security-judge provider
 *    (separate issue) owns the "an open finding never flips approved before
 *    adjudication" rule.
 *  - `approved` = every lens present approved && (no securityVerdict or it is
 *    approved).
 *  - A lens that errored (no output at all) forces `approved:false` plus a
 *    non-contestable gap describing the failure — fail-closed: a review that
 *    didn't run is never a pass. It still flows through the SAME
 *    review->refutation edge (an implementer can contest a transient tool
 *    failure), capped like any other gap by the edge's `max_retries`.
 *  - A lens skipped by `when:` is absent from `lentes` — nothing to do.
 */

/** A gap's originating lens. "conventions" is a sub-tag the correctness lens
 * applies to its 2nd rubric (raizes-docs/anti-patterns/A-B-C) — not a separate
 * fanout lens. */
export type LensName = "correctness" | "conventions" | "data" | "security";

export interface LensGap {
  lens: LensName;
  description: string;
  file?: string;
  line?: number;
  contestable: boolean;
}

/** Shape of one lens's own validated JSON output (what the LLM/provider emits). */
export interface LensResult {
  lens: "correctness" | "data" | "security";
  model: string;
  approved: boolean;
  gaps: LensGap[];
  // Full shape owned by the security-judge issue; kept minimal here on purpose.
  securityVerdict?: { approved: boolean; findings: unknown[]; criticalArea: boolean };
}

export interface ReviewOutput {
  approved: boolean;
  gaps: LensGap[];
  securityVerdict: LensResult["securityVerdict"] | null;
}

export const aggregateReview = (lentes: Array<Record<string, unknown>>): ReviewOutput => {
  const gaps: LensGap[] = [];
  let approved = true;
  let securityVerdict: ReviewOutput["securityVerdict"] = null;

  for (const entry of lentes) {
    const name = String(entry.name ?? "unknown");

    if (typeof entry.error === "string") {
      approved = false;
      gaps.push({ lens: name as LensName, description: `Lente '${name}' falhou: ${entry.error}`, contestable: false });
      continue;
    }

    const output = entry.output as Record<string, unknown> | undefined;
    if (!output) continue; // no output and no error — nothing to aggregate (shouldn't happen in practice)

    if (typeof output.approved === "boolean") approved = approved && output.approved;

    if (name === "security") {
      securityVerdict = output as unknown as ReviewOutput["securityVerdict"];
      const findings = Array.isArray(output.findings) ? (output.findings as Array<Record<string, unknown>>) : [];
      for (const finding of findings) {
        // Only an open AND blocking finding is contestable — a low-confidence
        // note (blocking:false) never forces a refutation round.
        if (finding.status !== "open" || finding.blocking !== true) continue;
        gaps.push({
          lens: "security",
          description: String(finding.description ?? "achado de segurança sem descrição"),
          ...(typeof finding.file === "string" ? { file: finding.file } : {}),
          ...(typeof finding.line === "number" ? { line: finding.line } : {}),
          contestable: true,
        });
      }
      continue;
    }

    const rawGaps = Array.isArray(output.gaps) ? (output.gaps as Array<Record<string, unknown>>) : [];
    for (const gap of rawGaps) {
      if (!gap.contestable) continue;
      const lens: LensName = name === "correctness" && gap.rubrica === "convencoes" ? "conventions" : (name as LensName);
      gaps.push({
        lens,
        description: String(gap.description ?? ""),
        ...(typeof gap.file === "string" ? { file: gap.file } : {}),
        ...(typeof gap.line === "number" ? { line: gap.line } : {}),
        contestable: true,
      });
    }
  }

  return { approved, gaps, securityVerdict };
};
