#!/usr/bin/env bash
# Install (or update) the second Cove Resonance instance for Claude on this VPS.
#   sudo bash ops/cove-claude/install.sh
# Creates only new things: user cove-claude, /opt/cove-claude, /etc/cove-claude,
# cove-claude*.service and the gege.lumi.org.cn site. The ChatGPT instance (its
# directory, ports, services and domain) is never modified.
# The NetEase cookie is read without echo and is never printed or logged.
set -euo pipefail

DOMAIN=gege.lumi.org.cn
BASE=/opt/cove-claude
ETC=/etc/cove-claude
BRIDGE_PORT=8797
GATEWAY_PORT=8798
REPO_URL=${COVE_REPO_URL:-https://github.com/Lumi729/Te-quiero-hasta-elinfinto.git}
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n== %s\n' "$*"; }
die() { printf '\n[停止] %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die '请用 sudo 运行：sudo bash ops/cove-claude/install.sh'
command -v systemctl >/dev/null || die '这台机器没有 systemd。'
command -v git >/dev/null || die '请先安装 git：apt-get install -y git'
NODE="$(command -v node || true)"
[ -n "$NODE" ] || die '没有找到 node（需要 Node.js 22）。'
NODE="$(readlink -f "$NODE")"
case "$NODE" in /root/*|/home/*) die "node 装在 $NODE（个人目录里），服务用户读不到。请装一个系统级的 Node.js 22（例如 NodeSource 的 apt 包）。";; esac
cd /
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 版本是 $("$NODE" -v)，需要 22 或更高。"
NPM="$(dirname "$NODE")/npm"; [ -x "$NPM" ] || NPM="$(command -v npm)"

# A port already in use must belong to this instance; otherwise stop before touching anything.
ours() { systemctl is-active --quiet "$1" 2>/dev/null; }
for pair in "$BRIDGE_PORT:cove-claude.service" "$GATEWAY_PORT:cove-claude-oauth.service"; do
  port=${pair%%:*} unit=${pair#*:}
  if ss -ltnH "( sport = :$port )" 2>/dev/null | grep -q . && ! ours "$unit"; then
    die "端口 $port 已被其他程序占用（可能是 ChatGPT 那份），为了不影响它，已停止安装。"
  fi
done

say '1/7 系统用户和目录'
id cove-claude >/dev/null 2>&1 || useradd --system --home-dir "$BASE/home" --shell /usr/sbin/nologin cove-claude
install -d -o cove-claude -g cove-claude -m 0750 "$BASE"
install -d -o cove-claude -g cove-claude -m 0700 "$BASE/home" "$BASE/access"
install -d -o root -g root -m 0700 "$ETC"

say '2/7 下载 / 更新代码（同一个仓库，单独一份）'
if [ -d "$BASE/app/.git" ]; then
  runuser -u cove-claude -- git -C "$BASE/app" pull --ff-only
else
  runuser -u cove-claude -- git clone "$REPO_URL" "$BASE/app"
fi
KIT="$BASE/app/ops/cove-claude" # always use the units/configs from the code being installed

say '3/7 安装依赖、测试、编译'
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  echo '安装 ffmpeg（测试和音频片段需要）…'
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg >/dev/null; }
fi
as_app() { runuser -u cove-claude -- env HOME="$BASE/home" PATH="$(dirname "$NODE"):$PATH" "$@"; }
( cd "$BASE/app" && as_app "$NPM" ci --no-audit --no-fund && as_app "$NPM" test && as_app "$NPM" run build )

say '4/7 独立配置文件（已存在则保留原样）'
ENV_FILE="$ETC/bridge.env"
if [ ! -f "$ENV_FILE" ]; then
  read -rp '请输入你的网易云 UID（只接这个账号的一起听邀请）：' INVITER
  [[ "$INVITER" =~ ^[0-9]+$ ]] || die 'UID 只能是数字。'
  echo '请粘贴第二个账号的 NETEASE_COOKIE（输入时不会显示；直接回车可稍后再填）：'
  read -rs COOKIE; echo
  esc() { local v=${1//\\/\\\\}; printf '"%s"' "${v//\"/\\\"}"; }
  TOKEN="$(openssl rand -hex 32 2>/dev/null || "$NODE" -p 'require("crypto").randomBytes(32).toString("hex")')"
  ( umask 077
    { echo "NODE_ENV=production"
      echo "PORT=$BRIDGE_PORT"
      echo "BRIDGE_LISTEN_HOST=127.0.0.1"
      echo "BRIDGE_PUBLIC_ORIGIN=https://$DOMAIN"
      echo "BRIDGE_INGEST_TOKEN=$TOKEN"
      echo "BRIDGE_UNIX_SOCKET="
      echo "TOGETHER_ENABLED=true"
      echo "TOGETHER_POLL_INTERVAL_MS=4000"
      echo "TOGETHER_HEARTBEAT_INTERVAL_MS=10000"
      echo "NETEASE_INVITER_UID=$INVITER"
      echo "NETEASE_AUDIO_ENABLED=true"
      echo "NETEASE_COOKIE=$(esc "$COOKIE")"
    } > "$ENV_FILE" )
  unset COOKIE TOKEN
  chown root:root "$ENV_FILE"; chmod 0600 "$ENV_FILE"
  echo "已写入 $ENV_FILE（只有 root 能读）。"
else
  echo "$ENV_FILE 已存在，没有改动。"
fi
if [ ! -s "$BASE/access/.access-key" ]; then
  ( umask 077; "$NODE" -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))' > "$BASE/access/.access-key" )
  chown cove-claude:cove-claude "$BASE/access/.access-key"; chmod 0600 "$BASE/access/.access-key"
fi

say '5/7 systemd 服务'
for unit in cove-claude.service cove-claude-oauth.service; do
  sed "s#@NODE@#$NODE#g" "$KIT/$unit" > "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable cove-claude.service cove-claude-oauth.service >/dev/null
if grep -q '^NETEASE_COOKIE=""$' "$ENV_FILE"; then
  echo 'Cookie 还没填：先只启动授权服务。填好后运行 sudo systemctl restart cove-claude'
  systemctl restart cove-claude-oauth.service
else
  systemctl restart cove-claude.service cove-claude-oauth.service
fi

say '6/7 反向代理和 HTTPS（只新增 gege 这一个站点）'
if command -v nginx >/dev/null && systemctl is-active --quiet nginx; then
  if [ -d /etc/nginx/sites-available ]; then site=/etc/nginx/sites-available/$DOMAIN; link=/etc/nginx/sites-enabled/$DOMAIN
  else site=/etc/nginx/conf.d/$DOMAIN.conf; link=; fi
  if [ -f "$site" ] && ! grep -q COVE_CLAUDE_SITE_V1 "$site"; then
    echo "$site 已存在且不是本脚本生成的，没有覆盖。"
  elif [ ! -f "$site" ]; then
    cp "$KIT/nginx-gege.conf" "$site"; [ -n "$link" ] && ln -sf "$site" "$link"
    if ! nginx -t 2>/dev/null; then rm -f "$site" ${link:+"$link"}; die 'nginx 配置检查没通过，已撤回新站点，原有站点没受影响。'; fi
    systemctl reload nginx
  fi
  if command -v certbot >/dev/null; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect --keep-until-expiring \
      || echo '证书申请没成功：请确认 gege.lumi.org.cn 的 DNS 已指向这台 VPS，再重新运行本脚本。'
  else
    echo '没有 certbot：apt-get install -y certbot python3-certbot-nginx 后重新运行本脚本。'
  fi
elif command -v caddy >/dev/null && systemctl is-active --quiet caddy; then
  if ! grep -q COVE_CLAUDE_SITE_V1 /etc/caddy/Caddyfile; then
    cp -p /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-cove-claude-$(date +%s)"
    { echo; cat "$KIT/Caddyfile.snippet"; } >> /etc/caddy/Caddyfile
    caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || die 'Caddy 配置检查没通过；备份在 /etc/caddy/Caddyfile.before-cove-claude-*，请恢复后联系维护者。'
    systemctl reload caddy
  fi
  echo 'Caddy 会自动申请 HTTPS 证书。'
else
  echo '没有检测到正在运行的 nginx 或 Caddy：请把 gege.lumi.org.cn 指向 http://127.0.0.1:8798（/listener/events 指向 8797）。'
fi

say '7/7 自检'
bash "$KIT/verify.sh" || true
echo
echo "完成。Claude 连接器地址：https://$DOMAIN/mcp/music"
echo "同意页要用的连接密钥：sudo cat $BASE/access/.access-key"
