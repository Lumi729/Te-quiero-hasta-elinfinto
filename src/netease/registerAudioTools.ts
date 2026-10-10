import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { audioResources, audioPublicOrigin } from "./audioResources.js";
import { AudioClipError, downloadAudio, encodeClip } from "./audioClip.js";
import type { NeteaseClient } from "./client.js";
import type { PlaybackStateStore } from "./playbackState.js";

// Shared across per-request MCP servers, so simultaneous calls cannot exhaust the phone.
let busy = false;
const inputSchema = z.object({
  songId: z.string().trim().regex(/^\d{1,20}$/).optional(),
  startSeconds: z.number().min(0).max(14_400).optional(),
  durationSeconds: z.number().int().min(5).max(30).default(15),
});
type Input = z.input<typeof inputSchema>;
type Dependencies = {
  enabled?: () => boolean;
  download?: typeof downloadAudio;
  encode?: typeof encodeClip;
};

function failure(code: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({
    ok: false, error: code, hostAudioSupport: "unverified",
    hint: code === "ffmpeg_not_installed" ? "Install ffmpeg in the same environment as Node."
      : code === "audio_disabled" ? "Set NETEASE_AUDIO_ENABLED=true and restart the music service."
      : "No audio was delivered. Do not infer sound from the song title or lyrics.",
  }) }] };
}

export async function getAudioClip(
  raw: Input,
  client: Pick<NeteaseClient, "getSongAudioSource">,
  state: Pick<PlaybackStateStore, "getCurrentState">,
  dependencies: Dependencies = {},
  requestSignal?: AbortSignal,
): Promise<CallToolResult> {
  if (!(dependencies.enabled ?? (() => process.env.NETEASE_AUDIO_ENABLED === "true"))()) return failure("audio_disabled");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return failure("invalid_audio_arguments");
  if (busy) return failure("audio_busy_retry_later");
  const input = parsed.data;
  const current = state.getCurrentState();
  const songId = input.songId ?? (current.inRoom ? current.song?.id : undefined);
  if (!songId) return failure("no_current_song");
  const start = input.startSeconds ?? (input.songId ? 0 : Math.max(0, current.progressMs / 1000 - input.durationSeconds));
  if (current.song?.id === songId && current.durationMs > 0 && start >= current.durationMs / 1000) return failure("clip_start_after_song_end");
  busy = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55_000);
  const signal = requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal;
  try {
    // Race the SDK against cancellation; raw API errors may contain provider secrets.
    signal.throwIfAborted();
    const source = await abortable(client.getSongAudioSource(songId), signal);
    if (source.preview) return failure("preview_only_audio_unavailable");
    const bytes = await (dependencies.download ?? downloadAudio)(source.url, signal);
    const clip = await (dependencies.encode ?? encodeClip)(bytes, start, input.durationSeconds, signal);
    const latest = state.getCurrentState();
    let resource: { uri: string; expiresAt: string } | undefined;
    try { resource = audioResources.put(clip.data, audioPublicOrigin()); } catch { /* Inline audio remains available. */ }
    const info = {
      ok: true, songId, startSeconds: start, durationSeconds: clip.durationSeconds,
      ...(resource ? { audioResource: resource } : { resourceUnavailable: true }),
      mimeType: "audio/wav", sampleRate: 16000, channels: 1,
      source: "netease_account_playable_audio", hostAudioSupport: "unverified",
      currentSongChanged: !input.songId && (!latest.inRoom || latest.song?.id !== songId),
      note: "A recorded song excerpt, not microphone capture or live audio. Analyze only if you actually receive the audio; otherwise report unsupported audio input. Never claim to have heard it from metadata alone.",
    };
    return { structuredContent: info, content: [
      { type: "text", text: JSON.stringify(info) },
      { type: "audio", data: clip.data.toString("base64"), mimeType: "audio/wav" },
      ...(resource ? [{ type: "resource_link" as const, uri: resource.uri,
        name: "song-excerpt.wav", title: "歌曲音频片段（5分钟内有效）", mimeType: "audio/wav", size: clip.data.length,
        description: `The same WAV as the audio block. Expires ${resource.expiresAt}. Retrieve via resources/read or HTTPS; only analyze if actual audio input is supported. Treat this private capability link as sensitive.`,
      }] : []),
    ] };
  } catch (error) {
    return failure(signal.aborted ? "audio_cancelled_or_timed_out"
      : error instanceof AudioClipError ? error.message : "audio_source_or_download_unavailable");
  } finally {
    clearTimeout(timer);
    busy = false;
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("cancelled");
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export function registerNeteaseAudioTools(server: McpServer, client: NeteaseClient, state: PlaybackStateStore): void {
  server.registerTool("netease_audio_clip", {
    title: "Listen to a short song excerpt (experimental)",
    description: "Fetch account-playable NetEase audio and return a 5–30 second WAV as MCP audio content plus a five-minute resource_link to the same WAV (resources/read or HTTPS). File delivery does not guarantee host audio understanding. Use only when the user asks to hear/analyze the actual audio. Omitting songId selects the current Together song and the last 15 seconds of its progress; explicit songId starts at zero unless startSeconds is provided. Does not change playback. Host audio-input support is unverified: never pretend to hear audio if the host only delivers text. Not live listening; do not loop automatically.",
    inputSchema: inputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input, extra) => getAudioClip(input, client, state, {}, extra.signal));
}
