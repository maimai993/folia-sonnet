// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';
import { PlayerState } from '@/types';

// test/unit/services/lyricDirector/prefetchNextSong.test.ts
const { requestStage, messages, getLyrics } = vi.hoisted(() => ({
    requestStage: vi.fn(), messages: vi.fn(), getLyrics: vi.fn(),
}));
vi.mock('@/services/aiStage', () => ({ requestStage, setProtectedStageKeys: vi.fn() }));
vi.mock('@/i18n/config', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/stores/useStatusMessageStore', () => ({ setStatusMessage: messages }));
vi.mock('@/services/onlineMusic/omni', () => ({ omni: { getLyrics } }));
vi.mock('@/services/prefetchService', () => ({ getPrefetchedData: () => null }));
const song = (id: string) => ({ id, name: id, artists: [{ name: 'artist' }], sourceRef: { kind: 'online', providerId: 'netease', mediaId: id } }) as SongResult;
const lyrics = (text: string) => ({ lines: [{ fullText: text, words: [], time: 0 }] }) as never;
const result = { decision: { mode: 'classic', reason: 'ok', params: {} }, source: 'ai' };
let dispose: (() => void) | undefined;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); localStorage.clear();
    requestStage.mockResolvedValue(result);
    getLyrics.mockResolvedValue({ lyrics: lyrics('next') });
});
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); });
async function setup() {
    const director = await import('@/services/lyricDirector/director');
    const { usePlaybackStore: store } = await import('@/stores/usePlaybackStore');
    const { useAudioSettingsStore: audio } = await import('@/stores/useAudioSettingsStore');
    const coordinator = await import('@/services/stagePlaybackCoordinator');
    const { currentTime } = await import('@/stores/motionSignals');
    const queue = Array.from({ length: 13 }, (_, i) => song(String(i)));
    store.setState({ currentSong: queue[0], playQueue: queue, lyrics: lyrics('first'), duration: 200, playerState: PlayerState.PLAYING, transitionDisplay: null });
    audio.setState({ loopMode: 'off' }); currentTime.set(0);
    return { director, store, audio, coordinator, currentTime, queue };
}
describe('stage playback scheduling', () => {
    it('does not generate the next song from director finally or claim an upload', async () => {
        const { director } = await setup();
        await director.runLyricDirectorDecision(); await flush();
        expect(requestStage).toHaveBeenCalledTimes(1);
        expect(messages).not.toHaveBeenCalled();
    }, 15_000);
    it('fetches ten caches without lyrics or generation, then generates only the immediate next at 45s', async () => {
        const { coordinator, currentTime } = await setup();
        requestStage.mockImplementation(async (input) => {
            if (input.cacheOnly) throw Object.assign(new Error('miss'), { name: 'StageCacheMissError' });
            return result;
        });
        dispose = coordinator.startStagePlaybackCoordinator(); await flush();
        expect(requestStage).toHaveBeenCalledTimes(10);
        expect(requestStage.mock.calls.every(([input]) => input.cacheOnly === true)).toBe(true);
        expect(getLyrics).not.toHaveBeenCalled();
        currentTime.set(155); await flush();
        const generated = requestStage.mock.calls.filter(([input]) => !input.cacheOnly);
        expect(generated).toHaveLength(1);
        expect(generated[0][0].song.title).toBe('1');
        currentTime.set(180); await flush();
        expect(requestStage.mock.calls.filter(([input]) => !input.cacheOnly)).toHaveLength(1);
    });
    it('uses the playback crossfade plan rather than the file end for the lead window', async () => {
        const { coordinator, currentTime, store, queue } = await setup();
        const { useAutomixSettingsStore } = await import('@/stores/useAutomixSettingsStore');
        store.setState({ playQueue: [queue[0], { ...queue[1], durationMs: 200000 }] });
        useAutomixSettingsStore.setState({ automixEnabled: true, transitionMode: 'crossfade', crossfadeMaxSec: 10 });
        requestStage.mockImplementation(async (input) => {
            if (input.cacheOnly) throw Object.assign(new Error('miss'), { name: 'StageCacheMissError' });
            return result;
        });
        dispose = coordinator.startStagePlaybackCoordinator(); await flush();
        currentTime.set(150); await flush();
        expect(requestStage.mock.calls.filter(([input]) => !input.cacheOnly)).toHaveLength(1);
        useAutomixSettingsStore.setState({ automixEnabled: false });
    });

    it('does not generate a next song already in cache', async () => {
        const { coordinator, currentTime } = await setup();
        dispose = coordinator.startStagePlaybackCoordinator(); await flush();
        currentTime.set(160); await flush();
        expect(requestStage.mock.calls.every(([input]) => input.cacheOnly)).toBe(true);
        expect(getLyrics).not.toHaveBeenCalled();
    });
    it('uses committed shuffle order and stops at an unknown reshuffle; one/all do not repeat tracks', async () => {
        const { coordinator, store, queue } = await setup();
        store.setState({ playQueue: [queue[0], queue[4], queue[2]] });
        expect(coordinator.upcomingStageSongs(store.getState(), 'shuffle').map(s => s.id)).toEqual(['4', '2']);
        store.setState({ currentSong: queue[2] });
        expect(coordinator.upcomingStageSongs(store.getState(), 'shuffle')).toEqual([]);
        expect(coordinator.upcomingStageSongs(store.getState(), 'one')).toEqual([]);
        expect(coordinator.upcomingStageSongs(store.getState(), 'all').map(s => s.id)).toEqual(['0', '4']);
    });
    it('revokes the old window and its generation after queue changes and cleanup', async () => {
        const { coordinator, store, queue } = await setup();
        requestStage.mockImplementation(() => new Promise(() => {}));
        dispose = coordinator.startStagePlaybackCoordinator();
        const old = requestStage.mock.calls[0][0];
        store.setState({ playQueue: [queue[0], queue[5]] });
        expect(old.signal.aborted).toBe(true); expect(old.isCurrent()).toBe(false);
        const latest = requestStage.mock.calls.at(-1)![0]; dispose(); dispose = undefined;
        expect(latest.signal.aborted).toBe(true);
    });
    it('accepted update revokes a pending director result; invalid update has no application right', async () => {
        const { director, store } = await setup();
        const { normalizeStageIdentity } = await import('@/services/stageCache/identity');
        const identityKey = normalizeStageIdentity({ title: '0', artists: ['artist'] })!.key;
        let resolve!: (value: typeof result) => void;
        requestStage.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
        const pending = director.runLyricDirectorDecision();
        const input = requestStage.mock.calls[0][0];
        director.applyCurrentStageUpdate({ identityKey, payload: result, isCurrent: () => false });
        expect(input.isCurrent()).toBe(true);
        director.applyCurrentStageUpdate({ identityKey, payload: result });
        expect(input.isCurrent()).toBe(false);
        resolve(result); expect((await pending).kind).toBe('stale');
        expect(store.getState().currentSong?.name).toBe('0');
    });

    it('A-B-A and lyric replacement revoke a late director apply, cancellation stays silent', async () => {
        vi.useFakeTimers();
        const { director, store, queue } = await setup();
        let resolve!: (value: typeof result) => void;
        requestStage.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
        const pending = director.runLyricDirectorDecision();
        store.setState({ currentSong: queue[1] }); director.notifyLyricDirectorSongChanged();
        store.setState({ currentSong: queue[0] }); director.notifyLyricDirectorSongChanged();
        resolve(result); expect((await pending).kind).toBe('stale');
        requestStage.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
        const lyricPending = director.runLyricDirectorDecision();
        store.setState({ lyrics: lyrics('changed') }); director.notifyLyricDirectorLyricsLoaded();
        resolve(result); expect((await lyricPending).kind).toBe('stale');
        requestStage.mockRejectedValueOnce(Object.assign(new Error('cancel'), { name: 'AbortError' }));
        expect((await director.runLyricDirectorDecision()).kind).toBe('stale');
        expect(messages).not.toHaveBeenCalled(); director.abortLyricDirectorRequests();
    });
});
