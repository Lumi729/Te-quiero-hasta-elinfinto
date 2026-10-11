#!/data/data/com.termux/files/usr/bin/bash
# Native Termux part of the kit: copies the launcher and tunnel script out of Ubuntu and records the
# two domains (no secrets) in ~/.cove-kit. Run after `kit.sh setup`.
set -euo pipefail
conf="$(proot-distro login cove -- cat /root/cove-kit.env)" || { echo '先在 Ubuntu 里运行 kit.sh setup'; exit 1; }
grep -E '^(GPT_DOMAIN|CLAUDE_DOMAIN)=' <<<"$conf" > "$HOME/.cove-kit"
proot-distro login cove -- cat /root/cove-app/ops/phone-claude/cove.sh > "$HOME/cove.sh"
proot-distro login cove -- cat /root/cove-app/ops/phone-kit/tunnel.sh > "$HOME/cove-kit-tunnel.sh"
echo '好了：bash ~/cove-kit-tunnel.sh gpt（第一次建 ChatGPT 隧道），bash ~/cove-kit-tunnel.sh claude（Claude 隧道），以后 bash ~/cove.sh 一键启动。'
