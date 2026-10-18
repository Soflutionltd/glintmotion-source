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

const cliButton = document.getElementById("cli-install");

function showCli(status) {
  cliButton.textContent = status.installed ? "Installée" : "Installer";
  cliButton.disabled = status.installed;
  if (status.installed) {
    document.getElementById("cli-help").textContent =
      `Installée dans ${status.link}, un dossier que les terminaux du Mac ont dans leur PATH.`;
  }
}

cliButton.addEventListener("click", async () => {
  try {
    showCli(await api.cli.install());
    showToast("Commande installée");
  } catch (error) {
    showToast(error.message);
  }
});

api.cli.status().then(showCli);

const skillsButton = document.getElementById("skills-install");

function showSkills(status, backups = []) {
  const partial = status.missing < status.skills * status.targets.length;
  skillsButton.textContent = status.installed ? "À jour" : partial ? "Mettre à jour" : "Installer";
  skillsButton.disabled = status.installed;
  if (!status.installed) return;
  const saved = backups.length ? ` Anciennes versions : ${backups.join(", ")}.` : "";
  document.getElementById("skills-help").textContent =
    `${status.skills} compétences installées dans ${status.targets.join(" et ")}. ` +
    `Les agents les chargent à leur prochaine session.${saved}`;
}

skillsButton.addEventListener("click", async () => {
  try {
    const result = await api.skills.install();
    showSkills(result, result.backups);
    showToast("Compétences installées");
  } catch (error) {
    showToast(error.message);
  }
});

api.skills.status().then(showSkills);

const higgsfieldButton = document.getElementById("higgsfield-connect");
const higgsfieldHelp = document.getElementById("higgsfield-help");
const higgsfieldPitch = higgsfieldHelp.textContent;

function showHiggsfield(status) {
  higgsfieldButton.disabled = status.connecting;
  higgsfieldButton.textContent = status.connecting
    ? "Dans le navigateur…"
    : status.connected
      ? "Déconnecter"
      : "Connecter";
  higgsfieldButton.dataset.connected = String(status.connected);
  higgsfieldHelp.textContent = status.connected
    ? `Connecté${status.email ? ` en tant que ${status.email}` : ""}. L'agent de Glintmotion peut générer des plans sur tes crédits Higgsfield.`
    : higgsfieldPitch;
}

higgsfieldButton.addEventListener("click", async () => {
  const connected = higgsfieldButton.dataset.connected === "true";
  try {
    if (connected) {
      showHiggsfield(await api.higgsfield.disconnect());
      showToast("Higgsfield déconnecté");
      return;
    }
    showHiggsfield({ connected: false, connecting: true });
    showHiggsfield(await api.higgsfield.connect());
    showToast("Higgsfield connecté");
  } catch (error) {
    showHiggsfield(await api.higgsfield.status());
    showToast(error.message);
  }
});

api.higgsfield.status().then(showHiggsfield);

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
