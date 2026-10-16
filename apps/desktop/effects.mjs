import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The Glintmotion Effects catalog, in the HyperFrames registry format. */
export const EFFECTS_REGISTRY = "https://raw.githubusercontent.com/Soflutionltd/glintmotion-effects/main";
export const EFFECTS_CACHE_HOURS = 24;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * The catalog index (catalog.json), fetched at most once a day. When the network
 * fails the last copy on disk is used, so search keeps working offline.
 */
export async function loadEffectsCatalog({ cacheFile, fetchImpl = fetch, now = Date.now() } = {}) {
  const cached = cacheFile && existsSync(cacheFile) ? readCache(cacheFile) : null;
  const fresh = cached && now - statSync(cacheFile).mtimeMs < EFFECTS_CACHE_HOURS * 3_600_000;
  if (fresh) return { items: cached.items, source: "cache" };
  try {
    const response = await fetchImpl(`${EFFECTS_REGISTRY}/catalog.json`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`catalog.json answered ${response.status}`);
    const catalog = await response.json();
    if (!Array.isArray(catalog?.items)) throw new Error("catalog.json has no items");
    if (cacheFile) {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(catalog));
    }
    return { items: catalog.items, source: "network" };
  } catch (error) {
    if (cached) return { items: cached.items, source: "offline cache", warning: error.message };
    throw new Error(`The effects catalog is unreachable and not cached yet: ${error.message}`);
  }
}

function readCache(file) {
  try {
    const catalog = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(catalog?.items) ? catalog : null;
  } catch {
    return null;
  }
}

const words = (value) =>
  String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Items matching every query word (name, title, description, tags), best first. */
export function searchEffects(items, { query, tag, limit = 40 } = {}) {
  const terms = words(query);
  const wanted = tag ? String(tag).toLowerCase() : null;
  const scored = [];
  for (const item of items) {
    const tags = (item.tags ?? []).map((t) => String(t).toLowerCase());
    if (wanted && !tags.includes(wanted)) continue;
    const name = words(item.name);
    const title = words(item.title);
    const rest = new Set([...words(item.description), ...tags.flatMap(words)]);
    let score = 0;
    let matchesAll = true;
    for (const term of terms) {
      const hit = (list) => list.some((w) => w === term || w.startsWith(term));
      if (hit(name)) score += 3;
      else if (hit(title)) score += 2;
      else if ([...rest].some((w) => w === term || w.startsWith(term))) score += 1;
      else matchesAll = false;
    }
    if (matchesAll) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  return { total: scored.length, items: scored.slice(0, limit).map(({ item }) => item) };
}

/** Engine args that install `name` from the effects catalog into the project in `cwd`. */
export function addEffectArgs(name) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(name ?? ""))) {
    throw new Error("name must be an effect name from glintmotion_effects, e.g. gl-cube.");
  }
  return ["add", name, "--registry", EFFECTS_REGISTRY, "--json", "--no-clipboard"];
}
