import { existsSync } from "node:fs";
import { join } from "node:path";

/** Each clip is a registry block; its preview lives in ui/first-video/<block>.mp4. */
export const FIRST_VIDEO_PARTS = [
  {
    id: "hook",
    label: "Accroche",
    hint: "Capter l'attention dès les premières secondes",
    clips: [
      { block: "glass-shard-title", title: "Titre en éclats de verre" },
      { block: "wireframe-portal-title", title: "Titre qui traverse un portail" },
      { block: "canopy-part-title", title: "Titre sous les feuillages" },
      { block: "frost-sequence-camera-orbit", title: "Mots en particules de givre" },
    ],
  },
  {
    id: "proof",
    label: "Preuve",
    hint: "Montrer le produit au travail",
    clips: [
      { block: "app-showcase", title: "App sur trois téléphones" },
      { block: "ui-3d-reveal", title: "Interface qui se déplie en 3D" },
      { block: "vfx-iphone-device", title: "iPhone et MacBook" },
      { block: "data-chart", title: "Graphique qui monte" },
    ],
  },
  {
    id: "turn",
    label: "Bascule",
    hint: "Passer du problème à la réponse",
    clips: [
      { block: "vfx-shatter", title: "L'ancien message vole en éclats" },
      { block: "x-post", title: "Le post qui pose le problème" },
      { block: "cross-warp-morph", title: "Une scène se tord en la suivante" },
    ],
  },
  {
    id: "cta",
    label: "Appel à l'action",
    hint: "Poser la marque et ce qu'on demande",
    clips: [
      { block: "logo-outro", title: "Logo et signature" },
      { block: "instagram-follow", title: "Bouton « Suivre »" },
    ],
  },
];

const RESOLUTIONS = ["portrait", "landscape", "square"];
const MAX_TEXT = 2_000;
const DOMAIN = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i;

/** A site gives the agent fonts, colors and logo; anything else is an idea in words. */
export function readSiteOrIdea(value) {
  const text = String(value ?? "").trim();
  if (!text) return { site: null, idea: null };
  if (text.length > MAX_TEXT) throw new Error(`Texte trop long : ${MAX_TEXT} caractères au plus.`);
  if (!DOMAIN.test(text)) return { site: null, idea: text };
  const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  return { site: url.href, idea: null };
}

function nameFrom({ site, idea }) {
  if (site) return new URL(site).hostname.replace(/^www\./, "").split(".")[0];
  return String(idea ?? "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .slice(0, 5)
    .join(" ");
}

/** A folder name createProject accepts, not yet taken in `parent`. */
export function projectNameFor({ site, idea, parent }) {
  const base = nameFrom({ site, idea }).slice(0, 40).trim() || "Ma vidéo";
  let name = base;
  for (let n = 2; existsSync(join(parent, name)); n++) name = `${base} ${n}`;
  return name;
}

export function checkResolution(resolution) {
  if (!RESOLUTIONS.includes(resolution)) throw new Error(`Format inconnu : ${resolution}`);
  return resolution;
}

function pickedClips(picks) {
  return FIRST_VIDEO_PARTS.map((part) => {
    const clip = part.clips.find((candidate) => candidate.block === picks?.[part.id]);
    if (!clip) throw new Error(`Choisis un extrait pour « ${part.label} ».`);
    return { part, clip };
  });
}

/** What the agent receives from the four-part card. */
export function firstVideoPrompt({ picks, site, idea }) {
  if (!site && !idea) throw new Error("Indique ton site ou décris ton idée.");
  const lines = ["Crée une vidéo de lancement de 15 à 20 secondes, en quatre parties et dans cet ordre :"];
  pickedClips(picks).forEach(({ part, clip }, index) => {
    lines.push(
      `${index + 1}. ${part.label} (${part.hint.toLowerCase()}) : pars du bloc ${clip.block}, à installer avec \`glintmotion add ${clip.block}\`.`,
    );
  });
  if (site) {
    lines.push(
      `La marque : ${site}. Lance \`glintmotion capture ${site} --skip-vision --json\` et reprends ses polices, ses couleurs, son logo et ses vrais textes.`,
    );
  }
  if (idea) lines.push(`Le sujet : ${idea}`);
  lines.push(
    "Adapte chaque bloc au format de ce projet et à la marque, remplace tous les textes d'exemple, enchaîne les quatre parties sans coupure sèche, puis vérifie avec `glintmotion check --json`.",
  );
  return lines.join("\n");
}
