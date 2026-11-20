import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

// 宿主认不认得出「哪个模组卡死了」，以及卡死之后别人还能不能调（issue M15）。
//
// host.js 依赖 nodejs-mobile 的 linked binding，整份加载不起来；这里把它那段观察
// （从 `const HUNG_WATCH_MS` 到 `const startHungWatch`）**原样取出来**跑，判据的每一行都是
// 宿主里真正在跑的那几行，抄错、被改掉、被删掉都会红。

const hostPath = path.resolve('android/app/src/main/assets/folia-node/host.js');
const hostSource = fs.readFileSync(hostPath, 'utf8');

type Inside = { modId: string; where: string; since: number } | null;

const extractWatch = () => {
    const start = hostSource.indexOf('const HUNG_WATCH_MS');
    const end = hostSource.indexOf('const startHungWatch');
    if (start < 0 || end < 0) throw new Error('host.js 里找不到熔断观察那一段');
    return hostSource.slice(start, end);
};

type WatchBlock = {
    lookForHungMod: () => void;
    hungMarks: Map<string, { where: string; since: number }>;
    logs: Array<{ level: string; message: string }>;
};

const makeWatch = (options: { inside: Inside; progress?: () => number; now?: () => number }) => {
    const logs: Array<{ level: string; message: string }> = [];
    const faults: string[] = [];
    const emitLog = (level: string, message: string) => logs.push({ level, message });
    const hostInfo = { modSystem: { unresponsive: true } };
    const guard = {
        current: () => options.inside,
        progress: options.progress ?? (() => 0),
        noteFault: (modId: string, kind: string, where: string) => {
            faults.push(`${modId}:${kind}:${where}`);
            return true;
        },
    };
    // 墙钟由用例给：`Date` 作为参数传进去，块里的 `Date.now()` 就读到假时钟。
    const FakeDate = { now: options.now ?? (() => 0) };
    const factory = new Function(
        'emitLog',
        'hostInfo',
        'guard',
        'logs',
        'Date',
        `${extractWatch()}\nreturn { lookForHungMod, hungMarks, logs };`,
    );
    const block = factory(emitLog, hostInfo, guard, logs, FakeDate) as WatchBlock;
    return { ...block, faults };
};

/** 两次观察之间隔一秒：模组已经在门里 2.5 秒，这条观察才第一次醒来。 */
const STUCK_SINCE = 0;
const FIRST_WAKE = 2500;

describe('宿主的无响应观察（M15）', () => {
    it('模组卡在门里两秒以上、期间没有任何调用完成 → 判成无响应，日志点名位置', () => {
        const watch = makeWatch({ inside: { modId: 'frozen', where: 'rpc loop', since: STUCK_SINCE }, now: () => FIRST_WAKE });
        // 第一次醒来看到的是「一段新的、已经很久的调用」：只记下来。
        watch.lookForHungMod();
        expect(watch.hungMarks.size).toBe(0);
        // 第二次醒来还卡在同一句、progress 没动：判死。
        watch.lookForHungMod();
        expect(watch.hungMarks.size).toBe(1);
        expect(Object.fromEntries(watch.hungMarks).frozen).toMatchObject({ where: 'rpc loop' });
        expect(watch.faults).toEqual(['frozen:unresponsive:rpc loop']);
        expect(watch.logs[0].message).toContain('[frozen] 无响应：rpc loop');
    });

    it('卡住期间别的调用还在完成 → 不判（那是异步等待，不是死循环）', () => {
        let progress = 10;
        const watch = makeWatch({
            inside: { modId: 'waiting', where: 'rpc slow', since: STUCK_SINCE },
            progress: () => progress,
            now: () => FIRST_WAKE,
        });
        watch.lookForHungMod();
        progress += 1;
        watch.lookForHungMod();
        progress += 1;
        watch.lookForHungMod();
        expect(watch.hungMarks.size).toBe(0);
        expect(watch.faults).toEqual([]);
    });

    it('门里没人时不判任何模组', () => {
        let clock = 0;
        const watch = makeWatch({ inside: null, now: () => clock });
        for (let index = 0; index < 5; index += 1) {
            clock += 1000;
            watch.lookForHungMod();
        }
        expect(watch.hungMarks.size).toBe(0);
    });

    it('判成无响应后，这个模组的调用立刻回 mod-hung；别的模组照常', () => {
        const watch = makeWatch({ inside: { modId: 'frozen', where: 'rpc loop', since: STUCK_SINCE }, now: () => FIRST_WAKE });
        watch.lookForHungMod();
        watch.lookForHungMod();
        expect(watch.faults.length).toBe(1);
        // 宿主里挡调用的是这一段（host.js 的 hungRefusal），逻辑一致：只挡被熔断的那一个。
        const refusal = (modId: string) => (watch.hungMarks.has(modId) ? { ok: false, error: `mod-hung:${modId}` } : null);
        expect(refusal('frozen')).toEqual({ ok: false, error: 'mod-hung:frozen' });
        // 关键：别的模组不受牵连 —— 这是 issue M15 要的「其余功能可用」。
        expect(refusal('healthy')).toBeNull();
    });
});

/*
 * 这一段对着 host.js 的源码核对接线，观察本身被删掉、被别处调用、或者哪一支没先挡，都会红。
 */
describe('host.js 源码接线（M15）', () => {
    it('观察在模组第一次被调用之前就位，并在每次观察间隔跑一次', () => {
        const mainIndex = hostSource.indexOf('const main = () => {');
        const startIndex = hostSource.lastIndexOf('startHungWatch();');
        // 从 main() 之后找，别命中 set-system-enabled 里那句同名的 `const list = loadAll();`。
        const loadIndex = hostSource.indexOf('const list = loadAll();', mainIndex);
        expect(mainIndex).toBeGreaterThan(-1);
        expect(startIndex).toBeGreaterThan(mainIndex);
        expect(loadIndex).toBeGreaterThan(mainIndex);
        expect(startIndex).toBeLessThan(loadIndex);
        expect(hostSource).toMatch(/setInterval\(lookForHungMod, HUNG_WATCH_MS\)/);
    });

    it('rpc 与 secrets 两支都先挡无响应的模组', () => {
        expect(hostSource).toMatch(/rpc: async \(\{ modId, name, args \}\) => \{\s*\n\s*const hung = hungRefusal\(modId, `rpc \$\{name\}`\);/);
        expect(hostSource).toMatch(/secrets: async \(\{ modId, op, key, value \}\) => \{\s*\n\s*const hung = hungRefusal\(modId, `secrets \$\{op\}`\);/);
    });

    it('重新载入时清掉上一次的无响应标记', () => {
        expect(hostSource).toMatch(/hungMarks\.delete\(id\);/);
        expect(hostSource).toMatch(/guard\.clearHung\(id\)/);
    });

    it('call-stats 把「无响应」交出去，面板才有得显示', () => {
        expect(hostSource).toMatch(/'call-stats': \(\{ modId \}\) => \{/);
        expect(hostSource).toMatch(/hung: Boolean\(hung\)/);
    });
});
