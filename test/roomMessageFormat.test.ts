import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRealtimeChatTextMessage, describeChatMessageFormat, learnRoomMessageFormat, loadRoomFormat, saveRoomFormat } from "../src/netease/realtimeTransport.js";

const incoming = (ltType: string, roomId: string, msgType = 0, extra: Record<string, unknown> = {}) => ({
  msg_type_: msgType,
  from_id_: "359887555",
  from_nick_: "Lumi_LL",
  msg_attach_: "大家好",
  client_msg_id_: "abcdef-123456",
  msg_setting_: { ext_: JSON.stringify({ appName: "music", serverExt: { userId: 359887555, nickname: "Lumi_LL", avatarUrl: "https://a/b.jpg" }, clientExt: { bizType: "listenTogether", ltType, roomId, clientMsgId: "x", userId: 1, ...extra } }) },
});
const clientExtOf = (msg: Record<string, unknown>) => JSON.parse(JSON.parse(JSON.stringify((msg.msg_setting_ as { ext_: string }).ext_)) as string).clientExt;

test("two-person rooms keep the FRIEND chat format", () => {
  const msg = buildRealtimeChatTextMessage("hi", "room-2", "11111111-2222-3333-4444-555555555555");
  assert.equal(clientExtOf(msg).ltType, "FRIEND");
});

test("multi-person rooms send AI chat with the room's own ltType and room-level fields", () => {
  // Shape observed in the owner's real three-person room (values replaced).
  const format = learnRoomMessageFormat(incoming("MULTI_MATCH_SONG", "room-3", 0, { partyType: 2, syncSource: "", clientSessionId: "owner-phone-session" }), "room-3", 1);
  assert.deepEqual(format, { ltType: "MULTI_MATCH_SONG", extra: { partyType: 2, syncSource: "" }, learnedFrom: "text", learnedAtMs: 1, usesClientSession: true });
  const ext = clientExtOf(buildRealtimeChatTextMessage("我也在", "room-3", "11111111-2222-3333-4444-555555555555", undefined, format, "ai-own-session"));
  assert.equal(ext.clientSessionId, "ai-own-session", "AI uses its own device session, never the owner's");
  assert.equal(ext.ltType, "MULTI_MATCH_SONG");
  assert.equal(ext.partyType, 2);
  assert.equal(ext.roomId, "room-3", "room id is our own, not copied");
  assert.equal(ext.clientMsgId, "11111111-2222-3333-4444-555555555555");
  assert.equal(ext.userId, undefined, "per-sender fields are never copied from someone else");
});

test("formats from another room or without Listen Together ext are ignored", () => {
  assert.equal(learnRoomMessageFormat(incoming("MULTI", "other-room"), "room-3"), null);
  assert.equal(learnRoomMessageFormat({ msg_type_: 0, msg_setting_: { ext_: "{}" } }, "room-3"), null);
});

test("chat diagnostics show structure but never text, nick, avatar or full ids", () => {
  const line = JSON.stringify(describeChatMessageFormat(incoming("MULTI", "room-3-abcdef"), "in"));
  assert.match(line, /"ltType":"MULTI"/);
  assert.match(line, /"bizType":"listenTogether"/);
  for (const secret of ["大家好", "Lumi_LL", "https://a/b.jpg", "359887555", "room-3-abcdef"]) assert.ok(!line.includes(secret), secret);
});

test("a learned room format survives a service restart in the same room only", () => {
  const file = join(mkdtempSync(join(tmpdir(), "cove-fmt-")), "f.json");
  const format = learnRoomMessageFormat(incoming("MULTI_MATCH_SONG", "room-3"), "room-3", 5)!;
  saveRoomFormat("room-3", format, file);
  assert.deepEqual(loadRoomFormat("room-3", file), format);
  assert.equal(loadRoomFormat("another-room", file), null);
  assert.equal(loadRoomFormat("room-3", file + ".missing"), null);
});

test("format comparison shows setting flags and serverExt shape, not values", () => {
  const out = describeChatMessageFormat(buildRealtimeChatTextMessage("hi", "room-3", "11111111-2222-3333-4444-555555555555", { userId: "18023854293", nick: "Infinito_LY", avatar: "https://x/y.jpg" }), "out");
  assert.equal((out.setting as Record<string, unknown>).history_save_, true);
  assert.deepEqual(Object.keys(out.serverExt as object).sort(), ["avatarUrl", "msgId", "nickname", "userId"]);
  assert.equal((out.serverExt as Record<string, unknown>).msgId, "number:11digits");
  const line = JSON.stringify(out);
  for (const secret of ["Infinito_LY", "https://x/y.jpg", "18023854293"]) assert.ok(!line.includes(secret), secret);
});

test("AI chat carries the room's msgTag flags like official chat, never free text", () => {
  const raw = incoming("MULTI_MATCH_SONG", "room-3");
  const ext = JSON.parse(raw.msg_setting_.ext_);
  ext.msgTag = { msgUserSource: "USER", userMsgGenerationMode: 1, note: "free text here!" };
  raw.msg_setting_.ext_ = JSON.stringify(ext);
  const format = learnRoomMessageFormat(raw, "room-3")!;
  assert.deepEqual(format.msgTag, { msgUserSource: "USER", userMsgGenerationMode: 1 });
  const msg = buildRealtimeChatTextMessage("hi", "room-3", "11111111-2222-3333-4444-555555555555", undefined, format, "s");
  assert.deepEqual(JSON.parse((msg.msg_setting_ as { ext_: string }).ext_).msgTag, { msgUserSource: "USER", userMsgGenerationMode: 1 });
  assert.equal(JSON.parse((buildRealtimeChatTextMessage("hi", "r2").msg_setting_ as { ext_: string }).ext_).msgTag, undefined, "two-person rooms unchanged");
});

test("msgTag with null, nested or numeric-string flags is still learned; long text never is", () => {
  const raw = incoming("MULTI_MATCH_SONG", "room-3");
  const ext = JSON.parse(raw.msg_setting_.ext_);
  ext.msgTag = JSON.stringify({ msgUserSource: null, userMsgGenerationMode: { mode: "1" } });
  raw.msg_setting_.ext_ = JSON.stringify(ext);
  assert.deepEqual(learnRoomMessageFormat(raw, "room-3")!.msgTag, { msgUserSource: null, userMsgGenerationMode: { mode: "1" } });
  ext.msgTag = { msgUserSource: "a sentence with spaces", userMsgGenerationMode: "x".repeat(40) };
  raw.msg_setting_.ext_ = JSON.stringify(ext);
  assert.equal(learnRoomMessageFormat(raw, "room-3")!.msgTag, undefined);
  const shape = describeChatMessageFormat(raw, "in");
  assert.deepEqual(shape.msgTag, { msgUserSource: "string:22:spaces", userMsgGenerationMode: "string:40" });
});
