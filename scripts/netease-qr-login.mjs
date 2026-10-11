#!/usr/bin/env node
// Log a NetEase Cloud Music account in by QR code and save its cookie to a file (mode 0600).
//   node scripts/netease-qr-login.mjs /root/cove-claude-secrets/netease-cookie
// The cookie is never printed. Only the account nickname and UID are shown, so you can
// check that the right account scanned.
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const api = require("NeteaseCloudMusicApi");
const QRCode = require("qrcode");
const target = process.argv[2];
if (!target) { console.error("用法：node scripts/netease-qr-login.mjs <保存 Cookie 的文件>"); process.exit(2); }

// Keep only name=value pairs from Set-Cookie lines (drop Path / Expires / Max-Age ...).
function cookiePairs(setCookies) {
  const pairs = new Map();
  for (const line of setCookies ?? []) {
    const first = String(line).split(";")[0].trim(), eq = first.indexOf("=");
    if (eq > 0 && first.slice(eq + 1)) pairs.set(first.slice(0, eq), first.slice(eq + 1));
  }
  return [...pairs].map(([k, v]) => `${k}=${v}`).join("; ");
}

const pictures = ["/sdcard/Download", "/storage/emulated/0/Download"].filter(dir => existsSync(dir));
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let round = 1; round <= 3; round++) {
  const key = (await api.login_qr_key({ timestamp: Date.now() })).body?.data?.unikey;
  if (!key) { console.error("拿不到二维码，请检查网络后重试。"); process.exit(1); }
  const url = `https://music.163.com/login?codekey=${key}`;
  console.log("\n请用【第二个网易云账号】的网易云音乐 App 扫码登录：\n");
  console.log(await QRCode.toString(url, { type: "terminal", small: true }));
  for (const dir of pictures) {
    try { await QRCode.toFile(`${dir}/netease-login-qr.png`, url, { width: 480, margin: 2 }); console.log(`二维码图片也保存到了：${dir}/netease-login-qr.png（同一台手机可以在网易云扫码页点「相册」选它）`); break; } catch {}
  }
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const result = await api.login_qr_check({ key, timestamp: Date.now() });
    const code = result.body?.code;
    if (code === 802 && i % 5 === 0) console.log("已扫码，请在 App 里点确认登录…");
    if (code === 800) { console.log("二维码过期了，换一张新的。"); break; }
    if (code === 803) {
      const cookie = cookiePairs(result.cookie);
      if (!/MUSIC_U=/.test(cookie)) { console.error("登录成功但没拿到 MUSIC_U，请重试。"); process.exit(1); }
      let who = "";
      try { const account = await api.user_account({ cookie }); const p = account.body?.profile; who = p ? `${p.nickname}（UID ${p.userId}）` : ""; } catch {}
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target + ".tmp", cookie, { mode: 0o600 }); renameSync(target + ".tmp", target); chmodSync(target, 0o600);
      for (const dir of pictures) rmSync(`${dir}/netease-login-qr.png`, { force: true });
      console.log(`\n登录成功：${who || "已保存"}。Cookie 已保存到 ${target}（没有显示出来）。`);
      process.exit(0);
    }
  }
}
console.error("没有完成扫码登录，可以重新运行。");
process.exit(1);
