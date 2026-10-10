#!/usr/bin/env python3
"""Patch the existing personal OAuth gateway; preserve its key and OAuth settings."""
from pathlib import Path
import os
import subprocess
import tempfile
import time
import sys

path = Path(sys.argv[1] if len(sys.argv) > 1 else '/root/cove-access/oauth-gateway.cjs')
source = path.read_text()
marker = '// QIANQIAN_AUDIO_RESOURCE_ROUTE_V1'
if marker in source:
    print('音频资源路由已安装，无需重复修改。')
    raise SystemExit(0)
replacements = {
    'function proxy(req, res) {': "function proxy(req, res, targetPath = '/mcp/music') {",
    "path: '/mcp/music', method: req.method, headers}": 'path: targetPath, method: req.method, headers}',
}
for old, new in replacements.items():
    if source.count(old) != 1:
        raise SystemExit('网关版本与预期不同，未修改任何文件。请交给维护者检查。')
    source = source.replace(old, new, 1)
anchor = "    if (u.pathname === '/mcp/music' && !u.search && ['GET', 'POST', 'DELETE'].includes(req.method)) {"
if source.count(anchor) != 1:
    raise SystemExit('未找到预期 MCP 路由，未修改任何文件。')
route = r"""    // QIANQIAN_AUDIO_RESOURCE_ROUTE_V1
    // A 256-bit capability identifies one WAV for five minutes. The backend enforces expiry.
    if (/^\/audio-clips\/[A-Za-z0-9_-]{43}\.wav$/.test(u.pathname) && !u.search && ['GET', 'HEAD'].includes(req.method)) {
      return proxy(req, res, u.pathname);
    }
"""
source = source.replace(anchor, route + anchor, 1)
fd, temporary = tempfile.mkstemp(prefix='.audio-route-', suffix='.cjs', dir=path.parent)
try:
    with os.fdopen(fd, 'w') as output:
        output.write(source)
    subprocess.run(['node', '--check', temporary], check=True)
    backup = path.with_name(path.name + '.before-audio-' + str(time.time_ns()))
    backup.write_bytes(path.read_bytes())
    backup.chmod(0o600)
    os.chmod(temporary, path.stat().st_mode & 0o777)
    os.replace(temporary, path)
    print('已添加短期 WAV 路由。原网关已备份；连接密钥保持不变。请重启授权服务窗口。')
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
