import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { asRecord, readNumber, readString, type RealtimeCredentials } from "./types.js";

const NIM_APP_KEY = "3a6a3e48f6854dfa4e4464f3bdaec3b4";
const ENTER_TIMEOUT_MS = 15_000;
const BOOTSTRAP_TIMEOUT_MS = 20_000;
const SEND_TIMEOUT_MS = 10_000;
const MAX_CHAT_TEXT_LENGTH = 500;
const MAX_JSON_STRING_BYTES = 65_536;

type RealtimePlayStatus = "PLAY" | "PAUSE" | "UNKNOWN";

export type RealtimePlaybackEvent = {
  type: "playback";
  serverSeq: number | null;
  commandType: string | null;
  songId: string | null;
  formerSongId: string | null;
  progressMs: number;
  playStatus: RealtimePlayStatus;
  receivedAtMs: number;
  clientSeq?: number;
  senderId?: string;
};

export type RealtimeChatRoomMessage = {
  type: "chatroom_message";
  category: "text" | "custom" | "robot" | "notification" | "other";
  msgType: number | null;
  senderId: string | null;
  senderNick: string | null;
  text: string | null;
  messageId: string | null;
  timetagMs: number | null;
  receivedAtMs: number;
};

export type RealtimeTransportStatus = {
  enabled: boolean;
  connected: boolean;
  roomId: string | null;
  chatRoomId: string | null;
  credentialsReady: boolean;
  lastPlaybackEvent: RealtimePlaybackEvent | null;
  lastChatMessage: RealtimeChatRoomMessage | null;
  lastError: string | null;
  lastUnrecognizedEvent?: { receivedAtMs: number; shape: string[] } | null;
  /** Listen Together chat format learned from this room's own messages (multi-person rooms differ from FRIEND). */
  roomMessageFormat?: RoomMessageFormat | null;
  /** Masked structure of the latest official text message received and the latest one we sent (for comparison). */
  textFormats?: { lastIn: Record<string, unknown> | null; lastOut: Record<string, unknown> | null };
};

export type RoomMessageFormat = {
  ltType: string;
  /** Extra clientExt fields copied onto outgoing chat (room-level values only). */
  extra: Record<string, string | number | boolean>;
  learnedFrom: "text" | "custom" | "playback" | "other";
  learnedAtMs: number;
  /** The room's messages carry a device session id; we then send our own, never someone else's. */
  usesClientSession?: boolean;
  /** Top-level msgTag of official chat (short enum-like values only, e.g. how the message was produced). */
  msgTag?: Record<string, string | number | boolean>;
};

// msgTag values are short enum-like flags; anything else (free text, long tokens) is never copied or shown.
const ENUM_VALUE = /^[A-Za-z0-9_.-]{0,32}$/;
function enumFields(value: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, child] of Object.entries(asRecord(parseJsonString(value)))) {
    if (typeof child === "number" || typeof child === "boolean" || (typeof child === "string" && ENUM_VALUE.test(child))) out[key] = child;
  }
  return out;
}

export type RealtimeChatSendResult = {
  ok: true;
  roomId: string;
  chatRoomId: string;
  messageId: string;
  text: string;
  code: number;
};

export type RealtimeMemberProfile = {
  userId?: string;
  nick?: string;
  avatar?: string;
  gender?: number;
};

type ConnectOptions = {
  roomId: string;
  chatRoomId: string;
  credentials: RealtimeCredentials;
  memberProfile?: RealtimeMemberProfile;
};

type EventHandler = (...args: unknown[]) => void;

type ChatRoomLike = {
  init(appInstallDir: string, extension: string): boolean;
  initEventHandlers(): void;
  enter(roomId: number, requestLoginData: string, info: Record<string, unknown>, extension: string): boolean;
  exit(roomId: number, extension: string): void;
  sendMsg(roomId: number, msg: Record<string, unknown>, extension: string): boolean;
  updateMyRoomRoleAsync(
    roomId: number,
    info: Record<string, unknown>,
    needNotify: boolean,
    notifyExt: string,
    cb: null,
    extension: string,
  ): Promise<[number, number]>;
  getMemberInfoByIDsAsync(
    roomId: number,
    ids: string[],
    cb: null,
    extension: string,
  ): Promise<[number, number, Array<Record<string, unknown>>]>;
  on(event: string, handler: EventHandler): unknown;
};

type NimClientLike = {
  init(appKey: string, appDataDir: string, appInstallDir: string, config: Record<string, unknown>): boolean;
  initEventHandlers(): void;
  login(appKey: string, account: string, password: string, cb: null, extension: string): Promise<[unknown]>;
  cleanup(jsonExtension: string): void;
};

type NimPluginLike = {
  initEventHandlers(): void;
  chatRoomRequestEnterAsync(roomId: number, cb: null, extension: string): Promise<[number, string]>;
};

type NodeNimModule = {
  ChatRoom: new () => ChatRoomLike;
  NIMClient: new () => NimClientLike;
  NIMPlugin: new () => NimPluginLike;
};

type PendingEnter = {
  generation: number;
  roomNumber: number;
  resolve: () => void;
  reject: (error: Error) => void;
};

type PendingSend = {
  roomNumber: number;
  roomId: string;
  chatRoomId: string;
  text: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (result: RealtimeChatSendResult) => void;
  reject: (error: Error) => void;
};

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > MAX_JSON_STRING_BYTES) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function normalizeStatus(value: unknown): RealtimePlayStatus {
  const status = readString(value)?.toUpperCase();
  return status === "PLAY" || status === "PAUSE" ? status : "UNKNOWN";
}

function extractPlaybackCommand(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 7) return null;
  const parsed = parseJsonString(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const found = extractPlaybackCommand(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const object = asRecord(parsed);
  if (!Object.keys(object).length) return null;
  const hasCommandFields =
    object.commandType !== undefined
    || object.playStatus !== undefined
    || object.targetSongId !== undefined
    || object.progress !== undefined;
  if (hasCommandFields) return object;

  for (const key of ["command", "commandInfo", "config", "content", "data", "msg_attach_", "msg_body_", "ext_"]) {
    if (object[key] === undefined) continue;
    const found = extractPlaybackCommand(object[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function findPlaybackEnvelope(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 7) return null;
  const parsed = parseJsonString(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const found = findPlaybackEnvelope(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const object = asRecord(parsed);
  if (!Object.keys(object).length) return null;
  const eventType = readNumber(object.event_type) ?? readNumber(object.type);
  if (eventType === 20_000) return object;

  for (const nested of Object.values(object)) {
    const found = findPlaybackEnvelope(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

const PLAYBACK_DIAGNOSTIC_KEYS = new Set([
  "event_type",
  "type",
  "commandType",
  "command",
  "commandInfo",
  "config",
  "content",
  "data",
  "targetSongId",
  "formerSongId",
  "songId",
  "progress",
  "playStatus",
  "serverSeq",
  "clientSeq",
  "commandId",
  "roomId",
  "bizType",
  "ltType",
  "appName",
  "clientExt",
]);

function sanitizePlaybackDiagnostic(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[max-depth]";
  const parsed = parseJsonString(value);
  if (Array.isArray(parsed)) {
    return parsed.slice(0, 16).map((item) => sanitizePlaybackDiagnostic(item, depth + 1));
  }
  if (!parsed || typeof parsed !== "object") return parsed;

  const object = parsed as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(object)) {
    if (PLAYBACK_DIAGNOSTIC_KEYS.has(key)) {
      result[key] = sanitizePlaybackDiagnostic(nested, depth + 1);
    }
  }
  return result;
}

// Unknown room protocols must be inspected without exporting chat text or credentials.
// Only known structural field names and numeric event discriminators survive.
export function describeUnknownRoomEvent(raw: unknown): string[] {
  const fields: string[] = [];
  const keys = new Set([...PLAYBACK_DIAGNOSTIC_KEYS,
    "msg_attach_", "msg_body_", "msg_setting_", "ext_", "msg_type_", "sub_type_",
    "payload", "body", "message", "event", "playCommand", "playback", "status",
    "song", "music", "musicId", "position", "progressMs", "duration", "playlist",
  ]);
  function visit(value: unknown, path: string, depth: number): void {
    if (depth > 7 || fields.length >= 64) return;
    const parsed = parseJsonString(value);
    if (Array.isArray(parsed)) {
      fields.push(`${path}:array`);
      for (const item of parsed.slice(0, 4)) visit(item, `${path}[]`, depth + 1);
    } else if (parsed && typeof parsed === "object") {
      for (const [key, child] of Object.entries(parsed)) {
        if (!keys.has(key) || fields.length >= 64) continue;
        const next = `${path}.${key}`;
        const code = ["event_type", "type", "msg_type_", "sub_type_"].includes(key)
          ? readNumber(child) : null;
        fields.push(code !== null && Number.isSafeInteger(code)
          ? `${next}:code=${code}` : `${next}:${typeof child}`);
        visit(child, next, depth + 1);
      }
    }
  }
  visit(raw, "$", 0);
  return fields;
}

export function buildPlaybackDiagnostic(raw: unknown): Record<string, unknown> | null {
  const message = asRecord(raw);
  const envelope = findPlaybackEnvelope(raw);
  if (!envelope) return null;

  const setting = asRecord(message.msg_setting_);
  const senderId = readString(message.from_id_);
  const messageId = readString(message.client_msg_id_);
  return {
    msgType: readNumber(message.msg_type_),
    subType: readNumber(message.sub_type_),
    senderSuffix: senderId ? senderId.slice(-4) : null,
    messageIdSuffix: messageId ? messageId.slice(-6) : null,
    attach: sanitizePlaybackDiagnostic(message.msg_attach_),
    settingExt: sanitizePlaybackDiagnostic(setting.ext_),
    envelope: sanitizePlaybackDiagnostic(envelope),
  };
}

export function decodeRealtimePlaybackEvent(
  raw: unknown,
  receivedAtMs = Date.now(),
): RealtimePlaybackEvent | null {
  const envelope = findPlaybackEnvelope(raw);
  if (!envelope) return null;
  const command = extractPlaybackCommand(envelope);
  if (!command) return null;

  const progress = readNumber(command.progress);
  const serverSeq = readNumber(command.serverSeq) ?? readNumber(envelope.serverSeq);
  const clientSeq = readNumber(command.clientSeq);
  const senderId = readString(asRecord(raw).from_id_);
  return {
    type: "playback",
    serverSeq,
    commandType: readString(command.commandType)?.toUpperCase() ?? null,
    songId: readString(command.targetSongId),
    formerSongId: readString(command.formerSongId),
    progressMs: Math.max(0, progress ?? 0),
    playStatus: normalizeStatus(command.playStatus),
    receivedAtMs,
    ...(clientSeq === null ? {} : { clientSeq }),
    ...(senderId ? { senderId } : {}),
  };
}

function extractChatText(value: unknown): string | null {
  const direct = readString(value);
  if (!direct) return null;
  const parsed = parseJsonString(direct);
  if (typeof parsed === "string") return direct;
  const object = asRecord(parsed);
  return readString(object.text)
    ?? readString(object.content)
    ?? readString(object.body)
    ?? readString(object.msg);
}

function chatMessageCategory(msgType: number | null): RealtimeChatRoomMessage["category"] {
  if (msgType === 0) return "text";
  if (msgType === 5) return "notification";
  if (msgType === 11) return "robot";
  if (msgType === 100) return "custom";
  return "other";
}

// clientExt keys that describe one message or one sender, never copied from someone else's message.
// clientSessionId identifies the sending device: copying the owner's would make their phone treat AI chat as its own echo.
const PER_MESSAGE_EXT_KEYS = new Set(["clientSessionId", "clientMsgId", "msgId", "roomId", "userId", "uid", "nickname", "nick", "avatar", "avatarUrl", "text", "content", "msg", "at", "atList", "atUsers", "time", "timestamp"]);

function listenTogetherExt(raw: unknown): { top: Record<string, unknown>; client: Record<string, unknown> } | null {
  const message = asRecord(raw);
  const ext = asRecord(parseJsonString(asRecord(message.msg_setting_).ext_));
  const client = asRecord(parseJsonString(ext.clientExt));
  const bizType = readString(client.bizType) ?? readString(ext.bizType);
  if (bizType !== "listenTogether") return null;
  return { top: ext, client };
}

/** Learn the room's chat format (ltType and room-level fields) from any message seen in that room. */
export function learnRoomMessageFormat(raw: unknown, roomId: string, receivedAtMs = Date.now()): RoomMessageFormat | null {
  const found = listenTogetherExt(raw);
  if (!found) return null;
  const ltType = readString(found.client.ltType) ?? readString(found.top.ltType);
  const extRoom = readString(found.client.roomId) ?? readString(found.top.roomId);
  if (!ltType || (extRoom && extRoom !== roomId)) return null;
  const extra: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(found.client)) {
    if (key === "bizType" || key === "ltType" || PER_MESSAGE_EXT_KEYS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") extra[key] = value;
  }
  const msgType = readNumber(asRecord(raw).msg_type_);
  const learnedFrom = findPlaybackEnvelope(raw) ? "playback" : msgType === 0 ? "text" : msgType === 100 ? "custom" : "other";
  const usesClientSession = typeof found.client.clientSessionId === "string";
  const msgTag = enumFields(found.top.msgTag);
  return { ltType, extra, learnedFrom, learnedAtMs: receivedAtMs, ...(usesClientSession ? { usesClientSession } : {}), ...(Object.keys(msgTag).length ? { msgTag } : {}) };
}

/** Masked structure of a chat message for TOGETHER_CHAT_DIAGNOSTICS: no text, nick, avatar or full ids. */
export function describeChatMessageFormat(raw: unknown, direction: "in" | "out"): Record<string, unknown> {
  const message = asRecord(raw);
  const setting = asRecord(message.msg_setting_);
  const ext = asRecord(parseJsonString(setting.ext_));
  const mask = (value: unknown) => { const v = readString(value) ?? (typeof value === "number" ? String(value) : null); return v ? "***" + v.slice(-4) : null; };
  const describe = (object: Record<string, unknown>) => Object.fromEntries(Object.entries(object).map(([key, value]) => {
    if (["bizType", "ltType", "appName", "type", "subType"].includes(key)) return [key, value];
    if (/id$/i.test(key)) return [key, mask(value)];
    if (value && typeof value === "object") return [key, "{" + Object.keys(value).join(",") + "}"];
    return [key, typeof value];
  }));
  const attach = readString(message.msg_attach_);
  return {
    direction,
    msgType: readNumber(message.msg_type_),
    subType: readNumber(message.sub_type_),
    sender: mask(message.from_id_),
    attachLength: attach?.length ?? 0,
    bodyLength: readString(message.msg_body_)?.length ?? 0,
    ext: describe(ext),
    clientExt: describe(asRecord(parseJsonString(ext.clientExt))),
    msgTag: enumFields(ext.msgTag),
    serverExt: Object.fromEntries(Object.entries(asRecord(parseJsonString(ext.serverExt))).map(([key, value]) => [key,
      typeof value === "number" ? `number:${String(value).length}digits` : typeof value === "string" && /^\d+$/.test(value) ? `digits:${value.length}` : typeof value])),
    setting: Object.fromEntries(Object.entries(setting).filter(([key]) => key !== "ext_").map(([key, value]) => [key, typeof value === "string" ? "string" : value])),
  };
}

// Each instance has its own TMPDIR / private /tmp, so this file is never shared between the two services.
const ROOM_FORMAT_FILE = () => join(tmpdir(), "cove-room-format.json");
export function saveRoomFormat(roomId: string, format: RoomMessageFormat, file = ROOM_FORMAT_FILE()): void {
  try { writeFileSync(file, JSON.stringify({ roomId, format }), { mode: 0o600 }); } catch { /* best effort */ }
}
export function loadRoomFormat(roomId: string, file = ROOM_FORMAT_FILE()): RoomMessageFormat | null {
  try {
    const saved = asRecord(JSON.parse(readFileSync(file, "utf8")));
    const format = asRecord(saved.format);
    return saved.roomId === roomId && typeof format.ltType === "string" ? format as unknown as RoomMessageFormat : null;
  } catch { return null; }
}

export function buildRealtimeChatTextMessage(
  text: string,
  roomId: string,
  messageId: string = randomUUID(),
  senderProfile?: RealtimeMemberProfile,
  roomFormat?: Pick<RoomMessageFormat, "ltType" | "extra" | "usesClientSession" | "msgTag"> | null,
  clientSessionId?: string,
): Record<string, unknown> {
  const normalized = text.trim();
  if (!normalized) throw new Error("ChatRoom message cannot be empty");
  if (normalized.length > MAX_CHAT_TEXT_LENGTH) {
    throw new Error(`ChatRoom message exceeds ${MAX_CHAT_TEXT_LENGTH} characters`);
  }
  const numericUserId = senderProfile?.userId && /^\d+$/.test(senderProfile.userId)
    ? Number(senderProfile.userId)
    : null;
  const senderNick = senderProfile?.nick?.trim();
  const senderAvatar = senderProfile?.avatar?.trim();
  const serverExt = numericUserId !== null && senderNick && senderAvatar
    ? {
        userId: numericUserId,
        nickname: senderNick,
        avatarUrl: senderAvatar,
        msgId: Number(BigInt(`0x${messageId.replaceAll("-", "").slice(0, 12)}`) % 90_000_000_000n + 10_000_000_000n),
        ...(typeof senderProfile?.gender === "number" ? { gender: senderProfile.gender } : {}),
      }
    : undefined;
  const ext = JSON.stringify({
    ...(serverExt ? { serverExt } : {}),
    appName: "music",
    // Official chat marks how a message was produced; the owner's phone may drop untagged chat from history.
    ...(roomFormat?.msgTag ? { msgTag: roomFormat.msgTag } : {}),
    clientExt: {
      ...(roomFormat?.extra ?? {}),
      bizType: "listenTogether",
      // Two-person rooms are FRIEND; multi-person rooms use another type the official client reveals.
      ltType: roomFormat?.ltType ?? "FRIEND",
      ...(roomFormat?.usesClientSession && clientSessionId ? { clientSessionId } : {}),
      roomId,
      clientMsgId: messageId,
    },
  });
  return {
    msg_type_: 0,
    msg_attach_: normalized,
    msg_body_: "",
    client_msg_id_: messageId,
    sub_type_: 0,
    msg_setting_: {
      ext_: ext,
      anti_spam_enable_: false,
      history_save_: true,
      anti_spam_using_yidun_: 1,
      route_enabled_: true,
    },
  };
}

export function decodeRealtimeChatRoomMessage(
  raw: unknown,
  receivedAtMs = Date.now(),
): RealtimeChatRoomMessage | null {
  const message = asRecord(raw);
  if (!Object.keys(message).length) return null;
  const msgType = readNumber(message.msg_type_);
  return {
    type: "chatroom_message",
    category: chatMessageCategory(msgType),
    msgType,
    senderId: readString(message.from_id_),
    senderNick: readString(message.from_nick_),
    text: extractChatText(message.msg_body_) ?? extractChatText(message.msg_attach_),
    messageId: readString(message.client_msg_id_),
    timetagMs: readNumber(message.timetag_),
    receivedAtMs,
  };
}

export function buildRealtimeChatRoomEnterInfo(
  profile?: RealtimeMemberProfile,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const nick = profile?.nick?.trim();
  const avatar = profile?.avatar?.trim();
  if (nick) values.nick = nick;
  if (avatar) values.avatar = avatar;
  return { values_: values };
}

function numericChatRoomId(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Unsupported NIM chatRoomId: ${value}`);
  }
  return parsed;
}

async function loadNodeNim(): Promise<NodeNimModule> {
  const imported = await import("node-nim");
  const candidate = (imported as { default?: unknown }).default ?? imported;
  const module = candidate as Partial<NodeNimModule>;
  if (typeof module.ChatRoom !== "function") {
    throw new Error("node-nim ChatRoom export is unavailable");
  }
  if (typeof module.NIMClient !== "function" || typeof module.NIMPlugin !== "function") {
    throw new Error("node-nim NIMClient/NIMPlugin exports are unavailable");
  }
  return module as NodeNimModule;
}

export class NeteaseRealtimeTransport {
  private chatroom: ChatRoomLike | null = null;
  private runtimeReady = false;
  private readonly pendingSends = new Map<string, PendingSend>();
  private roomNumber: number | null = null;
  private connecting: Promise<void> | null = null;
  private pendingEnter: PendingEnter | null = null;
  private activeMemberProfile: RealtimeMemberProfile | null = null;
  // This service's own device session id for multi-person room chat (stable for the process).
  private readonly clientSessionId = randomUUID();
  private generation = 0;
  private status: RealtimeTransportStatus;

  constructor(
    private readonly enabled = true,
    private readonly onChatMessage?: (message: RealtimeChatRoomMessage) => void,
    private readonly onPlaybackEvent?: (event: RealtimePlaybackEvent) => void,
  ) {
    this.status = {
      enabled,
      connected: false,
      roomId: null,
      chatRoomId: null,
      credentialsReady: false,
      lastPlaybackEvent: null,
      lastChatMessage: null,
      lastError: null,
      lastUnrecognizedEvent: null,
      roomMessageFormat: null,
      textFormats: { lastIn: null, lastOut: null },
    };
  }

  getStatus(): RealtimeTransportStatus {
    return {
      ...this.status,
      lastUnrecognizedEvent: this.status.lastUnrecognizedEvent
        ? { ...this.status.lastUnrecognizedEvent, shape: [...this.status.lastUnrecognizedEvent.shape] }
        : null,
      lastPlaybackEvent: this.status.lastPlaybackEvent
        ? { ...this.status.lastPlaybackEvent }
        : null,
      lastChatMessage: this.status.lastChatMessage
        ? { ...this.status.lastChatMessage }
        : null,
      roomMessageFormat: this.status.roomMessageFormat
        ? { ...this.status.roomMessageFormat, extra: { ...this.status.roomMessageFormat.extra } }
        : null,
      textFormats: structuredClone(this.status.textFormats ?? { lastIn: null, lastOut: null }),
    };
  }

  async connect(options: ConnectOptions): Promise<void> {
    if (!this.enabled) return;
    if (
      this.status.connected
      && this.status.roomId === options.roomId
      && this.status.chatRoomId === options.chatRoomId
    ) return;
    if (this.connecting) return this.connecting;

    this.connecting = this.connectInternal(options)
      .catch((error) => {
        this.recordConnectionError(error);
        throw error;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private async ensureRuntime(): Promise<void> {
    if (this.runtimeReady) return;

    const nim = await loadNodeNim();
    const chatroom = new nim.ChatRoom();
    console.log("NIM diag: before chatroom.init");
    if (!chatroom.init("", "")) {
      throw new Error("NIM chatroom initialization failed");
    }
    console.log("NIM diag: after chatroom.init");
    chatroom.initEventHandlers();

    this.chatroom = chatroom;
    this.installRuntimeHandlers(chatroom);
    this.runtimeReady = true;
    console.log("NetEase NIM ChatRoom runtime initialized once for this process");
  }

  // Isolate the short-lived IM bootstrap client in a child process.
  // node-nim cleanup can occasionally spin a native HTTP thread on Linux and
  // starve the whole Bridge process. The child only obtains the fresh ChatRoom
  // enter ticket; the parent kills it afterwards so the OS tears down all
  // native bootstrap threads without depending on SDK cleanup.
  private async requestEnterTicket(
    credentials: RealtimeCredentials,
    roomNumber: number,
  ): Promise<[number, string]> {
    const dataDir = join(
      tmpdir(),
      `cove-nim-bootstrap-${process.pid}-${randomUUID()}`,
    );
    const compiledModule = fileURLToPath(
      new URL("./nimTicketBootstrap.js", import.meta.url),
    );
    const sourceModule = fileURLToPath(
      new URL("./nimTicketBootstrap.ts", import.meta.url),
    );
    const useSourceModule = !existsSync(compiledModule) && existsSync(sourceModule);
    const modulePath = useSourceModule ? sourceModule : compiledModule;

    if (!existsSync(modulePath)) {
      throw new Error("NIM ticket bootstrap module is unavailable");
    }

    console.log("NIM diag: starting isolated bootstrap child");
    const child = fork(modulePath, [], {
      execArgv: useSourceModule ? ["--import", "tsx"] : [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });

    try {
      const result = await new Promise<[number, string]>((resolve, reject) => {
        let settled = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          callback();
        };

        timeoutHandle = setTimeout(() => {
          finish(() => reject(new Error("NIM ticket bootstrap timed out")));
        }, BOOTSTRAP_TIMEOUT_MS);
        timeoutHandle.unref?.();

        child.once("error", (error) => {
          finish(() => reject(error));
        });

        child.once("exit", (code, signal) => {
          finish(() => reject(new Error(
            "NIM ticket bootstrap exited before reply"
            + ` code=${String(code)} signal=${String(signal)}`
            + (stderr ? ` stderr=${stderr.slice(-400)}` : ""),
          )));
        });

        child.once("message", (raw) => {
          const message = asRecord(raw);
          if (message.ok !== true) {
            finish(() => reject(new Error(
              readString(message.error) || "NIM ticket bootstrap failed",
            )));
            return;
          }

          const rawResult = message.result;
          if (!Array.isArray(rawResult) || rawResult.length < 2) {
            finish(() => reject(new Error("NIM ticket bootstrap returned an invalid result")));
            return;
          }
          const code = readNumber(rawResult[0]);
          const ticket = readString(rawResult[1]);
          if (code === null || !ticket) {
            finish(() => reject(new Error("NIM ticket bootstrap returned an invalid ticket")));
            return;
          }
          finish(() => resolve([code, ticket]));
        });

        child.send({
          appKey: NIM_APP_KEY,
          dataDir,
          accId: credentials.accId,
          token: credentials.token,
          roomNumber,
        }, (error) => {
          if (error) finish(() => reject(error));
        });
      });

      console.log("NetEase NIM enter ticket acquired in isolated bootstrap child");
      return result;
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 1000);
        timer.unref?.();
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private installRuntimeHandlers(chatroom: ChatRoomLike): void {
    chatroom.on("enter", (...args: unknown[]) => {
      const room = readNumber(args[0]);
      const step = readNumber(args[1]);
      const code = readNumber(args[2]);
      const pending = this.pendingEnter;
      if (!pending || room !== pending.roomNumber || pending.generation !== this.generation) return;
      if (step !== 5) return;
      this.pendingEnter = null;
      if (code === 200) pending.resolve();
      else pending.reject(new Error(`NIM chatroom auth failed${code === null ? "" : ` code=${code}`}`));
    });

    chatroom.on("sendMsg", (...args: unknown[]) => {
      const room = readNumber(args[0]);
      const code = readNumber(args[1]);
      const rawMessage = asRecord(args[2]);
      const messageId = readString(rawMessage.client_msg_id_);
      if (!messageId) return;
      const pending = this.pendingSends.get(messageId);
      if (!pending || room !== pending.roomNumber) return;
      this.pendingSends.delete(messageId);
      clearTimeout(pending.timeout);
      if (code === 200) {
        console.log(`NetEase ChatRoom message sent: code=200 messageId=***${messageId.slice(-6)} textLength=${pending.text.length}`);
        pending.resolve({
          ok: true,
          roomId: pending.roomId,
          chatRoomId: pending.chatRoomId,
          messageId,
          text: pending.text,
          code,
        });
      } else {
        pending.reject(new Error(`NIM ChatRoom send failed${code === null ? "" : ` code=${code}`}`));
      }
    });

    chatroom.on("receiveMsg", (...args: unknown[]) => {
      const room = readNumber(args[0]);
      if (this.roomNumber !== null && room !== this.roomNumber) return;
      const receivedAtMs = Date.now();
      if (this.status.roomId) {
        const format = learnRoomMessageFormat(args[1], this.status.roomId, receivedAtMs);
        if (format) {
          const previous = this.status.roomMessageFormat;
          // A human/official text message is the best template; do not let other kinds override it.
          if (!previous || format.learnedFrom === "text" || previous.learnedFrom !== "text") {
            this.status.roomMessageFormat = format;
            if (previous?.ltType !== format.ltType || previous?.learnedFrom !== format.learnedFrom) saveRoomFormat(this.status.roomId, format);
          }
          if (previous?.ltType !== format.ltType) console.log(`NetEase room chat format: ltType=${format.ltType} from=${format.learnedFrom}`);
        }
      }
      if (readNumber(asRecord(args[1]).msg_type_) === 0) {
        this.status.textFormats = { lastIn: describeChatMessageFormat(args[1], "in"), lastOut: this.status.textFormats?.lastOut ?? null };
      }
      if (/^(1|true|on|yes)$/i.test(process.env.TOGETHER_CHAT_DIAGNOSTICS?.trim() ?? "")) {
        console.log(`NetEase chat diagnostic: ${JSON.stringify(describeChatMessageFormat(args[1], "in"))}`);
      }
      const event = decodeRealtimePlaybackEvent(args[1], receivedAtMs);
      if (event) {
        this.status.lastPlaybackEvent = event;
        console.log(
          `NetEase realtime playback event: command=${event.commandType ?? "UNKNOWN"} songId=${event.songId ?? "unknown"} progressMs=${event.progressMs} serverSeq=${event.serverSeq ?? "unknown"} latencyAnchor=receivedAt`,
        );
        if (/^(1|true|on|yes)$/i.test(process.env.TOGETHER_PLAYBACK_DIAGNOSTICS?.trim() ?? "")) {
          const diagnostic = buildPlaybackDiagnostic(args[1]);
          if (diagnostic) {
            console.log(`NetEase playback diagnostic: ${JSON.stringify(diagnostic)}`);
          }
        }
        try {
          this.onPlaybackEvent?.(event);
        } catch (error) {
          const detail = error instanceof Error ? error.message : "unknown error";
          console.error(`NetEase realtime playback sink failed: ${detail}`);
        }
        return;
      }

      const message = decodeRealtimeChatRoomMessage(args[1], receivedAtMs);
      if (!message) return;
      this.status.lastChatMessage = message;
      if (message.category === "custom" || message.category === "notification") {
        this.status.lastUnrecognizedEvent = {
          receivedAtMs,
          shape: describeUnknownRoomEvent(args[1]),
        };
      }
      const sender = message.senderId ? `***${message.senderId.slice(-4)}` : "unknown";
      const messageId = message.messageId ? `***${message.messageId.slice(-6)}` : "unknown";
      const textPreview = message.category === "text" && message.text
        ? message.text.replace(/[\r\n\t]+/g, " ").slice(0, 80)
        : null;
      console.log(
        `NetEase ChatRoom message received: category=${message.category} msgType=${message.msgType ?? "unknown"} sender=${sender} textLength=${message.text?.length ?? 0} textPreview=${textPreview === null ? "n/a" : JSON.stringify(textPreview)} messageId=${messageId}`,
      );
      try {
        this.onChatMessage?.(message);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        console.error(`NetEase ChatRoom message sink failed: ${detail}`);
      }
    });

    chatroom.on("exit", (...args: unknown[]) => {
      const room = readNumber(args[0]);
      if (this.roomNumber !== null && room !== this.roomNumber) return;
      const reason = readNumber(args[2]) ?? readNumber(args[1]);
      this.status.connected = false;
      this.status.lastError = `NIM chatroom exited${reason === null ? "" : ` reason=${reason}`}`;
      console.warn(this.status.lastError);
    });

    chatroom.on("linkCondition", (...args: unknown[]) => {
      const room = readNumber(args[0]);
      if (this.roomNumber !== null && room !== this.roomNumber) return;
      const condition = readNumber(args[1]);
      if (condition === 0) {
        if (this.roomNumber !== null) this.status.connected = true;
        this.status.lastError = null;
        return;
      }
      if (condition === 1) {
        this.status.lastError = "NIM realtime link is retrying internally";
        console.warn(this.status.lastError);
        return;
      }
      if (condition === 2) {
        this.status.connected = false;
        this.status.lastError = "NIM realtime link requires chatroom re-entry";
        console.warn(this.status.lastError);
      }
    });

  }

  private async connectInternal(options: ConnectOptions): Promise<void> {
    const generation = ++this.generation;
    const roomNumber = numericChatRoomId(options.chatRoomId);
    this.status = {
      enabled: this.enabled,
      connected: false,
      roomId: options.roomId,
      chatRoomId: options.chatRoomId,
      credentialsReady: true,
      lastPlaybackEvent: this.status.roomId === options.roomId ? this.status.lastPlaybackEvent : null,
      lastChatMessage: this.status.roomId === options.roomId ? this.status.lastChatMessage : null,
      lastUnrecognizedEvent: this.status.roomId === options.roomId ? this.status.lastUnrecognizedEvent : null,
      // A restart inside the same room reuses the format learned before, so AI chat shows at once.
      roomMessageFormat: this.status.roomId === options.roomId && this.status.roomMessageFormat
        ? this.status.roomMessageFormat
        : loadRoomFormat(options.roomId),
      textFormats: this.status.textFormats ?? { lastIn: null, lastOut: null },
      lastError: null,
    };

    await this.ensureRuntime();
    const chatroom = this.chatroom;
    if (!chatroom) throw new Error("NIM realtime runtime is unavailable");

    if (this.roomNumber !== null && this.roomNumber !== roomNumber) {
      try {
        chatroom.exit(this.roomNumber, "");
      } catch {
        // Best effort. Keep the native SDK alive and move to the new room.
      }
    }
    this.roomNumber = roomNumber;

    const [requestCode, requestLoginData] =
      await this.requestEnterTicket(options.credentials, roomNumber);
    if (requestCode !== 200 || !requestLoginData) {
      throw new Error(`NIM chatroom enter ticket failed code=${requestCode}`);
    }

    const entered = new Promise<void>((resolve, reject) => {
      this.pendingEnter = { generation, roomNumber, resolve, reject };
    });
    const started = chatroom.enter(
      roomNumber,
      requestLoginData,
      buildRealtimeChatRoomEnterInfo(options.memberProfile),
      "",
    );
    if (!started) {
      this.pendingEnter = null;
      throw new Error("NIM chatroom enter request was rejected locally");
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("NIM chatroom enter timed out")), ENTER_TIMEOUT_MS);
      timeoutHandle.unref?.();
    });
    try {
      await Promise.race([entered, timeout]);
      if (generation !== this.generation) return;

      const profile = options.memberProfile;
      if (profile?.nick || profile?.avatar) {
        const memberUpdate: Record<string, unknown> = {
          account_id_: options.credentials.accId,
          ...(profile.nick ? { nick_: profile.nick.trim() } : {}),
          ...(profile.avatar ? { avatar_: profile.avatar.trim() } : {}),
        };
        const [, updateCode] = await chatroom.updateMyRoomRoleAsync(
          roomNumber,
          memberUpdate,
          false,
          "",
          null,
          "",
        );
        if (updateCode !== 200) {
          throw new Error(`NIM ChatRoom member profile update failed code=${updateCode}`);
        }

        const [, lookupCode, members] = await chatroom.getMemberInfoByIDsAsync(
          roomNumber,
          [options.credentials.accId],
          null,
          "",
        );
        if (lookupCode !== 200) {
          throw new Error(`NIM ChatRoom member profile verify failed code=${lookupCode}`);
        }
        const ownMember = asRecord(members[0]);
        console.log(
          `NetEase ChatRoom member profile synced: nick=${readString(ownMember.nick_) ? "present" : "empty"} avatar=${readString(ownMember.avatar_) ? "present" : "empty"}`,
        );
      }

      this.activeMemberProfile = options.memberProfile ?? null;
      this.status.connected = true;
      this.status.lastError = null;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (this.pendingEnter?.generation === generation) this.pendingEnter = null;
    }
  }

  async sendChatRoomText(text: string): Promise<RealtimeChatSendResult> {
    const chatroom = this.chatroom;
    const roomNumber = this.roomNumber;
    const roomId = this.status.roomId;
    const chatRoomId = this.status.chatRoomId;
    if (!this.enabled) throw new Error("NetEase realtime transport is disabled");
    if (!this.status.connected || !chatroom || roomNumber === null || !roomId || !chatRoomId) {
      throw new Error("Not connected to a NetEase ChatRoom");
    }

    const messageId = randomUUID();
    const msg = buildRealtimeChatTextMessage(text, roomId, messageId, this.activeMemberProfile ?? undefined, this.status.roomMessageFormat, this.clientSessionId);
    this.status.textFormats = { lastIn: this.status.textFormats?.lastIn ?? null, lastOut: describeChatMessageFormat(msg, "out") };
    if (/^(1|true|on|yes)$/i.test(process.env.TOGETHER_CHAT_DIAGNOSTICS?.trim() ?? "")) {
      console.log(`NetEase chat diagnostic: ${JSON.stringify(describeChatMessageFormat(msg, "out"))}`);
    }
    const normalized = text.trim();

    return await new Promise<RealtimeChatSendResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingSends.delete(messageId);
        reject(new Error("NIM ChatRoom send timed out"));
      }, SEND_TIMEOUT_MS);
      timeout.unref?.();
      this.pendingSends.set(messageId, { roomNumber, roomId, chatRoomId, text: normalized, timeout, resolve, reject });

      let accepted = false;
      try {
        accepted = chatroom.sendMsg(roomNumber, msg, "");
      } catch (error) {
        this.pendingSends.delete(messageId);
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error("NIM ChatRoom send threw an unknown error"));
        return;
      }
      if (!accepted) {
        this.pendingSends.delete(messageId);
        clearTimeout(timeout);
        reject(new Error("NIM ChatRoom send request was rejected locally"));
      }
    });
  }

  async disconnect(): Promise<void> {
    this.generation += 1;
    for (const [messageId, pending] of this.pendingSends) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("NIM ChatRoom disconnected before send completed"));
      this.pendingSends.delete(messageId);
    }
    const pending = this.pendingEnter;
    this.pendingEnter = null;
    pending?.reject(new Error("NIM chatroom enter cancelled"));

    const roomNumber = this.roomNumber;
    this.roomNumber = null;
    this.status.connected = false;
    this.status.roomId = null;
    this.status.chatRoomId = null;
    this.status.roomMessageFormat = null;
    this.status.credentialsReady = false;
    this.activeMemberProfile = null;

    if (roomNumber !== null && this.chatroom) {
      try {
        this.chatroom.exit(roomNumber, "");
      } catch {
        // Best-effort room exit. Keep the NIM runtime initialized for reuse.
      }
    }
  }

  recordConnectionError(error: unknown): void {
    this.status.connected = false;
    this.status.lastError = error instanceof Error ? error.message : "NIM realtime connect failed";
  }
}
