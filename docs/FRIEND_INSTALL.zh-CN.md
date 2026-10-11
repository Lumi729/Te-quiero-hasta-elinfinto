# 从零安装：在安卓手机上让 ChatGPT 和 Claude 陪你一起听网易云

装好以后：你在网易云「一起听」里邀请两个 AI 的账号进房间，它们能看到你在聊天室发的话、知道在放什么歌和歌词，会在聊天室里回你，还能帮你切歌、点歌。两份服务完全独立，一份给 ChatGPT，一份给 Claude，都跑在你自己的手机上。

> 全程大约 1 小时，大部分时间在等下载。遇到看不懂的提示，截图给帮你装的人看就好。
>
> 想让自己的 AI（Claude / ChatGPT）一步步带你装：把这个链接发给它，说「请按这份说明一步步带我安装」：
> https://github.com/Lumi729/Te-quiero-hasta-elinfinto/blob/main/docs/AI_INSTALL_ASSISTANT.md

---

## 0. 先准备好这些

| 要准备的 | 说明 |
| --- | --- |
| 一台安卓手机 | 装 Termux 用。手机要一直开着服务才在线。 |
| Termux | 从 F-Droid 或 Termux 的 GitHub 发布页下载，**不要用应用商店里的旧版**。 |
| 一个自己的域名，托管在 Cloudflare | 例如 `example.com`。要在 Cloudflare 里能管理它的 DNS。会用到两个子域名，比如 `gpt.example.com` 和 `claude.example.com`，不用提前建，安装时会自动建。 |
| 3 个网易云账号 | 你自己的大号（用来邀请），加两个小号：一个给 ChatGPT，一个给 Claude。小号最好在你手机的网易云 App 里也能切换登录，或者在另一台手机上登录，扫码要用。 |
| ChatGPT 和 Claude | 都要能添加「自定义连接器」：ChatGPT 需要打开开发者模式，Claude 需要支持自定义连接器的套餐。 |

另外先查好**你自己大号的网易云 UID**：网易云 App → 我的 → 点头像进主页 → 右上角「…」→ 分享 → 复制链接，链接里 `id=` 后面那串数字就是。

---

## 1. 装 Termux 基础工具

打开 Termux（看到 `~ $`），一行一行输入：

```bash
pkg update -y && pkg upgrade -y
pkg install -y proot-distro cloudflared tmux curl
termux-setup-storage
```

最后一行会弹出「允许访问存储」，点允许。扫码登录时要把二维码存到相册。

## 2. 装一个 Ubuntu（名字叫 cove）

```bash
proot-distro install --override-alias cove ubuntu
proot-distro login cove
```

看到 `root@localhost` 开头，就进到 Ubuntu 里了。

## 3. 在 Ubuntu 里装 Node.js 22

```bash
apt update && apt install -y curl git ca-certificates ffmpeg
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
node -v
```

最后显示 `v22.` 开头就对了。

## 4. 下载并安装两份服务

还在 Ubuntu 里：

```bash
git clone https://github.com/Lumi729/Te-quiero-hasta-elinfinto.git /root/cove-app
bash /root/cove-app/ops/phone-kit/kit.sh setup
```

它会：

1. 下载依赖、跑一遍测试、编译。第一次要十几分钟，看到一大堆 `ok` 是正常的。
2. 问你三件事：**你大号的 UID**、**给 ChatGPT 用的地址**（例如 `gpt.example.com`）、**给 Claude 用的地址**（例如 `claude.example.com`）。
3. 让两个小号**分别扫码登录**：
   - 屏幕上会出现二维码，同时存到手机「下载」文件夹里的 `netease-login-qr.png`；
   - 用**给 ChatGPT 的那个小号**打开网易云 App → 扫一扫。如果就是这台手机，在扫码页点「相册」，选那张图；
   - 登录成功会显示账号昵称，确认是对的小号；
   - 接着给 Claude 的小号再来一次。

Cookie 不会显示在屏幕上，只存在这台手机里。

## 5. 回到原生 Termux，拿启动器

输入 `exit` 退出 Ubuntu（回到 `~ $`），然后：

```bash
proot-distro login cove -- cat /root/cove-app/ops/phone-kit/install-termux.sh > ~/cove-install.sh && bash ~/cove-install.sh
```

## 6. 建两条 Cloudflare 隧道（只做一次）

1. 登录 Cloudflare：
   ```bash
   cloudflared tunnel login
   ```
   它会给一个链接，用浏览器打开，选你的域名，点授权。
2. 建 ChatGPT 那条：
   ```bash
   bash ~/cove-kit-tunnel.sh gpt
   ```
   看到 `Registered tunnel connection` 就说明建好、连上了，按 Ctrl+C 停掉。
3. 建 Claude 那条：
   ```bash
   bash ~/cove-kit-tunnel.sh claude
   ```
   同样看到 `Registered` 后按 Ctrl+C。

## 7. 一键启动

```bash
bash ~/cove.sh
```

等半分钟，再体检一次：

```bash
bash ~/cove.sh check
```

两份都显示「外网 … → 401 ✓」和「登录信息地址 ✓」，就全部通了。

为了不被手机关掉：下拉通知栏，在 Termux 的通知上点「Acquire wakelock」；在系统设置里把 Termux 的电池优化改成「不限制」；在多任务界面把 Termux 锁住。

## 8. 在 Claude 里添加连接器

1. Claude → 设置 → 连接器 → 添加自定义连接器。
2. 名字随便起，地址填 `https://你给Claude的地址/mcp/music`，其他留空。
3. 会跳出授权页。先确认页面上大字写着 **claude.ai**，再输入连接密钥，点「允许 Claude 连接」。
4. 连接密钥在原生 Termux 里这样看：
   ```bash
   proot-distro login cove -- bash /root/cove-app/ops/phone-kit/kit.sh key claude
   ```
   长按选中、复制、粘贴。**密钥不要发给任何人。**

## 9. 在 ChatGPT 里添加连接器

1. ChatGPT → 设置 → 应用与连接器 → 高级设置，打开**开发者模式**。
2. 新建连接器：地址填 `https://你给ChatGPT的地址/mcp/music`，认证方式选 **OAuth**。
3. 在 OAuth 的高级设置里：
   - 客户端 ID 填 `cove-chatgpt`
   - 客户端密钥**留空**
   - Token 端点认证方式选 **none**
4. 页面上会显示一个**回调地址**，形如 `https://chatgpt.com/connector/oauth/xxxx`，把它复制下来，在原生 Termux 里保存：
   ```bash
   proot-distro login cove -- bash /root/cove-app/ops/phone-kit/kit.sh chatgpt-callback 复制的回调地址
   bash ~/cove.sh restart gpt-oauth
   ```
5. 回到 ChatGPT 点创建或连接。授权页上应写着 **chatgpt.com**，密钥用：
   ```bash
   proot-distro login cove -- bash /root/cove-app/ops/phone-kit/kit.sh key gpt
   ```

ChatGPT 的界面经常改版，名字可能和上面不完全一样，找意思相近的选项就好。如果它不让你填客户端 ID，截图问帮你装的人。

## 10. 开始一起听

- **双人听**：在网易云「一起听」里，从「邀请听友」里邀请其中一个 AI 的小号，几秒后它会自动进房间。
- **三人听**：两个小号都勾上一起邀请，**不要点「匹配多人听」**，那是和陌生人随机配对的。三人房里：
  - 你说的话两个 AI 都会回；
  - 两个 AI 之间最多接两句，不会互相刷屏。
- 在 ChatGPT 或 Claude 的对话里：
  - 说「**开始长等待监听一起听**」，它就会守着聊天室，看到你在网易云里说话就回你；
  - 也可以直接让它「暂停」「下一首」「搜一下《xxx》下一首放」。
- 三人房刚开、或者服务刚重启时，**你先在聊天室发一句话**，服务会照着你的消息学会这个房间的格式，之后 AI 发的话才看得到、关掉再打开也还在。学过一次会记住。

## 11. 日常命令（都在原生 Termux 里）

| 想做什么 | 输入 |
| --- | --- |
| 全部打开 | `bash ~/cove.sh` |
| 看是不是都正常 | `bash ~/cove.sh check` |
| 全部关掉 | `bash ~/cove.sh stop` |
| 更新代码 | `proot-distro login cove -- bash /root/cove-app/ops/phone-kit/kit.sh update && bash ~/cove.sh restart` |
| 换某个 AI 的网易云小号 | `proot-distro login cove -- bash /root/cove-app/ops/phone-kit/kit.sh login gpt`（或 `claude`），再 `bash ~/cove.sh restart` |
| 看各个服务的输出 | `bash ~/cove.sh look`（Ctrl+B 再按 n 切换，Ctrl+B 再按 d 退出查看） |

`restart` 只重启音乐服务，登录不受影响，不用在 Claude / ChatGPT 里重连。

## 12. 常见问题

| 看到的 | 原因和办法 |
| --- | --- |
| `check` 里外网是 530 / 502 | Cloudflare 连不到手机。确认隧道窗口开着、手机有网；`bash ~/cove.sh stop claude-tunnel && bash ~/cove.sh claude`（ChatGPT 那条把 claude 换成 gpt / chatgpt）重开隧道。 |
| 服务窗口出现 `signal 9` | 被手机系统关掉了。做第 7 步最后那几条防杀设置，再 `bash ~/cove.sh`。 |
| `getaddrinfo EAI_AGAIN music.163.com` | 手机一时连不上网易云，网络恢复后会自己好。 |
| 授权页显示 `authorization_expired` | 授权页过期（超过 10 分钟或服务重启过）。关掉页面，从 Claude / ChatGPT 重新点连接。 |
| 三人房里 AI 的话看不到 / 重新打开就没了 | 你先在聊天室发一句话，让服务学会房间格式，再让 AI 说话。 |
| Claude / ChatGPT 提示要重新登录 | 点连接器重新连接，输入对应的连接密钥。 |

## 安全提醒

- **连接密钥、网易云 Cookie 不要发给任何人**，截图前注意遮住。
- 授权页一定要确认写的是 **claude.ai** 或 **chatgpt.com** 再输入密钥。
- 扫码只用给 AI 准备的小号，不要用自己的大号。
- 服务的日志会自动把 Cookie 和令牌遮成 `<hidden>`。
