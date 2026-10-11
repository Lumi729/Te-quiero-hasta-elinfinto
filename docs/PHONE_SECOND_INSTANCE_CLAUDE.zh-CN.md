# 手机上的第二份一起听（给 Claude 用，gege.lumi.org.cn）

和 ChatGPT 那份并排跑在同一台手机的 Termux 里，完全独立：

| | ChatGPT 那份（不变） | Claude 这份（新） |
| --- | --- | --- |
| 代码 | `/root/qianqian-music` | `/root/cove-claude` |
| 端口 | 8787 / 授权 8788 | 8797 / 授权 8798（只监听本机） |
| 授权目录 | `/root/cove-access` | `/root/cove-claude-access` |
| 网易云账号 | 原账号 | 第二个账号（`/root/cove-claude-secrets/netease-cookie`） |
| 临时文件 / 音频片段 | 系统 /tmp | `/root/cove-claude-tmp` |
| 隧道 | `cove-music.yml` | 新隧道 `cove-claude`（`cove-claude.yml`） |

队列、会话都在各自进程的内存里，不会共用。

## 第一次安装

1. Ubuntu 窗口（`proot-distro login cove` 进去）：
   ```bash
   cd /root/qianqian-music && git pull --ff-only && bash ops/phone-claude/setup.sh
   ```
   会问你自己的网易云 UID，然后让第二个账号扫码登录（同一台手机：在网易云扫码页点「相册」，选 Download 里的 `netease-login-qr.png`）。
2. 原生 Termux 窗口（`$` 开头）建隧道：
   ```bash
   proot-distro login cove -- cat /root/cove-claude/ops/phone-claude/tunnel.sh > ~/cove-claude-tunnel.sh && bash ~/cove-claude-tunnel.sh
   ```
   第一次如果提示先登录 Cloudflare，按提示运行 `cloudflared tunnel login`，再运行上面那行。

## 每次启动（新开两个窗口）

- Ubuntu：`bash /root/cove-claude/ops/phone-claude/start.sh`（一起听 + 授权服务，Ctrl+C 一起停）
- 原生 Termux：`bash ~/cove-claude-tunnel.sh`

## Claude 里填

`https://gege.lumi.org.cn/mcp/music`。同意页要输入的连接密钥：`cat /root/cove-claude-access/.access-key`（在 Ubuntu 里）。

## 更新

Claude 这份：Ctrl+C 停掉 start.sh 后，Ubuntu 里运行 `bash /root/cove-claude/ops/phone-claude/setup.sh`（配置和登录保留），再启动。
ChatGPT 这份照旧：`cd /root/qianqian-music && git pull --ff-only && npm run build`，重启它自己的窗口。

日志里不会出现 Cookie 和 token（`src/logRedaction.ts` 会替换成 `<hidden>`）。
