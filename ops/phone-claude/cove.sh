#!/data/data/com.termux/files/usr/bin/bash
# One command for both instances, in native Termux. Every service gets its own tmux window,
# so closing the Termux screen does not stop them.
#   bash ~/cove.sh            start everything (ChatGPT + Claude)
#   bash ~/cove.sh chatgpt    start only the ChatGPT one     bash ~/cove.sh claude   only the Claude one
#   bash ~/cove.sh status     what is running                 bash ~/cove.sh look     watch the windows
#   bash ~/cove.sh stop       stop everything (or: stop chatgpt / stop claude)
#   bash ~/cove.sh diag on|off   masked chat-format logging for both instances (restart music to apply)
#   bash ~/cove.sh check      full health check incl. the public HTTPS addresses (prints no cookie/token)
set -uo pipefail
S=cove
in_ubuntu() { echo "proot-distro login cove -- bash -c '$1'"; }
declare -A CMD=(
  # Both instances serve the same owner: the ChatGPT one reuses the UID entered for the Claude one,
  # so in a three-person room it never mistakes the other AI for the owner.
  [gpt-music]="$(in_ubuntu 'cd /root/qianqian-music && export NETEASE_INVITER_UID="$(sed -n s/^NETEASE_INVITER_UID=//p /root/cove-claude-secrets/bridge.env 2>/dev/null)" && { [ -f /root/cove-chat-diagnostics ] && export TOGETHER_CHAT_DIAGNOSTICS=1; true; } && NETEASE_COOKIE_FILE=/root/cove-resonance/.netease-cookie bash scripts/start-personal.sh')"
  [gpt-oauth]="$(in_ubuntu 'node /root/cove-access/oauth-gateway.cjs')"
  [gpt-tunnel]="cloudflared tunnel --config \"\$HOME/.cloudflared/cove-music.yml\" run"
  [claude]="$(in_ubuntu 'bash /root/cove-claude/ops/phone-claude/start.sh')"
  [claude-tunnel]="bash \$HOME/cove-claude-tunnel.sh"
)
GROUP_chatgpt="gpt-music gpt-oauth gpt-tunnel"
GROUP_claude="claude claude-tunnel"
names() { case "${1:-all}" in chatgpt) echo "$GROUP_chatgpt";; claude) echo "$GROUP_claude";; all) echo "$GROUP_chatgpt $GROUP_claude";;
  gpt-music|gpt-oauth|gpt-tunnel|claude-tunnel) echo "$1";; *) echo "不认识：$1（可用 all / chatgpt / claude / claude-tunnel / gpt-tunnel）" >&2; exit 1;; esac; }
running() { tmux list-windows -t "$S" -F '#W' 2>/dev/null | grep -qx "$1"; }
up() { curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1/" && echo "✓ 在运行" || echo "✗ 没有响应"; }

command -v tmux >/dev/null || { echo '先安装 tmux…'; pkg install -y tmux >/dev/null || exit 1; }
command -v curl >/dev/null || pkg install -y curl >/dev/null

case "${1:-start}" in
  status)
    echo "ChatGPT 音乐服务 8787：$(up 8787)"; echo "ChatGPT 授权服务 8788：$(up 8788)"
    echo "ChatGPT 隧道：$(running gpt-tunnel && echo '✓ 窗口开着' || echo '✗ 没开')"
    echo "Claude 音乐服务 8797：$(up 8797)"; echo "Claude 授权服务 8798：$(up 8798)"
    echo "Claude 隧道：$(running claude-tunnel && echo '✓ 窗口开着' || echo '✗ 没开')";;
  check)
    # Count only real cloudflared processes; the tmux shell wrapper's command line also names the config.
    tunnels() { local n=0 p; for p in $(pgrep -x cloudflared); do tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q "$1" && n=$((n+1)); done; echo "$n"; }
    scrub() { sed -E 's/((MUSIC_[A-Z_]*|__csrf|NMTID)=)[^; ]+/\1<hidden>/g; s/(Bearer )[A-Za-z0-9._~+\/-]+/\1<hidden>/g; s/([?&](code|session|token)=)[^& ]+/\1<hidden>/g'; }
    pub() { # domain → "401 ✓" style verdicts for the public address
      local d=$1 code meta
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "https://$d/mcp/music")
      meta=$(curl -s --max-time 20 "https://$d/.well-known/oauth-protected-resource")
      case "$code" in 401) echo "  外网 https://$d/mcp/music → 401 ✓（正常：要求登录）";;
        502|530|521|522|523|524|1033) echo "  外网 https://$d/mcp/music → $code ✗（Cloudflare 连不到手机：隧道没连上或本机端口没响应）";;
        000) echo "  外网 https://$d/mcp/music → 打不开 ✗（手机没网，或 DNS 还没生效）";;
        *) echo "  外网 https://$d/mcp/music → $code ✗";; esac
      if grep -q "\"resource\":\"https://$d/mcp/music\"" <<<"$meta"; then echo "  登录信息地址 ✓"; else echo "  登录信息地址 ✗：$(head -c 120 <<<"$meta")"; fi
    }
    for n in gpt-music gpt-oauth gpt-tunnel claude claude-tunnel; do running "$n" || echo "窗口 $n 没开 ✗"; done
    echo "== Claude 那份（gege.lumi.org.cn）"
    echo "  本机 8797：$(up 8797)   本机 8798：$(up 8798)"; pub gege.lumi.org.cn
    echo "  同时在跑的 Claude 隧道：$(tunnels cove-claude.yml) 个（应为 1）"
    echo "== ChatGPT 那份（cove.lumi.org.cn）"
    echo "  本机 8787：$(up 8787)   本机 8788：$(up 8788)"; pub cove.lumi.org.cn
    echo "  同时在跑的 ChatGPT 隧道：$(tunnels cove-music.yml) 个（应为 1）"
    echo "== 各窗口最后几行（已遮住 Cookie / token）"
    for n in claude claude-tunnel gpt-tunnel; do
      running "$n" || continue
      echo "-- $n"; tmux capture-pane -p -t "$S:$n" -S -200 | grep -v '^$' | tail -n 6 | scrub
    done;;
  diag)
    case "${2:-}" in
      on) proot-distro login cove -- touch /root/cove-chat-diagnostics; echo '诊断已打开：重启两份音乐服务后生效（bash ~/cove.sh stop gpt-music && bash ~/cove.sh stop claude && bash ~/cove.sh）。';;
      off) proot-distro login cove -- rm -f /root/cove-chat-diagnostics; echo '诊断已关闭：重启两份音乐服务后生效。';;
      *) echo '用法：bash ~/cove.sh diag on 或 bash ~/cove.sh diag off';;
    esac;;
  look)
    echo '进入后：Ctrl+B 再按 n 切换下一个窗口，Ctrl+B 再按 d 退出查看（服务继续运行）。'; sleep 2
    exec tmux attach -t "$S";;
  stop)
    for n in $(names "${2:-all}"); do running "$n" && tmux send-keys -t "$S:$n" C-c; done
    sleep 3
    for n in $(names "${2:-all}"); do running "$n" && tmux kill-window -t "$S:$n"; done
    echo '已停止。';;
  start|all|chatgpt|claude)
    group=$([ "${1:-start}" = start ] && echo all || echo "$1")
    [ "$group" != chatgpt ] && [ ! -f "$HOME/cove-claude-tunnel.sh" ] && { echo 'Claude 隧道还没建：先按说明运行一次 cove-claude-tunnel.sh'; exit 1; }
    termux-wake-lock 2>/dev/null || true
    tmux has-session -t "$S" 2>/dev/null || tmux new-session -d -s "$S" -n home
    for n in $(names "$group"); do
      if running "$n"; then echo "$n 已经在运行，跳过。"; continue; fi
      tmux new-window -d -t "$S" -n "$n" "${CMD[$n]}; echo; echo '[已停止] 按回车关闭这个窗口'; read"
      echo "已打开：$n"; sleep 2
    done
    echo; echo '全部在后台运行啦。看状态：bash ~/cove.sh status    看窗口：bash ~/cove.sh look';;
  *) sed -n '3,8p' "$0";;
esac
