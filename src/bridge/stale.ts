import type { InMemoryEventQueue, StaleSkipSummary } from "../queue.js";
import type { BridgeEvent } from "../types.js";

/** BRIDGE_STALE_EVENT_SECONDS (default 300; 0 turns skipping off). Read on every use so a restart picks it up. */
export function staleEventMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BRIDGE_STALE_EVENT_SECONDS?.trim();
  const seconds = raw === undefined || raw === "" ? 300 : Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 300_000;
}

/** Expire stale events before a consumer takes one, and log what was skipped (no message text). */
export function sweepStale(queue: InMemoryEventQueue, filter: ((event: BridgeEvent) => boolean) | undefined, consumer: string): void {
  const swept = queue.expireStale(staleEventMs(), filter);
  if (swept) {
    console.log(`Cove Bridge skipped ${swept.count} stale event(s) older than ${staleEventMs() / 1000}s for ${consumer}: createdAt ${swept.oldestCreatedAt} .. ${swept.newestCreatedAt}`);
  }
}

/** One sentence for the model about what was skipped since it last asked. */
export function describeStale(summary: StaleSkipSummary, staleMs = staleEventMs()): string {
  const minutes = Math.round(staleMs / 60_000);
  const span = minutes >= 1 ? `${minutes} 分钟` : `${Math.round(staleMs / 1000)} 秒`;
  return `已跳过 ${summary.count} 条超过 ${span}的旧消息（${summary.oldestCreatedAt} 至 ${summary.newestCreatedAt}），它们没有交给你，也不需要回复。`;
}
