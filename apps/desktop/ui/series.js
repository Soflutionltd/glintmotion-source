// A project whose series.json lists versions: its card offers to export them all at once.
// Loaded before app.js, whose cards send "project-card"; uses api, showToast and cleanError from it.

const POLL_MS = 1500;
/** project path -> its card's series line; Home re-renders cards, so the latest one wins. */
const seriesRows = new Map();
const exporting = new Set();

function seriesText(count) {
  return `Série · ${count} version${count > 1 ? "s" : ""}`;
}

function setSeriesLine(path, text, running) {
  const row = seriesRows.get(path);
  if (!row) return;
  row.querySelector(".card-series-text").textContent = text;
  row.querySelector(".card-series-action").disabled = running;
}

async function followSeriesExport(path, count) {
  const job = await api.series.status(path).catch(() => null);
  if (job?.status === "running") {
    setSeriesLine(path, `Export… ${Math.round(job.progress ?? 0)} %`, true);
    setTimeout(() => followSeriesExport(path, count), POLL_MS);
    return;
  }
  exporting.delete(path);
  setSeriesLine(path, seriesText(count), false);
  if (job?.status === "done") {
    const failed = job.failed?.length ?? 0;
    const made = job.outputs?.length ?? 0;
    showToast(
      failed ? `${made} vidéos exportées, ${failed} en échec.` : `Série exportée : ${made} vidéos.`,
      failed ? undefined : "done",
    );
    api.series.reveal(path);
  } else if (job?.status === "failed") {
    showToast(job.error ?? "L'export de la série a échoué.");
  }
}

function showSeries(card, project) {
  const row = card.querySelector(".card-series");
  if (!project.series) return;
  row.hidden = false;
  seriesRows.set(project.path, row);
  const running = exporting.has(project.path);
  setSeriesLine(project.path, running ? "Export…" : seriesText(project.series), running);
  row.querySelector(".card-series-action").addEventListener("click", async () => {
    exporting.add(project.path);
    setSeriesLine(project.path, "Export…", true);
    try {
      await api.series.export(project.path);
    } catch (error) {
      exporting.delete(project.path);
      setSeriesLine(project.path, seriesText(project.series), false);
      showToast(cleanError(error));
      return;
    }
    followSeriesExport(project.path, project.series);
  });
}

document.addEventListener("project-card", (event) => showSeries(event.target, event.detail));
