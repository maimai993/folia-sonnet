// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

// Stores read localStorage at import time, and Node's own experimental storage
// shadows jsdom's here, so an in-memory Storage goes in before any import runs.
vi.hoisted(() => {
    const items = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (key: string) => items.get(key) ?? null,
            setItem: (key: string, value: string) => { items.set(key, String(value)); },
            removeItem: (key: string) => { items.delete(key); },
            clear: () => items.clear(),
            key: (index: number) => Array.from(items.keys())[index] ?? null,
            get length() { return items.size; },
        },
    });
});
import type { FoliumCallStats } from '@/mods/runtime/guard';
import type { FoliumIssue } from '@/mods/runtime/status';
import type { FoliumClientStart } from '@/mods/runtime/clientLoader';
import { SLOW_MAIN_CALL_MS, SLOW_RUNNING_MS, SLOW_START_MS, describeModCost, isModHung, isModSlow } from '@/mods/manager/modCost';

// test/unit/mod-system/modCost.test.ts
// The numbers on a mod's row, worked out from what the gates counted: where
// its start stands, the time its code takes in each second in which it runs
// (the gate counts no frames, so the number is not per frame), the totals of
// the failure record, and where "slow" begins.

const stats = (listenerMs: number, listenerSeconds: number): FoliumCallStats => ({
    calls: 100, totalMs: listenerMs + 50, longestMs: 50, failures: 0, listenerMs, listenerSeconds,
});
const issue = (where: string, count: number): FoliumIssue => ({ where, message: 'boom', count, firstAt: 1, lastAt: 2 });
const started = (ms: number): FoliumClientStart => ({ state: 'started', ms });

describe('what a mod costs, for its row', () => {
    it('gives the time its listeners take in each second in which they ran', () => {
        // 120 ms in the 4 seconds it ran: 30 ms of each second.
        const cost = describeModCost(started(212.4), stats(120, 4), [], null);
        expect(cost).toMatchObject({ start: { state: 'started', ms: 212 }, runningMs: 30, failures: 0, failurePlaces: 0, main: null });
        expect(isModSlow(cost)).toBe(false);
    });

    it('has no running time before anything ran again, and no start for a mod without a client', () => {
        expect(describeModCost({ state: 'starting', late: false }, stats(0, 0), [], null))
            .toMatchObject({ start: { state: 'starting', late: false }, runningMs: null, slowStart: false });
        expect(describeModCost(undefined, null, [], null)).toMatchObject({ start: undefined, runningMs: null });
    });

    it('has no start time for a start that threw, and marks one still going past the limit as slow', () => {
        const failed = describeModCost({ state: 'failed' }, null, [issue('client activate', 1)], null);
        expect(failed).toMatchObject({ start: { state: 'failed' }, slowStart: false, failures: 1 });
        const late = describeModCost({ state: 'starting', late: true }, null, [], null);
        expect(late).toMatchObject({ start: { state: 'starting', late: true }, slowStart: true, failures: 0 });
        expect(isModSlow(late)).toBe(true);
    });

    it('adds the failure record up: how many times, in how many places', () => {
        const cost = describeModCost(started(10), null, [issue('a mount', 3), issue('b onFrame', 1000)], null);
        expect(cost).toMatchObject({ failures: 1003, failurePlaces: 2 });
        // Failing is not being slow.
        expect(isModSlow(cost)).toBe(false);
    });

    it('marks slow at each limit and not below it', () => {
        expect(describeModCost(started(SLOW_START_MS - 1), null, [], null).slowStart).toBe(false);
        expect(describeModCost(started(SLOW_START_MS), null, [], null).slowStart).toBe(true);

        expect(describeModCost(started(10), stats(SLOW_RUNNING_MS - 1, 1), [], null).slowRunning).toBe(false);
        expect(describeModCost(started(10), stats(SLOW_RUNNING_MS * 3, 3), [], null).slowRunning).toBe(true);

        const main = (longestMs: number) => ({ calls: 2, totalMs: longestMs + 1, longestMs, failures: 0 });
        expect(describeModCost(undefined, null, [], main(SLOW_MAIN_CALL_MS - 1)).slowMain).toBe(false);
        const slow = describeModCost(undefined, null, [], main(SLOW_MAIN_CALL_MS));
        expect(slow).toMatchObject({ slowMain: true, main: { totalMs: SLOW_MAIN_CALL_MS + 1, longestMs: SLOW_MAIN_CALL_MS } });
        expect(isModSlow(slow)).toBe(true);
        expect(isModSlow(undefined)).toBe(false);
    });

    it('把宿主判定的无响应带到行的标记上，并说清卡在哪一句', () => {
        // 桌面端主进程的 gate 没有这一项：hung 缺省就是没有。
        expect(describeModCost(started(10), null, [], { calls: 1, totalMs: 1, longestMs: 1, failures: 0 }))
            .toMatchObject({ hung: false, hungWhere: null });
        expect(isModHung(undefined)).toBe(false);

        const hung = describeModCost(started(10), null, [], {
            calls: 3, totalMs: 90, longestMs: 80, failures: 0, hung: true, hungWhere: 'rpc loop',
        });
        expect(hung).toMatchObject({ hung: true, hungWhere: 'rpc loop', slowMain: false });
        expect(isModHung(hung)).toBe(true);
        // 无响应不是「慢」：它没有被判定成慢的地方，行上要显示的是「无响应」而不是「慢」。
        expect(isModSlow(hung)).toBe(false);

        // 没有位置（旧宿主）时也照样显示标记，只是提示里没有那一句。
        const withoutWhere = describeModCost(undefined, null, [], { calls: 1, totalMs: 1, longestMs: 1, failures: 0, hung: true });
        expect(withoutWhere).toMatchObject({ hung: true, hungWhere: null });
        expect(isModHung(withoutWhere)).toBe(true);
    });
});
