import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildBridgeEvent } from "../src/bridge/events.js";
import { registerBridgeTools } from "../src/bridge/registerTools.js";
import { registerBridgeWaitTool } from "../src/bridge/registerWaitTool.js";
import type { TogetherWorker } from "../src/netease/togetherWorker.js";
import { InMemoryEventQueue } from "../src/queue.js";

const old = new Date(Date.now() - 120_000).toISOString();
function event(id: string, room = "room:owner", text = id, date = old) {
  return buildBridgeEvent(id, "netease.chatroom", text, date, undefined, room);
}

test("catch-up keeps every original, ACKs together and resumes one reply after partial failure", async () => {
  const queue = new InMemoryEventQueue();
  const a = event("a", undefined, "g老师在吗");
  const b = event("b", undefined, "刚才的不用了，先聊聊天");
  queue.enqueue(a); queue.enqueue(b);
  // Exercise actual registered wait, ACK and routed reply handlers with a failing egress.
  type Handler = (args: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<{
    structuredContent: Record<string, unknown>;
  }>;
  const handlers = new Map<string, Handler>();
  const server = { registerTool(name: string, _schema: unknown, handler: Handler) {
    handlers.set(name, handler);
  } } as unknown as McpServer;
  const sent: string[] = [];
  let fail = true;
  const worker = { async sendChatRoomText(text: string) {
    if (text === "第二句" && fail) { fail = false; throw new Error("temporary disconnect"); }
    sent.push(text);
  } } as unknown as TogetherWorker;
  registerBridgeWaitTool(server, queue, () => true);
  registerBridgeTools(server, queue, () => true, worker);
  const call = (name: string, args = {}) => handlers.get(name)!(args, { signal: new AbortController().signal });
  const result = (await call("cove_bridge_wait")).structuredContent;
  assert.deepEqual(result.batchEventIds, ["a", "b"]);
  assert.match(String(result.modelContext), /ONE consolidated/);
  assert.ok(String(result.visibleText).indexOf(a.visibleText) < String(result.visibleText).indexOf(b.visibleText));
  assert.deepEqual(queue.getEvent("a"), a);
  assert.deepEqual(queue.getEvent("b"), b);
  assert.equal(queue.reserveNext(), null);
  assert.equal(queue.reserveBacklog(), null);
  await call("cove_bridge_wait_ack", { eventId: "a" });
  await call("cove_bridge_wait_ack", { eventId: "a" });
  assert.equal(queue.status().delivered, 2);
  queue.release("a"); // accepted batches never redispatch
  assert.equal(queue.status().pending, 0);
  queue.enqueue(event("c"));
  const reply = { eventId: "a", messages: ["第一句", "第二句"] };
  await assert.rejects(call("cove_bridge_reply", reply), /temporary disconnect/);
  assert.equal(queue.reserveNext(), null);
  assert.equal((await call("cove_bridge_wait")).structuredContent.awaitingReply, true);
  await call("cove_bridge_reply", reply);
  await call("cove_bridge_reply", reply);
  assert.deepEqual(sent, ["第一句", "第二句"]);
  assert.equal(queue.getOutstandingRequiredReplyEvent(), null);
  assert.equal(queue.reserveNext()?.id, "c");
  assert.equal(queue.status().total, 3);
});

test("pre-handoff release returns whole batch to FIFO; member operations cannot split it", () => {
  const queue = new InMemoryEventQueue();
  queue.enqueue(event("a")); queue.enqueue(event("b"));
  assert.ok(queue.reserveBacklog());
  assert.throws(() => queue.markDelivered("b"), /batch eventId/);
  assert.throws(() => queue.claimReply("b", "fp"), /batch eventId/);
  assert.throws(() => queue.dismiss("a"), /consolidated/);
  queue.release("a");
  assert.equal(queue.status().pending, 2);
  assert.equal(queue.reserveNext()?.id, "a");
  assert.equal(queue.reserveBacklog(), null);
});

test("fresh, unscoped and single messages keep normal per-event behavior", () => {
  for (const events of [
    [event("a")],
    [event("a", undefined, "a", new Date().toISOString()), event("b")],
    [event("a", ""), event("b", "")],
  ]) {
    const queue = new InMemoryEventQueue();
    events.forEach(e => queue.enqueue(e));
    assert.equal(queue.reserveBacklog(), null);
    assert.equal(queue.reserveNext()?.id, "a");
  }
});

test("batch stops at room, owner, peer or profile boundary and honors the filter", () => {
  for (const boundary of [event("boundary", "another-room:owner"), event("boundary", "room:another-owner"),
    buildBridgeEvent("boundary", "netease.chatroom.peer", "peer"),
    buildBridgeEvent("boundary", "test", "other source")]) {
    const queue = new InMemoryEventQueue();
    queue.enqueue(event("a")); queue.enqueue(event("b"));
    queue.enqueue(boundary); queue.enqueue(event("c"));
    assert.deepEqual(queue.reserveBacklog()?.batchEventIds, ["a", "b"]);
    assert.equal(queue.status().pending, 2);
  }
  const queue = new InMemoryEventQueue();
  queue.enqueue(event("a")); queue.enqueue(event("b"));
  assert.equal(queue.reserveBacklog(e => e.source === "test"), null);
  assert.equal(queue.status().pending, 2);
});

test("backlog limits preserve overflow rather than truncate or drop messages", () => {
  const queue = new InMemoryEventQueue();
  for (let i = 0; i < 35; i++) queue.enqueue(event(String(i)));
  const batch = queue.reserveBacklog();
  assert.ok(batch);
  assert.ok(batch.batchEventIds.length <= 32);
  assert.equal(queue.status().total, 35);
  assert.equal(queue.status().pending, 35 - batch.batchEventIds.length);
  const large = new InMemoryEventQueue();
  large.enqueue(event("large", undefined, "x".repeat(64_000)));
  large.enqueue(event("next"));
  assert.equal(large.reserveBacklog(), null);
  assert.equal(large.status().pending, 2);
});
