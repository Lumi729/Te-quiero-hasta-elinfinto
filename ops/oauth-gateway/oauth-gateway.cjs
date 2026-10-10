'use strict';
// Personal OAuth gateway in front of the music MCP service (127.0.0.1:8787).
// Clients: ChatGPT (fixed client "cove-chatgpt") and Claude custom connectors (dynamic client registration).
// Only the owner can approve: the consent page requires the connection key in .access-key.
// QIANQIAN_CLAUDE_CONNECTOR_V1
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const env = process.env;
const ORIGIN = env.COVE_PUBLIC_ORIGIN || 'https://cove.lumi.org.cn';
const PORT = Number(env.COVE_GATEWAY_PORT ?? 8788);
const UPSTREAM_PORT = Number(env.COVE_UPSTREAM_PORT || 8787);
const DIR = env.COVE_ACCESS_DIR || __dirname;
// The original resource stays first: ChatGPT keeps using /mcp/music and the root metadata.
const RESOURCE = ORIGIN + '/mcp/music';
const RESOURCES = new Map([[ORIGIN + '/mcp/music', '/mcp/music'], [ORIGIN + '/mcp', '/mcp']]);
const CHATGPT_CALLBACK = env.COVE_CHATGPT_CALLBACK || 'https://chatgpt.com/connector/oauth/B19F6YVguEU1';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'; // Claude web, desktop and mobile
const CALLBACKS = [CHATGPT_CALLBACK, CLAUDE_CALLBACK];
const CLIENT = 'cove-chatgpt';
const keyFile = path.join(DIR, '.access-key');
const clientsFile = path.join(DIR, '.oauth-clients.json');
const random = () => crypto.randomBytes(32).toString('base64url');
const hash = value => crypto.createHash('sha256').update(value).digest();
const equal = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, random(), {mode: 0o600, flag: 'wx'});
fs.chmodSync(keyFile, 0o600);
const password = fs.readFileSync(keyFile, 'utf8').trim();
if (password.length < 32) throw new Error('Access key is too short');
const pending = new Map(), codes = new Map(), access = new Map(), refresh = new Map();
let failures = [], registrations = [];
// Registered Claude clients survive restarts (public clients, no secrets); tokens stay in memory only.
const MAX_CLIENTS = 20;
let clients = new Map();
try {
  const saved = JSON.parse(fs.readFileSync(clientsFile, 'utf8'));
  if (Array.isArray(saved)) clients = new Map(saved.filter(c => c && typeof c.client_id === 'string' && Array.isArray(c.redirect_uris)).map(c => [c.client_id, c]));
} catch {}
function saveClients() {
  const temporary = clientsFile + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify([...clients.values()]), {mode: 0o600});
  fs.renameSync(temporary, clientsFile);
}
// The fixed ChatGPT client may use any allowlisted callback; registered clients only their own.
const callbacksFor = id => id === CLIENT ? CALLBACKS : clients.get(id)?.redirect_uris || null;
const appName = callback => new URL(callback).hostname === 'claude.ai' ? 'Claude' : 'ChatGPT';
const live = (map, key) => {
  const item = map.get(key);
  if (!item || item.expires <= Date.now()) { map.delete(key); return null; }
  return item;
};
const prune = () => {
  for (const map of [pending, codes, access, refresh])
    for (const [key, item] of map) if (item.expires <= Date.now()) map.delete(key);
};
setInterval(prune, 60000).unref();
const escape = text => String(text).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
function json(res, status, body, extra = {}) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'Pragma': 'no-cache', ...extra});
  res.end(JSON.stringify(body));
}
const metadataUrl = resource => resource === RESOURCE
  ? ORIGIN + '/.well-known/oauth-protected-resource'
  : ORIGIN + '/.well-known/oauth-protected-resource' + RESOURCES.get(resource);
function deny(res, resource) {
  json(res, 401, {error: 'unauthorized'}, {
    'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl(resource)}", scope="music"`
  });
}
async function body(req, type, limit = 16384) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith(type)) throw new Error('Unexpected body type');
  let bytes = 0, chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('Body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}
async function form(req) {
  const params = new URLSearchParams(await body(req, 'application/x-www-form-urlencoded'));
  for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new Error('Duplicate parameter');
  return params;
}
const badScope = scope => (scope || 'music').split(' ').filter(Boolean).some(s => s !== 'music');
function issue(res, client, resource) {
  const at = random(), rt = random();
  access.set(hash(at).toString('hex'), {expires: Date.now() + 3600000, resource, scope: 'music'});
  refresh.set(hash(rt).toString('hex'), {expires: Date.now() + 30 * 86400000, client, resource});
  json(res, 200, {access_token: at, token_type: 'Bearer', expires_in: 3600, refresh_token: rt, scope: 'music'});
}
function proxy(req, res, targetPath = '/mcp/music') {
  const headers = {...req.headers, host: '127.0.0.1:' + UPSTREAM_PORT};
  delete headers.authorization; delete headers.connection; delete headers.cookie;
  const upstream = http.request({hostname: '127.0.0.1', port: UPSTREAM_PORT,
    path: targetPath, method: req.method, headers}, reply => {
    res.writeHead(reply.statusCode, reply.headers);
    reply.pipe(res);
    reply.on('error', () => res.destroy());
  });
  upstream.on('error', () => {
    if (!res.headersSent) json(res, 502, {error: 'music_service_unavailable'});
    else res.destroy();
  });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
  upstream.setTimeout(90000, () => upstream.destroy());
  req.pipe(upstream);
}
async function register(req, res) {
  registrations = registrations.filter(t => t > Date.now() - 60000);
  if (registrations.length >= 10) return json(res, 429, {error: 'try_again_in_one_minute'});
  registrations.push(Date.now());
  let meta;
  try { meta = JSON.parse(await body(req, 'application/json')); } catch { return json(res, 400, {error: 'invalid_client_metadata', error_description: 'Send a JSON object'}); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return json(res, 400, {error: 'invalid_client_metadata'});
  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.some(u => u !== CLAUDE_CALLBACK))
    return json(res, 400, {error: 'invalid_redirect_uri', error_description: 'Only ' + CLAUDE_CALLBACK + ' can be registered'});
  if ((meta.token_endpoint_auth_method ?? 'none') !== 'none')
    return json(res, 400, {error: 'invalid_client_metadata', error_description: 'token_endpoint_auth_method must be none'});
  const grants = meta.grant_types ?? ['authorization_code', 'refresh_token'], types = meta.response_types ?? ['code'];
  if (!Array.isArray(grants) || grants.some(g => !['authorization_code', 'refresh_token'].includes(g)) || !Array.isArray(types) || types.some(t => t !== 'code'))
    return json(res, 400, {error: 'invalid_client_metadata', error_description: 'Only authorization_code / refresh_token with response type code'});
  if (meta.scope !== undefined && (typeof meta.scope !== 'string' || badScope(meta.scope))) return json(res, 400, {error: 'invalid_client_metadata', error_description: 'Only scope music'});
  const client = {client_id: 'cove-claude-' + crypto.randomBytes(16).toString('base64url'), client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: typeof meta.client_name === 'string' ? meta.client_name.slice(0, 100) : 'Claude', redirect_uris: [CLAUDE_CALLBACK],
    grant_types: grants, response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'music'};
  clients.set(client.client_id, client);
  while (clients.size > MAX_CLIENTS) clients.delete(clients.keys().next().value);
  saveClients();
  return json(res, 201, client);
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if ((req.url || '').length > 8192) return json(res, 414, {error: 'uri_too_long'});
    const u = new URL(req.url, ORIGIN), p = u.searchParams;
    for (const key of p.keys()) if (p.getAll(key).length !== 1) return json(res, 400, {error: 'duplicate_parameter'});
    if (req.method === 'GET' && u.pathname === '/') return json(res, 200, {ok: true, service: 'cove-oauth-gateway'});
    // RFC 9728: the resource here must equal the URL entered in the client, character for character.
    const protectedResource = {'/.well-known/oauth-protected-resource': RESOURCE,
      '/.well-known/oauth-protected-resource/mcp/music': ORIGIN + '/mcp/music',
      '/.well-known/oauth-protected-resource/mcp': ORIGIN + '/mcp'}[u.pathname];
    if (req.method === 'GET' && protectedResource)
      return json(res, 200, {resource: protectedResource, authorization_servers: [ORIGIN], scopes_supported: ['music'], bearer_methods_supported: ['header']});
    if (req.method === 'GET' && u.pathname === '/.well-known/oauth-authorization-server')
      return json(res, 200, {issuer: ORIGIN, authorization_endpoint: ORIGIN + '/oauth/authorize',
        token_endpoint: ORIGIN + '/oauth/token', registration_endpoint: ORIGIN + '/register', response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: ['music']});
    if (['/register', '/oauth/register'].includes(u.pathname) && req.method === 'POST') return await register(req, res);
    if (u.pathname === '/oauth/authorize' && req.method === 'GET') {
      const callbacks = callbacksFor(p.get('client_id') || ''), resource = p.get('resource');
      if (!callbacks || !callbacks.includes(p.get('redirect_uri')) || p.get('response_type') !== 'code' ||
          p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge') || '') ||
          !p.get('state') || (resource !== null && !RESOURCES.has(resource)) || badScope(p.get('scope')))
        return json(res, 400, {error: 'invalid_request', hint: 'Check client ID, exact callback, resource and S256 PKCE'});
      prune();
      if (pending.size >= 1000) return json(res, 429, {error: 'try_again_later'});
      const id = random(), callback = p.get('redirect_uri'), app = appName(callback), host = new URL(callback).hostname;
      pending.set(id, {challenge: p.get('code_challenge'), state: p.get('state'), client: p.get('client_id'), callback, resource, expires: Date.now() + 600000});
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        // same-origin, not no-referrer: with no-referrer the browser sends "Origin: null" on the approve button.
        'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', // Chromium applies form-action to the redirect after approval too, so allow exactly this request's callback origin.
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(callback).origin}; frame-ancestors 'none'; base-uri 'none'`});
      return res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>千千的一起听 · 授权</title><style>body{font:18px system-ui;max-width:460px;margin:60px auto;padding:24px;background:#f4f5fb;color:#202338}input,button{box-sizing:border-box;width:100%;padding:14px;margin:12px 0;font:inherit}button{background:#5c55cc;color:white;border:0;border-radius:10px}.to{background:#fff;border:2px solid #5c55cc;border-radius:10px;padding:12px;word-break:break-all}.to b{font-size:22px}</style><h1>连接千千的一起听</h1><p>允许 ${escape(app)} 读取一起听消息、歌曲和歌词，并通过音乐工具发送回复及控制账号音乐功能。</p><p class="to">授权后会跳转到：<br><b>${escape(host)}</b><br><small>${escape(callback)}</small></p><p>如果上面不是你正在连接的 ${escape(app)}，请直接关闭此页。</p><p>请输入手机 Termux 中显示的连接密钥。不是网易云密码。</p><form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${id}"><input type="password" name="password" autocomplete="current-password" required placeholder="连接密钥"><button type="submit">允许 ${escape(app)} 连接</button></form><p>不授权可直接关闭此页。</p></html>`);
    }
    if (u.pathname === '/oauth/authorize' && req.method === 'POST') {
      // Pages opened before this fix (or strict browsers) still send "Origin: null"; accept it only for a same-site form post.
      const origin = req.headers.origin, sameSite = req.headers['sec-fetch-site'] === 'same-origin';
      if (origin && origin !== ORIGIN && !(origin === 'null' && sameSite)) return json(res, 403, {error: 'invalid_origin'});
      const params = await form(req), id = params.get('request_id'), session = live(pending, id);
      if (!session) return json(res, 400, {error: 'authorization_expired', hint: 'Restart connection from ChatGPT or Claude'});
      failures = failures.filter(t => t > Date.now() - 60000);
      if (failures.length >= 10) return json(res, 429, {error: 'try_again_in_one_minute'});
      if (!equal(params.get('password') || '', password)) { failures.push(Date.now()); return json(res, 403, {error: 'wrong_key', hint: 'Go back and retry'}); }
      pending.delete(id);
      const code = random();
      codes.set(hash(code).toString('hex'), {...session, expires: Date.now() + 120000});
      const redirect = new URL(session.callback);
      redirect.searchParams.set('code', code); redirect.searchParams.set('state', session.state);
      res.writeHead(303, {Location: redirect.href, 'Cache-Control': 'no-store'});
      return res.end();
    }
    if (['/oauth/token', '/token'].includes(u.pathname) && req.method === 'POST') {
      const params = await form(req), client = params.get('client_id') || '';
      if (!callbacksFor(client) || req.headers.authorization || params.has('client_secret'))
        return json(res, 400, {error: 'invalid_client', hint: 'Use token endpoint authentication method none'});
      const resource = params.get('resource');
      if (resource !== null && !RESOURCES.has(resource)) return json(res, 400, {error: 'invalid_target'});
      if (params.has('scope') && badScope(params.get('scope'))) return json(res, 400, {error: 'invalid_scope'});
      if (params.get('grant_type') === 'authorization_code') {
        const key = hash(params.get('code') || '').toString('hex'), session = live(codes, key);
        const verifier = params.get('code_verifier') || '';
        if (!session || session.client !== client || params.get('redirect_uri') !== session.callback ||
            (resource !== null && session.resource !== null && resource !== session.resource) ||
            !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
            !equal(hash(verifier).toString('base64url'), session.challenge)) return json(res, 400, {error: 'invalid_grant'});
        codes.delete(key); return issue(res, client, session.resource ?? resource);
      }
      if (params.get('grant_type') === 'refresh_token') {
        const key = hash(params.get('refresh_token') || '').toString('hex'), token = live(refresh, key);
        if (!token || token.client !== client || (resource !== null && token.resource !== null && resource !== token.resource))
          return json(res, 400, {error: 'invalid_grant', error_description: 'Refresh token expired or revoked; reconnect'});
        refresh.delete(key); return issue(res, client, token.resource ?? resource);
      }
      return json(res, 400, {error: 'unsupported_grant_type'});
    }
    // QIANQIAN_AUDIO_RESOURCE_ROUTE_V1
    // A 256-bit capability identifies one WAV for five minutes. The backend enforces expiry.
    if (/^\/audio-clips\/[A-Za-z0-9_-]{43}\.wav$/.test(u.pathname) && !u.search && ['GET', 'HEAD'].includes(req.method)) {
      return proxy(req, res, u.pathname);
    }
    const resource = ORIGIN + u.pathname;
    if (RESOURCES.has(resource) && !u.search && ['GET', 'POST', 'DELETE'].includes(req.method)) {
      const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(req.headers.authorization || '');
      const token = match && live(access, hash(match[1]).toString('hex'));
      // Tokens issued without a resource (older ChatGPT flow) work on both MCP paths.
      if (!token || (token.resource !== null && token.resource !== resource) || token.scope !== 'music') return deny(res, resource);
      return proxy(req, res, RESOURCES.get(resource));
    }
    json(res, 404, {error: 'not_found'});
  } catch {
    if (!res.headersSent) json(res, 400, {error: 'invalid_request'});
    else res.destroy();
  }
});
server.headersTimeout = 15000;
server.requestTimeout = 30000;
server.on('error', err => { console.error(err.code === 'EADDRINUSE' ? '端口 8788 已占用：请先停止旧 gateway 窗口，然后重新运行。' : 'Gateway failed: ' + err.code); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => console.log('COVE_OAUTH_READY :' + server.address().port));
