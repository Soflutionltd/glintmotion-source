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
/** One row of variable values per version, as `render --batch` reads it. */
export const SERIES_FILE = "series.json";
const ENTITIES = { "&quot;": '"', "&#39;": "'", "&apos;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" };

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

/** The variables a project declares on its root (`data-composition-variables`); [] when none. */
export function readVariables(dir) {
  let html;
  try {
    html = readFileSync(join(dir, "index.html"), "utf-8");
  } catch {
    return [];
  }
  const match = /data-composition-variables\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(html);
  if (!match) return [];
  const raw = (match[1] ?? match[2]).replace(/&(?:quot|#39|apos|lt|gt|amp);/g, (entity) => ENTITIES[entity]);
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((variable) => typeof variable?.id === "string") : [];
  } catch {
    return [];
  }
}

/** The versions of a series project, one object of variable values each. Throws on a malformed file. */
export function loadSeries(dir) {
  const file = join(dir, SERIES_FILE);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch (error) {
    throw new Error(`${SERIES_FILE} illisible : ${error.message}`);
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${SERIES_FILE} ne contient aucune version.`);
  const bad = rows.findIndex((row) => typeof row !== "object" || row === null || Array.isArray(row));
  if (bad !== -1) throw new Error(`${SERIES_FILE} : la version ${bad + 1} n'est pas un objet de variables.`);
  if (rows.length > MAX_SERIES) throw new Error(`${rows.length} versions : ${MAX_SERIES} au plus par série.`);
  return rows;
}

export function seriesCount(dir) {
  if (!existsSync(join(dir, SERIES_FILE))) return 0;
  try {
    return loadSeries(dir).length;
  } catch {
    return 0;
  }
}

/** Exported files are named after each version when every name is a distinct plain file name. */
export function seriesOutputKey(rows) {
  const names = rows.map((row) => (typeof row.name === "string" ? row.name.trim() : ""));
  const plain = names.every((name) => name && !/[/\\:]/.test(name) && !name.startsWith("."));
  return plain && new Set(names).size === names.length ? "name" : "index";
}

function describeVariable(variable) {
  const options = Array.isArray(variable.options)
    ? `choix : ${variable.options.map((option) => option?.value ?? option).join(", ")}`
    : (variable.type ?? "string");
  const fallback =
    typeof variable.default === "string" && variable.default
      ? `Défaut : ${variable.default}`
      : "Vide : texte du modèle";
  return `- ${variable.id} (${options}) — ${variable.label ?? variable.id}. ${fallback}.`;
}

/** What the agent receives when a series of a template that declares variables opens. */
export function seriesPrompt(templateName, briefs, variables) {
  return [
    `Ce projet est une copie du modèle « ${templateName} », pour une série de ${briefs.length} version${briefs.length > 1 ? "s" : ""}. Ne modifie pas index.html : le design et les animations restent ceux du modèle. Chaque version est une ligne de ${SERIES_FILE}, qui ne remplit que ces variables :`,
    "",
    ...variables.map(describeVariable),
    "",
    `Écris ${SERIES_FILE} : {"rows": [{"name": "…", "<variable>": "…"}, …]}, une ligne par version, dans l'ordre ci-dessous. \`name\` est court et unique : il nomme le fichier exporté. N'écris que les variables qui changent.`,
    "",
    ...briefs.flatMap((brief, index) => [`Version ${index + 1} :`, brief, ""]),
    "Ensuite :",
    `1. \`glintmotion compare . --batch ${SERIES_FILE} --at <3 à 6 instants où les textes sont affichés> --out snapshots/series.jpg --json\` : regarde la planche, et réécris les phrases que \`repeated\` signale dans plusieurs versions.`,
    "2. Pour chaque ligne, `glintmotion check --json --variables '<la ligne en JSON>'` : chaque titre doit tenir dans son cadre.",
    "Ne lance pas l'export : la personne exporte la série depuis l'accueil.",
  ].join("\n");
}
