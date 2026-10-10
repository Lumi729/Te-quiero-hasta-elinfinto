#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  echo '请在运行 Node 的 Ubuntu 环境安装：apt-get update && apt-get install -y ffmpeg' >&2
  exit 1
fi
if [[ ! -f dist/src/server.js ]]; then
  echo '请先运行 npm ci 和 npm run build。' >&2
  exit 1
fi
cookie_file="${NETEASE_COOKIE_FILE:-$repo_dir/.netease-cookie}"
if [[ -z "${NETEASE_COOKIE:-}" ]]; then
  if [[ ! -s "$cookie_file" ]]; then
    echo '找不到 Cookie 文件。请设置 NETEASE_COOKIE_FILE 指向现有 .netease-cookie。' >&2
    exit 1
  fi
  export NETEASE_COOKIE="$(cat -- "$cookie_file")"
fi
export TOGETHER_ENABLED="${TOGETHER_ENABLED:-true}"
export NETEASE_AUDIO_ENABLED="${NETEASE_AUDIO_ENABLED:-true}"
export PORT="${PORT:-8787}"
export BRIDGE_PUBLIC_ORIGIN="${BRIDGE_PUBLIC_ORIGIN:-https://cove.lumi.org.cn}"
echo "启动千千的一起听；音频实验开关：$NETEASE_AUDIO_ENABLED；端口：$PORT"
exec npm start
