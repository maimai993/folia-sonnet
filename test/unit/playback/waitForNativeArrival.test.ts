import { describe, expect, it, vi } from 'vitest';
import {
    nativeEngineHasArrived,
    waitForNativeArrival,
} from '@/components/app/playback/start/waitForNativeArrival';

// test/unit/playback/waitForNativeArrival.test.ts
// Pins the signal that keeps 「点歌后界面是这首、声音是上一首」 from coming back:
// `playFromQueue` answering ok only means the native side took the order, the address is
// installed later. Only the **engine's own** media identity counts — the service's cached
// songKey moves whenever the Web pushes metadata, so it can't be the judge (that false
// positive was reproduced on a real device). A timeout, a newer play, or a bridge that
// throws all mean "not taken", so the caller falls back to the Web flow.

const neverCalled = () => {
    throw new Error('readEngine should not be called');
};

const engine = (songKey: string, durationMs = 0, positionMs = 0) => ({ songKey, durationMs, positionMs });

describe('nativeEngineHasArrived —— 引擎真的装着这首歌', () => {
    it('身份对得上、时长已知 → 到了', () => {
        expect(nativeEngineHasArrived(engine('online:netease:1', 162461), 'online:netease:1')).toBe(true);
    });

    it('身份对得上、只有位置在走（无时长的流） → 也算到了', () => {
        expect(nativeEngineHasArrived(engine('online:netease:1', 0, 1200), 'online:netease:1')).toBe(true);
    });

    it('身份换了但媒体还没装载（时长、位置都是 0）→ 还不算', () => {
        expect(nativeEngineHasArrived(engine('online:netease:1', 0, 0), 'online:netease:1')).toBe(false);
    });

    it('引擎装的还是别的歌 → 不算，哪怕界面已经认领了新歌', () => {
        expect(nativeEngineHasArrived(engine('online:netease:0', 111000, 4000), 'online:netease:1')).toBe(false);
    });

    it('空快照 / 没有 songKey → 不算', () => {
        expect(nativeEngineHasArrived(null, 'online:netease:1')).toBe(false);
        expect(nativeEngineHasArrived(undefined, 'online:netease:1')).toBe(false);
        expect(nativeEngineHasArrived({}, 'online:netease:1')).toBe(false);
        expect(nativeEngineHasArrived(engine('', 120000), 'online:netease:1')).toBe(false);
    });
});

describe('waitForNativeArrival —— 等原生真正装上这首歌', () => {
    it('引擎第一次就报着这首歌，立刻认这一单，不再等', async () => {
        const sleep = vi.fn(async () => undefined);
        const arrived = await waitForNativeArrival({
            readEngine: async () => engine('online:netease:1', 162461),
            expectsKey: 'online:netease:1',
            sleep,
        });
        expect(arrived).toBe(true);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('受理后地址还要几拍才回来，等到的那一拍返回 true', async () => {
        const snapshots = [
            engine('online:netease:0', 111000, 3000),
            engine('online:netease:0', 111000, 3250),
            engine('online:netease:1', 162461, 0),
        ];
        let index = 0;
        const arrived = await waitForNativeArrival({
            readEngine: async () => snapshots[Math.min(index++, snapshots.length - 1)],
            expectsKey: 'online:netease:1',
            sleep: async () => undefined,
        });
        expect(arrived).toBe(true);
        expect(index).toBe(3);
    });

    it('身份换了但一直没装载（时长位置全是 0）→ 超时不认，交给 Web 流程', async () => {
        let clock = 0;
        const readEngine = vi.fn(async () => engine('online:netease:1', 0, 0));
        const arrived = await waitForNativeArrival({
            readEngine,
            expectsKey: 'online:netease:1',
            timeoutMs: 1000,
            intervalMs: 250,
            now: () => clock,
            sleep: async (ms) => { clock += ms; },
        });
        expect(arrived).toBe(false);
        expect(readEngine).toHaveBeenCalledTimes(4);
    });

    it('引擎一直在放上一首 → 超时返回 false', async () => {
        let clock = 0;
        const readEngine = vi.fn(async () => engine('online:netease:0', 111000, 9000));
        const arrived = await waitForNativeArrival({
            readEngine,
            expectsKey: 'online:netease:1',
            timeoutMs: 1000,
            intervalMs: 250,
            now: () => clock,
            sleep: async (ms) => { clock += ms; },
        });
        expect(arrived).toBe(false);
        expect(readEngine).toHaveBeenCalledTimes(4);
    });

    it('用户中途点了别的歌（stillWanted 变 false）就不再空等，也不再读快照', async () => {
        let wanted = true;
        let reads = 0;
        const arrived = await waitForNativeArrival({
            readEngine: async () => {
                reads += 1;
                wanted = false; // 读完这一拍之后被顶掉
                return engine('online:netease:0', 111000, 1000);
            },
            expectsKey: 'online:netease:1',
            stillWanted: () => wanted,
            sleep: async () => undefined,
        });
        expect(arrived).toBe(false);
        expect(reads).toBe(1);
    });

    it('一上来就已经被顶掉，连快照都不读', async () => {
        const arrived = await waitForNativeArrival({
            readEngine: neverCalled,
            expectsKey: 'online:netease:1',
            stillWanted: () => false,
        });
        expect(arrived).toBe(false);
    });

    it('桥不可用（读快照抛错）当作没到，立刻返回 false 交给 Web 流程', async () => {
        const arrived = await waitForNativeArrival({
            readEngine: async () => {
                throw new Error('plugin not available');
            },
            expectsKey: 'online:netease:1',
            sleep: async () => undefined,
        });
        expect(arrived).toBe(false);
    });

    it('快照是 null / 没有 songKey 都不算到达', async () => {
        const snapshots: Array<ReturnType<typeof engine> | null> = [null, engine(''), null];
        let index = 0;
        let clock = 0;
        const arrived = await waitForNativeArrival({
            readEngine: async () => snapshots[Math.min(index++, snapshots.length - 1)],
            expectsKey: 'online:netease:1',
            timeoutMs: 600,
            intervalMs: 250,
            now: () => clock,
            sleep: async (ms) => { clock += ms; },
        });
        expect(arrived).toBe(false);
    });
});
