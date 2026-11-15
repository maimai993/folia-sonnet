import { afterEach, describe, expect, it, vi } from 'vitest';

// test/unit/hooks/nativeLyricsSubscriptionHandle.test.ts
// Pins how the native lyric subscription is torn down: Capacitor's addListener answers a
// **handle object** `{ remove }`, not a function. The cleanup used to call the handle itself,
// which threw a TypeError inside the effect cleanup and took the whole render down (black
// screen). Also pins the two things that decide whose lyrics land in the store: the song key
// the payload has to match, and an empty lrc clearing the previous song's lines instead of
// leaving them on screen.

const env = vi.hoisted(() => ({
    effect: null as null | (() => void | (() => void)),
    cleanup: null as null | (() => void),
    lyrics: [] as unknown[],
    subscribedNames: [] as string[],
    removed: 0,
    listener: null as null | ((payload: unknown) => void),
}));

vi.mock('react', () => ({
    useEffect: (fn: () => void | (() => void)) => {
        env.effect = fn;
    },
}));
vi.mock('@/platform/runtime', () => ({ isCapacitorAndroid: () => true }));
vi.mock('@/stores/usePlaybackStore', () => ({
    setLyricsState: (value: unknown) => {
        env.lyrics.push(value);
    },
}));

const { useNativeLyricsSubscription } = await import('@/hooks/useNativeLyricsSubscription');

type CapacitorWindow = { Capacitor?: { Plugins?: Record<string, unknown> } };

/** 单测跑在 node 里，没有 window：这个 hook 运行时会去读全局的 window，给一个就行。 */
const fakeWindow = (): CapacitorWindow => {
    const holder = globalThis as unknown as { window?: CapacitorWindow };
    holder.window ??= {};
    return holder.window;
};

const installPlugin = (addListener: unknown): void => {
    fakeWindow().Capacitor = { Plugins: { FoliaPlayback: { addListener } } };
};

/** 装一个记下回调的假插件，`subscribe` 是 async 的，所以要放几拍微任务。 */
const startSubscribed = async (songKey: string | null): Promise<void> => {
    installPlugin(async (name: string, callback: (payload: unknown) => void) => {
        env.subscribedNames.push(name);
        env.listener = callback;
        return { remove: () => { env.removed += 1; } };
    });
    useNativeLyricsSubscription(songKey);
    const cleanup = env.effect?.();
    env.cleanup = typeof cleanup === 'function' ? cleanup : null;
    await Promise.resolve();
    await Promise.resolve();
};

const flushMicrotasks = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
};

afterEach(() => {
    env.effect = null;
    env.lyrics = [];
    env.subscribedNames = [];
    env.removed = 0;
    env.listener = null;
    env.cleanup = null;
    delete fakeWindow().Capacitor;
});

describe('useNativeLyricsSubscription —— 原生歌词订阅的挂与拆', () => {
    it('拆订阅调的是句柄上的 remove，不是把句柄当函数调（黑屏那条）', async () => {
        await startSubscribed('online:netease:1');
        expect(env.subscribedNames).toEqual(['foliaPlaybackLyrics']);
        expect(() => env.cleanup?.()).not.toThrow();
        expect(env.removed).toBe(1);
    });

    it('订阅还没回来就卸载了，回来后立刻自拆，不留悬挂监听', async () => {
        const gate: { release: (() => void) | null } = { release: null };
        installPlugin(async () => {
            await new Promise<void>((resolve) => { gate.release = resolve; });
            return { remove: () => { env.removed += 1; } };
        });
        useNativeLyricsSubscription('online:netease:1');
        const cleanup = env.effect?.();
        cleanup?.(); // 卸载早于 addListener 的 resolve
        gate.release?.();
        await flushMicrotasks();
        expect(env.removed).toBe(1);
    });

    it('只把当前这首的歌词写进 store', async () => {
        await startSubscribed('online:netease:1');
        env.listener?.({ songKey: 'online:netease:2', lrc: '[00:01.00]别人的词' });
        expect(env.lyrics).toHaveLength(0);
        env.listener?.({ songKey: 'online:netease:1', lrc: '[00:01.00]自己的词' });
        expect(env.lyrics).toHaveLength(1);
        expect((env.lyrics[0] as { lines: { fullText: string }[] }).lines[0].fullText).toBe('自己的词');
    });

    it('原生说这首没歌词，就清掉上一首的，不把别人的词挂在界面上', async () => {
        await startSubscribed('online:netease:1');
        env.listener?.({ songKey: 'online:netease:1', lrc: '' });
        expect(env.lyrics).toEqual([null]);
    });

    it('卸载之后推来的结果一概不写 store', async () => {
        await startSubscribed('online:netease:1');
        const listener = env.listener;
        env.cleanup?.();
        listener?.({ songKey: 'online:netease:1', lrc: '[00:01.00]迟到的词' });
        expect(env.lyrics).toHaveLength(0);
    });

    it('先订阅再取快照，补回新订阅之前已经拉到的当前歌词', async () => {
        const order: string[] = [];
        fakeWindow().Capacitor = { Plugins: { FoliaPlayback: {
            addListener: async (_name: string, cb: (payload: unknown) => void) => {
                order.push('subscribe'); env.listener = cb; return { remove: () => undefined };
            },
            getQueueState: async () => {
                order.push('snapshot');
                return { songKey: 'B', lyrics: { songKey: 'B', lrc: '[00:01]第二首' } };
            },
        } } };
        useNativeLyricsSubscription('B');
        env.effect?.();
        await flushMicrotasks();
        expect(order).toEqual(['subscribe', 'snapshot']);
        expect((env.lyrics[0] as { lines: { fullText: string }[] }).lines[0].fullText).toBe('第二首');
    });

    it('快照晚于实时歌词返回时，不把新歌词覆盖回旧快照', async () => {
        let resolve!: (value: unknown) => void;
        fakeWindow().Capacitor = { Plugins: { FoliaPlayback: {
            addListener: async (_name: string, cb: (payload: unknown) => void) => {
                env.listener = cb; return { remove: () => undefined };
            },
            getQueueState: () => new Promise(r => { resolve = r; }),
        } } };
        useNativeLyricsSubscription('B'); env.effect?.(); await flushMicrotasks();
        env.listener?.({ songKey: 'B', lrc: '[00:01]实时歌词' });
        resolve({ songKey: 'B', lyrics: { songKey: 'B', lrc: '' } });
        await flushMicrotasks();
        expect(env.lyrics).toHaveLength(1);
        expect(env.lyrics[0]).not.toBeNull();
    });

    it('插件上没有 addListener 时安静退出，不抛错', async () => {
        installPlugin(undefined);
        useNativeLyricsSubscription('online:netease:1');
        expect(() => env.effect?.()).not.toThrow();
        await flushMicrotasks();
        expect(env.lyrics).toHaveLength(0);
    });
});
