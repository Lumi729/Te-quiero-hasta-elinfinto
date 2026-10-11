#!/data/data/com.termux/files/usr/bin/bash
# Native Termux: one Cloudflare tunnel per instance (cove-gpt / cove-claude), http2 because some
# networks block QUIC. First run creates the tunnel, the DNS record and ~/.cloudflared/cove-<i>.yml.
#   bash ~/cove-kit-tunnel.sh <gpt|claude>
set -euo pipefail
i=${1:-}; [ "$i" = gpt ] || [ "$i" = claude ] || { echo '用法：bash ~/cove-kit-tunnel.sh gpt 或 claude'; exit 1; }
. "$HOME/.cove-kit"
host=$([ "$i" = gpt ] && echo "$GPT_DOMAIN" || echo "$CLAUDE_DOMAIN")
read -r music oauth <<<"$([ "$i" = gpt ] && echo "8787 8788" || echo "8797 8798")"
dir="$HOME/.cloudflared" name="cove-$i" config="$HOME/.cloudflared/cove-$i.yml"
command -v cloudflared >/dev/null || { echo '没有 cloudflared：pkg install cloudflared'; exit 1; }
if [ ! -f "$config" ]; then
  [ -f "$dir/cert.pem" ] || { echo '先登录一次 Cloudflare：cloudflared tunnel login（打开它给的链接，选你的域名授权），再重新运行。'; exit 1; }
  cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$name" || cloudflared tunnel create "$name"
  id="$(cloudflared tunnel list 2>/dev/null | awk -v n="$name" '$2==n{print $1}')"
  [ -n "$id" ] && [ -f "$dir/$id.json" ] || { echo '隧道凭证没找到，没有写配置。'; exit 1; }
  cloudflared tunnel route dns "$name" "$host" || echo "（如果提示记录已存在：去 Cloudflare 删掉旧的 $host 记录后重新运行）"
  umask 077
  cat > "$config" <<YML
tunnel: $id
credentials-file: $dir/$id.json
protocol: http2
ingress:
  - hostname: $host
    path: ^/listener/events\$
    service: http://127.0.0.1:$music
  - hostname: $host
    service: http://127.0.0.1:$oauth
  - service: http_status:404
YML
  echo "已写好 $config"
fi
exec cloudflared tunnel --protocol http2 --config "$config" run
