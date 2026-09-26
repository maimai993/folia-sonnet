import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceLoopPressStreak, type LoopPressStreak } from '@/services/ponder/loopShuffleHint';

// test/unit/ponder/loopShuffleHint.test.ts
// 连点循环按钮三下弹「想找随机播放吗」，间隔太长不算连点，整个生命周期最多弹两次。

const fresh: LoopPressStreak = { count: 0, lastAt: -Infinity };

const pressAt = (times: number[]) => {
    let streak = fresh;
    return times.map(now => {
        const next = advanceLoopPressStreak(streak, now);
        streak = next.streak;
        return next.triggered;
    });
};

describe('advanceLoopPressStreak', () => {
    it('连点第三下触发，之后从头数', () => {
        expect(pressAt([0, 300, 600, 900, 1200, 1500])).toEqual([false, false, true, false, false, true]);
    });

    it('两下之间隔太久就重新数', () => {
        expect(pressAt([0, 300, 2500, 2800, 3100])).toEqual([false, false, false, false, true]);
    });
});

describe('noteLoopButtonPress', () => {
    let storage: Map<string, string>;

    beforeEach(() => {
        vi.resetModules();
        storage = new Map();
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => { storage.set(key, value); },
            removeItem: (key: string) => { storage.delete(key); },
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const load = async () => {
        const hint = await import('@/services/ponder/loopShuffleHint');
        const { useStatusMessageStore } = await import('@/stores/useStatusMessageStore');
        const { usePonderStore } = await import('@/stores/usePonderStore');
        return { hint, useStatusMessageStore, usePonderStore };
    };

    const burst = (press: (now: number) => void, start: number) => {
        press(start);
        press(start + 200);
        press(start + 400);
    };

    it('最多弹两次，且跨会话累计', async () => {
        const { hint, useStatusMessageStore } = await load();
        burst(hint.noteLoopButtonPress, 0);
        expect(useStatusMessageStore.getState().message?.actionLabel).toBeTruthy();

        useStatusMessageStore.getState().setMessage(null);
        burst(hint.noteLoopButtonPress, 10_000);
        expect(useStatusMessageStore.getState().message).not.toBeNull();

        useStatusMessageStore.getState().setMessage(null);
        burst(hint.noteLoopButtonPress, 20_000);
        expect(useStatusMessageStore.getState().message).toBeNull();
        expect(storage.get('folia_loop_shuffle_hint_count')).toBe('2');

        vi.resetModules();
        const reloaded = await load();
        burst(reloaded.hint.noteLoopButtonPress, 0);
        expect(reloaded.useStatusMessageStore.getState().message).toBeNull();
    });

    it('点提示进入 queue-shuffle 思索', async () => {
        const { hint, useStatusMessageStore, usePonderStore } = await load();
        burst(hint.noteLoopButtonPress, 0);
        useStatusMessageStore.getState().message?.onAction?.();
        expect(usePonderStore.getState().session?.targetId).toBe('queue-shuffle');
        expect(useStatusMessageStore.getState().message).toBeNull();
    });

    it('关掉思索提示时不弹', async () => {
        const { hint, useStatusMessageStore, usePonderStore } = await load();
        usePonderStore.setState({ ponderHintVisibility: 'off' });
        burst(hint.noteLoopButtonPress, 0);
        expect(useStatusMessageStore.getState().message).toBeNull();
        expect(storage.has('folia_loop_shuffle_hint_count')).toBe(false);
    });
});
