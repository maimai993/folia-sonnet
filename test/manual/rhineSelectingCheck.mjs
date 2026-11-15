// test/manual/rhineSelectingCheck.mjs
//
// 在真浏览器里验 SELECTING FILES 动画：造一个和 bundle 同构的 DOM
// （#stage > .file-title 文本节点），加载补丁，然后模拟 bundle 的 slice() 打字，
// 确认 data-folia-typing / data-folia-done 与时序都对。
//
// 跑：node test/manual/rhineSelectingCheck.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const source = readFileSync('public/rhinelab/folia-rhine-patch.js', 'utf8');

/*
 * 复刻 bundle 的结构：.file-title 的第一个子节点是纯文本 "FILE NUMBER: "，
 * bundle 直接改它的 textContent 来做打字机。
 */
const probe = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body>
<main id="viewport"><div id="stage"></div><section id="archive-ui" class="archive-ui">
  <button class="file-title" data-action="open">FILE NUMBER: <span id="selected-id">X-<span id="selected-code">001</span></span></button>
</section></main>
<script>${source}</script>
<script>
const log = [];
const title = document.querySelector('.file-title');
const firstChild = title.firstChild;

// 让 MutationObserver 先跑一轮
setTimeout(function () {
  log.push(['styleInjected', Boolean(document.getElementById('folia-selecting-style'))]);

  // 模拟 bundle 的打字：slice(0, k)。注意 bundle 是给同一个文本节点赋 textContent，
  // MutationObserver 的 characterData 通道要能收到。
  const target = 'SELECTING FILES...';
  const step = (k) => { firstChild.textContent = target.slice(0, k); };
  const snap = (label) => log.push([label, title.dataset.foliaTyping, title.dataset.foliaDone || '']);

  step(5);
  setTimeout(function () {
    snap('typed5');
    step(12);
    setTimeout(function () {
      snap('typed12');
      step(target.length);
      setTimeout(function () {
        snap('afterFull');
        log.push(['sweepAttached', Boolean(title.querySelector('.folia-sweep'))]);
        // 回到 FILE NUMBER:（bundle 在切出 boot 时这么干）
        firstChild.textContent = 'FILE NUMBER: ';
        setTimeout(function () {
          snap('backToIdle');
          log.push(['sweepRemoved', !title.querySelector('.folia-sweep')]);
          window.__RESULT__ = JSON.stringify(log);
        }, 150);
      }, 150);
    }, 150);
  }, 150);
}, 300);
</script></body></html>`;

const dir = mkdtempSync(join(tmpdir(), 'rhine-selecting-'));
const page = join(dir, 'probe.html');
writeFileSync(page, probe, 'utf8');

const port = 9900 + Math.floor(Math.random() * 90);
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
        await new Promise(resolve => setTimeout(resolve, 200));
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
        // 临时目录不追究
    }
}

if (!result) {
    console.log('失败：页面没有回报结果');
    process.exit(1);
}

const log = JSON.parse(result);
for (const entry of log) console.log('  ', ...entry);

const byKey = Object.fromEntries(log.map(([key, ...rest]) => [key, rest]));
const failures = [];
if (byKey.styleInjected?.[0] !== true) failures.push('样式没注入');
if (byKey.typed5?.[0] !== '1') failures.push('打字中没标记 typing');
if (byKey.typed12?.[0] !== '1') failures.push('打字中没标记 typing');
if (byKey.afterFull?.[1] !== '1') failures.push('打完后没标记 done');
if (byKey.sweepAttached?.[0] !== true) failures.push('完成后没挂扫线');
if (byKey.backToIdle?.[0] !== '0' || byKey.backToIdle?.[1] !== '') failures.push('回到 FILE NUMBER 后没复位');
if (byKey.sweepRemoved?.[0] !== true) failures.push('复位后扫线没移除');

if (failures.length) {
    console.log('失败：', failures.join('；'));
    process.exit(1);
}
console.log('SELECTING FILES 动画：全部通过');
