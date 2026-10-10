# 让 Claude 也能连接一起听

授权服务（`/root/cove-access/oauth-gateway.cjs`）现在同时支持 ChatGPT 和 Claude 自定义连接器。
仓库里的源码在 `ops/oauth-gateway/oauth-gateway.cjs`，用 `scripts/upgrade-oauth-gateway.sh` 安装。

## 安装

在运行音乐服务的 Ubuntu 窗口：

```bash
cd /root/qianqian-music &&
git pull --ff-only &&
bash scripts/upgrade-oauth-gateway.sh
```

脚本会先备份原授权服务（`oauth-gateway.cjs.before-claude-*`），连接密钥 `.access-key` 和 ChatGPT 设置都不变。
然后到授权服务窗口按 Ctrl+C，重新运行 `node /root/cove-access/oauth-gateway.cjs`。
和以前一样，重启授权服务后 ChatGPT 需要按提示重新连接一次。

## 在 Claude 里添加

设置 → 连接器 → 添加自定义连接器，地址填 `https://cove.lumi.org.cn/mcp/music`（`/mcp` 也可以），
其他留空。Claude 会自动注册，然后打开授权页：页面上会写「授权后会跳转到 claude.ai」，
输入 Termux 里的连接密钥再点同意。网页、桌面和手机用同一个回调地址。

## 做了什么

- 回调白名单：ChatGPT 原回调 + `https://claude.ai/api/mcp/auth_callback`。
- 动态客户端注册：`POST /register`（JSON），只接受 Claude 回调，只允许 `none` 认证；注册结果存在 `.oauth-clients.json`（不含密钥），最多 20 个。
- PKCE 只支持 S256；授权服务器元数据声明 `registration_endpoint` 和 `code_challenge_methods_supported`。
- `/mcp` 和 `/mcp/music` 各有自己的 protected resource metadata，`resource` 与填写的地址逐字一致；令牌绑定到申请时的 resource。
- 未登录返回 401 + `WWW-Authenticate: Bearer resource_metadata="..."`；`/oauth/token` 和 `/token` 接收表单；refresh token 失效返回 `invalid_grant`。
- 只有输入连接密钥才能同意；令牌仍只存在内存。

## 撤销

停止授权服务，用 `oauth-gateway.cjs.before-claude-*` 备份覆盖回 `oauth-gateway.cjs`，再启动。
