import assert from "node:assert/strict";
import test from "node:test";
import { NeteaseClient } from "../src/netease/client.js";

function clientWith(respond: (op: string, params: Record<string, unknown>) => unknown) {
  const client = new NeteaseClient("test-cookie");
  // Replace the network boundary: no account or provider request in these tests.
  (client as unknown as { call: typeof respond }).call = respond;
  return client;
}

test("pair playback does not probe the multi API", async () => {
  const client = clientWith((op) => {
    assert.equal(op, "listentogether_sync_playlist_get");
    return { data: { playCommand: { targetSongId: "42", playStatus: "PAUSE", progress: 9 } } };
  });
  assert.equal((await client.getPlaying("pair")).playStatus, "PAUSE");
});

test("multi fallback validates room, uses millisecond progress and blocks pair queue writes", async () => {
  const calls: string[] = [];
  const client = clientWith((op, params) => {
    calls.push(op);
    if (op === "listentogether_sync_playlist_get") return { data: {} };
    assert.equal(params.crypto, "eapi");
    if (String(params.uri).endsWith("heartbeat")) {
      assert.deepEqual(params.data, { roomId: "multi" });
      return { data: { heartBeatDuration: 20 } };
    }
    return { data: { multiLtRoomSnapshot: { roomId: "multi", roomPlaySongInfo: {
      playSong: { songId: 42 }, playedTime: 12345, version: 2,
    } } } };
  });
  assert.deepEqual(await client.getPlaying("multi"), { songId: "42", progress: 12345, playStatus: "PLAY" });
  await client.getPlaying("multi");
  assert.equal(calls.filter(x => x === "listentogether_sync_playlist_get").length, 1);
  await assert.rejects(client.getTogetherPlaylist("multi"), /多人房间/);
  await client.sendHeartbeat("multi", "42", true, 12345);
  const count = calls.length;
  await client.sendHeartbeat("multi", "42", true, 12345);
  assert.equal(calls.length, count);
});

test("a different room's snapshot cannot supply the song", async () => {
  const client = clientWith(op => op === "api"
    ? { data: { multiLtRoomSnapshot: { roomId: "other", roomPlaySongInfo: { playSong: { songId: 42 }, playedTime: 1 } } } }
    : { data: {} });
  assert.equal((await client.getPlaying("current")).songId, null);
});

test("malformed multi progress is not fabricated", async () => {
  const client = clientWith(op => op === "api"
    ? { data: { multiLtRoomSnapshot: { roomId: "multi", roomPlaySongInfo: { playSong: { songId: 42 }, playedTime: -1 } } } }
    : { data: {} });
  await assert.rejects(client.getPlaying("multi"), /不完整/);
});
