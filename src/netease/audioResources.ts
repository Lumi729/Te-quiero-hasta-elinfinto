import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const AUDIO_PATH = /^\/audio-clips\/([A-Za-z0-9_-]{43})\.wav$/;
export class AudioResourceStore {
  private clips = new Map<string, { data: Buffer; expires: number }>();
  constructor(private readonly now = Date.now, private readonly ttlMs = 300_000, private readonly capacity = 8) {}
  prune() {
    for (const [key, clip] of this.clips) if (clip.expires <= this.now()) this.clips.delete(key);
  }
  put(data: Buffer, origin: string) {
    this.prune();
    if (data.length > 1_000_000) throw new Error("audio_resource_too_large");
    // Keep every issued link valid for its promised TTL; refuse new resources when full.
    if (this.clips.size >= this.capacity) throw new Error("audio_resource_capacity");
    const token = randomBytes(32).toString("base64url");
    const expires = this.now() + this.ttlMs;
    this.clips.set(token, { data: Buffer.from(data), expires });
    return { uri: `${origin}/audio-clips/${token}.wav`, expiresAt: new Date(expires).toISOString() };
  }
  get(token: string) {
    this.prune();
    return this.clips.get(token)?.data;
  }
}
export const audioResources = new AudioResourceStore();
setInterval(() => audioResources.prune(), 30_000).unref();

export function audioPublicOrigin(): string {
  const url = new URL(process.env.BRIDGE_PUBLIC_ORIGIN?.trim() || `http://localhost:${process.env.PORT || "8787"}`);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
    throw new Error("invalid_audio_public_origin");
  }
  return url.origin;
}

export function serveAudioResource(req: IncomingMessage, res: ServerResponse, url: URL, store = audioResources): boolean {
  if (!url.pathname.startsWith("/audio-clips/")) return false;
  const match = AUDIO_PATH.exec(url.pathname);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (!match || url.search) { res.writeHead(404).end(); return true; }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }).end(); return true; }
  const data = store.get(match[1]);
  if (!data) { res.writeHead(404).end(); return true; }
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Content-Disposition", 'attachment; filename="song-excerpt.wav"');
  res.setHeader("Accept-Ranges", "bytes");
  let start = 0, end = data.length - 1;
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, data.length - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
    } else start = data.length;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= data.length) {
      res.writeHead(416, { "Content-Range": `bytes */${data.length}` }).end(); return true;
    }
    res.setHeader("Content-Range", `bytes ${start}-${end}/${data.length}`);
  }
  res.setHeader("Content-Length", end - start + 1);
  res.writeHead(req.headers.range ? 206 : 200);
  res.end(req.method === "HEAD" ? undefined : data.subarray(start, end + 1));
  return true;
}

export function registerAudioResources(server: McpServer): void {
  const origin = audioPublicOrigin();
  server.registerResource("song-excerpt", new ResourceTemplate(`${origin}/audio-clips/{token}.wav`, { list: undefined }),
    { title: "Temporary song excerpt", mimeType: "audio/wav", description: "Short-lived WAV; possession of the link grants access until expiry. Host audio decoding is not guaranteed." },
    async (uri) => {
      const match = AUDIO_PATH.exec(uri.pathname);
      const data = uri.origin === origin && !uri.search && !uri.hash && match ? audioResources.get(match[1]) : undefined;
      if (!data) throw new Error("Audio resource missing or expired");
      return { contents: [{ uri: uri.href, mimeType: "audio/wav", blob: data.toString("base64") }] };
    });
}
