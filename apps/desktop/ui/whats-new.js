const page = document.getElementById("wn-page");

const DATE_FORMAT = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : DATE_FORMAT.format(date);
}

function list(title, items) {
  const section = element("section", "wn-list");
  section.append(element("h3", null, title));
  const ul = element("ul");
  for (const item of items) ul.append(element("li", null, item));
  section.append(ul);
  return section;
}

function lead(entry) {
  const article = element("article", "wn-lead");
  if (entry.video) {
    const video = element("video", "wn-video");
    Object.assign(video, {
      src: entry.video,
      controls: true,
      autoplay: true,
      muted: true,
      playsInline: true,
    });
    article.append(video);
  }
  article.append(element("h2", null, entry.title));
  const meta = element("p", "wn-meta");
  meta.append(
    element("span", "wn-version", entry.version),
    element("span", null, formatDate(entry.date)),
  );
  article.append(meta);
  if (entry.summary) article.append(element("p", "wn-summary", entry.summary));
  if (entry.improved?.length) article.append(list("Amélioré", entry.improved));
  if (entry.fixed?.length) article.append(list("Corrigé", entry.fixed));
  return article;
}

function card(entry) {
  const item = element("article", "wn-card");
  const meta = element("p", "wn-card-meta");
  meta.append(
    element("strong", null, entry.version),
    element("span", null, formatDate(entry.date)),
  );
  item.append(meta, element("h3", null, entry.title));
  if (entry.summary) item.append(element("p", "wn-card-summary", entry.summary));
  return item;
}

function render({ since, entries }) {
  if (entries.length === 0) {
    document.getElementById("wn-empty").hidden = false;
    return;
  }
  const [latest, ...earlier] = entries;
  page.append(lead(latest));
  if (earlier.length === 0) return;
  const details = element("details", "wn-earlier");
  details.open = true;
  details.append(
    element(
      "summary",
      null,
      since ? "Aussi depuis ta dernière mise à jour" : "Versions précédentes",
    ),
  );
  for (const entry of earlier) details.append(card(entry));
  page.append(details);
}

document
  .getElementById("wn-close")
  .addEventListener("click", () => window.glintmotion.whatsNew.close());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.glintmotion.whatsNew.close();
});
window.glintmotion.whatsNew.data().then(render);
