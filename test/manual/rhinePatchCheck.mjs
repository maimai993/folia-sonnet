// test/manual/rhinePatchCheck.mjs
//
// 验 folia-rhine-patch.js：策略默认值、消息桥、rAF 节流、DPR 上限、cancel。
//
// 节流用确定性的假时钟量（headless 的 rAF 跑得比真实时钟快，按墙钟数帧不准），
// 再在真浏览器里验「补丁能执行、消息桥通、cancel 有效」。
//
// 跑：node test/manual/rhinePatchCheck.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const source = readFileSync('public/rhinelab/folia-rhine-patch.js', 'utf8');
const failures = [];

/* —— 一、假时钟下的节流（确定性） —— */
const simulate = (idleFps, spanMs) => {
    let now = 0;
    const timers = [];
    /*
     * 补丁现在会碰 DOM（SELECTING 动画那一段）：给一个最小 document 桩，
     * readyState 设成 complete 直接走同步安装分支，installSelectingAnimations
     * 在 body 缺失时会立刻返回，不影响节流这部分测量。
     */
    const fakeDocument = {
        readyState: 'complete',
        body: null,
        head: null,
        documentElement: null,
        getElementById: () => null,
        querySelector: () => null,
        createElement: () => ({ dataset: {}, style: {}, className: '', textContent: '' }),
        addEventListener() {},
    };
    const fake = {
        addEventListener() {},
        matchMedia: () => ({ matches: false }),
        devicePixelRatio: 3,
        document: fakeDocument,
        setTimeout: (fn, ms) => {
            const timer = { at: now + (ms || 0), fn };
            timers.push(timer);
            return timer;
        },
        clearTimeout: timer => {
            const index = timers.indexOf(timer);
            if (index >= 0) timers.splice(index, 1);
        },
        requestAnimationFrame: fn => {
            // 原生 rAF：60Hz 节拍。
            const timer = { at: now + 1000 / 60, fn };
            timers.push(timer);
            return timer;
        },
        cancelAnimationFrame: timer => {
            const index = timers.indexOf(timer);
            if (index >= 0) timers.splice(index, 1);
        },
        performance: { now: () => now },
        Map, Set, Math, JSON, console, TypeError,
        HTMLCanvasElement: { prototype: { getContext: () => null } },
        MessageEvent: class {},
    };
    fake.window = fake;
    const factory = new Function(
        'window', 'document', 'HTMLCanvasElement', 'MessageEvent', 'performance',
        'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame',
        `${source}; return window;`,
    );
    const scope = factory(
        fake, fakeDocument, fake.HTMLCanvasElement, fake.MessageEvent, fake.performance,
        fake.setTimeout, fake.clearTimeout, fake.requestAnimationFrame, fake.cancelAnimationFrame,
    );
    // 宽限期会让前 25 秒一律走 maxFps，量 idleFps 时把它关掉。
    if (idleFps !== undefined) scope.__FOLIA_RHINE_SET__({ idleFps, bootGraceMs: 0 });

    let frames = 0;
    const start = now;
    const tick = () => {
        frames += 1;
        if (now - start < spanMs) scope.requestAnimationFrame(tick);
    };
    scope.requestAnimationFrame(tick);
    for (let guard = 0; guard < 10_000; guard += 1) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift();
        if (!next || now - start > spanMs + 100) break;
        now = Math.max(now, next.at);
        next.fn(now);
    }
    return { frames, policy: { ...scope.__FOLIA_RHINE__ } };
};

const idle12 = simulate(12, 1000);
console.log('假时钟 60Hz 原生 / idleFps=12 / 1000ms ->', idle12.frames, '帧');
if (idle12.frames > 14 || idle12.frames < 9) {
    failures.push(`idleFps=12 时 1000ms 应为约 12 帧，实际 ${idle12.frames}`);
}
const idle60 = simulate(60, 1000);
console.log('假时钟 60Hz 原生 / idleFps=60 / 1000ms ->', idle60.frames, '帧');
if (idle60.frames < 50) failures.push(`idleFps=60 时不该被压到 ${idle60.frames} 帧`);

/* —— 二、真浏览器：执行、消息桥、DPR、cancel —— */
const probe = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body>
<script>${source}</script>
<script>
window.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'rhine-policy') window.__FOLIA_RHINE_SET__(event.data.policy);
});
const log = [];
try {
  const p = window.__FOLIA_RHINE__;
  log.push(['defaults', p.maxFps, p.idleFps, p.activeMs, p.maxPixelRatio]);
  log.push(['setFn', typeof window.__FOLIA_RHINE_SET__]);
  log.push(['ctxSet', window.__FOLIA_RHINE_CONTEXTS__ instanceof Set]);
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'rhine-policy', policy: { idleFps: 40, maxPixelRatio: 1.25 } } }));
  log.push(['afterSet', window.__FOLIA_RHINE__.idleFps, window.__FOLIA_RHINE__.maxPixelRatio]);
  log.push(['dpr', window.devicePixelRatio]);
  let fired = false;
  const id = requestAnimationFrame(function () { fired = true; });
  cancelAnimationFrame(id);
  setTimeout(function () {
    log.push(['cancelWorked', !fired]);
    window.__RESULT__ = JSON.stringify(log);
    document.title = 'DONE';
  }, 250);
} catch (error) {
  window.__RESULT__ = JSON.stringify([['error', String(error && error.stack || error)]]);
  document.title = 'DONE';
}
</script></body></html>`;

const dir = mkdtempSync(join(tmpdir(), 'rhine-patch-'));
const page = join(dir, 'probe.html');
writeFileSync(page, probe, 'utf8');

const port = 9500 + Math.floor(Math.random() * 400);
const browser = spawn(
    EDGE,
    [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${join(dir, 'profile')}`,
        'about:blank',
    ],
    { stdio: 'ignore' },
);

let result;
try {
    let version;
    for (let attempt = 0; attempt < 120 && !version; attempt += 1) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) version = await response.json();
        } catch {
            await new Promise(resolve => setTimeout(resolve, 150));
        }
    }
    if (!version) throw new Error('CDP 端口没起来');

    const socket = new WebSocket(version.webSocketDebuggerUrl);
    let nextId = 0;
    const waiting = new Map();
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        const settle = waiting.get(message.id);
        if (settle) {
            waiting.delete(message.id);
            settle(message);
        }
    });
    await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
    const send = (method, params = {}, sessionId) =>
        new Promise(resolve => {
            const id = ++nextId;
            waiting.set(id, resolve);
            socket.send(JSON.stringify({ id, method, params, sessionId }));
        });

    const target = await send('Target.createTarget', { url: 'about:blank' });
    const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true });
    const sessionId = attached.result.sessionId;
    await send('Page.enable', {}, sessionId);
    await send('Page.navigate', { url: `file:///${page.replace(/\\/g, '/')}` }, sessionId);

    for (let attempt = 0; attempt < 80 && !result; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 250));
        const reply = await send(
            'Runtime.evaluate',
            { expression: 'window.__RESULT__ || null', returnByValue: true },
            sessionId,
        );
        result = reply.result?.result?.value || undefined;
    }
    socket.close();
} finally {
    browser.kill();
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        // profile 目录被占，临时目录不追究
    }
}

if (!result) {
    console.log('失败：页面没有回报结果');
    process.exit(1);
}

const entries = JSON.parse(result);
const byKey = Object.fromEntries(entries.map(([key, ...rest]) => [key, rest]));
console.log('真浏览器结果：');
for (const [key, ...rest] of entries) console.log('  ', key, JSON.stringify(rest));

if (byKey.error) failures.push('补丁抛错');
if (byKey.setFn?.[0] !== 'function') failures.push('缺少 __FOLIA_RHINE_SET__');
if (byKey.ctxSet?.[0] !== true) failures.push('缺少上下文登记表');
if (byKey.afterSet?.[0] !== 40) failures.push('消息桥没改到 idleFps');
if (byKey.afterSet?.[1] !== 1.25) failures.push('消息桥没改到 maxPixelRatio');
if (byKey.cancelWorked?.[0] !== true) failures.push('cancelAnimationFrame 失效');

if (failures.length) {
    console.log('失败：', failures.join('；'));
    process.exit(1);
}
console.log('rhine patch: 全部通过');
