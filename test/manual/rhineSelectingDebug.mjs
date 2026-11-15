// test/manual/rhineSelectingDebug.mjs
//
// 调试 SELECTING 动画为什么没挂上：把补丁内部状态导出来看。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const source = readFileSync('public/rhinelab/folia-rhine-patch.js', 'utf8');

const probe = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body>
<main id="viewport"><div id="stage"></div><section id="archive-ui" class="archive-ui">
  <button class="file-title" data-action="open">FILE NUMBER: <span id="selected-id">X-</span></button>
</section></main>
<script>${source}</script>
<script>
const log = [];
setTimeout(function () {
  log.push(['styleExists', Boolean(document.getElementById('folia-selecting-style'))]);
  log.push(['titleFound', Boolean(document.querySelector('.file-title'))]);
  const t = document.querySelector('.file-title');
  log.push(['datasets', JSON.stringify(Object.assign({}, t.dataset))]);
  log.push(['firstChildType', t.firstChild ? t.firstChild.nodeType : 'none']);
  log.push(['firstChildText', JSON.stringify(t.firstChild ? t.firstChild.textContent : null)]);
  window.__RESULT__ = JSON.stringify(log);
}, 400);
</script></body></html>`;

const dir = mkdtempSync(join(tmpdir(), 'rhine-dbg-'));
const page = join(dir, 'probe.html');
writeFileSync(page, probe, 'utf8');
const port = 9800 + Math.floor(Math.random() * 90);
const browser = spawn(EDGE, ['--headless=new','--disable-gpu','--no-sandbox','--no-first-run',`--remote-debugging-port=${port}`,`--user-data-dir=${join(dir,'profile')}`,'about:blank'], { stdio: 'ignore' });

let result;
try {
    let version;
    for (let i = 0; i < 120 && !version; i += 1) {
        try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) version = await r.json(); }
        catch { await new Promise(r => setTimeout(r, 150)); }
    }
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    let nextId = 0; const waiting = new Map();
    socket.addEventListener('message', e => { const m = JSON.parse(e.data); const s = waiting.get(m.id); if (s) { waiting.delete(m.id); s(m); } });
    await new Promise(r => socket.addEventListener('open', r, { once: true }));
    const send = (method, params = {}, sessionId) => new Promise(resolve => { const id = ++nextId; waiting.set(id, resolve); socket.send(JSON.stringify({ id, method, params, sessionId })); });
    const target = await send('Target.createTarget', { url: 'about:blank' });
    const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true });
    const sessionId = attached.result.sessionId;
    await send('Page.enable', {}, sessionId);
    await send('Page.navigate', { url: `file:///${page.replace(/\\/g, '/')}` }, sessionId);
    for (let i = 0; i < 60 && !result; i += 1) {
        await new Promise(r => setTimeout(r, 200));
        const reply = await send('Runtime.evaluate', { expression: 'window.__RESULT__ || null', returnByValue: true }, sessionId);
        result = reply.result?.result?.value || undefined;
    }
    socket.close();
} finally {
    browser.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

if (result) for (const entry of JSON.parse(result)) console.log('  ', ...entry);
else console.log('没有结果');
