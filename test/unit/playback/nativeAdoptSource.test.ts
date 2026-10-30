import { describe, expect, it } from 'vitest';

// test/unit/playback/nativeAdoptSource.test.ts
// 认领原生播放器（issue #106）的判据：原生手里已经是这首歌时，Web 侧只对齐账本、
// 不重新装源。装源 effect 靠「地址相同就跳过」避免把原生正在放的歌从头再放。

type FakeState = {
    hasSource: boolean;
    currentUrl: string | null;
    positionMs: number;
    durationMs: number;
    playing: boolean;
    prepareCalls: number;
};

/**
 * 与 useNativePlaybackRuntime 装源 effect 的判定一致：地址相等就跳过 setSource。
 * 返回 'skip' 表示不装源，'prepare' 表示需要装。
 */
export const decideSourceInstall = (
    state: { hasSource: boolean; currentUrl: string | null },
    audioSrc: string | null,
): 'skip' | 'prepare' | 'idle' => {
    if (!audioSrc) return 'idle';
    if (state.hasSource && state.currentUrl === audioSrc) return 'skip';
    return 'prepare';
};

const adopt = (target: FakeState, url: string, incoming: { positionMs: number; durationMs: number; playing: boolean }) => {
    // 与 nativePlaybackEngine.adoptSource 同语义：只记账，不 prepare。
    target.hasSource = true;
    target.currentUrl = url;
    target.positionMs = Math.max(0, incoming.positionMs);
    target.durationMs = Math.max(0, incoming.durationMs);
    target.playing = incoming.playing;
};

describe('认领原生播放器', () => {
    it('认领后装源 effect 跳过：不把原生正在放的歌从头再放', () => {
        const engine: FakeState = {
            hasSource: false, currentUrl: null, positionMs: 0, durationMs: 0, playing: false, prepareCalls: 0,
        };
        const url = 'https://example.com/song.flac';
        expect(decideSourceInstall(engine, url)).toBe('prepare');

        adopt(engine, url, { positionMs: 61_000, durationMs: 200_000, playing: true });

        expect(decideSourceInstall(engine, url)).toBe('skip');
        expect(engine.prepareCalls).toBe(0);
        expect(engine.positionMs).toBe(61_000);
        expect(engine.playing).toBe(true);
    });

    it('换到另一首：仍然要装源', () => {
        const engine: FakeState = {
            hasSource: true, currentUrl: 'https://example.com/a.flac', positionMs: 1_000, durationMs: 1, playing: true, prepareCalls: 0,
        };
        expect(decideSourceInstall(engine, 'https://example.com/b.flac')).toBe('prepare');
    });

    it('没有地址：什么都不做', () => {
        const engine: FakeState = {
            hasSource: true, currentUrl: 'https://example.com/a.flac', positionMs: 0, durationMs: 0, playing: false, prepareCalls: 0,
        };
        expect(decideSourceInstall(engine, null)).toBe('idle');
    });

    it('认领保留原生暂停状态：暂停的歌不该记成在播', () => {
        const engine: FakeState = {
            hasSource: false, currentUrl: null, positionMs: 0, durationMs: 0, playing: false, prepareCalls: 0,
        };
        adopt(engine, 'https://example.com/song.flac', { positionMs: 12_000, durationMs: 200_000, playing: false });
        expect(engine.playing).toBe(false);
        expect(engine.positionMs).toBe(12_000);
    });
});
