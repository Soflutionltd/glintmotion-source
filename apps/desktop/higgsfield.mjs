import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

export const HIGGSFIELD_MCP_URL = "https://mcp.higgsfield.ai/mcp";
const RESOURCE_METADATA_URL = "https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp";
const SCOPE = "openid email offline_access";
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** An agent turn can last several minutes: a token closer than this to expiry is refreshed first. */
const REFRESH_MARGIN_MS = 10 * 60_000;

const CALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>Glintmotion</title>
<body style="font:16px -apple-system,sans-serif;background:#f1f0ec;color:#1c1c1a;display:grid;place-items:center;height:90vh">
<p>Higgsfield est connecté. Tu peux revenir dans Glintmotion.</p></body>`;

const base64url = (buffer) => buffer.toString("base64url");

/** The email claim of an id_token, read for display only: the token itself is never trusted here. */
export function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(idToken).split(".")[1], "base64url").toString("utf-8"),
    );
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

async function readJson(response, what) {
  const body = await response.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  if (!response.ok || !json) {
    const detail = json?.error_description ?? json?.error ?? body.slice(0, 200);
    const error = new Error(`Higgsfield a refusé ${what} (${response.status}). ${detail}`.trim());
    error.oauthError = json?.error ?? null;
    throw error;
  }
  return json;
}

/**
 * The person's Higgsfield account, connected with OAuth (dynamic client registration, PKCE, loopback redirect).
 * Tokens are encrypted with Electron safeStorage, whose key macOS keeps in the Keychain.
 * @param {{ file: string, safeStorage: Electron.SafeStorage, openExternal: (url: string) => Promise<void>, fetch?: typeof fetch, now?: () => number }} options
 */
export function createHiggsfieldAccount({
  file,
  safeStorage,
  openExternal,
  fetch = globalThis.fetch,
  now = Date.now,
}) {
  let pendingLogin = null;

  function load() {
    if (!existsSync(file)) return null;
    return JSON.parse(safeStorage.decryptString(readFileSync(file)));
  }

  function save(state) {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("Le Trousseau du Mac n'est pas disponible.");
    writeFileSync(file, safeStorage.encryptString(JSON.stringify(state)), { mode: 0o600 });
  }

  async function discover() {
    const resource = await readJson(await fetch(RESOURCE_METADATA_URL), "la découverte du serveur");
    const issuer = resource.authorization_servers?.[0];
    if (!issuer) throw new Error("Higgsfield n'annonce aucun serveur de connexion.");
    const server = await readJson(
      await fetch(new URL("/.well-known/oauth-authorization-server", issuer)),
      "la découverte du serveur de connexion",
    );
    for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
      if (!server[key]) throw new Error(`Le serveur de connexion de Higgsfield n'a pas de ${key}.`);
    }
    return server;
  }

  function listenForCallback(state) {
    return new Promise((resolveListen, rejectListen) => {
      let settle;
      const code = new Promise((resolve, reject) => (settle = { resolve, reject }));
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback") return response.writeHead(404).end();
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(CALLBACK_PAGE);
        server.close();
        clearTimeout(timer);
        if (url.searchParams.get("state") !== state)
          return settle.reject(new Error("Réponse de Higgsfield inattendue."));
        const error = url.searchParams.get("error");
        if (error) {
          const refused =
            error === "access_denied"
              ? "Connexion à Higgsfield refusée."
              : `Higgsfield : ${error}.`;
          return settle.reject(new Error(refused));
        }
        settle.resolve(url.searchParams.get("code"));
      });
      const timer = setTimeout(() => {
        server.close();
        settle.reject(
          new Error("La connexion à Higgsfield n'a pas été validée dans le navigateur."),
        );
      }, LOGIN_TIMEOUT_MS);
      server.on("error", rejectListen);
      server.listen(0, "127.0.0.1", () => {
        const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
        const close = () => {
          clearTimeout(timer);
          server.close();
        };
        resolveListen({ redirectUri: `http://127.0.0.1:${port}/callback`, code, close });
      });
    });
  }

  async function login() {
    const server = await discover();
    const state = base64url(randomBytes(16));
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const { redirectUri, code, close } = await listenForCallback(state);
    try {
      await authorizeOnce({ server, state, verifier, challenge, redirectUri, code });
    } finally {
      close();
    }
  }

  async function authorizeOnce({ server, state, verifier, challenge, redirectUri, code }) {
    const client = await readJson(
      await fetch(server.registration_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Glintmotion",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: SCOPE,
        }),
      }),
      "l'enregistrement de Glintmotion",
    );
    const authorize = new URL(server.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: HIGGSFIELD_MCP_URL,
    })) {
      authorize.searchParams.set(key, value);
    }
    await openExternal(authorize.href);
    const tokens = await requestTokens(server.token_endpoint, {
      grant_type: "authorization_code",
      code: await code,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: HIGGSFIELD_MCP_URL,
    });
    const saved = {
      clientId: client.client_id,
      tokenEndpoint: server.token_endpoint,
      revocationEndpoint: server.revocation_endpoint ?? null,
      email: emailFromIdToken(tokens.id_token),
      ...tokenFields(tokens, null),
    };
    save(saved);
  }

  async function requestTokens(endpoint, form) {
    const tokens = await readJson(
      await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
      }),
      "le jeton de connexion",
    );
    if (!tokens.access_token) throw new Error("Higgsfield n'a pas renvoyé de jeton.");
    return tokens;
  }

  function tokenFields(tokens, previousRefresh) {
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? previousRefresh,
      expiresAt: tokens.expires_in ? now() + Number(tokens.expires_in) * 1000 : null,
    };
  }

  function status() {
    const state = load();
    return {
      connected: Boolean(state),
      email: state?.email ?? null,
      connecting: Boolean(pendingLogin),
    };
  }

  return {
    status,

    /** Opens the Higgsfield consent page in the browser and resolves once the person has accepted. */
    connect() {
      if (!pendingLogin) {
        pendingLogin = login().finally(() => {
          pendingLogin = null;
        });
      }
      return pendingLogin.then(status);
    },

    async disconnect() {
      const state = load();
      rmSync(file, { force: true });
      if (!state?.revocationEndpoint || !state.refreshToken) return status();
      const response = await fetch(state.revocationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: state.refreshToken,
          token_type_hint: "refresh_token",
          client_id: state.clientId,
        }),
      });
      if (!response.ok) {
        throw new Error(
          `Higgsfield est déconnecté de ce Mac, mais n'a pas confirmé la révocation (${response.status}).`,
        );
      }
      return status();
    },

    /** A valid access token, refreshed when it is about to expire; null when no account is connected. */
    async accessToken() {
      const state = load();
      if (!state) return null;
      if (!state.expiresAt || state.expiresAt - REFRESH_MARGIN_MS > now()) return state.accessToken;
      if (!state.refreshToken) {
        rmSync(file, { force: true });
        return null;
      }
      try {
        const tokens = await requestTokens(state.tokenEndpoint, {
          grant_type: "refresh_token",
          refresh_token: state.refreshToken,
          client_id: state.clientId,
          resource: HIGGSFIELD_MCP_URL,
        });
        const next = { ...state, ...tokenFields(tokens, state.refreshToken) };
        save(next);
        return next.accessToken;
      } catch (error) {
        if (error.oauthError !== "invalid_grant") throw error;
        rmSync(file, { force: true });
        return null;
      }
    },
  };
}
