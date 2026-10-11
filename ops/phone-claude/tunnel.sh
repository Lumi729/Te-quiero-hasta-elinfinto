#!/data/data/com.termux/files/usr/bin/bash
# Native Termux: a separate Cloudflare tunnel for gege.lumi.org.cn. cove-music.yml is never touched.
#   First time: creates tunnel "cove-claude", routes gege.lumi.org.cn to it, writes cove-claude.yml.
#   Every time: runs it. Ctrl+C stops only this tunnel.
set -euo pipefail
dir="$HOME/.cloudflared" config="$HOME/.cloudflared/cove-claude.yml" name=cove-claude host=gege.lumi.org.cn
command -v cloudflared >/dev/null || { echo '没有 cloudflared：pkg install cloudflared'; exit 1; }
if [ ! -f "$config" ]; then
  [ -f "$dir/cert.pem" ] || { echo '先登录一次 Cloudflare：cloudflared tunnel login（会给一个链接，用浏览器打开，选 lumi.org.cn 授权），然后重新运行本脚本。'; exit 1; }
  cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$name" || cloudflared tunnel create "$name"
  id="$(cloudflared tunnel list 2>/dev/null | awk -v n="$name" '$2==n{print $1}')"
  [ -n "$id" ] && [ -f "$dir/$id.json" ] || { echo '隧道凭证没找到，未写配置。请把屏幕截图给维护者。'; exit 1; }
  cloudflared tunnel route dns "$name" "$host" || echo "（如果提示记录已存在：去 Cloudflare 把旧的 $host 记录删掉后重新运行）"
  umask 077
  cat > "$config" <<YML
tunnel: $id
credentials-file: $dir/$id.json
ingress:
  - hostname: $host
    path: ^/listener/events\$
    service: http://127.0.0.1:8797
  - hostname: $host
    service: http://127.0.0.1:8798
  - service: http_status:404
YML
  echo "已写好 $config（原来的 cove-music.yml 没有改动）。"
fi
exec cloudflared tunnel --config "$config" run
