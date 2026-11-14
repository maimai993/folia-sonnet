// test/manual/rhineBootProbe.mjs
//
// 用真浏览器加载 public/rhinelab/rhine.htm#folia，采样开屏阶段（#stage.dataset.boot）
// 随时间的变化，确认三件事：
//   1. 开屏阶段是否依次经过 access -> logo -> auth -> scan -> welcome -> array
//   2. 是否卡在某一阶段不动（用户报的"还是在完成播放"）
//   3. 卡住时帧率是多少（是不是被节流压死了）
//
// 跑：node test/manual/rhineBootProbe.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const page = resolve('public/rhinelab/rhine.htm');
const url = `file:///${page.replace(/\\/g, '/')}#folia`;
const dir = mkdtempSync(join(tmpdir(), 'rhine-boot-'));
const port = 9700 + Math.floor(Math.random() * 90);

const browser = spawn(
    EDGE,
    [
        '--headless=new', '--no-sandbox', '--no-first-run',
        '--allow-file-access-from-files',
        '--autoplay-policy=no-user-gesture-required',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${join(dir, 'profile')}`,
        'about:blank',
    ],
    { stdio: 'ignore' },
);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let samples = [];
try {
    let version;
    for (let i = 0; i < 160 && !version; i += 1) {
        try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) version = await r.json(); }
        catch { await sleep(150); }
    }
    if (!version) throw new Error('CDP 没起来');

    const socket = new WebSocket(version.webSocketDebuggerUrl);
    let nextId = 0;
    const waiting = new Map();
    socket.addEventListener('message', ev => {
        const m = JSON.parse(ev.data);
        const s = waiting.get(m.id);
        if (s) { waiting.delete(m.id); s(m); }
    });
    await new Promise(r => socket.addEventListener('open', r, { once: true }));
    const send = (method, params = {}, sessionId) => new Promise(res => {
        const id = ++nextId; waiting.set(id, res);
        socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

    const target = await send('Target.createTarget', { url: 'about:blank' });
    const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true });
    const sessionId = attached.result.sessionId;
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Page.navigate', { url }, sessionId);

    // 采样 40 秒，每 500ms 一次
    for (let tick = 0; tick < 80; tick += 1) {
        await sleep(500);
        const expr = `(() => {
            const stage = document.getElementById('stage');
            const scene = document.getElementById('three-scene');
            const title = document.querySelector('.file-title');
            return JSON.stringify({
                t: Math.round(performance.now() / 100) / 10,
                boot: stage ? (stage.dataset.boot || '(none)') : '(no stage)',
                fps: scene ? (scene.dataset.fps || '') : '',
                title: title && title.firstChild ? (title.firstChild.textContent || '').trim() : '',
                foliaTyping: title ? (title.dataset.foliaTyping || '') : '',
                foliaDone: title ? (title.dataset.foliaDone || '') : '',
            });
        })()`;
        const reply = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
        const raw = reply.result?.result?.value;
        if (raw) samples.push(JSON.parse(raw));
    }
    socket.close();
} finally {
    browser.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(`采样 ${samples.length} 条（每 500ms）`);
console.log('t(s)   boot      fps   title                typing done');
for (const s of samples) {
    console.log(
        String(s.t).padStart(5),
        (s.boot || '').padEnd(9),
        String(s.fps).padStart(4),
        ' ',
        (s.title || '').padEnd(20),
        String(s.foliaTyping).padStart(2),
        String(s.foliaDone).padStart(4),
    );
}

// 汇总：阶段序列
const seen = [];
for (const s of samples) {
    if (s.boot && s.boot !== '(none)' && seen[seen.length - 1] !== s.boot) seen.push(s.boot);
}
console.log('\n阶段序列:', seen.join(' -> '));
const last = samples[samples.length - 1];
console.log('最终阶段:', last && last.boot);
console.log('是否进入过 array:', seen.includes('array'));
console.log('是否进入过 detail:', seen.includes('detaIL') || seen.includes('detail'));
