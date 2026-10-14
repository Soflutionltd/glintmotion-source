// Home's templates: any project marked as one, and new versions that keep its design.
// Loaded before app.js, whose project list sends "templates-loaded"; uses api, setBusy,
// cleanError, openProject, loadProjects, cardTemplate, metaLine and frameSize from it.

const templatesSection = document.getElementById("templates");
const templateGrid = document.getElementById("template-grid");
const templateDialog = document.getElementById("template-dialog");
const templateForm = document.getElementById("template-form");
const templateError = templateForm.querySelector(".form-error");
let templateDir = "";

function openTemplateDialog(template) {
  templateDir = template.path;
  document.getElementById("template-name").textContent = template.name;
  templateForm.reset();
  templateError.hidden = true;
  templateDialog.showModal();
  templateForm.elements.text.focus();
}

function renderTemplates(templates) {
  templatesSection.hidden = templates.length === 0;
  templateGrid.replaceChildren();
  for (const template of templates) {
    const card = cardTemplate.content.firstElementChild.cloneNode(true);
    card.querySelector(".card-title").textContent = template.name;
    card.querySelector(".card-meta").textContent = metaLine(template);
    card.querySelector(".card-time").textContent = "Nouvelle version";
    card.title = template.path;
    const frame = card.querySelector(".frame");
    const size = frameSize(template);
    frame.style.width = `${size.width}px`;
    frame.style.height = `${size.height}px`;
    card.querySelector(".card-open").addEventListener("click", () => openTemplateDialog(template));
    const edit = card.querySelector('[data-tool="reveal"]');
    edit.textContent = "Modifier";
    edit.addEventListener("click", () => openProject(template.path));
    const remove = card.querySelector('[data-tool="template"]');
    remove.textContent = "Retirer le modèle";
    remove.addEventListener("click", async () => {
      await api.templates.set(template.path, false);
      await loadProjects();
    });
    card.querySelector('[data-tool="forget"]').remove();
    templateGrid.append(card);
  }
}

templateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  templateError.hidden = true;
  const series = templateForm.elements.series.checked;
  // The busy overlay sits under a modal dialog's top layer.
  templateDialog.close();
  setBusy(series ? "Création de la série…" : "Création de la version…");
  try {
    await api.templates.use({ dir: templateDir, text: templateForm.elements.text.value, series });
  } catch (error) {
    setBusy(null);
    templateError.textContent = cleanError(error);
    templateError.hidden = false;
    templateDialog.showModal();
  }
});

document.getElementById("cancel-template").addEventListener("click", () => templateDialog.close());
document.addEventListener("templates-loaded", (event) => renderTemplates(event.detail));
