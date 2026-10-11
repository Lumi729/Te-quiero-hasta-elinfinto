#!/usr/bin/env bash
# Read-only checks for both instances. Never restarts or edits anything.
set -uo pipefail
DOMAIN=${1:-gege.lumi.org.cn}
OLD=${2:-cove.lumi.org.cn}
CLAUDE_CB=https://claude.ai/api/mcp/auth_callback
ok=0 bad=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  ✓ $1"; ok=$((ok+1)); else echo "  ✗ $1"; bad=$((bad+1)); fi; }
json() { curl -fsS --max-time 15 "$1"; }

echo "Claude 实例（$DOMAIN）"
check '服务 cove-claude 在运行' 'systemctl is-active --quiet cove-claude'
check '服务 cove-claude-oauth 在运行' 'systemctl is-active --quiet cove-claude-oauth'
check '一起听服务只监听本机 8797' 'curl -fsS --max-time 5 http://127.0.0.1:8797/'
check '授权服务器元数据含注册接口和 S256' "json https://$DOMAIN/.well-known/oauth-authorization-server | grep -q '\"registration_endpoint\":\"https://$DOMAIN/register\"' && json https://$DOMAIN/.well-known/oauth-authorization-server | grep -q '\"code_challenge_methods_supported\":\\[\"S256\"\\]'"
check "resource 与 https://$DOMAIN/mcp/music 逐字一致" "json https://$DOMAIN/.well-known/oauth-protected-resource/mcp/music | grep -q '\"resource\":\"https://$DOMAIN/mcp/music\"'"
check "resource 与 https://$DOMAIN/mcp 逐字一致" "json https://$DOMAIN/.well-known/oauth-protected-resource/mcp | grep -q '\"resource\":\"https://$DOMAIN/mcp\"'"
for path in /mcp/music /mcp; do
  check "$path 未登录返回 401 + resource_metadata" "curl -sS -o /dev/null -D - -X POST --max-time 15 https://$DOMAIN$path | grep -qi '^www-authenticate: Bearer resource_metadata=\"https://$DOMAIN/.well-known/oauth-protected-resource'"
done
check '注册接口接受 Claude 回调（201）' "[ \"\$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST https://$DOMAIN/register -H 'content-type: application/json' -d '{\"client_name\":\"verify\",\"redirect_uris\":[\"$CLAUDE_CB\"],\"token_endpoint_auth_method\":\"none\"}')\" = 201 ]"
check '注册接口拒绝其他回调（400）' "[ \"\$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST https://$DOMAIN/register -H 'content-type: application/json' -d '{\"redirect_uris\":[\"https://evil.example/cb\"]}')\" = 400 ]"
check '失效 refresh token 返回 invalid_grant' "curl -sS --max-time 15 -X POST https://$DOMAIN/oauth/token -H 'content-type: application/x-www-form-urlencoded' -d 'grant_type=refresh_token&refresh_token=bad&client_id=cove-chatgpt' | grep -q invalid_grant"
check '最近日志里没有 Cookie / token' "! journalctl -u cove-claude -u cove-claude-oauth --since '-1 day' --no-pager 2>/dev/null | grep -Eq 'MUSIC_U=[^<]|Bearer [A-Za-z0-9]'"

echo "ChatGPT 实例（$OLD，只读检查）"
check '原域名 MCP 仍要求登录（401）' "[ \"\$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST https://$OLD/mcp/music)\" = 401 ]"
check '原域名元数据正常' "json https://$OLD/.well-known/oauth-protected-resource | grep -q '\"resource\":\"https://$OLD/mcp/music\"'"
for unit in $(systemctl list-units --type=service --state=running --no-legend 2>/dev/null | awk '{print $1}' | grep -E '^cove' | grep -v '^cove-claude'); do
  check "原服务 $unit 在运行" "systemctl is-active --quiet $unit"
done
echo "通过 $ok 项，失败 $bad 项"
[ "$bad" -eq 0 ]
