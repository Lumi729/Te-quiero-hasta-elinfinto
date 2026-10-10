# 千千的一起听：音频片段实验

这是 Lumi729 的个人分支，基于 Yancey × Cove 的 MIT 项目 Cove Resonance。

## 现在增加了什么

新增 `netease_audio_clip`，同时出现在 `/mcp` 和 `/mcp/music`。
它用服务端已登录的网易云账号获取标准音质可播放音源，截取短片段，
返回 MCP 标准 `audio` 内容（WAV，单声道，16 kHz）。不会改变手机播放。
不需要 OpenAI API Key，也不另开一个模型。

- 不传 songId：取调用时的一起听歌曲，默认截取当前进度之前的 15 秒；歌曲刚开始则从开头取。
- 指定 songId：从这首歌的开头取，或用 startSeconds 指定位置。
- durationSeconds：5–30 秒，默认 15 秒。
- 歌曲在取片段期间切换，会返回 currentSongChanged=true，片段仍标记原来的 songId。
- 版权、地区、账号权限或仅试听时返回错误；不绕过限制、不借用其他账号。

这是歌曲录音片段，不是麦克风采集，不是连续实时音流，不自动循环下载。

## 已验证与未验证

已验证：账号 API 返回值解析、下载和重定向限制、大小上限、真实 FFmpeg 截取、
WAV 解码、MCP 工具注册与音频结果、参数校验、并发与取消、原有测试回归。

未验证：手机上的真实网易云音源下载，以及 ChatGPT 普通聊天是否将 **MCP 工具返回的音频**
交给模型。普通聊天能分析上传的 MP3 并不能证明能接收 MCP 音频。
当前工作会话在单独测试音频输入时明确报告不支持。

工具返回 `hostAudioSupport: "unverified"`；`ok: true` 只表示片段已准备好。
模型必须实际收到音频才可描述乐器、人声或旋律，不能以歌词/歌名冒充听到。
协议依据：https://modelcontextprotocol.io/specification/2025-06-18/server/tools#audio-content

## 从千千现有手机部署迁移

在 **Ubuntu / proot 的 root@localhost 窗口** 操作。先复用一个空闲窗口准备新目录，
原来的 `/root/cove-resonance` 保留，OAuth 网关和 Cloudflare 隧道无需重装。

```bash
cd /root
apt-get update && apt-get install -y ffmpeg
git clone https://github.com/Lumi729/Te-quiero-hasta-elinfinto.git qianqian-music
cd /root/qianqian-music
npm ci
npm test && npm run build
```

若 `qianqian-music` 已存在，先查看其中的 `git status`，不要重复 clone 或覆盖本地改动。
依赖需要 Node 22，和原服务一致。

准备成功后，去**原来运行 npm start 的音乐服务窗口**按 Ctrl+C 停止原服务。
不停止 OAuth / cloudflared。随后在同一个音乐服务窗口运行：

```bash
cd /root/qianqian-music
NETEASE_COOKIE_FILE=/root/cove-resonance/.netease-cookie bash scripts/start-personal.sh
```

新服务读取原 Cookie 文件，不显示、不复制到 Git；使用相同端口 8787 和原有 OAuth 入口。
不要同时运行两套音乐服务或两个 NIM 登录。
若出现 EADDRINUSE，先确认旧音乐服务是否仍在运行，不要批量结束 Termux 进程。

## 怎么测

重启后，在 ChatGPT 插件管理中刷新工具列表（如界面没有刷新入口，重新连接），
确认出现 `netease_audio_clip`。地址仍为原来的 `/mcp/music`。
在想测试的普通聊天中选中插件，发送：

> 调用 netease_audio_clip，取当前歌曲 15 秒。如果实际收到声音，再描述人声、乐器和节奏；
> 如果只收到文字、音频被省略或提示不支持，请直接报告，不要根据歌名或歌词猜。

也可先指定已经搜索到的 songId，startSeconds=0，durationSeconds=15。
不要把 `ok=true` 直接当成客户端已经听到。
若客户端不支持，保留错误结果即可；这不影响原来的歌词、聊天室和播放控制。

## 关闭实验 / 回到旧版

只关闭音频（先 Ctrl+C 停止新服务）：

```bash
cd /root/qianqian-music
NETEASE_AUDIO_ENABLED=false NETEASE_COOKIE_FILE=/root/cove-resonance/.netease-cookie bash scripts/start-personal.sh
```

完全回旧版（先 Ctrl+C 停止新服务）：

```bash
cd /root/cove-resonance
export NETEASE_COOKIE="$(cat .netease-cookie)"
export TOGETHER_ENABLED=true
export PORT=8787
export BRIDGE_PUBLIC_ORIGIN=https://cove.lumi.org.cn
npm start
```

## 实现边界

默认关闭（`NETEASE_AUDIO_ENABLED=false`）；个人启动脚本显式开启。
单次最多下载 16 MiB，单片段最多 30 秒；整个调用限时 55 秒；同进程只处理一个音频请求。
只接受账号 API 给出的网易云媒体域名，强制 HTTPS，逐跳验证重定向，不转发 Cookie。
FFmpeg 只处理临时本地文件，限制输入格式和协议；结束后删除临时文件。
音频以工具结果返回，没有增加公开下载路由、公开 Cookie 或外部音频服务。
现有公网 MCP 必须继续经过已配置的 OAuth 网关。
