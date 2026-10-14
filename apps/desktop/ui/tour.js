// The guided tour of Home: on the very first launch, and from Help > Visite guidée (#tour).

const TOUR_SEEN_KEY = "glintmotion.tourSeen";

/** `target` is a selector on Home; a step without one is a card in the middle of the window. */
const TOUR_STEPS = [
  {
    target: "#composer",
    title: "Décris ta vidéo",
    text: "Le produit, le message, le ton, la durée. Glintmotion crée le projet et l'agent écrit la vidéo pendant que tu regardes.",
  },
  {
    target: ".first-video",
    title: "Ou pars d'un montage",
    text: "Quatre parties tirées de vraies vidéos de lancement. Donne ton site : l'agent reprend tes couleurs, tes polices et ton logo.",
  },
  {
    target: "#templates:not([hidden]), #project-grid:not([hidden])",
    title: "Tes modèles",
    text: "Sur la carte d'un projet, « Faire un modèle ». Chaque nouvelle version garde son design, et une série crée une semaine de posts d'un coup.",
  },
  {
    target: "#side-connect",
    title: "Branche ton agent",
    text: "Cursor ou Claude Code peuvent aussi piloter Glintmotion : créer un projet, le retoucher, l'exporter.",
  },
  {
    target: null,
    title: "Dans le studio",
    text: "La timeline en bas, l'agent à droite : tape @ pour lui montrer un fichier. « Capture » enregistre l'image affichée, « Export » la vidéo.",
  },
];

let tourIndex = -1;
let tourCard = null;
let tourTarget = null;

function tourElement() {
  const card = document.createElement("div");
  card.className = "tour-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "false");
  card.setAttribute("aria-labelledby", "tour-title");
  card.innerHTML = `
    <p class="tour-step"></p>
    <h2 id="tour-title"></h2>
    <p class="tour-text"></p>
    <div class="tour-actions">
      <button type="button" class="btn btn-secondary btn-small" data-tour="skip">Passer</button>
      <button type="button" class="btn btn-primary btn-small" data-tour="next"></button>
    </div>`;
  card.querySelector('[data-tour="skip"]').addEventListener("click", endTour);
  card.querySelector('[data-tour="next"]').addEventListener("click", () => showStep(tourIndex + 1));
  return card;
}

function placeCard(target) {
  const card = tourCard;
  card.classList.toggle("is-centered", !target);
  if (!target) {
    card.style.left = "";
    card.style.top = "";
    return;
  }
  const box = target.getBoundingClientRect();
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  const margin = 16;
  // Clears the target's outline (6px offset) and its 10px halo.
  const gap = 28;
  const below = box.bottom + gap + height <= window.innerHeight;
  const beside = box.right + gap + width <= window.innerWidth;
  let left = below ? box.left : beside ? box.right + gap : box.left;
  let top = below ? box.bottom + gap : beside ? box.top : box.top - height - gap;
  left = Math.min(Math.max(margin, left), window.innerWidth - width - margin);
  top = Math.min(Math.max(margin, top), window.innerHeight - height - margin);
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function showStep(index) {
  tourTarget?.classList.remove("tour-target");
  if (index >= TOUR_STEPS.length) {
    endTour();
    return;
  }
  tourIndex = index;
  const step = TOUR_STEPS[index];
  tourTarget = step.target ? document.querySelector(step.target) : null;
  tourCard.querySelector(".tour-step").textContent = `${index + 1} sur ${TOUR_STEPS.length}`;
  tourCard.querySelector("h2").textContent = step.title;
  tourCard.querySelector(".tour-text").textContent = step.text;
  const isLast = index === TOUR_STEPS.length - 1;
  tourCard.querySelector('[data-tour="skip"]').hidden = isLast;
  tourCard.querySelector('[data-tour="next"]').textContent = isLast ? "C'est parti" : "Suivant";
  if (tourTarget) {
    tourTarget.classList.add("tour-target");
    tourTarget.scrollIntoView({ block: "start", behavior: "instant" });
  }
  placeCard(tourTarget);
  tourCard.querySelector('[data-tour="next"]').focus();
}

function endTour() {
  tourTarget?.classList.remove("tour-target");
  tourTarget = null;
  tourCard?.remove();
  tourCard = null;
  tourIndex = -1;
  document.body.classList.remove("is-touring");
  localStorage.setItem(TOUR_SEEN_KEY, "1");
}

function startTour() {
  if (tourCard) return;
  showView("projects");
  document.body.classList.add("is-touring");
  tourCard = tourElement();
  document.body.append(tourCard);
  showStep(0);
}

document.addEventListener("keydown", (event) => {
  if (tourCard && event.key === "Escape") endTour();
});
window.addEventListener("resize", () => tourCard && placeCard(tourTarget));

// The first project list decides the templates step's target, so the tour waits for it.
document.addEventListener(
  "templates-loaded",
  () => {
    const asked = location.hash === "#tour";
    if (asked) history.replaceState(null, "", location.pathname);
    if (asked || !localStorage.getItem(TOUR_SEEN_KEY)) startTour();
  },
  { once: true },
);
