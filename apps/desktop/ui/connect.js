const api = window.glintmotion;
const snippets = {};

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (toast.hidden = true), 1800);
}

async function load() {
  const info = await api.mcp.info();
  if (!info) throw new Error("Le serveur de connexion n'a pas démarré.");
  const header = `Bearer ${info.token}`;
  snippets.cursor = JSON.stringify(
    { glintmotion: { url: info.url, headers: { Authorization: header } } },
    null,
    2,
  );
  snippets.claude = `claude mcp add --scope user --transport http glintmotion ${info.url} --header "Authorization: ${header}"`;
  snippets.raw = `URL           ${info.url}\nAuthorization ${header}`;
  for (const key of Object.keys(snippets)) {
    document.getElementById(`snippet-${key}`).textContent = snippets[key];
  }
  if (info.error) {
    const error = document.getElementById("connect-error");
    error.textContent = info.error;
    error.hidden = false;
  }
}

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    await api.mcp.copy(snippets[button.dataset.copy]);
    showToast("Copié");
  });
});

load().catch((error) => {
  const box = document.getElementById("connect-error");
  box.textContent = error.message;
  box.hidden = false;
});
