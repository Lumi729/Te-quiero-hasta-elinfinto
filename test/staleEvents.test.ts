import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildBridgeEvent } from "../src/bridge/events.js";
import { registerBridgeTools } from "../src/bridge/registerTools.js";
import { registerBridgeWaitTool } from "../src/bridge/registerWaitTool.js";
import { describeStale, staleEventMs } from "../src/bridge/stale.js";
import { TogetherWorker } from "../src/netease/togetherWorker.js";
import type { RealtimeChatRoomMessage } from "../src/netease/realtimeTransport.js";
import { InMemoryEventQueue } from "../src/queue.js";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const chat = (id: string, age: number, room = "room:owner") => buildBridgeEvent(id, "netease.chatroom", id, ago(age), undefined, room);
const state = (id: string, age: number) => buildBridgeEvent(id, "netease.music_changed", id, ago(age));

type Handler = (args: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<{ structuredContent: Record<string, unknown>; content: Array<{ text: string }> }>;
function tools(queue: InMemoryEventQueue) {
  const handlers = new Map<string, Handler>();
  const server = { registerTool(name: string, _schema: unknown, handler: Handler) { handlers.set(name, handler); } } as unknown as McpServer;
  registerBridgeWaitTool(server, queue, () => true);
  registerBridgeTools(server, queue, () => true, { async sendChatRoomText() {} } as unknown as TogetherWorker);
  return (name: string, args = {}) => handlers.get(name)!(args, { signal: new AbortController().signal });
}

test("events older than BRIDGE_STALE_EVENT_SECONDS are ACKed, never shown, and hold no backpressure", () => {
  const queue = new InMemoryEventQueue();
  queue.enqueue(chat("old-chat", 10 * 60_000));
  queue.enqueue(state("old-song", 6 * 60_000));
  queue.enqueue(chat("fresh", 5_000));
  const swept = queue.expireStale(300_000);
  assert.equal(swept?.count, 2);
  assert.equal(queue.getOutstandingRequiredReplyEvent(), null, "an expired required event does not block replies");
  assert.equal(queue.reserveNext()?.id, "fresh");
  assert.equal(queue.status().pending, 0);
  assert.equal(queue.takeStaleSummary()?.count, 2);
  assert.equal(queue.takeStaleSummary(), null, "the summary is reported once");
});

test("reserved or replying events are never expired; 0 turns skipping off", () => {
  const queue = new InMemoryEventQueue();
  queue.enqueue(chat("taken", 10 * 60_000));
  assert.equal(queue.reserveNext()?.id, "taken");
  assert.equal(queue.expireStale(300_000), null);
  assert.equal(queue.getOutstandingRequiredReplyEvent()?.id, "taken", "the reply it owes still counts");
  const other = new InMemoryEventQueue();
  other.enqueue(chat("old", 10 * 60_000));
  assert.equal(other.expireStale(staleEventMs({ BRIDGE_STALE_EVENT_SECONDS: "0" })), null);
  assert.equal(staleEventMs({}), 300_000);
  assert.equal(staleEventMs({ BRIDGE_STALE_EVENT_SECONDS: "60" }), 60_000);
  assert.equal(staleEventMs({ BRIDGE_STALE_EVENT_SECONDS: "abc" }), 300_000);
});

test("long-wait: stale messages are dropped, 1-5 minute backlog is still batched, and the next wait says what was skipped", async () => {
  const queue = new InMemoryEventQueue();
  for (let i = 0; i < 12; i += 1) queue.enqueue(chat(`stale-${i}`, 6 * 60_000 + i));
  queue.enqueue(chat("recent-a", 120_000));
  queue.enqueue(chat("recent-b", 90_000));
  const call = tools(queue);
  const first = await call("cove_bridge_wait");
  assert.deepEqual(first.structuredContent.batchEventIds, ["recent-a", "recent-b"], "g老师's catch-up batch keeps working for what is left");
  const skipped = first.structuredContent.skippedStale as { count: number; note: string };
  assert.equal(skipped.count, 12);
  assert.match(skipped.note, /已跳过 12 条超过 5 分钟的旧消息/);
  assert.match(first.content[0].text, /已跳过 12 条/);
  assert.ok(!String(first.structuredContent.modelContext).includes("stale-"), "stale text never reaches the model");
});

test("widget sync skips stale events too and the next long-wait reports them", async () => {
  const queue = new InMemoryEventQueue();
  queue.enqueue(chat("stale", 7 * 60_000));
  const call = tools(queue);
  assert.equal((await call("cove_bridge_sync")).structuredContent.hasEvent, false);
  const wait = await call("cove_bridge_wait", { timeoutSeconds: 1 });
  assert.equal(wait.structuredContent.timedOut, true);
  assert.equal((wait.structuredContent.skippedStale as { count: number }).count, 1);
  assert.match(describeStale({ count: 3, oldestCreatedAt: "a", newestCreatedAt: "b" }, 300_000), /已跳过 3 条超过 5 分钟的旧消息/);
});

test("full lyrics are attached once per song; later chat for that song gets a short pointer", () => {
  const contexts: Array<string | undefined> = [];
  const worker = new TogetherWorker({ cookie: "", enabled: false, inviterUid: "1", onEvent: (_s, _t, context) => { contexts.push(context); } });
  const internals = worker as unknown as { currentLyricsModelContext: string | null; previousSongId: string | null; lyricsSentForSongId: string | null; handleRealtimeChatMessage: (m: RealtimeChatRoomMessage) => void };
  const say = (n: number) => internals.handleRealtimeChatMessage({ type: "chatroom_message", category: "text", msgType: 0, senderId: "1", senderNick: "me", text: "hi " + n, messageId: "m" + n, timetagMs: n, receivedAtMs: n });
  internals.currentLyricsModelContext = "NETEASE FULL-LYRICS CONTEXT ... 整首歌词 ...";
  internals.previousSongId = "song-1";
  say(1); say(2);
  assert.match(contexts[0]!, /FULL-LYRICS/);
  assert.doesNotMatch(contexts[1]!, /FULL-LYRICS/);
  assert.match(contexts[1]!, /already provided/);
  internals.previousSongId = "song-2"; internals.lyricsSentForSongId = null; // what a song change does
  internals.currentLyricsModelContext = "NETEASE FULL-LYRICS CONTEXT ... 第二首 ...";
  say(3);
  assert.match(contexts[2]!, /第二首/);
});
