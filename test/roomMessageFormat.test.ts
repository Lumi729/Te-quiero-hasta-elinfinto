import assert from "node:assert/strict";
import test from "node:test";
import { buildRealtimeChatTextMessage, describeChatMessageFormat, learnRoomMessageFormat } from "../src/netease/realtimeTransport.js";

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
  const format = learnRoomMessageFormat(incoming("MULTI", "room-3", 0, { partyType: 2, sceneId: "s1" }), "room-3", 1);
  assert.deepEqual(format, { ltType: "MULTI", extra: { partyType: 2, sceneId: "s1" }, learnedFrom: "text", learnedAtMs: 1 });
  const ext = clientExtOf(buildRealtimeChatTextMessage("我也在", "room-3", "11111111-2222-3333-4444-555555555555", undefined, format));
  assert.equal(ext.ltType, "MULTI");
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
