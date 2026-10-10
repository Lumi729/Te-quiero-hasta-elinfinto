import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
export class AudioClipError extends Error {}

// Only provider-owned media URLs returned by the account API, never arbitrary user URLs.
export function validateMediaUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AudioClipError("invalid_media_url"); }
  if (url.protocol === "http:") url.protocol = "https:";
  const allowed = ["music.126.net", "music.163.com"].some(
    (host) => url.hostname === host || url.hostname.endsWith("." + host),
  );
  if (!allowed || url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new AudioClipError("unsupported_media_host");
  }
  return url;
}

export async function downloadAudio(value: string, signal: AbortSignal, fetcher = fetch): Promise<Buffer> {
  let url = validateMediaUrl(value);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetcher(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const target = response.headers.get("location");
      if (!target || redirects === 3) throw new AudioClipError("media_redirect_failed");
      url = validateMediaUrl(new URL(target, url).href);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new AudioClipError("media_download_failed");
    }
    const size = Number(response.headers.get("content-length"));
    if (size > MAX_AUDIO_BYTES) {
      await response.body.cancel();
      throw new AudioClipError("media_too_large");
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    try {
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        received += chunk.byteLength;
        if (received > MAX_AUDIO_BYTES) throw new AudioClipError("media_too_large");
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!received) throw new AudioClipError("empty_media");
    return Buffer.concat(chunks, received);
  }
  throw new AudioClipError("media_redirect_failed");
}

export async function encodeClip(input: Buffer, startSeconds: number, durationSeconds: number, signal?: AbortSignal) {
  const dir = await mkdtemp(join(tmpdir(), "qianqian-audio-"));
  try {
    const source = join(dir, "source.bin");
    const output = join(dir, "clip.wav");
    await writeFile(source, input, { mode: 0o600 });
    // Decode only a local file; playlists cannot fetch remote resources or local secrets.
    await exec("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-protocol_whitelist", "file,pipe", "-format_whitelist", "mp3,flac,mov,aac,ogg,wav",
      "-ss", String(startSeconds), "-i", source, "-t", String(durationSeconds),
      "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
      "-threads", "1", output], { timeout: 20_000, maxBuffer: 64 * 1024, signal });
    const data = await readFile(output);
    if (data.length < 1000 || data.length > 1_000_000) throw new AudioClipError("empty_or_oversized_clip");
    const probe = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", output],
      { timeout: 5_000, maxBuffer: 4096, signal });
    const duration = Number(JSON.parse(probe.stdout).format?.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 30.1) throw new AudioClipError("invalid_clip_duration");
    return { data, durationSeconds: duration };
  } catch (error) {
    if (error instanceof AudioClipError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AudioClipError("ffmpeg_not_installed");
    throw new AudioClipError("audio_decode_failed_or_timed_out");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
