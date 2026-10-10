import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { AudioResourceStore, serveAudioResource } from "../src/netease/audioResources.js";

test("resources expire, are unguessable, and capacity never invalidates a live link", () => {
  let now = 1000;
  const store = new AudioResourceStore(() => now, 100, 1);
  const original = Buffer.from("RIFFtest");
  const resource = store.put(original, "https://music.example");
  const token = new URL(resource.uri).pathname.split('/')[2].slice(0, -4);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  original.fill(0);
  assert.equal(store.get(token)?.toString(), "RIFFtest");
  assert.equal(store.get("wrong"), undefined);
  assert.throws(() => store.put(original, "https://music.example"), /capacity/);
  assert.equal(store.get(token)?.toString(), "RIFFtest");
  now = 1100;
  assert.equal(store.get(token), undefined);
  assert.ok(store.put(original, "https://music.example"));
});

test("HTTP resource supports bytes, HEAD, ranges, expiry and rejects unrelated paths", async () => {
  let now = 1000;
  const store = new AudioResourceStore(() => now, 100);
  const resource = store.put(Buffer.from("RIFF123456"), "https://music.example");
  const path = new URL(resource.uri).pathname;
  const server = createServer((req, res) => {
    if (!serveAudioResource(req, res, new URL(req.url!, "http://localhost"), store)) res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const full = await fetch(base + path);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "audio/wav");
    assert.equal(full.headers.get("cache-control"), "private, no-store");
    assert.equal(await full.text(), "RIFF123456");
    const head = await fetch(base + path, { method: "HEAD" });
    assert.equal(head.headers.get("content-length"), "10");
    assert.equal(await head.text(), "");
    const range = await fetch(base + path, { headers: { Range: "bytes=0-3" } });
    assert.equal(range.status, 206); assert.equal(await range.text(), "RIFF");
    const suffix = await fetch(base + path, { headers: { Range: "bytes=-2" } });
    assert.equal(await suffix.text(), "56");
    for (const value of ["bytes=10-", "bytes=4-2", "bytes=0-1,3-4", "bytes=-0"]) {
      assert.equal((await fetch(base + path, { headers: { Range: value } })).status, 416);
    }
    assert.equal((await fetch(base + path, { method: "POST" })).status, 405);
    assert.equal((await fetch(base + path + "?x=1")).status, 404);
    assert.equal((await fetch(base + "/audio-clips/no.wav")).status, 404);
    now = 1100;
    assert.equal((await fetch(base + path)).status, 404);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
