#!/usr/bin/env bash
# Fresh phone install of two independent Cove Resonance instances (ChatGPT + Claude), in Termux's
# Ubuntu "cove". Everything about the owner (domains, UID, accounts) is asked, nothing is hard-coded.
#   bash kit.sh setup                    first install / re-run safely (keeps config and logins)
#   bash kit.sh start <gpt|claude> <music|oauth>   used by the launcher
#   bash kit.sh key <gpt|claude>         connection key for that instance's consent page
#   bash kit.sh chatgpt-callback <url>   the callback URL ChatGPT shows for the connector
#   bash kit.sh login <gpt|claude>       (re)login that instance's NetEase account by QR code
#   bash kit.sh update                   pull, test and build the code (then: bash ~/cove.sh restart)
# NetEase cookies, tokens and keys are never printed (except `key`, which the owner needs).
set -euo pipefail
APP=/root/cove-app CONF=/root/cove-kit.env REPO_URL=https://github.com/Lumi729/Te-quiero-hasta-elinfinto.git
die() { printf '\n[停止] %s\n' "$*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }
inst_ok() { [ "${1:-}" = gpt ] || [ "${1:-}" = claude ] || die "第二个参数只能是 gpt 或 claude"; }
dir() { echo "/root/cove-$1"; }
ports() { [ "$1" = gpt ] && echo "8787 8788" || echo "8797 8798"; }
load() { [ -f "$CONF" ] || die "还没安装：先运行 bash $APP/ops/phone-kit/kit.sh setup"; . "$CONF"; }
domain_of() { [ "$1" = gpt ] && echo "$GPT_DOMAIN" || echo "$CLAUDE_DOMAIN"; }
ask_domain() { local v; read -rp "$1" v; v=${v#https://}; v=${v%%/*}; [[ "$v" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "域名格式不对：$v"; echo "$v"; }

build() {
  say '下载 / 更新代码'
  if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else git clone "$REPO_URL" "$APP"; fi
  say '安装依赖、测试、编译（第一次会比较久）'
  cd "$APP" && npm ci --no-audit --no-fund && npm test && npm run build
}

login() {
  local i=$1 d; d=$(dir "$1")
  echo; echo "请用给【$( [ "$i" = gpt ] && echo ChatGPT || echo Claude )】准备的那个网易云账号扫码（不是你自己的大号）："
  echo '1) 扫码登录（推荐）   2) 自己粘贴 Cookie'
  local how; read -rp '选 1 或 2：' how
  if [ "$how" = 2 ]; then
    echo '请粘贴 Cookie（输入时不会显示）：'; local c; read -rs c; echo
    [[ "$c" == *MUSIC_U=* ]] || die 'Cookie 里没有 MUSIC_U，没有保存。'
    ( umask 077; printf '%s' "$c" > "$d/secrets/netease-cookie" ); unset c
  else
    node "$APP/scripts/netease-qr-login.mjs" "$d/secrets/netease-cookie"
  fi
}

case "${1:-}" in
  setup)
    command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die '需要 Node.js 22：按指南第 3 步安装。'
    command -v git >/dev/null || die '需要 git：apt install -y git'
    command -v ffmpeg >/dev/null || { apt-get update -qq && apt-get install -y -qq ffmpeg >/dev/null; }
    build
    if [ ! -f "$CONF" ]; then
      say '基本信息（以后不用再填）'
      echo '你自己的网易云 UID：App → 我的 → 点头像 → 右上角「…」→ 分享 → 复制链接，id= 后面的数字。'
      read -rp '你的网易云 UID：' uid; [[ "$uid" =~ ^[0-9]+$ ]] || die 'UID 只能是数字。'
      gd=$(ask_domain '给 ChatGPT 用的地址（例如 gpt.你的域名.com）：')
      cd_=$(ask_domain '给 Claude 用的地址（例如 claude.你的域名.com）：')
      [ "$gd" != "$cd_" ] || die '两个地址不能一样。'
      ( umask 077; printf 'OWNER_UID=%s\nGPT_DOMAIN=%s\nCLAUDE_DOMAIN=%s\nCHATGPT_CALLBACK=\n' "$uid" "$gd" "$cd_" > "$CONF" )
    fi
    . "$CONF"
    for i in gpt claude; do
      d=$(dir $i); mkdir -p "$d/secrets" "$d/access" "$d/tmp"; chmod 700 "$d" "$d/secrets" "$d/access" "$d/tmp"
      [ -s "$d/access/.access-key" ] || ( umask 077; node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))' > "$d/access/.access-key" )
      [ -s "$d/secrets/ingest-token" ] || ( umask 077; node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$d/secrets/ingest-token" )
      if [ -s "$d/secrets/netease-cookie" ]; then echo "$i 的网易云账号已经登录过，跳过。"; else login $i; fi
    done
    say '好了'
    echo "ChatGPT 的连接器地址：https://$GPT_DOMAIN/mcp/music"
    echo "Claude 的连接器地址：https://$CLAUDE_DOMAIN/mcp/music"
    echo '下一步：按指南回到原生 Termux 建隧道、拿启动器。';;
  start)
    inst_ok "${2:-}"; load; i=$2 d=$(dir "$2"); read -r music oauth <<<"$(ports "$i")"
    case "${3:-}" in
      oauth)
        # The fixed ChatGPT client only works with the exact callback the owner copied from ChatGPT.
        export COVE_CHATGPT_CALLBACK="${CHATGPT_CALLBACK:-https://chatgpt.com/connector/oauth/not-configured}"
        export COVE_PUBLIC_ORIGIN="https://$(domain_of "$i")" COVE_GATEWAY_PORT=$oauth COVE_UPSTREAM_PORT=$music COVE_ACCESS_DIR="$d/access"
        exec node "$APP/ops/oauth-gateway/oauth-gateway.cjs";;
      music)
        [ -s "$d/secrets/netease-cookie" ] || die "$i 的网易云账号还没登录：bash $APP/ops/phone-kit/kit.sh login $i"
        export NODE_ENV=production PORT=$music BRIDGE_LISTEN_HOST=127.0.0.1 BRIDGE_PUBLIC_ORIGIN="https://$(domain_of "$i")"
        export BRIDGE_INGEST_TOKEN="$(cat "$d/secrets/ingest-token")" NETEASE_COOKIE="$(cat "$d/secrets/netease-cookie")"
        export TOGETHER_ENABLED="${TOGETHER_ENABLED:-true}" NETEASE_AUDIO_ENABLED=true NETEASE_INVITER_UID="$OWNER_UID" TMPDIR="$d/tmp"
        [ -f /root/cove-chat-diagnostics ] && export TOGETHER_CHAT_DIAGNOSTICS=1
        cd "$APP" && exec node dist/src/server.js;;
      *) die '用法：kit.sh start <gpt|claude> <music|oauth>';;
    esac;;
  key) inst_ok "${2:-}"; cat "$(dir "$2")/access/.access-key"; echo;;
  login) inst_ok "${2:-}"; load; rm -f "$(dir "$2")/secrets/netease-cookie"; login "$2"; echo '登录好了，运行 bash ~/cove.sh restart 生效。';;
  chatgpt-callback)
    load; url=${2:-}
    [[ "$url" =~ ^https://chatgpt\.com/connector/oauth/[A-Za-z0-9_-]+$ ]] || die '应该是 https://chatgpt.com/connector/oauth/… 这样的地址，从 ChatGPT 的连接器设置里复制。'
    sed -i "s#^CHATGPT_CALLBACK=.*#CHATGPT_CALLBACK=$url#" "$CONF"
    echo '已保存。重启两个授权服务生效：bash ~/cove.sh restart gpt-oauth && bash ~/cove.sh restart claude-oauth';;
  update) build; echo '更新好了：回到原生 Termux 运行 bash ~/cove.sh restart';;
  *) sed -n '4,10p' "$0";;
esac
