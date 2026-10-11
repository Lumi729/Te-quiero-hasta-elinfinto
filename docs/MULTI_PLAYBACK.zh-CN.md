# 多人播放读取（实验）

双人播放接口没有返回歌曲和状态时，查询 `/api/listen/together/multi/match/status/get`，只接受 roomId 与当前连接一致的 multiLtRoomSnapshot。roomPlaySongInfo.playSong.songId 是歌曲，playedTime 是毫秒进度。多人播放由服务端驱动，本机暂停不代表全房间暂停。多人 version 不作为双人 NIM serverSeq 使用。

识别多人房间后，心跳使用 `/api/listen/together/multi/match/heartbeat`，遵守 heartBeatDuration 的最小等待时间。状态仍按现有 HTTP reconcile 周期更新（默认 30 秒），不是实时推送同步。暂不适配多人加入、退出、推歌或切歌；拦截已识别多人房间的双人播放和队列写入。

协议参考（独立实现，未复制源代码）：
https://github.com/tabidachinokaze/music-party/blob/main/docs/OFFICIAL-MULTIPLAYER.md
https://github.com/tabidachinokaze/music-party/blob/main/src/main/multi-api.ts

尚待真实账号验收。30005 的含义仍未确认，没有把它当作播放事件。自动测试使用模拟响应，不代表手机已验证。
