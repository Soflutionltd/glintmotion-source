const api = window.glintmotion;

const grid = document.getElementById("project-grid");
const emptyState = document.getElementById("empty-state");
const busy = document.getElementById("busy");
const busyText = document.getElementById("busy-text");
const toast = document.getElementById("toast");
const dialog = document.getElementById("new-dialog");
const form = document.getElementById("new-form");
const parentLabel = document.getElementById("new-parent");
const formError = document.getElementById("new-error");
const cardTemplate = document.getElementById("card-template");

let newParent = "";
let toastTimer = 0;

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 8000);
}

function showPath(dir) {
  parentLabel.textContent = `\u200e${dir}\u200e`;
}

function setBusy(text) {
  busyText.textContent = text ?? "";
  busy.hidden = !text;
}

function cleanError(error) {
  return String(error?.message ?? error).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    "",
  );
}

function relativeTime(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `il y a ${days} j`;
  return new Date(iso).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function metaLine(project) {
  const parts = [];
  if (project.width && project.height) parts.push(`${project.width}×${project.height}`);
  if (project.duration) parts.push(`${Math.round(project.duration * 10) / 10} s`);
  if (project.videos) parts.push(`${project.videos} vidéo${project.videos > 1 ? "s" : ""}`);
  if (project.audios) parts.push(`${project.audios} son${project.audios > 1 ? "s" : ""}`);
  return parts.join(" · ") || "Composition HTML";
}

function frameSize(project) {
  const max = 108;
  if (!project.width || !project.height) return { width: 96, height: 96 };
  const ratio = project.width / project.height;
  return ratio >= 1
    ? { width: Math.round(max * 1.5), height: Math.round((max * 1.5) / ratio) }
    : { width: Math.round(max * ratio * 1.25), height: Math.round(max * 1.25) };
}

async function openProject(dir) {
  setBusy("Ouverture du studio…");
  try {
    await api.openProject(dir);
  } catch (error) {
    setBusy(null);
    showToast(cleanError(error));
  }
}

function renderSidebar(projects) {
  document.getElementById("project-count").textContent = projects.length
    ? String(projects.length)
    : "";
  const list = document.getElementById("recent-list");
  list.replaceChildren();
  if (projects.length === 0) {
    const empty = document.createElement("li");
    empty.className = "recents-empty";
    empty.textContent = "Aucun projet récent";
    list.append(empty);
    return;
  }
  for (const project of projects.slice(0, 12)) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "recent-item";
    button.title = project.path;
    const dot = document.createElement("span");
    dot.className = "recent-dot";
    const name = document.createElement("span");
    name.textContent = project.name;
    button.append(dot, name);
    button.addEventListener("click", () => openProject(project.path));
    item.append(button);
    list.append(item);
  }
}

function renderProjects(projects) {
  renderSidebar(projects);
  grid.replaceChildren();
  emptyState.hidden = projects.length > 0;
  grid.hidden = projects.length === 0;
  for (const project of projects) {
    const card = cardTemplate.content.firstElementChild.cloneNode(true);
    card.querySelector(".card-title").textContent = project.name;
    card.querySelector(".card-meta").textContent = metaLine(project);
    card.querySelector(".card-time").textContent = `Ouvert ${relativeTime(project.openedAt)}`;
    card.title = project.path;
    const frame = card.querySelector(".frame");
    const size = frameSize(project);
    frame.style.width = `${size.width}px`;
    frame.style.height = `${size.height}px`;
    card.querySelector(".card-open").addEventListener("click", () => openProject(project.path));
    card
      .querySelector('[data-tool="reveal"]')
      .addEventListener("click", () => api.revealProject(project.path));
    card.querySelector('[data-tool="forget"]').addEventListener("click", async () => {
      await api.forgetProject(project.path);
      await loadProjects();
    });
    grid.append(card);
  }
}

async function loadProjects() {
  try {
    renderProjects(await api.listProjects());
  } catch (error) {
    showToast(cleanError(error));
  }
}

async function openFolder() {
  const dir = await api.pickFolder("open");
  if (dir) await openProject(dir);
}

async function startNewProject(format = "portrait") {
  newParent = await api.defaultParent();
  showPath(newParent);
  form.reset();
  form.elements.resolution.value = format;
  formError.hidden = true;
  dialog.showModal();
  form.elements.name.focus();
}

function showView(name) {
  document.querySelectorAll(".nav-item[data-view]").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.view === name);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("is-active", view.id === `view-${name}`);
  });
  document.querySelector("main").scrollTop = 0;
}

document.querySelectorAll(".nav-item[data-view]").forEach((item) => {
  item.addEventListener("click", () => showView(item.dataset.view));
});
document.querySelectorAll(".quick-card[data-format]").forEach((card) => {
  card.addEventListener("click", () => startNewProject(card.dataset.format));
});

document.getElementById("open-folder").addEventListener("click", openFolder);
document.getElementById("side-open").addEventListener("click", openFolder);
document.getElementById("side-new").addEventListener("click", () => startNewProject());
document.getElementById("cancel-new").addEventListener("click", () => dialog.close());
document.getElementById("change-parent").addEventListener("click", async () => {
  const dir = await api.pickFolder("parent");
  if (dir) {
    newParent = dir;
    showPath(dir);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const confirm = document.getElementById("confirm-new");
  formError.hidden = true;
  confirm.disabled = true;
  confirm.textContent = "Création…";
  try {
    await api.createProject({
      name: form.elements.name.value,
      resolution: form.elements.resolution.value,
      parent: newParent,
    });
  } catch (error) {
    formError.textContent = cleanError(error);
    formError.hidden = false;
    confirm.disabled = false;
    confirm.textContent = "Créer";
  }
});

loadProjects();
if (location.hash === "#new") {
  history.replaceState(null, "", location.pathname);
  startNewProject();
}
