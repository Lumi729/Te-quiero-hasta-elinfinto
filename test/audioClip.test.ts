import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { AudioClipError, downloadAudio, encodeClip, MAX_AUDIO_BYTES, validateMediaUrl } from "../src/netease/audioClip.js";
import { NeteaseClient } from "../src/netease/client.js";
import { getAudioClip } from "../src/netease/registerAudioTools.js";
import { PlaybackStateStore } from "../src/netease/playbackState.js";

const state = new PlaybackStateStore();
state.enterRoom("test");
state.updateSong({ id: "123", name: "Test", artist: "Test", durationMs: 100_000 });
state.updatePlayback({ songId: "123", playStatus: "PAUSE", progressMs: 45_000, observedAtMs: Date.now() });
const client = { getSongAudioSource: async () => ({ url: "https://m701.music.126.net/test.mp3", preview: false }) };
const fake = {
  enabled: () => true,
  download: async () => Buffer.from("test"),
  encode: async (_b: Buffer, _s: number, d: number) => ({ data: Buffer.from("RIFFtest"), durationSeconds: d }),
};

test("media URLs are HTTPS provider URLs without credentials or custom ports", () => {
  assert.equal(validateMediaUrl("http://m701.music.126.net/test.mp3").protocol, "https:");
  for (const url of ["file:///etc/passwd", "https://127.0.0.1/", "https://music.126.net.evil.com/a", "https://evil-music.126.net/a", "https://user:secret@music.126.net/a", "https://music.126.net:8787/a"]) {
    assert.throws(() => validateMediaUrl(url), AudioClipError);
  }
});

test("download checks redirects and never forwards provider credentials", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_url, options) => {
    calls++;
    assert.equal(options?.headers, undefined);
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } });
  };
  await assert.rejects(downloadAudio(clientUrl(), new AbortController().signal, fetcher), /unsupported_media_host/);
  assert.equal(calls, 1);
});
function clientUrl() { return "https://m701.music.126.net/test.mp3"; }

test("download rejects oversized declared and streamed bodies", async () => {
  await assert.rejects(downloadAudio(clientUrl(), new AbortController().signal, async () => new Response("x", { headers: { "content-length": String(MAX_AUDIO_BYTES + 1) } })), /media_too_large/);
  await assert.rejects(downloadAudio(clientUrl(), new AbortController().signal, async () => new Response(new Uint8Array(MAX_AUDIO_BYTES + 1))), /media_too_large/);
});

test("download rejects empty responses and returns actual bytes", async () => {
  await assert.rejects(downloadAudio(clientUrl(), new AbortController().signal, async () => new Response("")), /empty_media/);
  assert.equal((await downloadAudio(clientUrl(), new AbortController().signal, async () => new Response("music"))).toString(), "music");
});

test("clip is opt-in and validates parameters before touching account", async () => {
  const disabled = await getAudioClip({}, client, state, { enabled: () => false });
  assert.match(JSON.stringify(disabled), /audio_disabled/);
  for (const args of [{ songId: "../secret" }, { durationSeconds: 31 }, { startSeconds: -1 }]) {
    assert.match(JSON.stringify(await getAudioClip(args, client, state, fake)), /invalid_audio_arguments/);
  }
});

test("current song returns real MCP audio with its excerpt position and explicit host uncertainty", async () => {
  let capturedStart = -1;
  const result = await getAudioClip({}, client, state, { ...fake, encode: async (b, s, d) => {
    capturedStart = s;
    return fake.encode(b, s, d);
  } });
  assert.equal(result.isError, undefined);
  assert.equal(capturedStart, 30);
  assert.equal(result.structuredContent?.hostAudioSupport, "unverified");
  assert.equal(result.structuredContent?.songId, "123");
  assert.equal(result.content[1].type, "audio");
  assert.equal(result.content[1].mimeType, "audio/wav");
  assert.equal(JSON.stringify(result).includes("music.126.net"), false);
});

test("explicit song works outside room; absent current song and out-of-range offset fail", async () => {
  const empty = new PlaybackStateStore();
  assert.match(JSON.stringify(await getAudioClip({}, client, empty, fake)), /no_current_song/);
  const explicit = await getAudioClip({ songId: "456" }, client, empty, fake);
  assert.equal(explicit.structuredContent?.startSeconds, 0);
  assert.match(JSON.stringify(await getAudioClip({ startSeconds: 100 }, client, state, fake)), /clip_start_after_song_end/);
});

test("trial-only and raw provider exceptions do not leak credentials", async () => {
  const preview = await getAudioClip({}, { getSongAudioSource: async () => ({ url: clientUrl(), preview: true }) }, state, fake);
  assert.match(JSON.stringify(preview), /preview_only/);
  const failed = await getAudioClip({}, { getSongAudioSource: async () => { throw new Error("MUSIC_U=secret"); } }, state, fake);
  assert.equal(failed.isError, true);
  assert.equal(JSON.stringify(failed).includes("secret"), false);
});

test("concurrent requests share a guard; cancellation releases it", async () => {
  const controller = new AbortController();
  const waiting = getAudioClip({}, { getSongAudioSource: () => new Promise(() => {}) }, state, fake, controller.signal);
  assert.match(JSON.stringify(await getAudioClip({}, client, state, fake)), /audio_busy/);
  controller.abort();
  assert.match(JSON.stringify(await waiting), /audio_cancelled/);
  assert.equal((await getAudioClip({}, client, state, fake)).isError, undefined);
});

test("song changes during download are reported, not relabelled", async () => {
  const local = new PlaybackStateStore();
  local.enterRoom("test");
  local.updateSong({ id: "123", name: "A", artist: "A", durationMs: 10_000 });
  const result = await getAudioClip({}, client, local, { ...fake, download: async () => {
    local.leaveRoom(); return Buffer.from("test");
  } });
  assert.equal(result.structuredContent?.songId, "123");
  assert.equal(result.structuredContent?.currentSongChanged, true);
});

test("account audio source uses standard quality and reports access restrictions", async () => {
  const require = createRequire(import.meta.url);
  const sdk = require("NeteaseCloudMusicApi");
  const original = sdk.song_url_v1;
  const actual = new NeteaseClient("test-cookie");
  try {
    sdk.song_url_v1 = async (args: Record<string, unknown>) => {
      assert.equal(args.cookie, "test-cookie");
      assert.equal(args.level, "standard");
      return { body: { code: 200, data: [{ id: 123, code: 200, url: clientUrl(), freeTrialInfo: null }] } };
    };
    assert.deepEqual(await actual.getSongAudioSource("123"), { url: clientUrl(), preview: false });
    sdk.song_url_v1 = async () => ({ body: { code: 200, data: [{ id: 123, code: 404, url: null }] } });
    await assert.rejects(actual.getSongAudioSource("123"), /audio_unavailable/);
  } finally { sdk.song_url_v1 = original; }
});

test("ffmpeg produces a decodable bounded WAV excerpt from real generated audio", async (t) => {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); }
  catch { t.skip("ffmpeg is not installed"); return; }
  const tone = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-f", "mp3", "pipe:1"]);
  const result = await encodeClip(tone, 2, 5);
  assert.equal(result.data.subarray(0, 4).toString(), "RIFF");
  assert.ok(Math.abs(result.durationSeconds - 5) < 0.1);
  assert.ok(result.data.length < 200_000);
  await assert.rejects(encodeClip(Buffer.from("not audio"), 0, 5), /audio_decode_failed/);
});

test("MCP tools/call delivers a decodable audio block through the SDK", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { registerNeteaseAudioTools } = await import("../src/netease/registerAudioTools.js");
  const tone = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=523:duration=6", "-f", "mp3", "pipe:1"]);
  const previousFetch = globalThis.fetch;
  const previousEnabled = process.env.NETEASE_AUDIO_ENABLED;
  const sdk = createRequire(import.meta.url)("NeteaseCloudMusicApi");
  const previousApi = sdk.song_url_v1;
  const server = new McpServer({ name: "audio-test", version: "1" });
  const host = new Client({ name: "audio-test-host", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    process.env.NETEASE_AUDIO_ENABLED = "true";
    sdk.song_url_v1 = async () => ({ body: { code: 200, data: [{ id: 123, code: 200, url: clientUrl() }] } });
    globalThis.fetch = async () => new Response(new Uint8Array(tone));
    registerNeteaseAudioTools(server, new NeteaseClient("never-return-this-cookie"), state);
    await server.connect(a);
    await host.connect(b);
    const result = await host.callTool({ name: "netease_audio_clip", arguments: { songId: "123", durationSeconds: 5 } });
    assert.equal(result.isError, undefined);
    const blocks = result.content as Array<{ type: string; data?: string }>;
    const audio = blocks.find((block) => block.type === "audio");
    assert.ok(audio?.data);
    assert.equal(Buffer.from(audio.data, "base64").subarray(0, 4).toString(), "RIFF");
    assert.equal(JSON.stringify(result).includes("never-return-this-cookie"), false);
  } finally {
    globalThis.fetch = previousFetch;
    sdk.song_url_v1 = previousApi;
    if (previousEnabled === undefined) delete process.env.NETEASE_AUDIO_ENABLED;
    else process.env.NETEASE_AUDIO_ENABLED = previousEnabled;
    await host.close(); await server.close();
  }
});
