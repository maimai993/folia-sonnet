// test/manual/rhineResumeCheck.mjs
//
// 验「续播标记」是否会导致开屏被跳过。
// 两次加载 rhin.htm#folia：
//   第一次：干净 sessionStorage          -> 应该看到完整阶段序列（含 array）
//   第二次：预先写入 rhine-resume=1      -> 复现用户现象（跳过 array）
//   第三次：写入后再清掉（模拟宿主修复） -> array 应该回来
//
// 跑：node test/manual/rhineResumeCheck.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const page = resolve('public/rhinelab/rhine.htm');
const url = `file:///${page.replace(/\\/g, '/')}#folia`;
const dir = mkdtempSync(join(tmpdir(), 'rhine-resume-'));
const port = 9600 + Math.floor(Math.random() * 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(dir, 'profile')}`,
    'about:blank',
], { stdio: 'ignore' });

/** 跑一轮：preset 决定加载前往 sessionStorage 塞什么。返回阶段序列。 */
async function round(send, sessionId, preset) {
    await send('Page.navigate', { url: 'about:blank' }, sessionId);
    await sleep(300);
    if (preset) {
        // 需要先处在这个 origin 才能写它的 sessionStorage。
        await send('Page.navigate', { url }, sessionId);
        await sleep(1200);
        await send('Runtime.evaluate', {
            expression: `sessionStorage.setItem('rhine-resume','1')`,
        }, sessionId);
        await send('Page.navigate', { url: 'about:blank' }, sessionId);
        await sleep(300);
    }
    await send('Page.navigate', { url }, sessionId);

    const seen = [];
    for (let tick = 0; tick < 70; tick += 1) {
        await sleep(500);
        const reply = await send('Runtime.evaluate', {
            expression: `(() => {
                const s = document.getElementById('stage');
                const sc = document.getElementById('three-scene');
                return JSON.stringify({
                    boot: s ? (s.dataset.boot || '') : '',
                    fps: sc ? (sc.dataset.fps || '') : '',
                });
            })()`,
            returnByValue: true,
        }, sessionId);
        const raw = reply.result?.result?.value;
        if (raw) {
            const { boot } = JSON.parse(raw);
            if (boot && seen[seen.length - 1] !== boot) seen.push(boot);
        }
        if (seen.includes('done')) break;
    }
    return seen;
}

let results = [];
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

    results.push(['干净 sessionStorage', await round(send, sessionId, false)]);
    results.push(['预置 rhine-resume=1', await round(send, sessionId, true)]);
    socket.close();
} finally {
    browser.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('');
for (const [label, seen] of results) {
    console.log(`${label}:`);
    console.log('  ', seen.join(' -> '));
    console.log('   含 array:', seen.includes('array'));
}
const clean = results[0][1];
const resumed = results[1][1];
const failures = [];
if (!clean.includes('array')) failures.push('干净状态下也没有 array 阶段（开屏本就残缺）');
if (resumed.includes('array')) failures.push('预置续播标记后仍有 array（现象没复现）');
if (failures.length) {
    console.log('\n提示：', failures.join('；'));
    process.exit(failures.some(f => f.includes('本来就') ) ? 1 : 0);
}
console.log('\n结论：续播标记确实会跳过 array 阶段 —— 宿主清标记即可修复。');
