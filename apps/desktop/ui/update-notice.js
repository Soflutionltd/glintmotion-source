// Loaded by Home and injected by the main process into the studio, so one bubble covers both.
(() => {
  const updates = window.glintmotion?.updates;
  if (!updates || document.getElementById("gm-update-notice")) return;

  const MESSAGES = {
    downloading:
      "Téléchargement de la mise à jour. Glintmotion redémarre tout seul, sans rien perdre.",
    ready:
      "Mise à jour prête. Glintmotion redémarre dès que tu fais une pause et rouvre tout là où tu en es.",
    failed: "La mise à jour n'a pas pu être téléchargée. Nouvel essai dans quelques heures.",
  };

  const bubble = document.createElement("div");
  bubble.id = "gm-update-notice";
  bubble.setAttribute("role", "status");
  bubble.hidden = true;
  const body = document.createElement("div");
  body.className = "gm-update-body";
  const text = document.createElement("p");
  const restart = document.createElement("button");
  restart.type = "button";
  restart.className = "gm-update-restart";
  restart.textContent = "Redémarrer maintenant";
  restart.addEventListener("click", () => {
    restart.disabled = true;
    updates.restartNow().finally(() => (restart.disabled = false));
  });
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "gm-update-dismiss";
  dismiss.setAttribute("aria-label", "Masquer");
  dismiss.textContent = "×";
  body.append(text, restart);
  bubble.append(body, dismiss);

  let dismissedStatus = null;
  dismiss.addEventListener("click", () => {
    dismissedStatus = bubble.dataset.status ?? null;
    bubble.hidden = true;
  });

  function show(state) {
    const message = MESSAGES[state.status];
    bubble.dataset.status = state.status;
    if (!message || dismissedStatus === state.status) {
      bubble.hidden = true;
      return;
    }
    dismissedStatus = null;
    text.textContent =
      state.status === "ready" && state.error ? `${message} (${state.error})` : message;
    restart.hidden = state.status !== "ready";
    bubble.hidden = false;
  }

  document.body.append(bubble);
  updates.state().then(show);
  updates.onState(show);
})();
