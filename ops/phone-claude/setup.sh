#!/usr/bin/env bash
# Phone (Termux + Ubuntu "cove") setup of the second, independent instance for Claude.
# Run inside Ubuntu:  bash /root/qianqian-music/ops/phone-claude/setup.sh
# Creates only new folders; the ChatGPT instance (/root/qianqian-music, /root/cove-access,
# ports 8787/8788, cove-music.yml) is never changed. The NetEase cookie is never printed.
set -euo pipefail
APP=/root/cove-claude
SECRETS=/root/cove-claude-secrets
ACCESS=/root/cove-claude-access
REPO_URL=https://github.com/Lumi729/Te-quiero-hasta-elinfinto.git
die() { printf '\n[停止] %s\n' "$*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }
[ -f /root/cove-resonance/package.json ] || [ -d /root/qianqian-music ] || die '请在装一起听的 Ubuntu（cove）里运行。'
command -v node >/dev/null || die '没有找到 node。'
node -e 'const net=require("net");let n=0;for(const p of [8797,8798]){const s=net.createServer();s.once("error",()=>{console.error("端口"+p+"被占用：如果 Claude 那份已经在运行，请先在它的窗口按 Ctrl+C。");process.exit(1)});s.listen(p,"127.0.0.1",()=>s.close(()=>{if(++n===2)process.exit(0)}))}' || exit 1

say '1/5 下载 / 更新代码（单独一份：/root/cove-claude）'
if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else git clone "$REPO_URL" "$APP"; fi

say '2/5 安装依赖、测试、编译（第一次会比较久）'
command -v ffmpeg >/dev/null || { apt-get update -qq && apt-get install -y -qq ffmpeg >/dev/null; }
cd "$APP" && npm ci --no-audit --no-fund && npm test && npm run build

say '3/5 独立配置（已存在就保留）'
umask 077
mkdir -p "$SECRETS" "$ACCESS" /root/cove-claude-tmp
chmod 700 "$SECRETS" "$ACCESS" /root/cove-claude-tmp
if [ ! -f "$SECRETS/bridge.env" ]; then
  echo '你的网易云 UID 怎么找：网易云 App → 我的 → 点头像进主页 → 右上角「…」→ 分享 → 复制链接，链接里 id= 后面那串数字。'
  read -rp '请输入你自己的网易云 UID（只接你的邀请）：' INVITER
  [[ "$INVITER" =~ ^[0-9]+$ ]] || die 'UID 只能是数字。'
  TOKEN="$(node -p 'require("crypto").randomBytes(32).toString("hex")')"
  printf '%s\n' "PORT=8797" "BRIDGE_LISTEN_HOST=127.0.0.1" "BRIDGE_PUBLIC_ORIGIN=https://gege.lumi.org.cn" \
    "BRIDGE_INGEST_TOKEN=$TOKEN" "TOGETHER_ENABLED=true" "NETEASE_AUDIO_ENABLED=true" "NETEASE_INVITER_UID=$INVITER" > "$SECRETS/bridge.env"
  unset TOKEN
fi
[ -s "$ACCESS/.access-key" ] || node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))' > "$ACCESS/.access-key"
chmod 600 "$SECRETS/bridge.env" "$ACCESS/.access-key"

say '4/5 第二个网易云账号登录'
if [ -s "$SECRETS/netease-cookie" ]; then
  echo '已经登录过，跳过。想换账号：rm /root/cove-claude-secrets/netease-cookie 后重新运行本脚本。'
else
  echo '1) 扫码登录（推荐）   2) 自己粘贴 Cookie'
  read -rp '选 1 或 2：' how
  if [ "$how" = 2 ]; then
    echo '请粘贴 Cookie（输入时不会显示）：'; read -rs COOKIE; echo
    [[ "$COOKIE" == *MUSIC_U=* ]] || die 'Cookie 里没有 MUSIC_U，没有保存。'
    printf '%s' "$COOKIE" > "$SECRETS/netease-cookie"; unset COOKIE; chmod 600 "$SECRETS/netease-cookie"
  else
    node "$APP/scripts/netease-qr-login.mjs" "$SECRETS/netease-cookie"
  fi
fi

say '5/5 好了'
echo '以后启动 Claude 那份（在 Ubuntu 里）：bash /root/cove-claude/ops/phone-claude/start.sh'
echo '第一次还要在原生 Termux（$ 开头的窗口）里建隧道：'
echo '  proot-distro login cove -- cat /root/cove-claude/ops/phone-claude/tunnel.sh > ~/cove-claude-tunnel.sh && bash ~/cove-claude-tunnel.sh'
echo '同意页要输入的连接密钥：cat /root/cove-claude-access/.access-key'
