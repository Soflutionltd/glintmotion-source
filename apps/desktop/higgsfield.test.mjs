import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createHiggsfieldAccount, emailFromIdToken, HIGGSFIELD_MCP_URL } from "./higgsfield.mjs";

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`enc:${value}`),
  decryptString: (buffer) => buffer.toString().replace(/^enc:/, ""),
};

const idToken = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakeHiggsfield({ tokenReplies }) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = String(input);
    const form =
      init.body instanceof URLSearchParams
        ? Object.fromEntries(init.body)
        : init.body
          ? JSON.parse(init.body)
          : null;
    calls.push({ url, form });
    if (url.endsWith("/oauth-protected-resource/mcp"))
      return json({ authorization_servers: ["https://auth.example"] });
    if (url === "https://auth.example/.well-known/oauth-authorization-server") {
      return json({
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
        registration_endpoint: "https://auth.example/register",
        revocation_endpoint: "https://auth.example/revoke",
      });
    }
    if (url === "https://auth.example/register") return json({ client_id: "client-1" });
    if (url === "https://auth.example/token") return tokenReplies.shift()();
    if (url === "https://auth.example/revoke") return new Response("", { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, calls };
}

/** Plays the browser: follows the consent URL straight to the loopback redirect. */
const acceptInBrowser =
  (params = {}) =>
  async (href) => {
    const authorize = new URL(href);
    const callback = new URL(authorize.searchParams.get("redirect_uri"));
    callback.searchParams.set("state", authorize.searchParams.get("state"));
    for (const [key, value] of Object.entries({ code: "code-1", ...params }))
      callback.searchParams.set(key, value);
    setTimeout(() => fetch(callback).catch(() => {}), 10);
  };

describe("Higgsfield account", () => {
  let dir;
  let clock;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gm-higgsfield-"));
    clock = 1_000_000;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const accountWith = (service, openExternal = acceptInBrowser()) =>
    createHiggsfieldAccount({
      file: join(dir, "higgsfield.bin"),
      safeStorage,
      openExternal,
      fetch: service.fetch,
      now: () => clock,
    });

  it("connects with PKCE and keeps the tokens encrypted", async () => {
    const service = fakeHiggsfield({
      tokenReplies: [
        () =>
          json({
            access_token: "a1",
            refresh_token: "r1",
            expires_in: 3600,
            id_token: idToken({ email: "me@example.com" }),
          }),
      ],
    });
    let consentUrl;
    const account = accountWith(service, async (href) => {
      consentUrl = new URL(href);
      await acceptInBrowser()(href);
    });

    assert.deepEqual(await account.connect(), {
      connected: true,
      email: "me@example.com",
      connecting: false,
    });
    assert.equal(consentUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(consentUrl.searchParams.get("resource"), HIGGSFIELD_MCP_URL);
    assert.match(
      consentUrl.searchParams.get("redirect_uri"),
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
    const exchange = service.calls.find(
      (call) => call.form?.grant_type === "authorization_code",
    ).form;
    assert.equal(exchange.code, "code-1");
    assert.ok(exchange.code_verifier.length >= 43);
    assert.ok(readFileSync(join(dir, "higgsfield.bin")).toString().startsWith("enc:"));
    assert.equal(await account.accessToken(), "a1");
  });

  it("refreshes a token close to expiry and forgets a revoked grant", async () => {
    const service = fakeHiggsfield({
      tokenReplies: [
        () => json({ access_token: "a1", refresh_token: "r1", expires_in: 3600 }),
        () => json({ access_token: "a2", expires_in: 3600 }),
        () => json({ error: "invalid_grant" }, 400),
      ],
    });
    const account = accountWith(service);
    await account.connect();

    clock += 55 * 60_000;
    assert.equal(await account.accessToken(), "a2");
    assert.equal(service.calls.at(-1).form.refresh_token, "r1");

    clock += 55 * 60_000;
    assert.equal(await account.accessToken(), null);
    assert.equal(account.status().connected, false);
  });

  it("keeps the account when the refresh fails for another reason", async () => {
    const service = fakeHiggsfield({
      tokenReplies: [
        () => json({ access_token: "a1", refresh_token: "r1", expires_in: 60 }),
        () => json({ error: "server_error" }, 500),
      ],
    });
    const account = accountWith(service);
    await account.connect();
    await assert.rejects(
      account.accessToken(),
      /Higgsfield a refusé le jeton de connexion \(500\)/,
    );
    assert.equal(account.status().connected, true);
  });

  it("reports a refused consent and stays disconnected", async () => {
    const service = fakeHiggsfield({ tokenReplies: [] });
    const account = accountWith(service, acceptInBrowser({ error: "access_denied" }));
    await assert.rejects(account.connect(), /Connexion à Higgsfield refusée/);
    assert.equal(account.status().connected, false);
  });

  it("revokes the refresh token on disconnect", async () => {
    const service = fakeHiggsfield({
      tokenReplies: [() => json({ access_token: "a1", refresh_token: "r1" })],
    });
    const account = accountWith(service);
    await account.connect();
    assert.deepEqual(await account.disconnect(), {
      connected: false,
      email: null,
      connecting: false,
    });
    assert.deepEqual(service.calls.at(-1), {
      url: "https://auth.example/revoke",
      form: { token: "r1", token_type_hint: "refresh_token", client_id: "client-1" },
    });
  });

  it("reads the email of an id_token and ignores a malformed one", () => {
    assert.equal(emailFromIdToken(idToken({ email: "a@b.c" })), "a@b.c");
    assert.equal(emailFromIdToken("garbage"), null);
  });
});
