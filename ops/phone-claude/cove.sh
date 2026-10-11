#!/data/data/com.termux/files/usr/bin/bash
# One command for both instances, in native Termux. Every service gets its own tmux window,
# so closing the Termux screen does not stop them.
#   bash ~/cove.sh            start everything (ChatGPT + Claude)
#   bash ~/cove.sh chatgpt    start only the ChatGPT one     bash ~/cove.sh claude   only the Claude one
#   bash ~/cove.sh status     what is running                 bash ~/cove.sh look     watch the windows
#   bash ~/cove.sh stop       stop everything (or: stop chatgpt / stop claude)
set -uo pipefail
S=cove
in_ubuntu() { echo "proot-distro login cove -- bash -c '$1'"; }
declare -A CMD=(
  [gpt-music]="$(in_ubuntu 'cd /root/qianqian-music && NETEASE_COOKIE_FILE=/root/cove-resonance/.netease-cookie bash scripts/start-personal.sh')"
  [gpt-oauth]="$(in_ubuntu 'node /root/cove-access/oauth-gateway.cjs')"
  [gpt-tunnel]="cloudflared tunnel --config \"\$HOME/.cloudflared/cove-music.yml\" run"
  [claude]="$(in_ubuntu 'bash /root/cove-claude/ops/phone-claude/start.sh')"
  [claude-tunnel]="bash \$HOME/cove-claude-tunnel.sh"
)
GROUP_chatgpt="gpt-music gpt-oauth gpt-tunnel"
GROUP_claude="claude claude-tunnel"
names() { case "${1:-all}" in chatgpt) echo "$GROUP_chatgpt";; claude) echo "$GROUP_claude";; *) echo "$GROUP_chatgpt $GROUP_claude";; esac; }
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
