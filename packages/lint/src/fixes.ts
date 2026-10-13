import type { HyperframeLintFinding, LintEdit } from "./types";

export type LintFixOutcome = {
  finding: HyperframeLintFinding;
  applied: boolean;
  /** Why a fix was left out: the file changed since lint, or it overlaps a fix already taken. */
  reason?: "source_changed" | "overlaps_other_fix";
};

const sameEdit = (a: LintEdit, b: LintEdit) =>
  a.start === b.start && a.end === b.end && a.replacement === b.replacement;

const overlaps = (a: LintEdit, b: LintEdit) => a.start < b.end && b.start < a.end;

/**
 * Applies every finding's fix whose edits still match `source`, all or nothing per finding.
 * A fix identical to one already taken (two findings on the same element) counts as applied.
 */
export function applyLintFixes(
  source: string,
  findings: HyperframeLintFinding[],
): { source: string; outcomes: LintFixOutcome[] } {
  const taken: LintEdit[] = [];
  const outcomes: LintFixOutcome[] = [];
  for (const finding of findings) {
    const edits = finding.fix?.edits;
    if (!edits || edits.length === 0) continue;
    if (edits.some((edit) => source.slice(edit.start, edit.end) !== edit.expected)) {
      outcomes.push({ finding, applied: false, reason: "source_changed" });
      continue;
    }
    const fresh = edits.filter((edit) => !taken.some((other) => sameEdit(edit, other)));
    if (fresh.some((edit) => taken.some((other) => overlaps(edit, other)))) {
      outcomes.push({ finding, applied: false, reason: "overlaps_other_fix" });
      continue;
    }
    taken.push(...fresh);
    outcomes.push({ finding, applied: true });
  }
  const rewritten = [...taken]
    .sort((a, b) => b.start - a.start)
    .reduce(
      (text, edit) => text.slice(0, edit.start) + edit.replacement + text.slice(edit.end),
      source,
    );
  return { source: rewritten, outcomes };
}
