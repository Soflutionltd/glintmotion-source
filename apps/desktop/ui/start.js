// Home's two ways to start a video: the prompt box, and the four-part card.
// Uses api, setBusy and cleanError from app.js.

const composer = document.getElementById("composer");
const fvForm = document.getElementById("fv-form");
const fvParts = document.getElementById("fv-parts");
const fvTemplate = document.getElementById("fv-part-template");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** part id -> picked block */
const picks = {};
let parts = [];

function partItem(part) {
  return fvParts.querySelector(`[data-part="${part.id}"]`);
}

function pickedIndex(part) {
  return part.clips.findIndex((clip) => clip.block === picks[part.id]);
}

function showClip(part, index) {
  const clip = part.clips[index];
  picks[part.id] = clip.block;
  const item = partItem(part);
  const video = item.querySelector("video");
  video.src = `first-video/${clip.block}.mp4`;
  if (!reduceMotion.matches) video.play().catch(() => {});
  item.querySelector(".fv-clip-title").textContent = clip.title;
  item.querySelector(".fv-count").textContent = `${index + 1}/${part.clips.length}`;
}

function randomOther(part) {
  const current = pickedIndex(part);
  if (part.clips.length < 2) return 0;
  const index = Math.floor(Math.random() * (part.clips.length - 1));
  return index >= current ? index + 1 : index;
}

function renderParts() {
  fvParts.replaceChildren();
  parts.forEach((part, position) => {
    const item = fvTemplate.content.firstElementChild.cloneNode(true);
    item.dataset.part = part.id;
    item.querySelector(".fv-num").textContent = String(position + 1);
    item.querySelector(".fv-label").textContent = part.label;
    item.querySelector(".fv-hint").textContent = part.hint;
    const swap = item.querySelector(".fv-swap");
    swap.setAttribute("aria-label", `Autre extrait pour « ${part.label} »`);
    swap.title = "Autre extrait";
    swap.addEventListener("click", () =>
      showClip(part, (pickedIndex(part) + 1) % part.clips.length),
    );
    const video = item.querySelector("video");
    item.addEventListener(
      "pointerenter",
      () => reduceMotion.matches && video.play().catch(() => {}),
    );
    item.addEventListener("pointerleave", () => reduceMotion.matches && video.pause());
    fvParts.append(item);
    showClip(part, 0);
  });
}

async function startProject(form, request) {
  const error = (form.closest(".first-video") ?? form).querySelector(".form-error");
  const submit = form.querySelector('[type="submit"]');
  error.hidden = true;
  submit.disabled = true;
  setBusy("Création du projet…");
  try {
    await api.start.project(request);
  } catch (reason) {
    setBusy(null);
    error.textContent = cleanError(reason);
    error.hidden = false;
    submit.disabled = false;
  }
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  startProject(composer, {
    text: composer.elements.text.value,
    resolution: composer.elements.resolution.value,
  });
});
composer.elements.text.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

fvForm.addEventListener("submit", (event) => {
  event.preventDefault();
  startProject(fvForm, {
    text: fvForm.elements.text.value,
    resolution: fvForm.elements.resolution.value,
    picks: { ...picks },
  });
});

document.getElementById("fv-shuffle").addEventListener("click", () => {
  for (const part of parts) showClip(part, randomOther(part));
});

api.start
  .firstVideoParts()
  .then((list) => {
    parts = list;
    renderParts();
  })
  .catch((reason) => showToast(cleanError(reason)));
