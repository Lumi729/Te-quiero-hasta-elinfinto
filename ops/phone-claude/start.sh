#!/usr/bin/env bash
# Start the Claude instance: `start.sh music` (127.0.0.1:8797), `start.sh oauth` (127.0.0.1:8798) or both (default).
# Ctrl+C stops what this window runs. Logs never show the cookie or tokens.
set -euo pipefail
APP=/root/cove-claude SECRETS=/root/cove-claude-secrets ACCESS=/root/cove-claude-access
[ -f "$APP/dist/src/server.js" ] || { echo '还没装好：先运行 bash /root/qianqian-music/ops/phone-claude/setup.sh'; exit 1; }
[ -s "$SECRETS/netease-cookie" ] || { echo '第二个网易云账号还没登录：重新运行 setup.sh'; exit 1; }
set -a; . "$SECRETS/bridge.env"; set +a
export NODE_ENV=production NETEASE_COOKIE="$(cat "$SECRETS/netease-cookie")"
[ -f /root/cove-chat-diagnostics ] && export TOGETHER_CHAT_DIAGNOSTICS=1 # masked chat-format logging
export TMPDIR=/root/cove-claude-tmp # temporary files and audio clips never mix with the ChatGPT instance
gateway() { COVE_PUBLIC_ORIGIN=https://gege.lumi.org.cn COVE_GATEWAY_PORT=8798 COVE_UPSTREAM_PORT=8797 COVE_ACCESS_DIR="$ACCESS" \
  NETEASE_COOKIE= BRIDGE_INGEST_TOKEN= node "$APP/ops/oauth-gateway/oauth-gateway.cjs"; }
# music / oauth run separately (the launcher gives each its own window), so restarting music keeps logins.
case "${1:-all}" in
  oauth) echo "启动 Claude 那份的授权服务（8798）"; gateway;;
  music) echo "启动 Claude 那份一起听（8797）"; cd "$APP" && exec node dist/src/server.js;;
  *) gateway & pid=$!; trap 'kill $pid 2>/dev/null' EXIT
     echo "启动 Claude 那份一起听（gege.lumi.org.cn，端口 8797 / 授权 8798）"; cd "$APP" && node dist/src/server.js;;
esac
