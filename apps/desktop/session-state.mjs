import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Beyond this, the file is from a restart that never came back (crash, forced quit), and
// reopening that project out of nowhere days later would surprise more than help.
const RESUME_MAX_AGE_MS = 15 * 60 * 1000;

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/** Where the person was when an update restarted the app: project folder and studio URL hash. */
export function writeResume(file, { dir, hash, now = Date.now() }) {
  writeJson(file, { dir, hash, savedAt: now });
}

/** Reads and removes the resume point, so a later ordinary launch opens Home as usual. */
export function takeResume(file, now = Date.now()) {
  const value = readJson(file);
  rmSync(file, { force: true });
  if (!value || typeof value.dir !== "string" || typeof value.savedAt !== "number") return null;
  if (now - value.savedAt > RESUME_MAX_AGE_MS) return null;
  if (!existsSync(join(value.dir, "index.html"))) return null;
  const hash = typeof value.hash === "string" && value.hash.startsWith("#project/") ? value.hash : "";
  return { dir: value.dir, hash };
}

/** A Map kept in a JSON file, for state that must outlive the app: one value per project folder. */
export function createPersistentMap(file) {
  const stored = readJson(file);
  const map = new Map(stored && typeof stored === "object" ? Object.entries(stored) : []);
  const save = () => writeJson(file, Object.fromEntries(map));
  return {
    get: (key) => map.get(key),
    set(key, value) {
      if (map.get(key) === value) return;
      map.set(key, value);
      save();
    },
    delete(key) {
      if (map.delete(key)) save();
    },
    clear() {
      if (map.size === 0) return;
      map.clear();
      save();
    },
  };
}

/** Negative, zero or positive as `a` is older than, the same as or newer than `b` (x.y.z). */
export function compareVersions(a, b) {
  const parts = (version) => String(version).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The version whose notes the person last saw; null on the first launch ever. */
export function readSeenVersion(file) {
  const version = readJson(file)?.version;
  return typeof version === "string" ? version : null;
}

export function writeSeenVersion(file, version) {
  writeJson(file, { version });
}

/**
 * @typedef {{ version: string, date: string, title: string, summary: string,
 *   improved: string[], fixed: string[], video: string | null }} WhatsNewEntry
 */

/** Entries newer than `since` and no newer than `current`, newest first. */
export function entriesSince(entries, since, current) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => typeof entry?.version === "string")
    .filter((entry) => compareVersions(entry.version, current) <= 0)
    .filter((entry) => since == null || compareVersions(entry.version, since) > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}
