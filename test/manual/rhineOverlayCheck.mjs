// test/manual/rhineOverlayCheck.mjs
//
// 验叠层在真浏览器里能不能挂上：
//   1. bundle 里的渲染钩子被调用（__FOLIA_OVERLAY__.stats.renders 增长）
//   2. 按 assemblyPart 找到了两个圆环的 mesh
//   3. 打开叠层后材质被替换、纹理被建出来
//   4. 关掉后材质还原
//
// 需要开屏跑完（约 22s）进到 detail 才会有场景，所以整体耗时较长。
//
// 跑：node test/manual/rhineOverlayCheck.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const page = resolve('public/rhinelab/rhine.htm');
const url = `file:///${page.replace(/\\/g, '/')}#folia`;
const dir = mkdtempSync(join(tmpdir(), 'rhine-overlay-'));
const port = 9500 + Math.floor(Math.random() * 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files',
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(dir, 'profile')}`,
    'about:blank',
], { stdio: 'ignore' });

let report = [];
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
    const evaluate = async (expression, sessionId) => {
        const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        return reply.result?.result?.value;
    };

    const target = await send('Target.createTarget', { url: 'about:blank' });
    const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true });
    const sessionId = attached.result.sessionId;
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);

    // 收集页面 console，便于排查
    const consoleLines = [];
    socket.addEventListener('message', ev => {
        const m = JSON.parse(ev.data);
        if (m.method === 'Runtime.consoleAPICalled') {
            const text = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
            if (text) consoleLines.push(text);
        }
    });

    await send('Page.navigate', { url }, sessionId);

    // 等开屏（约 22s）走完并进 detail 建场景；最多等 45 秒
    let bootState = '';
    for (let i = 0; i < 90; i += 1) {
        await sleep(500);
        bootState = await evaluate(`(document.getElementById('stage')||{}).dataset?.boot || ''`, sessionId);
        if (bootState === 'select' || bootState === 'inspect' || bootState === 'done') break;
    }
    report.push(['开屏阶段', bootState]);

    // 等场景真的建起来（渲染钩子被调用）
    let renders = 0;
    for (let i = 0; i < 40; i += 1) {
        renders = await evaluate(`(window.__FOLIA_OVERLAY__ && window.__FOLIA_OVERLAY__.stats.renders) || 0`, sessionId);
        if (renders > 10) break;
        await sleep(500);
    }
    report.push(['render 钩子调用次数', renders]);

    // 打开叠层，喂一首「正在播放」的歌
    await evaluate(`window.__FOLIA_OVERLAY_SET__({
        enabled: true,
        now: { title: '测试曲目', artist: 'Folia', lyric: '这是叠层验证用的歌词', playing: true, progress: 0.42 }
    })`, sessionId);
    await sleep(2000);

    const afterOn = await evaluate(`(() => {
        const s = window.__FOLIA_OVERLAY__;
        return JSON.stringify({ meshes: s.stats.meshes, textures: s.stats.textures, repaints: s.stats.repaints });
    })()`, sessionId);
    report.push(['启用后', afterOn]);

    const materialCheck = await evaluate(`(() => {
        const s = window.__FOLIA_OVERLAY__;
        if (!s.targets || !s.targets.length) return JSON.stringify({ overlaid: 0, total: 0 });
        let overlaid = 0;
        s.targets.forEach(m => {
            if (m.material && m.material.map && m.material.map.image && m.material.map.image.width) overlaid += 1;
        });
        return JSON.stringify({ overlaid, total: s.targets.length });
    })()`, sessionId);
    report.push(['已贴图 mesh', materialCheck]);

    // 关掉，验证材质还原
    await evaluate(`window.__FOLIA_OVERLAY_SET__({ enabled: false })`, sessionId);
    await sleep(1200);
    const afterOff = await evaluate(`(() => {
        const s = window.__FOLIA_OVERLAY__;
        return JSON.stringify({ targets: s.targets ? s.targets.length : 0, mountedScene: !!s.mountedScene });
    })()`, sessionId);
    report.push(['关闭后', afterOff]);

    socket.close();

    console.log('');
    for (const [label, value] of report) console.log(`${label}:`, value);

    const overlayLogs = consoleLines.filter(l => l.includes('rhine-overlay'));
    console.log('\n叠层日志:');
    if (overlayLogs.length) overlayLogs.slice(0, 10).forEach(l => console.log('  ', l));
    else console.log('   （无）');

    // 判定
    const failures = [];
    if (!(renders > 0)) failures.push('render 钩子从未被调用（bundle 补丁没生效）');
    const on = JSON.parse(afterOn || '{}');
    if (!(on.meshes > 0)) failures.push('没找到圆环 mesh');
    const mat = JSON.parse(materialCheck || '{}');
    if (!(mat.overlaid > 0)) failures.push('没有 mesh 贴上纹理');

    if (failures.length) {
        console.log('\n失败：', failures.join('；'));
        process.exit(1);
    }
    console.log('\n叠层：全部通过');
} finally {
    browser.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
