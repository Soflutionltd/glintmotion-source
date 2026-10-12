import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseHTML } from "linkedom";

/** Seconds of the source composition to render: [from, to). */
export interface RenderRange {
  from: number;
  to?: number;
}

export type RangeParseResult =
  | { ok: true; value: RenderRange | undefined }
  | { ok: false; message: string };

const RANGE_SOURCE_FILE = "compositions/__hf-range-source.html";
const TIME_RE = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/;

function parseTime(raw: string): number | undefined {
  const match = TIME_RE.exec(raw.trim());
  if (!match) return undefined;
  const minutes = match[1] ? Number(match[1]) : 0;
  return minutes * 60 + Number(match[2]);
}

/** Parse `--from` / `--to` (seconds, or m:ss). Neither flag means a full render. */
export function parseRenderRangeArgs(
  from: string | undefined,
  to: string | undefined,
): RangeParseResult {
  if (from == null && to == null) return { ok: true, value: undefined };
  const start = from == null ? 0 : parseTime(from);
  if (start === undefined) {
    return {
      ok: false,
      message: `Invalid --from "${from}". Use seconds (12.5) or m:ss (1:05).`,
    };
  }
  const end = to == null ? undefined : parseTime(to);
  if (to != null && end === undefined) {
    return {
      ok: false,
      message: `Invalid --to "${to}". Use seconds (12.5) or m:ss (1:05).`,
    };
  }
  if (end !== undefined && end <= start) {
    return {
      ok: false,
      message: `--to (${end}s) must be after --from (${start}s).`,
    };
  }
  return { ok: true, value: { from: start, to: end } };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Turn a root composition into a nested-composition template plus a host
 * index.html that plays it from `range.from` for the range length, so every
 * render stage (capture, audio, encode) sees an ordinary composition.
 */
export function buildRangeDocuments(
  sourceHtml: string,
  range: RenderRange,
): { index: string; source: string; duration: number } {
  const { document } = parseHTML(sourceHtml);
  const root = document.querySelector("[data-composition-id]");
  if (!root) throw new Error("The composition has no element with data-composition-id.");

  const total = Number(root.getAttribute("data-duration"));
  const hasTotal = Number.isFinite(total) && total > 0;
  if (!hasTotal && range.to === undefined) {
    throw new Error("The root composition has no data-duration. Pass --to.");
  }
  if (hasTotal && range.from >= total) {
    throw new Error(`--from (${range.from}s) is past the end of the composition (${total}s).`);
  }
  if (hasTotal && range.to !== undefined && range.to > total) {
    throw new Error(`--to (${range.to}s) is past the end of the composition (${total}s).`);
  }
  const duration = (range.to ?? total) - range.from;

  const headAssets = Array.from(
    document.querySelectorAll("head > script, head > style, head > link"),
  )
    .map((node) => node.outerHTML)
    .join("\n");
  const body = document.body?.innerHTML ?? root.outerHTML;
  const source = `<template>\n${headAssets}\n${body}\n</template>\n`;

  const meta = Array.from(document.querySelectorAll("head > meta"))
    .map((node) => node.outerHTML)
    .join("");
  const sizeAttrs = ["data-width", "data-height", "data-fps"]
    .map((name) => {
      const value = root.getAttribute(name);
      return value == null ? "" : ` ${name}="${escapeAttr(value)}"`;
    })
    .join("");
  const compositionId = escapeAttr(root.getAttribute("data-composition-id") ?? "main");
  const index = `<!doctype html>
<html>
<head>${meta}<style>html,body{margin:0;overflow:hidden}</style></head>
<body>
<div id="hf-range-root" data-composition-id="hf-range-root" data-no-timeline data-start="0" data-duration="${duration}"${sizeAttrs}>
<div id="hf-range-host" data-composition-id="${compositionId}" data-composition-src="${RANGE_SOURCE_FILE}" data-start="0" data-duration="${duration}" data-playback-start="${range.from}" data-track-index="0"${sizeAttrs}></div>
</div>
</body>
</html>
`;
  return { index, source, duration };
}

function linkEntries(fromDir: string, toDir: string, skip: Set<string>): void {
  for (const entry of readdirSync(fromDir)) {
    if (skip.has(entry)) continue;
    symlinkSync(join(fromDir, entry), join(toDir, entry));
  }
}

/**
 * Build a throwaway project next to the real one: every file is a symlink
 * except index.html (the range host) and the generated source template.
 * The temp folder keeps the project name so default output names match.
 */
export function prepareRangeProject(
  projectDir: string,
  entryFile: string | undefined,
  range: RenderRange,
): { dir: string; duration: number; cleanup: () => void } {
  const entry = entryFile ?? "index.html";
  if (dirname(entry) !== ".") {
    throw new Error("--from/--to only work with a composition file at the project root.");
  }
  const { index, source, duration } = buildRangeDocuments(
    readFileSync(join(projectDir, entry), "utf-8"),
    range,
  );

  const parent = mkdtempSync(join(tmpdir(), "hf-range-"));
  const cleanup = () => rmSync(parent, { recursive: true, force: true });
  try {
    const dir = join(parent, basename(projectDir));
    mkdirSync(dir);
    linkEntries(projectDir, dir, new Set(["index.html", entry, "compositions"]));
    const compositionsDir = join(projectDir, "compositions");
    mkdirSync(join(dir, "compositions"));
    if (lstatSync(compositionsDir, { throwIfNoEntry: false })?.isDirectory()) {
      linkEntries(compositionsDir, join(dir, "compositions"), new Set());
    }
    writeFileSync(join(dir, "index.html"), index);
    writeFileSync(join(dir, RANGE_SOURCE_FILE), source);
    return { dir, duration, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
