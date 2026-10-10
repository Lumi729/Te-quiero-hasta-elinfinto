import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ORIGIN = "https://cove.example.test";
const CHATGPT = "https://chatgpt.com/connector/oauth/B19F6YVguEU1";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const KEY = "k".repeat(43);

type Gateway = { base: string; upstreamPaths: string[]; stop: () => Promise<void>; restart: () => Promise<Gateway> };

async function startGateway(dir = mkdtempSync(join(tmpdir(), "cove-oauth-")), upstreamPaths: string[] = []): Promise<Gateway> {
  writeFileSync(join(dir, ".access-key"), KEY, { mode: 0o600 });
  const upstream: Server = createServer((req, res) => {
    upstreamPaths.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, path: req.url, auth: req.headers.authorization ?? null }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const child: ChildProcess = spawn(process.execPath, ["ops/oauth-gateway/oauth-gateway.cjs"], {
    env: { ...process.env, COVE_PUBLIC_ORIGIN: ORIGIN, COVE_GATEWAY_PORT: "0", COVE_UPSTREAM_PORT: String(address.port), COVE_ACCESS_DIR: dir },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (chunk) => { out += chunk; const m = /COVE_OAUTH_READY :(\d+)/.exec(out); if (m) resolve(m[1]); });
    child.once("exit", (code) => reject(new Error("gateway exited " + code)));
  });
  const stop = async () => {
    child.kill();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  };
  return { base: "http://127.0.0.1:" + port, upstreamPaths, stop, restart: async () => { await stop(); return startGateway(dir, upstreamPaths); } };
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

async function authorize(base: string, clientId: string, callback: string, resource: string | null) {
  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "st-1", scope: "music" });
  if (resource) query.set("resource", resource);
  const page = await fetch(base + "/oauth/authorize?" + query);
  assert.equal(page.status, 200);
  const html = await page.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)![1];
  const wrong = await fetch(base + "/oauth/authorize", form({ request_id: requestId, password: "nope" }));
  assert.equal(wrong.status, 403, "only the owner's connection key approves");
  const approved = await fetch(base + "/oauth/authorize", { ...form({ request_id: requestId, password: KEY }), redirect: "manual" });
  assert.equal(approved.status, 303);
  const location = new URL(approved.headers.get("location")!);
  assert.equal(location.origin + location.pathname, callback);
  assert.equal(location.searchParams.get("state"), "st-1");
  return { html, code: location.searchParams.get("code")!, verifier };
}

test("Claude: metadata, DCR, PKCE, both resources, 401 challenge and refresh", async () => {
  const gw = await startGateway();
  try {
    const as = await (await fetch(gw.base + "/.well-known/oauth-authorization-server")).json();
    assert.equal(as.registration_endpoint, ORIGIN + "/register");
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
    assert.ok(as.token_endpoint_auth_methods_supported.includes("none"));
    for (const path of ["/mcp", "/mcp/music"]) {
      const challenge = await fetch(gw.base + path, { method: "POST" });
      assert.equal(challenge.status, 401);
      const header = challenge.headers.get("www-authenticate")!;
      const metadataUrl = /resource_metadata="([^"]+)"/.exec(header)![1];
      assert.ok(metadataUrl.startsWith(ORIGIN + "/.well-known/oauth-protected-resource"));
      const prm = await (await fetch(gw.base + new URL(metadataUrl).pathname)).json();
      assert.equal(prm.resource, ORIGIN + path, "resource matches the entered URL exactly");
      assert.deepEqual(prm.authorization_servers, [ORIGIN]);
    }

    const rejected = await fetch(gw.base + "/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }) });
    assert.equal(rejected.status, 400);
    const mixed = await fetch(gw.base + "/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [CLAUDE, CHATGPT] }) });
    assert.equal(mixed.status, 400, "registration accepts only the Claude callback");
    const secretClient = await fetch(gw.base + "/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [CLAUDE], token_endpoint_auth_method: "client_secret_post" }) });
    assert.equal(secretClient.status, 400);
    const registered = await fetch(gw.base + "/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [CLAUDE], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
    assert.equal(registered.status, 201);
    const client = await registered.json();
    assert.deepEqual(client.redirect_uris, [CLAUDE]);
    assert.equal(client.token_endpoint_auth_method, "none");

    const evilRedirect = await fetch(gw.base + "/oauth/authorize?" + new URLSearchParams({ client_id: client.client_id, redirect_uri: CHATGPT, response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256", state: "s" }));
    assert.equal(evilRedirect.status, 400, "registered client cannot borrow another callback");
    const plain = await fetch(gw.base + "/oauth/authorize?" + new URLSearchParams({ client_id: client.client_id, redirect_uri: CLAUDE, response_type: "code", code_challenge: "x".repeat(43), code_challenge_method: "plain", state: "s" }));
    assert.equal(plain.status, 400, "S256 required");

    for (const path of ["/mcp/music", "/mcp"]) {
      const resource = ORIGIN + path;
      const { html, code, verifier } = await authorize(gw.base, client.client_id, CLAUDE, resource);
      assert.match(html, /<b>claude\.ai<\/b>/, "consent page shows the callback domain");
      assert.match(html, /允许 Claude 连接/);
      const badVerifier = await fetch(gw.base + "/token", form({ grant_type: "authorization_code", code, redirect_uri: CLAUDE, client_id: client.client_id, code_verifier: pkce().verifier, resource }));
      assert.equal((await badVerifier.json()).error, "invalid_grant");
      const { code: code2, verifier: verifier2 } = await authorize(gw.base, client.client_id, CLAUDE, resource);
      void code; void verifier;
      const tokens = await (await fetch(gw.base + "/token", form({ grant_type: "authorization_code", code: code2, redirect_uri: CLAUDE, client_id: client.client_id, code_verifier: verifier2, resource }))).json();
      assert.equal(tokens.token_type, "Bearer");
      const call = await fetch(gw.base + path, { method: "POST", headers: { authorization: "Bearer " + tokens.access_token, "content-type": "application/json" }, body: "{}" });
      assert.equal(call.status, 200);
      const echoed = await call.json();
      assert.equal(echoed.path, path, "proxied to the matching music service path");
      assert.equal(echoed.auth, null, "OAuth token never reaches the music service");
      const other = path === "/mcp" ? "/mcp/music" : "/mcp";
      assert.equal((await fetch(gw.base + other, { method: "POST", headers: { authorization: "Bearer " + tokens.access_token } })).status, 401, "token is bound to its resource");

      const refreshed = await (await fetch(gw.base + "/oauth/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id, resource }))).json();
      assert.ok(refreshed.access_token);
      const reused = await fetch(gw.base + "/oauth/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id, resource }));
      assert.equal(reused.status, 400);
      assert.equal((await reused.json()).error, "invalid_grant", "rotated refresh token is invalid_grant");
    }
    const garbage = await fetch(gw.base + "/token", form({ grant_type: "refresh_token", refresh_token: "nope", client_id: client.client_id }));
    assert.equal((await garbage.json()).error, "invalid_grant");

    const restarted = await gw.restart();
    const again = await authorize(restarted.base, client.client_id, CLAUDE, ORIGIN + "/mcp/music");
    assert.ok(again.code, "registered client survives a gateway restart");
    await restarted.stop();
  } catch (error) {
    await gw.stop().catch(() => {});
    throw error;
  }
});

test("ChatGPT: the original fixed-client flow keeps working unchanged", async () => {
  const gw = await startGateway();
  try {
    const prm = await (await fetch(gw.base + "/.well-known/oauth-protected-resource")).json();
    assert.equal(prm.resource, ORIGIN + "/mcp/music");
    const challenge = await fetch(gw.base + "/mcp/music");
    assert.equal(challenge.headers.get("www-authenticate"), `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="music"`);
    for (const resource of [ORIGIN + "/mcp/music", null]) {
      const { html, code, verifier } = await authorize(gw.base, "cove-chatgpt", CHATGPT, resource);
      assert.match(html, /<b>chatgpt\.com<\/b>/);
      assert.match(html, /允许 ChatGPT 连接/);
      const fields: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: CHATGPT, client_id: "cove-chatgpt", code_verifier: verifier };
      if (resource) fields.resource = resource;
      const tokens = await (await fetch(gw.base + "/oauth/token", form(fields))).json();
      assert.equal(tokens.scope, "music");
      const call = await fetch(gw.base + "/mcp/music", { method: "POST", headers: { authorization: "Bearer " + tokens.access_token } });
      assert.equal(call.status, 200);
      const refreshed = await fetch(gw.base + "/oauth/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: "cove-chatgpt" }));
      assert.equal(refreshed.status, 200);
    }
    const secret = await fetch(gw.base + "/oauth/token", form({ grant_type: "refresh_token", refresh_token: "x", client_id: "cove-chatgpt", client_secret: "s" }));
    assert.equal((await secret.json()).error, "invalid_client");
    const audio = await fetch(gw.base + "/audio-clips/" + "a".repeat(43) + ".wav");
    assert.equal(audio.status, 200, "audio clip route still proxied without OAuth");
    assert.deepEqual(gw.upstreamPaths.filter((p) => p.startsWith("/audio")), ["/audio-clips/" + "a".repeat(43) + ".wav"]);
    assert.equal(readFileSync(join(process.cwd(), "ops/oauth-gateway/oauth-gateway.cjs"), "utf8").includes("QIANQIAN_AUDIO_RESOURCE_ROUTE_V1"), true, "audio patch script sees it as installed");
  } finally {
    await gw.stop();
  }
});

test("upgrade script keeps the connection key and refuses unknown gateways", async () => {
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "cove-upgrade-"));
  try {
    writeFileSync(join(dir, ".access-key"), KEY);
    writeFileSync(join(dir, "oauth-gateway.cjs"), "const CALLBACK = 'https://example.test/other';\n");
    assert.throws(() => execFileSync("bash", ["scripts/upgrade-oauth-gateway.sh", join(dir, "oauth-gateway.cjs")], { stdio: "pipe" }));
    writeFileSync(join(dir, "oauth-gateway.cjs"), "const CALLBACK = 'https://chatgpt.com/connector/oauth/B19F6YVguEU1';\n");
    execFileSync("bash", ["scripts/upgrade-oauth-gateway.sh", join(dir, "oauth-gateway.cjs")], { stdio: "pipe" });
    assert.ok(readFileSync(join(dir, "oauth-gateway.cjs"), "utf8").includes("QIANQIAN_CLAUDE_CONNECTOR_V1"));
    assert.equal(readFileSync(join(dir, ".access-key"), "utf8"), KEY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
