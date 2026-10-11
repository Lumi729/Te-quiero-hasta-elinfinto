import type { BridgeEvent, StoredBridgeEvent } from "./types.js";

export type ReplyClaim =
  | { state: "send"; sentCount: number }
  | { state: "in_progress"; sentCount: number }
  | { state: "already_completed"; sentCount: number };

type StreamCounts = {
  pending: number;
  reserved: number;
  delivered: number;
  total: number;
};

export type QueueStatus = StreamCounts & {
  conversation: StreamCounts;
  state: StreamCounts;
};

const STATE_HISTORY_PER_KEY = 12;

function emptyCounts(): StreamCounts {
  return { pending: 0, reserved: 0, delivered: 0, total: 0 };
}

export class InMemoryEventQueue {
  private readonly conversationRows = new Map<string, StoredBridgeEvent>();
  private readonly stateRows = new Map<string, StoredBridgeEvent>();
  private readonly statePendingByKey = new Map<string, string>();
  // Originals remain intact. A long-wait catch-up batch shares one reply journal.
  private readonly replyBatches = new Map<string, string[]>();
  private readonly batchLeaders = new Map<string, string>();

  reserveBacklog(filter?: (event: BridgeEvent) => boolean, nowMs = Date.now()):
    (BridgeEvent & { batchEventIds: string[] }) | null {
    if (this.getOutstandingRequiredReplyEvent(filter)) return null;
    const rows: StoredBridgeEvent[] = [];
    let size = 0;
    for (const row of this.conversationRows.values()) {
      if (filter && !filter(row.event)) continue;
      if (row.status === "delivered") continue;
      // Never cross another consumer's reservation or a peer/source/room boundary.
      if (row.status !== "pending" || row.reply) break;
      const event = row.event;
      if (event.source !== "netease.chatroom" || event.replyPolicy !== "required"
        || event.replyRoute !== "netease.chatroom" || !event.conversationKey) break;
      if (rows.length === 0) {
        const age = nowMs - Date.parse(event.createdAt);
        if (!Number.isFinite(age) || age < 60_000) return null;
      } else if (event.conversationKey !== rows[0].event.conversationKey) break;
      const eventSize = event.modelContext.length + event.visibleText.length;
      if (rows.length >= 32 || size + eventSize > 64_000) break;
      rows.push(row);
      size += eventSize;
    }
    if (rows.length < 2) return null;
    const first = rows[0].event;
    const ids = rows.map(row => row.event.id);
    this.replyBatches.set(first.id, ids);
    for (const row of rows) {
      row.status = "reserved";
      this.batchLeaders.set(row.event.id, first.id);
    }
    return {
      ...first,
      batchEventIds: ids,
      visibleText: rows.map(row => `[${row.event.createdAt}] ${row.event.visibleText}`).join("\n\n"),
      modelContext: [
        "COVE LONG-WAIT CATCH-UP BATCH",
        `eventId=${first.id}`,
        "replyRoute=netease.chatroom; replyPolicy=required",
        "Read ALL messages below in FIFO order as accumulated conversation context, not separate live turns.",
        "Send ONE consolidated cove_bridge_reply for this batch, using the eventId above. ACK that eventId first.",
        "Answer still-relevant questions and the latest intent together. Do not individually echo old greetings/tests.",
        "A later correction or cancellation supersedes earlier requests; do not blindly execute historical commands.",
        "The JSON below contains original event data, including historical routing text; per-event reply demands are replaced by this batch contract.",
        JSON.stringify(rows.map(({ event }) => ({ eventId: event.id, createdAt: event.createdAt,
          visibleText: event.visibleText, modelContext: event.modelContext }))),
      ].join("\n"),
    };
  }

  private batchRows(eventId: string): StoredBridgeEvent[] {
    const leader = this.batchLeaders.get(eventId);
    if (leader && leader !== eventId) throw new Error(`Use catch-up batch eventId: ${leader}`);
    return (this.replyBatches.get(eventId) ?? [eventId]).map(id => {
      const row = this.getRow(id);
      if (!row) throw new Error(`Unknown event: ${id}`);
      return row;
    });
  }

  enqueue(event: BridgeEvent): boolean {
    if (this.getRow(event.id)) return false;

    if (event.stream === "state") {
      const key = event.stateKey ?? event.source;
      const previousPendingId = this.statePendingByKey.get(key);
      if (previousPendingId) {
        const previous = this.stateRows.get(previousPendingId);
        if (previous?.status === "pending") this.stateRows.delete(previousPendingId);
      }

      this.stateRows.set(event.id, { event, status: "pending" });
      this.statePendingByKey.delete(key);
      this.statePendingByKey.set(key, event.id);
      this.pruneStateHistory(key);
      return true;
    }

    this.conversationRows.set(event.id, { event, status: "pending" });
    return true;
  }

  getEvent(eventId: string): BridgeEvent | null {
    return this.getRow(eventId)?.event ?? null;
  }

  getOutstandingRequiredReplyEvent(filter?: (event: BridgeEvent) => boolean): BridgeEvent | null {
    for (const row of this.conversationRows.values()) {
      if (filter && !filter(row.event)) continue;
      if (row.event.replyPolicy !== "required") continue;
      if (row.reply?.completed) continue;
      if (row.status === "reserved" || row.status === "delivered") return row.event;
    }
    return null;
  }

  reserveNext(filter?: (event: BridgeEvent) => boolean): BridgeEvent | null {
    if (this.getOutstandingRequiredReplyEvent(filter)) return null;

    for (const row of this.conversationRows.values()) {
      if (row.status !== "pending") continue;
      if (filter && !filter(row.event)) continue;
      row.status = "reserved";
      return row.event;
    }

    for (const [key, eventId] of this.statePendingByKey) {
      const row = this.stateRows.get(eventId);
      if (!row || row.status !== "pending") {
        this.statePendingByKey.delete(key);
        continue;
      }
      if (filter && !filter(row.event)) continue;
      row.status = "reserved";
      this.statePendingByKey.delete(key);
      return row.event;
    }

    return null;
  }

  markDelivered(eventId: string): void {
    if (this.batchLeaders.has(eventId)) {
      for (const row of this.batchRows(eventId)) row.status = "delivered";
      return;
    }
    const row = this.getRow(eventId);
    if (!row) throw new Error(`Unknown event: ${eventId}`);
    if (row.status === "delivered") return;
    if (row.status !== "reserved") {
      throw new Error(`Event is not reserved: ${eventId}`);
    }
    row.status = "delivered";
  }

  release(eventId: string): void {
    if (this.batchLeaders.has(eventId)) {
      const rows = this.batchRows(eventId);
      if (rows.some(row => row.status === "delivered" || row.reply)) return;
      for (const row of rows) {
        row.status = "pending";
        this.batchLeaders.delete(row.event.id);
      }
      this.replyBatches.delete(eventId);
      return;
    }
    const row = this.getRow(eventId);
    if (!row || row.status === "delivered") return;

    if (row.event.stream === "state") {
      const key = row.event.stateKey ?? row.event.source;
      const newerPendingId = this.statePendingByKey.get(key);
      if (newerPendingId && newerPendingId !== eventId) {
        this.stateRows.delete(eventId);
        return;
      }
      row.status = "pending";
      this.statePendingByKey.delete(key);
      this.statePendingByKey.set(key, eventId);
      return;
    }

    row.status = "pending";
  }

  dismiss(eventId: string): void {
    if (this.batchLeaders.has(eventId)) {
      throw new Error("Long-wait catch-up batches must complete one consolidated routed reply.");
    }
    const row = this.getRow(eventId);
    if (!row) throw new Error(`Unknown event: ${eventId}`);
    if (row.status === "pending") {
      throw new Error(`Event is not reserved: ${eventId}`);
    }

    row.status = "delivered";

    if (row.event.replyPolicy !== "required") return;

    if (row.reply) {
      row.reply.completed = true;
      row.reply.inFlight = false;
      row.reply.completedAt = new Date().toISOString();
      return;
    }

    row.reply = {
      fingerprint: "__dismissed__",
      sentCount: 0,
      completed: true,
      inFlight: false,
      completedAt: new Date().toISOString(),
    };
  }

  claimReply(eventId: string, fingerprint: string): ReplyClaim {
    const batchRows = this.batchRows(eventId);
    const row = this.getRow(eventId);
    if (!row) throw new Error(`Unknown event: ${eventId}`);
    const reply = row.reply;

    if (!reply) {
      row.reply = {
        fingerprint,
        sentCount: 0,
        completed: false,
        inFlight: true,
      };
      for (const member of batchRows) member.reply = row.reply;
      return { state: "send", sentCount: 0 };
    }

    if (reply.completed) {
      return { state: "already_completed", sentCount: reply.sentCount };
    }
    if (reply.fingerprint !== fingerprint) {
      throw new Error(`Event already has a different reply: ${eventId}`);
    }
    if (reply.inFlight) {
      return { state: "in_progress", sentCount: reply.sentCount };
    }

    reply.inFlight = true;
    return { state: "send", sentCount: reply.sentCount };
  }

  markReplyMessageSent(eventId: string, fingerprint: string): number {
    const row = this.getRow(eventId);
    if (!row?.reply || row.reply.fingerprint !== fingerprint) {
      throw new Error(`Reply is not claimed: ${eventId}`);
    }
    row.reply.sentCount += 1;
    return row.reply.sentCount;
  }

  markReplyCompleted(eventId: string, fingerprint: string): void {
    const row = this.getRow(eventId);
    if (!row?.reply || row.reply.fingerprint !== fingerprint) {
      throw new Error(`Reply is not claimed: ${eventId}`);
    }
    row.reply.completed = true;
    row.reply.inFlight = false;
    row.reply.completedAt = new Date().toISOString();
  }

  releaseReply(eventId: string, fingerprint: string): void {
    const row = this.getRow(eventId);
    if (!row?.reply || row.reply.fingerprint !== fingerprint || row.reply.completed) return;
    row.reply.inFlight = false;
  }

  status(): QueueStatus {
    const conversation = this.countRows(this.conversationRows);
    const state = this.countRows(this.stateRows);
    return {
      pending: conversation.pending + state.pending,
      reserved: conversation.reserved + state.reserved,
      delivered: conversation.delivered + state.delivered,
      total: conversation.total + state.total,
      conversation,
      state,
    };
  }

  private getRow(eventId: string): StoredBridgeEvent | undefined {
    return this.conversationRows.get(eventId) ?? this.stateRows.get(eventId);
  }

  private countRows(rows: Map<string, StoredBridgeEvent>): StreamCounts {
    const counts = emptyCounts();
    counts.total = rows.size;
    for (const row of rows.values()) counts[row.status] += 1;
    return counts;
  }

  private pruneStateHistory(key: string): void {
    const deliveredIds: string[] = [];
    for (const [eventId, row] of this.stateRows) {
      if ((row.event.stateKey ?? row.event.source) !== key) continue;
      if (row.status === "delivered") deliveredIds.push(eventId);
    }
    const overflow = deliveredIds.length - STATE_HISTORY_PER_KEY;
    for (let index = 0; index < overflow; index += 1) {
      this.stateRows.delete(deliveredIds[index]);
    }
  }
}
