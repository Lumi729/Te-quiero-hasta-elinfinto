# 第二份一起听（给 Claude 用，gege.lumi.org.cn）

和 ChatGPT 那份完全独立：不同的系统用户（`cove-claude`）、目录（`/opt/cove-claude`）、
配置（`/etc/cove-claude/bridge.env`，只有 root 可读）、端口（一起听 8797、授权 8798，都只监听本机）、
systemd 服务（`cove-claude`、`cove-claude-oauth`，各自独立的私有 /tmp）。
队列、会话、待处理事件都在各自进程内存里；音频片段和 NIM 临时目录在各自私有 /tmp 里，不共用。
ChatGPT 那份的目录、端口、服务、域名都不会被修改。

## 安装（第一次）

先在域名解析里把 `gege.lumi.org.cn` 指向这台 VPS，然后：

```bash
curl -fsSL https://raw.githubusercontent.com/Lumi729/Te-quiero-hasta-elinfinto/main/ops/cove-claude/install.sh -o /tmp/cove-claude-install.sh
sudo bash /tmp/cove-claude-install.sh
```

脚本会问两件事：你的网易云 UID（只接你的邀请）、第二个账号的 Cookie（输入时不显示，也不会写进日志）。
BRIDGE_INGEST_TOKEN 和同意页用的连接密钥自动随机生成。nginx 或 Caddy 会自动加上 gege 这一个站点并配好 HTTPS。
最后会跑一遍自检。

## Claude 里填

`https://gege.lumi.org.cn/mcp/music`（`/mcp` 也可以）。授权页确认写着 claude.ai，输入连接密钥：

```bash
sudo cat /opt/cove-claude/access/.access-key
```

## 日常命令

| 做什么 | 命令 |
| --- | --- |
| 更新 Claude 这份 | `sudo bash /opt/cove-claude/app/ops/cove-claude/install.sh`（拉代码、测试、编译、重启，配置保留） |
| 重启 Claude 这份 | `sudo systemctl restart cove-claude cove-claude-oauth` |
| 看 Claude 这份的日志 | `sudo journalctl -u cove-claude -u cove-claude-oauth -f` |
| 改 Cookie / UID | `sudo nano /etc/cove-claude/bridge.env`，然后重启 Claude 这份 |
| 两份一起自检（只读） | `sudo bash /opt/cove-claude/app/ops/cove-claude/verify.sh` |
| 重启 ChatGPT 那份 | `sudo systemctl restart cove-bridge`（授权服务名用 `systemctl list-units 'cove*'` 查看） |
| 更新 ChatGPT 那份 | 在它自己的目录（`systemctl cat cove-bridge` 里的 WorkingDirectory）：`git pull --ff-only && npm ci && npm run build`，再重启它 |

授权服务重启后，Claude 需要重新连接一次（令牌只在内存里）；已注册的 Claude 客户端会保留。

## 日志安全

两份实例启动时都会把输出里的网易云 Cookie、BRIDGE_INGEST_TOKEN、Bearer 令牌和链接里的一次性参数替换成 `<hidden>`
（`src/logRedaction.ts`）。Cookie 只放在 root 才能读的配置文件里，由 systemd 读取，不出现在命令行或进程列表。

## 卸载

```bash
sudo systemctl disable --now cove-claude cove-claude-oauth
sudo rm /etc/systemd/system/cove-claude*.service && sudo systemctl daemon-reload
sudo rm -f /etc/nginx/sites-enabled/gege.lumi.org.cn /etc/nginx/sites-available/gege.lumi.org.cn && sudo systemctl reload nginx
sudo rm -rf /opt/cove-claude /etc/cove-claude && sudo userdel cove-claude
```
