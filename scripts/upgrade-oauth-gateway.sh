#!/usr/bin/env bash
# Install the repository's OAuth gateway (ChatGPT + Claude connectors) over the personal copy.
# Keeps .access-key (connection key) and the ChatGPT client; backs up the old gateway first.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
target="${1:-/root/cove-access/oauth-gateway.cjs}"
source_file="$here/ops/oauth-gateway/oauth-gateway.cjs"
dir="$(dirname "$target")"
if [ ! -f "$dir/.access-key" ]; then
  echo "没有找到 $dir/.access-key（连接密钥），未修改任何文件。请确认授权服务装在这里。"
  exit 1
fi
if [ -f "$target" ] && grep -q 'QIANQIAN_CLAUDE_CONNECTOR_V1' "$target" && cmp -s "$source_file" "$target"; then
  echo '授权服务已经是最新版，无需重复安装。'
  exit 0
fi
if [ -f "$target" ] && ! grep -q "chatgpt.com/connector/oauth/B19F6YVguEU1" "$target"; then
  echo '现有授权服务里的 ChatGPT 回调地址和预期不同，为了不弄坏 ChatGPT 连接，未修改任何文件。请交给维护者检查。'
  exit 1
fi
umask 077
temporary="$(mktemp "$dir/.oauth-gateway-XXXXXX.cjs")"
trap 'rm -f "$temporary"' EXIT
cp "$source_file" "$temporary"
node --check "$temporary"
if [ -f "$target" ]; then
  backup="$target.before-claude-$(date +%s)"
  cp -p "$target" "$backup"
  chmod 600 "$backup"
  echo "原授权服务已备份到：$backup"
fi
chmod 600 "$temporary"
mv "$temporary" "$target"
trap - EXIT
echo '已安装支持 Claude 的授权服务。连接密钥和 ChatGPT 设置保持不变。'
echo '请到授权服务窗口按 Ctrl+C，再重新运行：node /root/cove-access/oauth-gateway.cjs'
