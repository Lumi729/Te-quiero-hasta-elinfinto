# 给 AI 助手的安装说明：带用户在安卓手机上装好「网易云一起听 × ChatGPT & Claude」

> 你（AI 助手）正在帮一位**不懂技术**的用户安装本项目。用户会把命令复制到手机上的 Termux 运行，再把屏幕截图或文字发给你。你不能直接操作她的手机，你的工作是**一步一步带她做，看截图判断结果，出错时照本文排查**。
> 面向人的版本（同样的步骤）：[FRIEND_INSTALL.zh-CN.md](FRIEND_INSTALL.zh-CN.md)。代码仓库：https://github.com/Lumi729/Te-quiero-hasta-elinfinto

## 你必须遵守的规则

1. **一次只给一步**：给一条（最多两三条）命令，等她回复结果再继续。不要一次贴完整份指南。
2. **用简单的中文**解释这一步在做什么、成功会看到什么。不要讲原理，除非她问。
3. **绝不索要秘密**：网易云 Cookie、连接密钥（access key）、Cloudflare 令牌、OAuth 令牌，都只让她自己复制粘贴，**不要让她发给你**。她截图里如果出现了，提醒她删掉，并说明你不需要它。
4. 命令**原样给出**，用代码块，不要自己改写路径或参数。本文没写到的命令，不要凭空编造。
5. 要分清两个窗口：**原生 Termux**（提示符 `~ $`）和 **Ubuntu**（提示符 `root@localhost`）。每条命令都说清楚在哪个窗口运行。
6. 出错时先看本文「排查表」，对不上再让她截图给你看完整输出。不要让她随便删文件、重装系统。

## 整体结构（给你理解用）

- 手机 Termux 里装一个叫 `cove` 的 Ubuntu（proot-distro）。代码在 Ubuntu 的 `/root/cove-app`。
- 两份完全独立的服务：**gpt**（给 ChatGPT）和 **claude**（给 Claude）。每份有：
  - 一起听服务：gpt 端口 8787，claude 端口 8797；
  - OAuth 授权服务：gpt 端口 8788，claude 端口 8798；
  - 各自一个网易云**小号**（扫码登录），文件在 `/root/cove-gpt`、`/root/cove-claude`。
- 每份一条 Cloudflare 隧道，把用户自己的子域名（如 `gpt.example.com`、`claude.example.com`）接到手机上。
- 原生 Termux 里的启动器 `~/cove.sh` 用 tmux 在后台开 6 个窗口：gpt-music、gpt-oauth、gpt-tunnel、claude-music、claude-oauth、claude-tunnel。
- 用户自己的网易云**大号**用来邀请两个小号进「一起听」房间。大号的 UID 叫 OWNER_UID：只有大号说的话，AI 才必须回复。

## 开始前确认（逐项问她）

- [ ] 安卓手机，装好了 Termux（从 F-Droid 或 GitHub 下载，不是应用商店的旧版）。
- [ ] 有一个托管在 Cloudflare 的域名，她能登录 Cloudflare 管理它。没有的话先停下，告诉她需要先准备域名。
- [ ] 3 个网易云账号：她自己的大号，加两个小号（分别给 ChatGPT 和 Claude）。小号要能在网易云 App 里登录，扫码要用。
- [ ] 她大号的 UID：网易云 App → 我的 → 点头像 → 右上角「…」→ 分享 → 复制链接，`id=` 后面的数字。
- [ ] ChatGPT 能开开发者模式添加自定义连接器；Claude 的套餐支持添加自定义连接器。
- [ ] 想好两个子域名，例如 `gpt.她的域名` 和 `claude.她的域名`（不用提前在 Cloudflare 建）。

## 安装步骤

### 第 1 步｜原生 Termux：基础工具
```bash
pkg update -y && pkg upgrade -y
pkg install -y proot-distro cloudflared tmux curl
termux-setup-storage
```
成功：没有红色 `E:` 错误；最后弹出存储权限，点允许。

### 第 2 步｜原生 Termux：装 Ubuntu 并进入
```bash
proot-distro install --override-alias cove ubuntu
proot-distro login cove
```
成功：提示符变成 `root@localhost:~#`。

### 第 3 步｜Ubuntu：装 Node.js 22
```bash
apt update && apt install -y curl git ca-certificates ffmpeg
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
node -v
```
成功：`node -v` 显示 `v22.` 开头。

### 第 4 步｜Ubuntu：下载并安装两份服务
```bash
git clone https://github.com/Lumi729/Te-quiero-hasta-elinfinto.git /root/cove-app
bash /root/cove-app/ops/phone-kit/kit.sh setup
```
- 先跑 `npm ci`、`npm test`、`npm run build`，十几分钟，大量 `ok` 正常；结尾应是 `# fail 0`。
- 然后问：大号 UID、给 ChatGPT 的地址、给 Claude 的地址（只填域名，如 `gpt.example.com`，不带 https 和路径）。
- 然后两个小号依次扫码：先 gpt，再 claude。二维码同时存到手机「下载」里的 `netease-login-qr.png`。同一台手机就在网易云扫码页点「相册」选这张图。成功显示「登录成功：昵称（UID …）」，让她确认是对应的**小号**，不是大号。
- 中途失败可以直接重新运行 `bash /root/cove-app/ops/phone-kit/kit.sh setup`，已填的和已登录的会保留。
- 结尾会打印两个连接器地址：`https://<gpt域名>/mcp/music` 和 `https://<claude域名>/mcp/music`。

### 第 5 步｜原生 Termux：拿启动器
先 `exit` 退出 Ubuntu（回到 `~ $`），然后：
```bash
proot-distro login cove -- cat /root/cove-app/ops/phone-kit/install-termux.sh > ~/cove-install.sh && bash ~/cove-install.sh
```

### 第 6 步｜原生 Termux：建两条 Cloudflare 隧道（只做一次）
```bash
cloudflared tunnel login
```
它给一个链接：让她用浏览器打开，选她的域名授权。然后：
```bash
bash ~/cove-kit-tunnel.sh gpt
```
看到 `Registered tunnel connection` 就按 Ctrl+C。再来一次：
```bash
bash ~/cove-kit-tunnel.sh claude
```
看到 `Registered` 后按 Ctrl+C。
- 提示记录已存在：去 Cloudflare DNS 删掉同名的旧记录，再重新运行。

### 第 7 步｜原生 Termux：启动和体检
```bash
bash ~/cove.sh
```
等 30 秒：
```bash
bash ~/cove.sh check
```
成功：两份都有「外网 … → 401 ✓」「登录信息地址 ✓」「隧道 1 个」。
然后让她做防杀设置：通知栏 Termux 通知点「Acquire wakelock」；系统设置里 Termux 电池优化改「不限制」；多任务里锁住 Termux。

### 第 8 步｜Claude 连接器
1. Claude → 设置 → 连接器 → 添加自定义连接器，地址 `https://<claude域名>/mcp/music`，其他留空。
2. 跳出授权页，**先确认大字写着 claude.ai**，再输入连接密钥。密钥让她自己在原生 Termux 里查看、复制，不要发给你：
```bash
proot-distro login cove -- bash /root/cove-app/ops/phone-kit/kit.sh key claude
```

### 第 9 步｜ChatGPT 连接器
1. ChatGPT → 设置 → 应用与连接器 → 高级设置 → 打开开发者模式。
2. 新建连接器：地址 `https://<gpt域名>/mcp/music`，认证方式选 OAuth。
3. OAuth 高级设置：客户端 ID 填 `cove-chatgpt`，客户端密钥留空，Token 端点认证方式选 `none`。
4. 复制 ChatGPT 显示的回调地址（`https://chatgpt.com/connector/oauth/…`），在原生 Termux 运行：
```bash
proot-distro login cove -- bash /root/cove-app/ops/phone-kit/kit.sh chatgpt-callback 回调地址
bash ~/cove.sh restart gpt-oauth
```
5. 回 ChatGPT 点创建或连接，授权页应写 chatgpt.com，密钥用 `kit.sh key gpt` 查看（同第 8 步的命令，把 claude 换成 gpt）。
- ChatGPT 界面会改版，选项名不一定一致，帮她找意思相近的。如果找不到填客户端 ID 的地方，说明这一步要换方式，请她联系项目维护者，不要猜。

### 第 10 步｜第一次一起听
1. 用大号在网易云「一起听」里，从「邀请听友」邀请小号。三人房就把两个小号都勾上；**不要用「匹配多人听」**。
2. **三人房里先让她用大号在聊天室发一句话**，服务会照着学会房间格式，之后 AI 的话才显示、重新打开也在。
3. 在 Claude 或 ChatGPT 的新对话里打开对应的连接器，说「开始长等待监听一起听」，或者「现在在放什么歌」。

## 排查表

| 现象 | 处理 |
| --- | --- |
| `check`：外网 530 / 502 / 1033 | Cloudflare 连不到手机。让她 `bash ~/cove.sh look` 切到 gpt-tunnel 或 claude-tunnel 窗口截图。重开某条隧道：`bash ~/cove.sh stop claude-tunnel && bash ~/cove.sh claude`（gpt 用 `gpt-tunnel` 和 `chatgpt`）。隧道已固定用 http2，不受屏蔽 QUIC 的网络影响。 |
| `check`：外网打不开（000） | 手机没网，或 DNS 还没生效（新建后等几分钟）。 |
| `check`：本机端口 ✗ | 对应服务没起来：`bash ~/cove.sh look` 看那个窗口的报错。没装好就重新运行第 4 步的 setup。 |
| 窗口里 `signal 9` / `Process completed` | 安卓杀了进程：做第 7 步的防杀设置，再 `bash ~/cove.sh`。 |
| `getaddrinfo EAI_AGAIN music.163.com` | 暂时连不上网易云，网络恢复会自己好。 |
| 授权页 `invalid_request` | 客户端 ID 或回调地址不对：Claude 不要填任何高级选项；ChatGPT 确认 `cove-chatgpt`，以及第 9 步保存的回调地址和 ChatGPT 显示的一字不差，保存后要 `bash ~/cove.sh restart gpt-oauth`。 |
| 授权页 `authorization_expired` | 授权页超过 10 分钟或服务重启过：关掉，从 Claude / ChatGPT 重新点连接，只点一次同意。 |
| 授权页 `wrong_key` | 密钥复制不全或用错了那一份（gpt 和 claude 的密钥不同）。 |
| 连接器 502 / 要求重新登录 | 先 `bash ~/cove.sh check`；服务正常就在 Claude / ChatGPT 里重新连接。 |
| AI 进不了房间 | 确认用**大号**邀请，且大号 UID 填对：`proot-distro login cove -- cat /root/cove-kit.env` 看 `OWNER_UID`（这个文件没有秘密）。填错就让她运行 `proot-distro login cove -- sed -i 's/^OWNER_UID=.*/OWNER_UID=正确的UID/' /root/cove-kit.env`，再 `bash ~/cove.sh restart`。 |
| 三人房 AI 发的话看不到 / 重开就没 | 让她用大号在聊天室发一句话，再让 AI 说话。 |
| 两个 AI 互相刷屏 | 不应发生：每份最多转 2 条对方的话，大号一开口就重新计数。如果发生，让她截图并联系维护者。 |
| 小号登录失效 | `proot-distro login cove -- bash /root/cove-app/ops/phone-kit/kit.sh login gpt`（或 `claude`），再 `bash ~/cove.sh restart`。 |

## 日常命令（装好后教她）

| 做什么 | 原生 Termux 输入 |
| --- | --- |
| 全部打开 | `bash ~/cove.sh` |
| 体检 | `bash ~/cove.sh check` |
| 全部关掉 | `bash ~/cove.sh stop` |
| 更新代码 | `proot-distro login cove -- bash /root/cove-app/ops/phone-kit/kit.sh update && bash ~/cove.sh restart` |
| 看输出 | `bash ~/cove.sh look`（Ctrl+B 再按 n 切换，Ctrl+B 再按 d 退出） |

`restart` 只重启两个一起听服务，登录状态保留，不用重连。授权服务重启也会记住登录（只存令牌的哈希）。
