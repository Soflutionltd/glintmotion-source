import { BrowserWindow, ipcMain, net } from "electron";
import { join } from "node:path";
import { compareVersions, entriesSince, readSeenVersion, writeSeenVersion } from "./session-state.mjs";
import { UPDATE_BASE, WHATS_NEW_URL } from "./updater.mjs";

/** @returns {Promise<import("./session-state.mjs").WhatsNewEntry[]>} */
async function fetchEntries() {
  const response = await net.fetch(WHATS_NEW_URL, { cache: "no-cache" });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Les notes de version n'ont pas pu être chargées (HTTP ${response.status}).`);
  const entries = await response.json();
  if (!Array.isArray(entries)) throw new Error("Les notes de version sont illisibles.");
  return entries.map((entry) => ({ ...entry, video: entry.video ? new URL(entry.video, `${UPDATE_BASE}/`).href : null }));
}

/**
 * The "Quoi de neuf" window: after an update, the notes of every version since the one the
 * person last saw; from the Help menu, all of them.
 */
export function createWhatsNew({ here, parent, version, seenFile }) {
  /** @type {BrowserWindow | null} */
  let window = null;
  let shown = { current: version, since: null, entries: [] };

  ipcMain.handle("whatsNew:data", () => shown);
  ipcMain.handle("whatsNew:close", () => window?.close());

  function open(entries, since) {
    shown = { current: version, since, entries };
    if (window) {
      window.webContents.reload();
      window.focus();
      return;
    }
    window = new BrowserWindow({
      width: 620,
      height: 780,
      minWidth: 480,
      minHeight: 480,
      title: "Quoi de neuf",
      backgroundColor: "#fafaf8",
      parent: parent() ?? undefined,
      fullscreenable: false,
      webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
    });
    window.on("closed", () => (window = null));
    window.loadFile(join(here, "ui", "whats-new.html"));
  }

  /** On launch: opens only when this version is newer than the last one whose notes were seen. */
  async function showIfUpdated() {
    const seen = readSeenVersion(seenFile);
    if (seen == null) {
      writeSeenVersion(seenFile, version);
      return;
    }
    if (compareVersions(version, seen) <= 0) return;
    // Recorded only once the notes arrived: offline at launch, they show on the next one.
    const entries = entriesSince(await fetchEntries(), seen, version);
    writeSeenVersion(seenFile, version);
    if (entries.length > 0) open(entries, seen);
  }

  async function showAll() {
    open(entriesSince(await fetchEntries(), null, version), null);
  }

  return { showIfUpdated, showAll };
}
