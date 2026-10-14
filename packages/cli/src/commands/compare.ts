import { failCommand } from "../utils/commandResult.js";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { defineCommand } from "citty";
import type { Page } from "puppeteer-core";
import { createContactSheet } from "../capture/contactSheet.js";
import { parseBatchRows } from "./batchRender.js";
import { c } from "../ui/colors.js";
import { normalizeErrorMessage } from "../utils/errorMessage.js";
import { displayPathFromInput, readOptionalString, resolveFromBase } from "../utils/pathArgs.js";
import { trackCompareSheet } from "../telemetry/events.js";
import { withMeta } from "../utils/updateCheck.js";
import type { Example } from "./_examples.js";

const MAX_COMPARE_VARIANTS = 16;
const MAX_COMPARE_TIMES = 8;
const MAX_COLUMNS = 4;
const SERIES_CELL_WIDTH = 360;
const DEFAULT_RENDER_READY_TIMEOUT_MS = 5000;
// Shorter lines ("Dim. · 21:00", a day initial) are labels a series shares on purpose.
const REPEATED_LINE_MIN_LENGTH = 12;

export interface CompareVariantSpec {
  label: string;
  inputPath: string;
  displayPath: string;
  /** A `--batch` row: the variable values this variant renders with. */
  variables?: Record<string, unknown>;
}

export interface RepeatedLine {
  text: string;
  variants: string[];
}

export interface PreparedCompareVariant extends CompareVariantSpec {
  projectDir: string;
  stagedDir?: string;
}

export interface ParsedCompareArgs {
  variants: CompareVariantSpec[];
  outPath: string;
  atTimes: number[];
  cols?: number;
  json: boolean;
  timeoutMs: number;
}

export interface CompareVariantCapResult {
  variants: CompareVariantSpec[];
  truncated: boolean;
  total: number;
}

export interface CompareSuccessPayload {
  ok: true;
  sheet: string;
  variants: { label: string; path: string }[];
  times: number[];
  /** Copy found in several variants but not all: a line the series forgot to vary. */
  repeated: RepeatedLine[];
  rendered: number;
  truncated?: true;
  total?: number;
}

export const examples: Example[] = [
  [
    "Compare two agent-authored composition variants",
    "hyperframes compare ./variants/a ./variants/b --out compare.png",
  ],
  [
    "Compare three variants at a specific timeline time",
    "hyperframes compare ./a ./b ./c --at 2.5 --labels classic,bold,quiet --json",
  ],
  [
    "Series sheet: one row per batch row, one column per time, plus repeated copy",
    "hyperframes compare . --batch rows.json --at 1,4,9,14 --out renders/series.jpg --json",
  ],
];

function defaultLabelForPath(input: string): string {
  const name = basename(input);
  return extname(name).toLowerCase() === ".html" ? basename(name, extname(name)) : name;
}

function parsePathArgs(args: { _?: readonly unknown[] }): string[] {
  return (args._ ?? [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseLabels(value: unknown, pathCount: number): string[] | undefined {
  const raw = readOptionalString(value);
  if (!raw) return undefined;
  const labels = raw.split(",").map((part) => part.trim());
  if (labels.some((label) => label.length === 0)) {
    throw new Error("--labels entries must be non-empty");
  }
  if (labels.length !== pathCount) {
    throw new Error(`--labels count (${labels.length}) must match path count (${pathCount})`);
  }
  return labels;
}

function parseAtTimes(value: unknown): number[] {
  const raw = readOptionalString(value);
  if (!raw) return [0];
  const times = raw.split(",").map((part) => Number(part.trim()));
  if (times.some((time) => !Number.isFinite(time) || time < 0)) {
    throw new Error("--at must be non-negative seconds, comma-separated (e.g. 1,4.5,9)");
  }
  if (times.length > MAX_COMPARE_TIMES) {
    throw new Error(`--at takes at most ${MAX_COMPARE_TIMES} times`);
  }
  return times;
}

function batchLabel(row: Record<string, unknown>, index: number): string {
  const name = row.name;
  return typeof name === "string" && name.trim() ? name.trim() : String(index + 1);
}

/** One variant per `--batch` row, all rendering the same project. */
function batchVariants(
  args: { batch?: unknown; labels?: unknown },
  paths: string[],
  cwd: string,
): CompareVariantSpec[] {
  const batchPath = resolveFromBase(cwd, readOptionalString(args.batch) ?? "");
  if (paths.length !== 1) throw new Error("--batch takes exactly one project path");
  const rows = parseBatchRows(readFileSync(batchPath, "utf-8"), batchPath);
  if (rows.length < 2) throw new Error("--batch needs 2+ rows to compare");
  const labels = parseLabels(args.labels, rows.length);
  const project = paths[0]!;
  return rows.map((row, index) => ({
    label: labels?.[index] ?? batchLabel(row, index),
    inputPath: resolveFromBase(cwd, project),
    displayPath: displayPathFromInput(cwd, project),
    variables: row,
  }));
}

function parseColumns(value: unknown): number | undefined {
  const raw = readOptionalString(value);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--cols must be a positive integer");
  }
  return parsed;
}

function defaultCompareCols(cellCount: number): number {
  return Math.max(1, Math.min(MAX_COLUMNS, Math.ceil(Math.sqrt(cellCount))));
}

function pathVariants(
  args: { labels?: unknown },
  paths: string[],
  cwd: string,
): CompareVariantSpec[] {
  if (paths.length < 2) {
    throw new Error("need 2+ paths to compare");
  }
  const labels = parseLabels(args.labels, paths.length);
  return paths.map((input, index) => ({
    label: labels?.[index] ?? defaultLabelForPath(input),
    inputPath: resolveFromBase(cwd, input),
    displayPath: displayPathFromInput(cwd, input),
  }));
}

export function parseCompareArgs(
  args: {
    _?: readonly unknown[];
    labels?: unknown;
    out?: unknown;
    at?: unknown;
    cols?: unknown;
    json?: unknown;
    timeout?: unknown;
    batch?: unknown;
  },
  cwd = process.cwd(),
): ParsedCompareArgs {
  const paths = parsePathArgs(args);
  const variants = readOptionalString(args.batch)
    ? batchVariants(args, paths, cwd)
    : pathVariants(args, paths, cwd);

  return {
    variants,
    outPath: resolveFromBase(cwd, readOptionalString(args.out) ?? "compare.png"),
    atTimes: parseAtTimes(args.at),
    cols: parseColumns(args.cols),
    json: args.json === true,
    timeoutMs:
      Number.parseInt(readOptionalString(args.timeout) ?? "", 10) ||
      DEFAULT_RENDER_READY_TIMEOUT_MS,
  };
}

export function capCompareVariants(
  variants: readonly CompareVariantSpec[],
): CompareVariantCapResult {
  const total = variants.length;
  if (total <= MAX_COMPARE_VARIANTS) {
    return { variants: [...variants], truncated: false, total };
  }
  console.error(
    c.warn(
      `Warning: ${total} compare variants exceed the ${MAX_COMPARE_VARIANTS}-variant cap — rendering the first ${MAX_COMPARE_VARIANTS} of ${total}; re-run with fewer variants or split into multiple runs.`,
    ),
  );
  return {
    variants: variants.slice(0, MAX_COMPARE_VARIANTS),
    truncated: true,
    total,
  };
}

export function buildCompareSuccessPayload(
  sheet: string,
  variants: readonly CompareVariantSpec[],
  capResult: CompareVariantCapResult,
  series: { times: number[]; repeated: RepeatedLine[] } = { times: [0], repeated: [] },
): CompareSuccessPayload {
  const payload: CompareSuccessPayload = {
    ok: true,
    sheet,
    variants: variants.map((variant) => ({
      label: variant.label,
      path: variant.displayPath,
    })),
    times: series.times,
    repeated: series.repeated,
    rendered: variants.length,
  };
  if (capResult.truncated) {
    payload.truncated = true;
    payload.total = capResult.total;
  }
  return payload;
}

function inputError(variant: CompareVariantSpec): Error {
  return new Error(
    `Variant "${variant.label}" is not a composition input (${variant.displayPath}): expected a directory containing index.html or a .html file`,
  );
}

function stageHtmlVariant(variant: CompareVariantSpec): PreparedCompareVariant {
  const stagedDir = mkdtempSync(join(tmpdir(), "hf-compare-variant-"));
  try {
    // Copy the composition's sibling files but skip heavy/irrelevant trees — a
    // variant sitting next to node_modules or .git shouldn't drag them into tmp.
    cpSync(dirname(variant.inputPath), stagedDir, {
      recursive: true,
      filter: (src) => {
        const base = basename(src);
        return base !== "node_modules" && base !== ".git";
      },
    });
    const sourceName = basename(variant.inputPath);
    if (sourceName !== "index.html") {
      renameSync(join(stagedDir, sourceName), join(stagedDir, "index.html"));
    }
    return {
      ...variant,
      projectDir: stagedDir,
      stagedDir,
    };
  } catch (err) {
    rmSync(stagedDir, { recursive: true, force: true });
    throw err;
  }
}

export function prepareCompareVariantProjects(
  variants: readonly CompareVariantSpec[],
): PreparedCompareVariant[] {
  const prepared: PreparedCompareVariant[] = [];
  try {
    for (const variant of variants) {
      if (!existsSync(variant.inputPath)) {
        throw inputError(variant);
      }
      const stat = statSync(variant.inputPath);
      if (stat.isDirectory() && existsSync(join(variant.inputPath, "index.html"))) {
        prepared.push({
          ...variant,
          projectDir: variant.inputPath,
        });
        continue;
      }
      if (stat.isFile() && extname(variant.inputPath).toLowerCase() === ".html") {
        prepared.push(stageHtmlVariant(variant));
        continue;
      }
      throw inputError(variant);
    }
    return prepared;
  } catch (err) {
    for (const variant of prepared) {
      if (variant.stagedDir) {
        rmSync(variant.stagedDir, { recursive: true, force: true });
      }
    }
    throw err;
  }
}

function cleanupPreparedCompareVariants(variants: readonly PreparedCompareVariant[]): void {
  for (const variant of variants) {
    if (variant.stagedDir) {
      rmSync(variant.stagedDir, { recursive: true, force: true });
    }
  }
}

/**
 * Copy lines that recur in some variants but not every one. A line every variant
 * shares is the template's fixed copy (brand, tagline); with fewer than three
 * variants "some but not all" cannot happen.
 */
export function findRepeatedLines(
  copy: readonly { label: string; lines: readonly string[] }[],
  minLength = REPEATED_LINE_MIN_LENGTH,
): RepeatedLine[] {
  if (copy.length < 3) return [];
  const byKey = new Map<string, { text: string; variants: Set<number> }>();
  copy.forEach(({ lines }, index) => {
    for (const line of lines) {
      const text = line.replace(/\s+/g, " ").trim();
      if (text.length < minLength || !/\p{L}/u.test(text)) continue;
      const key = text.normalize("NFC").toLocaleLowerCase();
      const entry = byKey.get(key) ?? { text, variants: new Set<number>() };
      entry.variants.add(index);
      byKey.set(key, entry);
    }
  });
  return [...byKey.values()]
    .filter((entry) => entry.variants.size >= 2 && entry.variants.size < copy.length)
    .sort((a, b) => b.variants.size - a.variants.size || a.text.localeCompare(b.text))
    .map((entry) => ({
      text: entry.text,
      variants: [...entry.variants].sort((a, b) => a - b).map((index) => copy[index]!.label),
    }));
}

/** Every rendered text's own copy, whether or not it is on screen at this instant. */
function collectCopyLines(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.body.querySelectorAll("*")).flatMap((element) => {
      if (element.closest("[data-layout-ignore], script, style, template, noscript")) return [];
      // checkVisibility ignores opacity: a scene faded out at this instant still counts.
      if (element.checkVisibility?.() === false) return [];
      const own = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return own ? [own] : [];
    }),
  );
}

async function captureCompareVariant(
  variant: PreparedCompareVariant,
  opts: { times: number[]; frameDir: string; timeoutMs: number },
): Promise<{ framePaths: string[]; lines: string[]; renderReadyTimedOut: boolean }> {
  const lines = new Set<string>();
  let renderReadyTimedOut = false;
  try {
    const { captureSnapshots } = await import("./snapshot.js");
    const framePaths = await captureSnapshots(variant.projectDir, {
      at: opts.times,
      includeEnd: false,
      outputDir: opts.frameDir,
      timeout: opts.timeoutMs,
      variables: variant.variables,
      quiet: true,
      record: false,
      onReady: (info) => {
        renderReadyTimedOut = info.renderReadyTimedOut;
      },
      onFrame: async (page) => {
        for (const line of await collectCopyLines(page)) lines.add(line);
      },
    });
    if (framePaths.length !== opts.times.length) {
      throw new Error(`captured ${framePaths.length} of ${opts.times.length} frames`);
    }
    return { framePaths, lines: [...lines], renderReadyTimedOut };
  } catch (err) {
    throw new Error(
      `Render failed for variant "${variant.label}" (${variant.displayPath}): ${normalizeErrorMessage(err)}`,
    );
  }
}

function sheetLayout(parsed: ParsedCompareArgs, variants: readonly CompareVariantSpec[]) {
  const times = parsed.atTimes;
  if (times.length === 1) {
    return {
      cols: parsed.cols ?? defaultCompareCols(variants.length),
      labels: variants.map((variant) => variant.label),
      cellWidth: undefined,
    };
  }
  return {
    cols: times.length,
    labels: variants.flatMap((variant) => times.map((time) => `${variant.label} · ${time}s`)),
    cellWidth: SERIES_CELL_WIDTH,
  };
}

async function renderCompareSheet(parsed: ParsedCompareArgs): Promise<CompareSuccessPayload> {
  const capResult = capCompareVariants(parsed.variants);
  const variants = capResult.variants;
  const prepared = prepareCompareVariantProjects(variants);
  const frameRoot = mkdtempSync(join(tmpdir(), "hf-compare-frames-"));
  const framePaths: string[] = [];
  const copy: { label: string; lines: string[] }[] = [];

  try {
    let renderReadyTimedOut = false;
    for (let i = 0; i < prepared.length; i++) {
      const variant = prepared[i]!;
      const captured = await captureCompareVariant(variant, {
        times: parsed.atTimes,
        frameDir: join(frameRoot, `variant-${String(i + 1).padStart(2, "0")}`),
        timeoutMs: parsed.timeoutMs,
      });
      framePaths.push(...captured.framePaths);
      copy.push({ label: variant.label, lines: captured.lines });
      renderReadyTimedOut = renderReadyTimedOut || captured.renderReadyTimedOut;
    }

    const layout = sheetLayout(parsed, variants);
    mkdirSync(dirname(parsed.outPath), { recursive: true });
    await createContactSheet(framePaths, parsed.outPath, {
      cols: layout.cols,
      maxImages: framePaths.length,
      labelMode: "custom",
      labels: layout.labels,
      cellWidth: layout.cellWidth,
    });

    trackCompareSheet({
      command: "compare",
      cells: framePaths.length,
      truncated: capResult.truncated,
      total: capResult.total,
      renderReadyTimedOut,
    });
    return buildCompareSuccessPayload(parsed.outPath, variants, capResult, {
      times: parsed.atTimes,
      repeated: findRepeatedLines(copy),
    });
  } finally {
    cleanupPreparedCompareVariants(prepared);
    rmSync(frameRoot, { recursive: true, force: true });
  }
}

function printRepeatedLines(repeated: readonly RepeatedLine[]): void {
  if (repeated.length === 0) return;
  console.log(
    `\n${c.warn("⚠")}  ${repeated.length} line(s) repeated in some variants but not all:`,
  );
  for (const line of repeated) {
    console.log(`   "${line.text}" ${c.dim(`— ${line.variants.join(", ")}`)}`);
  }
}

function printJson(payload: object): void {
  console.log(JSON.stringify(withMeta(payload), null, 2));
}

export default defineCommand({
  meta: {
    name: "compare",
    description: "Render independent composition variants into one labeled comparison sheet",
  },
  args: {
    path: {
      type: "positional",
      description:
        "Composition project directory or .html file (pass 2+ paths, or one with --batch)",
      required: false,
    },
    at: {
      type: "string",
      description:
        "Timeline time in seconds, or several comma-separated: then one row per variant, one column per time (at most 8)",
    },
    batch: {
      type: "string",
      description:
        'JSON array of variable rows (or {"rows":[...]}), as with render --batch: one variant of the single project per row, labelled by its "name"',
    },
    labels: {
      type: "string",
      description: "Comma-separated labels matching the variant count",
    },
    out: {
      type: "string",
      description: "Output comparison sheet path (default: ./compare.png)",
    },
    cols: {
      type: "string",
      description: "Grid columns for a single --at time (default: sqrt heuristic, capped at 4)",
    },
    timeout: {
      type: "string",
      description: "Render-ready timeout in ms per variant (default: 5000)",
    },
    json: {
      type: "boolean",
      description: "Output result as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const jsonRequested = args.json === true;
    try {
      const parsed = parseCompareArgs(args);
      if (!parsed.json) {
        console.log(
          `${c.accent("◆")}  Rendering ${Math.min(parsed.variants.length, MAX_COMPARE_VARIANTS)} of ${parsed.variants.length} composition variants`,
        );
      }
      const payload = await renderCompareSheet(parsed);
      if (parsed.json) {
        printJson(payload);
      } else {
        console.log(`\n${c.success("◇")}  Comparison sheet saved to ${payload.sheet}`);
        printRepeatedLines(payload.repeated);
      }
    } catch (err) {
      const message = normalizeErrorMessage(err);
      if (jsonRequested) {
        printJson({ ok: false, error: message });
      } else {
        console.error(`\n${c.error("✗")} Compare failed: ${message}`);
      }
      failCommand();
    }
  },
});
