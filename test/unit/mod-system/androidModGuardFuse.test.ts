import { describe, expect, it, vi } from 'vitest';
import path from 'path';

// test/unit/mod-system/androidModGuardFuse.test.ts
// guard.cjs 给宿主熔断用的那几样（issue M15）。
//
// 以前的 gate 只统计耗时：`while (true) {}` 里什么都不回来，宿主也认不出是谁，只能让每个调用
// 干等原生那 180 秒。现在 gate 记下「谁在里面 / 在哪一句」（current）、「一共完成了几次调用」
// （progress）、以及被判定无响应之后的记账（noteFault / clearHung / getHung），并且在同步调用
// 之后把「里面」清干净——否则任何一个调用结束以后都会被误判成卡死。
//
// 这个文件是 .cjs 的孪生（src/mods/runtime/guard.ts），只有宿主会加载它。

const guardPath = path.resolve('android/app/src/main/assets/folia-node/modSystem/guard.cjs');

type Current = { modId: string; where: string; since: number } | null;

type Gate = {
    call: <T>(modId: string, where: string, fn: () => T, options?: { rethrow?: boolean }) => T;
    getStats: (modId: string) => { calls: number; longestMs: number; failures: number; faults: number; hung: boolean } | null;
    current: () => Current;
    progress: () => number;
    noteFault: (modId: string, kind: 'unresponsive' | 'heap', where: string) => boolean;
    clearHung: (modId: string) => void;
    getHung: (modId: string) => { where: string; since: number } | null;
};

const loadGate = (report = vi.fn()): Gate => {
    const resolved = require.resolve(guardPath);
    delete require.cache[resolved];
    const { createModGuard } = require(resolved) as { createModGuard: (fn: unknown) => Gate };
    return createModGuard(report);
};

describe('guard.cjs 的熔断账本（M15）', () => {
    it('同步调用期间看得到是谁、在哪一句；返回后立刻清空', () => {
        const gate = loadGate();
        expect(gate.current()).toBeNull();
        let seen: Current = null;
        gate.call('slow-mod', 'rpc doThing', () => {
            seen = gate.current();
            return 1;
        });
        expect(seen).toMatchObject({ modId: 'slow-mod', where: 'rpc doThing' });
        // 关键：调用回来以后不能还显示「在里面」，否则观察下一次就会把一个正常模组判成卡死。
        expect(gate.current()).toBeNull();
    });

    it('抛异常的同步调用也要退出「里面」', () => {
        const gate = loadGate();
        expect(() => gate.call('m', 'activate', () => {
            expect(gate.current()).toMatchObject({ modId: 'm', where: 'activate' });
            throw new Error('boom');
        })).not.toThrow();
        expect(gate.current()).toBeNull();
    });

    it('异步调用在等待期间留着，settle 之后才清；期间完成的调用会让 progress 增长', async () => {
        const gate = loadGate();
        let release: () => void = () => {};
        const pending = gate.call('async-mod', 'rpc wait', () => new Promise<void>((resolve) => {
            release = resolve;
        }));
        expect(gate.current()).toMatchObject({ modId: 'async-mod', where: 'rpc wait' });
        const before = gate.progress();
        // 宿主在等这个 Promise 期间照样调别的模组：那些调用完成就说明事件循环活着。
        gate.call('other-mod', 'rpc ping', () => 1);
        expect(gate.progress()).toBeGreaterThan(before);
        release();
        await pending;
        expect(gate.current()).toBeNull();
    });

    it('progress 只增不减，跨模组一起算', () => {
        const gate = loadGate();
        const start = gate.progress();
        gate.call('a', 'x', () => 1);
        gate.call('b', 'y', () => 2);
        expect(gate.progress()).toBe(start + 2);
    });

    it('noteFault 只记一次，并挂上无响应的位置；clearHung 之后回到干净状态', () => {
        const gate = loadGate();
        expect(gate.noteFault('frozen', 'unresponsive', 'rpc loop')).toBe(true);
        expect(gate.noteFault('frozen', 'unresponsive', 'rpc loop')).toBe(false);
        expect(gate.getHung('frozen')).toMatchObject({ where: 'rpc loop' });
        expect(gate.getStats('frozen')).toMatchObject({ faults: 1, hung: true });
        // 另一种毛病要各算各的。
        expect(gate.noteFault('frozen', 'heap', 'api.storage')).toBe(true);
        expect(gate.getStats('frozen')).toMatchObject({ faults: 2 });

        gate.clearHung('frozen');
        expect(gate.getHung('frozen')).toBeNull();
        expect(gate.getStats('frozen')).toMatchObject({ hung: false });
    });

    it('嵌套调用保留外层模组，最内层的调用结束不会把外层一起退出', () => {
        const gate = loadGate();
        gate.call('outer', 'rpc outer', () => {
            gate.call('outer', 'rpc inner', () => 1);
            // 内层是自己调的助手，出来以后外层还在里面，位置回到 outer。
            expect(gate.current()).toMatchObject({ modId: 'outer', where: 'rpc outer' });
        });
        expect(gate.current()).toBeNull();
    });

    it('原来的耗时统计还在', () => {
        const report = vi.fn();
        const gate = loadGate(report);
        gate.call('m', 'activate', () => 1);
        gate.call('m', 'activate', () => {
            throw new Error('nope');
        });
        expect(gate.getStats('m')).toMatchObject({ calls: 2, failures: 1 });
        expect(report).toHaveBeenCalledTimes(1);
    });
});
