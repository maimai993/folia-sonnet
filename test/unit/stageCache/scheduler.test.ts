import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStageScheduler } from '@/services/stageCache/scheduler';

// test/unit/stageCache/scheduler.test.ts — 用可控底层 Promise 复现取消、优先级与真实并发槽。
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());
describe('stage scheduler', () => {
    it('shares same key while cancelling only one consumer', async () => {
        const scheduler = createStageScheduler<string>();
        const pending = deferred<string>();
        const generate = vi.fn(() => pending.promise);
        const controller = new AbortController();
        const first = scheduler.request({ key: 'a', priority: 'next', generate, signal: controller.signal });
        const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
        const second = scheduler.request({ key: 'a', priority: 'current', generate });
        controller.abort();
        pending.resolve('done');
        await cancelled;
        await expect(second).resolves.toBe('done');
        expect(generate).toHaveBeenCalledTimes(1);
    });
    it('retains the physical slot after all consumers abort, keeping only newest highest priority waiting', async () => {
        const scheduler = createStageScheduler<string>();
        const pending = deferred<string>();
        const controller = new AbortController();
        const a = scheduler.request({ key: 'a', priority: 'current', generate: () => pending.promise, signal: controller.signal });
        const aborted = expect(a).rejects.toMatchObject({ name: 'AbortError' });
        await flush();
        controller.abort();
        const b = scheduler.request({ key: 'b', priority: 'current', generate: async () => 'b' });
        const replaced = expect(b).rejects.toMatchObject({ name: 'AbortError' });
        const generate = vi.fn(async () => 'c');
        const c = scheduler.request({ key: 'c', priority: 'current', generate });
        await expect(scheduler.request({ key: 'next', priority: 'next', generate })).rejects.toMatchObject({ name: 'AbortError' });
        expect(scheduler.getState()).toMatchObject({ runningKey: 'a', waitingKey: 'c' });
        expect(generate).not.toHaveBeenCalled();
        pending.resolve('a');
        await Promise.all([aborted, replaced]);
        await expect(c).resolves.toBe('c');
        expect(generate).toHaveBeenCalledTimes(1);
    });
    it('rechecks validity and cache immediately before generation', async () => {
        const scheduler = createStageScheduler<string>();
        const cached = deferred<string | undefined>();
        const generate = vi.fn(async () => 'generated');
        let valid = true;
        const result = scheduler.request({ key: 'a', priority: 'current', generate,
            isValid: () => valid, beforeRun: () => cached.promise });
        const aborted = expect(result).rejects.toMatchObject({ name: 'AbortError' });
        valid = false;
        cached.resolve(undefined);
        await aborted;
        expect(generate).not.toHaveBeenCalled();
        await expect(scheduler.request({ key: 'b', priority: 'current', generate,
            beforeRun: async () => 'cached' })).resolves.toBe('cached');
        expect(generate).not.toHaveBeenCalled();
    });
    it('backs off automatic failures while permitting manual retry', async () => {
        vi.useFakeTimers();
        const scheduler = createStageScheduler<string>({ failureBackoffMs: 100 });
        await expect(scheduler.request({ key: 'a', priority: 'current', generate: async () => { throw Error('offline'); } })).rejects.toThrow('offline');
        const generate = vi.fn(async () => 'ok');
        const next = scheduler.request({ key: 'b', priority: 'current', generate });
        await flush();
        expect(generate).not.toHaveBeenCalled();
        const replaced = expect(next).rejects.toMatchObject({ name: 'AbortError' });
        await expect(scheduler.request({ key: 'c', priority: 'manual', generate })).resolves.toBe('ok');
        await replaced;
        scheduler.dispose();
    });
});
