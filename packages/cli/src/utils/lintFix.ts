import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyLintFixes, lintProject, type HyperframeLintFinding } from "@hyperframes/lint";
import { c } from "../ui/colors.js";

export type LintFixReport = {
  file: string;
  code: string;
  selector?: string;
  description: string;
  applied: boolean;
  reason?: string;
};

function ownsFix(finding: HyperframeLintFinding, path: string): boolean {
  return finding.fix !== undefined && (!finding.file || resolve(finding.file) === path);
}

/** Lints the project, applies every fix still valid on disk and rewrites only the files that changed. */
export async function fixProjectLint(projectDir: string): Promise<LintFixReport[]> {
  const { results } = await lintProject(projectDir);
  return results.flatMap(({ file, result }) => {
    const path = resolve(join(projectDir, file));
    const findings = result.findings.filter((finding) => ownsFix(finding, path));
    if (findings.length === 0) return [];
    const original = readFileSync(path, "utf8");
    const { source, outcomes } = applyLintFixes(original, findings);
    if (source !== original) writeFileSync(path, source);
    return outcomes.map(({ finding, applied, reason }) => ({
      file,
      code: finding.code,
      ...(finding.selector ? { selector: finding.selector } : {}),
      description: finding.fix?.description ?? finding.code,
      applied,
      ...(reason ? { reason } : {}),
    }));
  });
}

/** Findings as printed: the edit offsets are for --fix, the reader only needs to know one exists. */
export function withoutFixEdits(findings: HyperframeLintFinding[]): object[] {
  return findings.map(({ fix, ...finding }) => (fix ? { ...finding, fixable: true } : finding));
}

export function printFixes(fixed: LintFixReport[]): void {
  if (fixed.length === 0) {
    console.log(`${c.dim("◇")}  No automatic fix to apply`);
  }
  for (const fix of fixed) {
    const where = c.dim(`${fix.file}${fix.applied ? "" : `, skipped: ${fix.reason}`}`);
    const label = fix.applied ? `${c.success("◇")}  Fixed` : `${c.warn("⚠")}  Not fixed`;
    console.log(`${label} ${fix.description} ${where}`);
  }
  console.log();
}
