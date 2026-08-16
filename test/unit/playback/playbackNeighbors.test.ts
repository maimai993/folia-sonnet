import { describe, it, expect } from 'vitest';
import { resolvePlaybackNeighbors } from '../../../src/utils/playbackNeighbors';
import type { SongResult } from '../../../src/types';

// test/unit/playback/playbackNeighbors.test.ts
// 这些用例锁定的是「浮动播放条箭头」与 usePlaybackQueueController 的下标规则保持一致，
// 任何一侧改了跳转规则，另一侧必须同步，否则箭头会显示成可点却跳不动（或反过来）。

const song = (id: string, name: string): SongResult => ({
    id,
    name,
    artists: [],
    album: {} as SongResult['album'],
    durationMs: 1000,
} as SongResult);

const queue = [song('a', 'Alpha'), song('b', 'Bravo'), song('c', 'Charlie')];

const resolve = (overrides: Partial<Parameters<typeof resolvePlaybackNeighbors>[0]> = {}) =>
    resolvePlaybackNeighbors({
        playQueue: queue,
        currentSong: queue[1],
        loopMode: 'off',
        isFmMode: false,
        isStageActive: false,
        ...overrides,
    });

describe('resolvePlaybackNeighbors', () => {
    it('returns both neighbours in the middle of the queue', () => {
        expect(resolve()).toEqual({
            prev: { canGo: true, title: 'Alpha' },
            next: { canGo: true, title: 'Charlie' },
        });
    });

    it('blocks prev at the head and next at the tail when loop is off', () => {
        expect(resolve({ currentSong: queue[0] }).prev).toEqual({ canGo: false, title: null });
        expect(resolve({ currentSong: queue[2] }).next).toEqual({ canGo: false, title: null });
    });

    it('wraps around both ends when loopMode is all', () => {
        expect(resolve({ currentSong: queue[0], loopMode: 'all' }).prev)
            .toEqual({ canGo: true, title: 'Charlie' });
        expect(resolve({ currentSong: queue[2], loopMode: 'all' }).next)
            .toEqual({ canGo: true, title: 'Alpha' });
    });

    it('does not wrap when loopMode is one — handleNextTrack leaves nextIndex at -1', () => {
        expect(resolve({ currentSong: queue[2], loopMode: 'one' }).next)
            .toEqual({ canGo: false, title: null });
    });

    it('marks next as reachable but unknown when FM will fetch past the tail', () => {
        expect(resolve({ currentSong: queue[2], isFmMode: true }).next)
            .toEqual({ canGo: true, title: null });
    });

    it('still knows the title one before the FM tail', () => {
        expect(resolve({ currentSong: queue[1], isFmMode: true }).next)
            .toEqual({ canGo: true, title: 'Charlie' });
    });

    it('blocks both directions while the stage is active', () => {
        const result = resolve({ isStageActive: true });
        expect(result.prev.canGo).toBe(false);
        expect(result.next.canGo).toBe(false);
    });

    it('blocks both directions without a current song or with an empty queue', () => {
        expect(resolve({ currentSong: null }).next.canGo).toBe(false);
        expect(resolve({ playQueue: [] }).next.canGo).toBe(false);
    });

    it('falls back to the queue head when the current song is not in the queue', () => {
        expect(resolve({ currentSong: song('zzz', 'Outsider') })).toEqual({
            prev: { canGo: false, title: null },
            next: { canGo: true, title: 'Alpha' },
        });
    });
});
