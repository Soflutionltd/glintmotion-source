import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Engine state, caches and renders belong to the source project: a new version starts from
// its source files alone.
const SKIPPED = new Set([
  ".hyperframes",
  ".waveform-cache",
  "renders",
  "snapshots",
  "node_modules",
  ".git",
  ".DS_Store",
  ".check.json",
]);
export const MAX_SERIES = 12;
const MAX_BRIEF = 2_000;

function readList(file) {
  try {
    const list = JSON.parse(readFileSync(file, "utf-8"));
    return Array.isArray(list) ? list.filter((dir) => typeof dir === "string") : [];
  } catch {
    return [];
  }
}

/** Template folders, newest first, without the ones deleted or moved since. */
export function readTemplates(file) {
  return readList(file).filter((dir) => existsSync(join(dir, "index.html")));
}

export function setTemplate(file, dir, isTemplate) {
  if (isTemplate && !existsSync(join(dir, "index.html"))) {
    throw new Error(`${basename(dir)} n'est pas un projet Glintmotion (pas de index.html).`);
  }
  const list = readList(file).filter((entry) => entry !== dir);
  if (isTemplate) list.unshift(dir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(list, null, 2));
}

/** One brief, or with `series` one per paragraph (a blank line between two versions). */
export function splitBriefs(text, series) {
  const value = String(text ?? "").trim();
  if (!value) throw new Error("Écris ce que doit dire la nouvelle version.");
  const briefs = series
    ? value
        .split(/\n\s*\n/)
        .map((brief) => brief.trim())
        .filter(Boolean)
    : [value];
  if (briefs.length > MAX_SERIES) {
    throw new Error(`${briefs.length} versions : ${MAX_SERIES} au plus par série.`);
  }
  const long = briefs.findIndex((brief) => brief.length > MAX_BRIEF);
  if (long !== -1) {
    throw new Error(`Version ${long + 1} trop longue : ${MAX_BRIEF} caractères au plus.`);
  }
  return briefs;
}

/** What the agent receives when a version of a template opens. */
export function templatePrompt(templateName, brief) {
  return [
    `Ce projet est une copie du modèle « ${templateName} ». Garde son design : palette, polices, mise en page, rythme et animations. Remplace tout le contenu par celui-ci :`,
    "",
    brief,
    "",
    "Si ce contenu demande plus ou moins de slides ou de scènes, duplique ou supprime celles du modèle en gardant leur style, et recale les débuts et les durées. Après chaque changement de texte, vérifie que les titres tiennent dans leur cadre, puis lance `glintmotion check --json`.",
  ].join("\n");
}

export function copyTemplate(source, dest) {
  if (existsSync(dest)) throw new Error(`Le dossier ${dest} existe déjà.`);
  cpSync(source, dest, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (path) => !SKIPPED.has(basename(path)),
  });
}
