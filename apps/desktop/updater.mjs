export const UPDATE_BASE = "https://glintmotion-updates.soflution.com";
export const FEED_URL = `${UPDATE_BASE}/stable/releases.json`;
export const WHATS_NEW_URL = `${UPDATE_BASE}/stable/whats-new.json`;

const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const RESTART_POLL_MS = 10_000;
// Long enough that someone reading the preview or thinking over a change is not "away".
export const IDLE_BEFORE_RESTART_S = 45;

/**
 * @typedef {{ status: "off" | "idle" | "checking" | "downloading" | "ready" | "failed",
 *   version: string | null, error: string | null }} UpdateState
 */

/**
 * Downloads updates in the background and restarts into them only once nothing would be
 * lost: `isBusy()` false (no agent, render, export or playback) and no input for
 * IDLE_BEFORE_RESTART_S. `prepareRestart` saves where the person is before the quit.
 *
 * @param {{
 *   updater: Pick<import("electron").AutoUpdater, "setFeedURL" | "on" | "checkForUpdates" | "quitAndInstall">,
 *   enabled: boolean,
 *   isBusy: () => boolean,
 *   idleSeconds: () => number,
 *   prepareRestart: (version: string | null) => Promise<void>,
 *   onState: (state: UpdateState) => void,
 * }} options
 */
export function createUpdater({ updater, enabled, isBusy, idleSeconds, prepareRestart, onState }) {
  /** @type {UpdateState} */
  let state = { status: enabled ? "idle" : "off", version: null, error: null };
  let restarting = false;
  const set = (next) => {
    state = { ...state, ...next };
    onState(state);
  };

  async function restartNow() {
    if (restarting || state.status !== "ready") return;
    restarting = true;
    try {
      await prepareRestart(state.version);
      updater.quitAndInstall();
    } catch (error) {
      restarting = false;
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** The "Redémarrer maintenant" button: never cuts an agent run, a render or an export short. */
  async function requestRestart() {
    if (state.status !== "ready") return;
    if (isBusy()) {
      set({ error: "un travail est en cours, Glintmotion redémarrera dès qu'il sera fini" });
      return;
    }
    await restartNow();
  }

  function check() {
    if (state.status === "idle" || state.status === "failed") updater.checkForUpdates();
  }

  function start() {
    if (!enabled) return;
    updater.setFeedURL({ url: FEED_URL, serverType: "json" });
    updater.on("checking-for-update", () => set({ status: "checking", error: null }));
    updater.on("update-available", () => set({ status: "downloading" }));
    updater.on("update-not-available", () => set({ status: "idle" }));
    updater.on("update-downloaded", (_event, _notes, name) => set({ status: "ready", version: name || null }));
    updater.on("error", (error) => {
      // A failed check (offline, server down) retries on the next round without a word;
      // a download that started and failed is something the person was told about.
      if (state.status === "ready") set({ error: error.message });
      else set({ status: state.status === "downloading" ? "failed" : "idle", error: error.message });
    });
    setTimeout(check, FIRST_CHECK_MS);
    setInterval(check, CHECK_EVERY_MS);
    setInterval(() => {
      if (state.status === "ready" && !isBusy() && idleSeconds() >= IDLE_BEFORE_RESTART_S) void restartNow();
    }, RESTART_POLL_MS);
  }

  return { start, requestRestart, state: () => state };
}
