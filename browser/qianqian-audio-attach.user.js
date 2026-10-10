// ==UserScript==
// @name         千千的一起听 · 音频附件助手（实验）
// @namespace    https://github.com/Lumi729/Te-quiero-hasta-elinfinto
// @version      0.1.0
// @description  点按钮，将聊天中最新的短期 WAV 链接尝试添加为附件；不自动发送。
// @match        https://chatgpt.com/*
// @grant        GM_xmlhttpRequest
// @connect      cove.lumi.org.cn
// @run-at       document-idle
// @noframes
// ==/UserScript==
(() => {
  'use strict';
  const valid = value => {
    try {
      const u = new URL(value);
      return u.origin === 'https://cove.lumi.org.cn' && !u.username && !u.password && !u.search && !u.hash && /^\/audio-clips\/[A-Za-z0-9_-]{43}\.wav$/.test(u.pathname);
    } catch { return false; }
  };
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:12px;top:100px;z-index:2147483647;max-width:240px;background:#20252d;color:white;padding:10px;border-radius:12px;font:14px sans-serif;box-shadow:0 2px 12px #0005';
  const button = document.createElement('button');
  button.textContent = '♫ 添加音频附件';
  button.style.cssText = 'padding:8px;border-radius:8px;cursor:pointer';
  const status = document.createElement('div');
  status.style.cssText = 'margin-top:6px;font-size:12px';
  status.setAttribute('role', 'status');
  status.textContent = '从当前聊天的 WAV 链接添加；由你发送';
  panel.append(button, status);
  document.body.append(panel);
  const download = url => new Promise((resolve, reject) => {
    GM_xmlhttpRequest({ method:'GET', url, anonymous:true, responseType:'arraybuffer', timeout:20000,
      onload(r) {
        if (r.status !== 200) return reject(new Error(r.status === 404 ? '链接已过期或文件不存在，请让插件重新生成。' : '下载失败：HTTP ' + r.status));
        if (!valid(r.finalUrl || url)) return reject(new Error('下载地址不符合允许范围。'));
        resolve(r.response);
      },
      onerror: () => reject(new Error('下载失败，请检查手机服务和隧道。')),
      ontimeout: () => reject(new Error('下载超时，请稍后再试。')),
    });
  });
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    const editor = document.querySelector('#prompt-textarea');
    if (!editor) { status.textContent = '请先打开要发送音频的聊天。'; return; }
    const links = [...document.querySelectorAll('main a[href]')].map(a => a.href).filter(valid);
    const url = window.prompt('确认要添加的短期 WAV 链接（五分钟有效）', links.at(-1) || '');
    if (url === null) return;
    if (!valid(url.trim())) { status.textContent = '请粘贴插件返回的 cove.lumi.org.cn 音频链接。'; return; }
    button.disabled = true;
    const locationAtStart = location.href;
    try {
      status.textContent = '正在下载音频…';
      const bytes = new Uint8Array(await download(url.trim()));
      const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
      if (bytes.length < 44 || bytes.length > 1000000 || ascii(0,4) !== 'RIFF' || ascii(8,12) !== 'WAVE') throw new Error('返回内容不是预期的 WAV 文件。');
      if (location.href !== locationAtStart || !editor.isConnected) throw new Error('聊天已切换，请在目标聊天重新操作。');
      const scope = editor.closest('form') || document.querySelector('main');
      const inputs = [...(scope?.querySelectorAll('input[type=file]') || [])].filter(input => {
        if (input.disabled) return false;
        const accept = input.accept.toLowerCase().split(',').map(x => x.trim());
        return !input.accept || accept.some(x => ['audio/*','audio/wav','audio/x-wav','.wav','*/*'].includes(x));
      });
      if (inputs.length !== 1) throw new Error('无法明确找到音频附件入口。请先点聊天的＋展开上传菜单，再重试；仍失败请用普通附件上传。');
      const input = inputs[0];
      if (input.files?.length) throw new Error('已有待处理文件，请先完成或取消它们。');
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'song-excerpt.wav', {type:'audio/wav'}));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', {bubbles:true}));
      status.textContent = '已交给上传入口。请确认出现 song-excerpt.wav 附件且上传完成，再自己点发送；没有附件卡片就代表未成功。';
    } catch (e) { status.textContent = e.message || '添加失败，请使用普通附件上传。'; }
    finally { button.disabled = false; }
  });
})();
