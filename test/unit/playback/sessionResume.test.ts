import type * as React from 'react';
import type * as Zustand from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';
import { getPlaybackSongKey } from '@/utils/appPlaybackGuards';
import { cancelSessionResume, createResumeTimeRef, usePendingResumeStore } from '@/stores/usePendingResumeStore';
import { nativePlaybackEngine as engine } from '@/services/playbackEngine/nativePlaybackEngine';
import { useNativePlaybackRuntime } from '@/services/playbackEngine/useNativePlaybackRuntime';
import { useSessionRestoreController } from '@/components/app/playback/restore/useSessionRestoreController';
import { adoptNativePlaybackState } from '@/components/app/playback/restore/adoptNativePlaybackState';
import type { NativeQueueState } from '@/services/nativeQueueBridge';
import { makeSongCurrent, startPlay } from '@/components/app/playback/currentSong';
import { usePlaybackQueueController } from '@/components/app/playback/start/usePlaybackQueueController';
import { setAudioSrc, usePlaybackStore } from '@/stores/usePlaybackStore';
import { setNativePlaybackReconciling } from '@/services/playbackEngine/nativePlaybackSync';
import { usePlaybackSessionSnapshot } from '@/components/app/playback/usePlaybackSessionSnapshot';
import { armMirrorQueueClaims } from '@/components/app/playback/restore/mirrorQueueClaim';
import { noteWholeQueueWrite } from '@/services/wholeQueueWrites';
import { noteQueueStart } from '@/components/app/playback/start/queueStarts';

// 跑真实会话恢复、装源 effect 与 FIFO 命令链；在缓存/音源解析和原生桥边界控制异步顺序。
const h = vi.hoisted(() => ({
    effects: [] as Array<() => unknown>, cache: new Map<string, unknown>(),
    skip: vi.fn(), localAudio: vi.fn(), audio: vi.fn(), native: vi.fn(), position: vi.fn(),
    prepare: vi.fn(), seek: vi.fn(), setVolume: vi.fn(), catalog: vi.fn(), persist: vi.fn(), canPlay: vi.fn(), play: vi.fn(),
    save: vi.fn(), queueRead: { current: null as null | (() => Promise<unknown>) },
}));
vi.mock('react', async original => ({ ...await original<typeof React>(),
    useEffect: (effect: () => unknown) => { h.effects.push(effect); },
    useMemo: (fn: () => unknown) => fn(), useState: (v: unknown) => [v, vi.fn()],
    useRef: (current: unknown) => ({ current }),
    useCallback: (fn: unknown) => fn, useDebugValue: () => {},
    useSyncExternalStore: (_sub: unknown, get: () => unknown) => get(),
}));
vi.mock('zustand', async original => {
    const { createStore } = await import('zustand/vanilla');
    const build = (initializer: never) => {
        const api = createStore(initializer);
        return Object.assign((select: (state: unknown) => unknown) => select(api.getState()), api);
    };
    return { ...await original<typeof Zustand>(), create: (initializer?: never) => initializer ? build(initializer) : build };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useCapacitorPlaybackBridge', () => ({ FoliaPlayback: { requestSkip: h.skip } }));
vi.mock('@/services/localLibraryEntityRepository', () => ({ getLocalLibraryCatalogSnapshot: h.catalog }));
vi.mock('@/utils/lyrics/localSongLyrics', () => ({ resolveLocalSongLyrics: async () => ({ lyrics: null }) }));
vi.mock('@/services/db', () => ({ getLocalSongs: () => [localRecord], getFromCache: (key: string) => key === 'last_queue' && h.queueRead.current ? h.queueRead.current() : h.cache.get(key), saveToCache: h.save, removeFromCache: vi.fn() }));
vi.mock('@/components/app/playback/playbackPositionCache', () => ({ readPlaybackPositionForSong: (target: SongResult) => h.position(target),
    getPositionWriteProbe: () => null, savePlaybackPosition: vi.fn(async () => {}) }));
vi.mock('@/services/nativeQueueBridge', () => ({ readNativeQueueState: h.native }));
vi.mock('@/services/prefetchService', () => ({ prefetchNearbySongs: vi.fn() }));
vi.mock('@/services/playbackEngine/nativePlayerPlugin', () => ({ isNativePlayerAvailable: () => true,
    nativePlayer: { prepare: h.prepare, seek: h.seek, setVolume: h.setVolume, play: h.play, stop: vi.fn(), addListener: async () => () => {} },
}));
vi.mock('@/components/app/playback/source/songAudioSource', () => ({ loadOnlineSongAudio: h.audio, loadLocalSongAudio: h.localAudio }));
vi.mock('@/services/onlineMusic/resourceCache', () => ({ getCachedSongCoverUrl: async () => null, getSongCacheWithLegacyMigration: async () => null }));
vi.mock('@/utils/onlineLyricsState', () => ({ loadOnlineLyricsState: async () => null, resolveOnlineLyrics: () => null }));
vi.mock('@/services/onlinePlayback', () => ({ applyOnlineAudioSourceMetadata: (song: SongResult) => song }));
vi.mock('@/services/onlineMusic/omni', () => ({ omni: { canPlaySong: h.canPlay, canPlayExternally: () => false, getLyrics: async () => ({ lyrics: null }) } }));
vi.mock('@/services/hifi/hifiPlayback', () => ({ releaseUnclaimedHifiTrack: vi.fn(), hifiRouteFor: () => 'web' }));
vi.mock('@/i18n/config', () => ({ default: { t: (key: string) => key, on: () => {}, language: 'en' } }));

const song: SongResult = { id: 'a', name: 'A', durationMs: 120000, artists: [], album: { id: '', name: '' }, sourceRef: { kind: 'online', providerId: 'bodian', mediaId: 'a' } };
const localRecord = { id: 'local-a', fileName: 'A.mp3', filePath: 'Music/A.mp3', title: 'A', titleOrigin: 'import',
    importedMetadata: { title: 'A', titleSource: 'filename', artistNames: [] }, duration: 120000, fileSize: 1,
    fileLastModified: 1, mimeType: 'audio/mpeg', addedAt: 1, folderName: 'Music' };
const songKey = getPlaybackSongKey(song);
const url = 'https://audio.test/shared';
const ref = createResumeTimeRef();
const onError = vi.fn();
const resolved = (address: string) => ({ kind: 'ok', audioSrc: address, fetchedAt: 0 });
const flush = async () => { for (let n = 0; n < 64; n++) await Promise.resolve(); };
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
function useRestoreHarness() {
    useSessionRestoreController({ blobUrlRef: { current: null }, currentOnlineAudioUrlFetchedAtRef: { current: null },
        setLyrics: vi.fn(), restoreCachedThemeForSong: vi.fn(), persistLastPlaybackCache: h.persist, clearPersistedStagePlaybackCache: vi.fn(),
        loadLocalSongs: vi.fn(), loadLocalPlaylists: vi.fn(), shouldAutoPlayRef: { current: false }, pendingResumeTimeRef: ref });
}
// 模拟渲染：用替换后的 React 捕获 effect，测试再控制它们的提交顺序。
function captureEffects<Args extends unknown[]>(renderHook: (...args: Args) => void, ...args: Args) {
    h.effects.length = 0;
    renderHook(...args);
    return [...h.effects];
}
function restore() {
    captureEffects(useRestoreHarness).forEach(effect => effect());
}
function useNativeSourceHarness(address: string) {
    useNativePlaybackRuntime({ enabled: true, audioSrc: address, shouldAutoPlayRef: { current: false }, pendingResumeTimeRef: ref,
        isLyricsLoading: false, getTargetPlaybackVolume: () => 1, repeatOne: false, onEnded: vi.fn(), onError });
}
function renderSource(address = url) {
    captureEffects(useNativeSourceHarness, address)[0]();
}
beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); setNativePlaybackReconciling(false); h.queueRead.current = null; armMirrorQueueClaims();
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn(), visibilityState: 'visible' });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    h.catalog.mockResolvedValue({ entities: [], assignments: [] }); h.canPlay.mockReturnValue(true);
    makeSongCurrent(null); setAudioSrc(null); cancelSessionResume(); ref.current = null;
    h.cache.set('last_song', song); h.cache.set('last_queue', [song]);
    h.native.mockResolvedValue(null); h.position.mockResolvedValue({ positionSec: 47, durationSec: 120, savedAt: 1000 });
    h.audio.mockResolvedValue(resolved(url)); h.prepare.mockResolvedValue({ ok: true }); h.seek.mockResolvedValue({ ok: true });
    h.play.mockResolvedValue({ ok: true });
});
afterEach(async () => { await engine.stop(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('#410 会话位置的一次性交接', () => {
    it.each(['before', 'during', 'after'])('位置在 prepare %s 到达：同源只装一次、只 seek 一次', async phase => {
        const gate = deferred<{ ok: boolean }>();
        if (phase !== 'before') {
            if (phase === 'during') h.prepare.mockReturnValueOnce(gate.promise);
            const preparing = engine.setSource(url, { songKey });
            if (phase === 'after') await preparing;
        }
        restore(); await flush();
        expect(ref.current).toBeNull();
        renderSource(); renderSource(); await flush();
        if (phase === 'during') expect(h.seek).not.toHaveBeenCalled();
        gate.resolve({ ok: true }); await flush(); renderSource(); await flush();
        expect(h.prepare).toHaveBeenCalledTimes(1);
        expect(h.prepare).toHaveBeenCalledWith(expect.objectContaining({ songKey, startPositionMs: null }));
        expect(h.seek.mock.calls.map(([ms]) => ms)).toEqual([47000]);
    });
    it('同一 URL 的不同歌曲不是同一源', async () => {
        await engine.setSource(url, { songKey: 'other' });
        restore(); await flush(); renderSource(); await flush();
        expect(h.prepare.mock.calls.map(([opts]) => opts.songKey)).toEqual(['other', songKey]);
        expect(h.seek.mock.calls.map(([ms]) => ms)).toEqual([47000]);
    });
    it('音源发布后同曲刷新 URL，丢弃旧位置而不阻塞新地址装源', async () => {
        restore(); await flush(); const fresh = `${url}?fresh`; setAudioSrc(fresh);
        renderSource(url); renderSource(fresh); await flush();
        expect(h.prepare).toHaveBeenCalledWith(expect.objectContaining({ url: fresh, startPositionMs: null }));
        expect(h.seek).not.toHaveBeenCalled();
    });
    it('晚到的位置不会自动重试已经失败的同一源', async () => {
        h.prepare.mockRejectedValueOnce(new Error('offline'));
        await expect(engine.setSource(url, { songKey })).rejects.toThrow('offline');
        restore(); await flush(); renderSource(); await flush();
        expect(h.prepare).toHaveBeenCalledTimes(1); expect(h.seek).not.toHaveBeenCalled();
    });
    it.each(['rejected', 'stale'])('prepare %s 后不得向前一首 seek', async failure => {
        const gate = deferred<{ stale: boolean }>(); h.prepare.mockReturnValueOnce(gate.promise);
        restore(); await flush(); renderSource(); await flush();
        if (failure === 'stale') gate.resolve({ stale: true }); else gate.reject(new Error('prepare failed'));
        await flush(); expect(h.seek).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledTimes(failure === 'stale' ? 0 : 1);
    });
    it.each(['skip', 'same song', 'manual seek', 'ABA'])('等待 prepare 期间遇到新意图 %s，不发过期 seek', async action => {
        const gate = deferred<{ ok: boolean }>(); h.prepare.mockReturnValueOnce(gate.promise);
        restore(); await flush(); renderSource(); await flush();
        if (action === 'skip') cancelSessionResume();
        if (action === 'same song') startPlay();
        if (action === 'manual seek') void engine.seek(9);
        if (action === 'ABA') { void engine.setSource(url, { songKey: 'B' }); void engine.setSource(url, { songKey }); }
        gate.resolve({ ok: true }); await flush();
        expect(h.seek.mock.calls).toEqual(action === 'manual seek' ? [[9000]] : []);
    });
    it('取音源失败后手动重播同一首从头开始', async () => {
        h.audio.mockRejectedValueOnce(new Error('source failed')); restore(); await flush();
        expect(usePendingResumeStore.getState().pending).toBeNull(); expect(ref.current).toBeNull();
        startPlay(); makeSongCurrent(song); setAudioSrc(url); renderSource(); await flush();
        expect(h.prepare).toHaveBeenCalledWith(expect.objectContaining({ startPositionMs: null })); expect(h.seek).not.toHaveBeenCalled();
    });
    it.each(['next', 'prev'])('原生 %s 受理且单曲队列回绕时，原地重播也不带上次位置', async direction => {
        const gate = deferred<{ ok: boolean }>(); h.prepare.mockReturnValueOnce(gate.promise);
        restore(); await flush(); renderSource(); await flush();
        h.skip.mockResolvedValue({ skipped: true });
        const queue = usePlaybackQueueController({ nativePlaybackRef: { current: true }, pendingResumeTimeRef: ref,
            audioRef: { current: null }, mainPlaybackSnapshotRef: { current: null }, navigateToPlaybackView: vi.fn(),
        } as never);
        if (direction === 'next') await queue.handleNextTrack(); else await queue.handlePrevTrack();
        expect(h.skip).toHaveBeenCalledWith({ direction: direction === 'next' ? 1 : -1 });
        gate.resolve({ ok: true }); await flush(); expect(h.seek).not.toHaveBeenCalled();
    });
    it('blob 音源只在着陆时把位置交给 HTML，不产生原生 seek', async () => {
        const localSong = { ...song, id: localRecord.id, isLocal: true, localRef: { songId: localRecord.id },
            sourceRef: { kind: 'local', mediaId: localRecord.id } };
        h.cache.set('last_song', localSong); h.cache.set('last_queue', [localSong]);
        const loading = deferred<{ localSong: typeof localRecord; blobUrl: string }>(); h.localAudio.mockReturnValueOnce(loading.promise);
        restore(); await flush(); expect(ref.current).toBeNull();
        loading.resolve({ localSong: localRecord, blobUrl: 'blob:local-copy' }); await flush(); renderSource('blob:local-copy');
        expect(ref.current).toBe(47); expect(usePendingResumeStore.getState().pending).toBeNull(); expect(h.prepare).not.toHaveBeenCalled();
        startPlay(); expect(ref.current).toBeNull(); // loadedmetadata 晚于重播意图，也读不到旧秒数。
    });
    it('读位置期间手动 seek 到 9s，不让迟到的 47s 覆盖', async () => {
        await engine.setSource(url, { songKey });
        const reading = deferred<{ positionSec: number; durationSec: number }>(); h.position.mockReturnValueOnce(reading.promise);
        restore(); await flush(); expect(h.position).toHaveBeenCalledTimes(1);
        await engine.seek(9); reading.resolve({ positionSec: 47, durationSec: 120 }); await flush();
        renderSource(); await flush(); expect(h.seek.mock.calls).toEqual([[9000]]);
    });
    it.each(['still current', 'manual seek', 'ABA', 'new play', 'stale prepare', 'failed prepare'])('prepare 中进后台，前台只补仍有效的请求：%s', async action => {
        const gate = deferred<{ stale: boolean }>(); h.prepare.mockReturnValueOnce(gate.promise);
        restore(); await flush(); renderSource(); await flush();
        setNativePlaybackReconciling(true);
        if (action === 'failed prepare') gate.reject(new Error('offline')); else gate.resolve({ stale: action === 'stale prepare' });
        await flush(); expect(h.seek).not.toHaveBeenCalled();
        if (action === 'manual seek') await engine.seek(9);
        if (action === 'new play') startPlay();
        setNativePlaybackReconciling(false);
        if (action === 'ABA') { await engine.setSource(url, { songKey: 'B' }); await engine.setSource(url, { songKey }); }
        renderSource(); renderSource(); await flush();
        expect(h.seek.mock.calls.map(([ms]) => ms)).toEqual(action === 'still current' ? [47000] : action === 'manual seek' ? [9000] : []);
    });
    it.each(['same token', 'reloaded', 'unknown'])('前台实际认领同曲：%s', async mode => {
        const gate = deferred<{ ok: boolean }>(); h.prepare.mockReturnValueOnce(gate.promise);
        restore(); await flush(); renderSource(); await flush();
        setNativePlaybackReconciling(true); gate.resolve({ ok: true }); await flush();
        const token = mode === 'same token' ? h.prepare.mock.calls[0][0].sourceToken : mode === 'reloaded' ? 'n:2' : undefined;
        expect(adoptNativePlaybackState({ hasSong: true, songKey, entries: [], durationMs: 120000, positionMs: 0,
            nativeMedia: { songKey, url, positionMs: 0, durationMs: 120000, playing: false, sourceToken: token },
        } as unknown as NativeQueueState)).toBe(true);
        setNativePlaybackReconciling(false); renderSource(); await flush(); renderSource(); await flush();
        expect(h.seek.mock.calls.map(([ms]) => ms)).toEqual(mode === 'same token' ? [47000] : []);
    });
    it('同 token 认领不洗掉已失败的装源：之后点播放必须重新 prepare', async () => {
        h.prepare.mockRejectedValueOnce(new Error('offline'));
        await expect(engine.setSource(url, { songKey })).rejects.toThrow('offline');
        const token = h.prepare.mock.calls[0][0].sourceToken;
        expect(engine.adoptSnapshot({ songKey, url, sourceToken: token, positionMs: 0, durationMs: 120000, playing: false })).toBe(true);
        expect(engine.sourceReadyError()).toBeTruthy();
        await engine.play();
        expect(h.prepare).toHaveBeenCalledTimes(2);
        expect(h.play).toHaveBeenCalledTimes(1);
    });
    it.each(['baseUrl 对得上', '没有 baseUrl（旧包）'])('伴奏/清唱 file:// 轨回前台：%s，同一 MediaItem 保留原始 https 地址与待补 seek', async mode => {
        const track = 'file:///data/instrumental/a.wav';
        const gate = deferred<{ ok: boolean }>(); h.prepare.mockReturnValueOnce(gate.promise);
        restore(); await flush(); renderSource(); await flush();
        setNativePlaybackReconciling(true); gate.resolve({ ok: true }); await flush();
        const media = { songKey, url: track, positionMs: 0, durationMs: 120000, playing: false, sourceToken: h.prepare.mock.calls[0][0].sourceToken,
            ...(mode === 'baseUrl 对得上' ? { baseUrl: url } : {}) };
        adoptNativePlaybackState({ hasSong: true, songKey, entries: [], durationMs: 120000, positionMs: 0, nativeMedia: media } as unknown as NativeQueueState);
        setNativePlaybackReconciling(false);
        if (mode === 'baseUrl 对得上') { expect(usePlaybackStore.getState().audioSrc).toBe(url); expect(engine.activeUrl()).toBe(url); }
        renderSource(usePlaybackStore.getState().audioSrc ?? url); await flush();
        expect(h.prepare).toHaveBeenCalledTimes(1);
        expect(h.seek.mock.calls.map(([ms]) => ms)).toEqual(mode === 'baseUrl 对得上' ? [47000] : []);
    });
    describe('挂载认领仍在播的 A 与会话恢复并行', () => {
        const entry = (s: SongResult) => ({ songKey: getPlaybackSongKey(s), providerId: 'bodian', songId: String(s.id), mid: '', hash: '', albumAudioId: '',
            url: '', title: s.name, artist: '', album: '', coverUrl: '', durationSec: 120 });
        const songB: SongResult = { ...song, id: 'b', name: 'B', sourceRef: { kind: 'online', providerId: 'bodian', mediaId: 'b' } };
        const fullA = { ...song, album: { id: 'al', name: 'Real Album' }, navidromeData: { id: 'nav-a' } } as SongResult;
        const fullB = { ...songB, album: { id: 'bl', name: 'B Album' } } as SongResult;
        const alive = () => ({ fromDisk: false, hasSong: true, index: 0, songKey, entries: [entry(song), entry(songB)], durationMs: 120000, positionMs: 5000,
            playing: true, nativeMedia: { songKey, url, positionMs: 5000, durationMs: 120000, playing: true, sourceToken: 'n:1' } }) as unknown as NativeQueueState;
        const gateQueueRead = () => {
            const gate = deferred<unknown>(); let calls = 0;
            h.queueRead.current = () => (++calls === 1 ? gate.promise : Promise.resolve(h.cache.get('last_queue')));
            return gate;
        };
        let stopWatching: (() => void) | undefined;
        const watchPersistence = () => {
            const cleanup = captureEffects(usePlaybackSessionSnapshot)[0]();
            if (typeof cleanup === 'function') stopWatching = () => { cleanup(); };
        };
        afterEach(() => { stopWatching?.(); stopWatching = undefined; });
        const savedQueues = () => h.save.mock.calls.filter(([key]) => key === 'last_queue').map(([, queue]) => queue as SongResult[]);
        beforeEach(() => { usePlaybackStore.getState().setPlayQueue([]); h.cache.set('last_song', fullA); h.cache.set('last_queue', [fullA, fullB]); h.native.mockResolvedValue(alive()); });

        it.each(['claim 先于读盘', 'claim 在读盘期间'])('%s：补全磁盘条目，定时持久化不写镜像壳', async when => {
            const gate = gateQueueRead(); watchPersistence();
            if (when === 'claim 先于读盘') adoptNativePlaybackState(alive());
            restore(); await flush();
            if (when === 'claim 在读盘期间') adoptNativePlaybackState(alive());
            vi.advanceTimersByTime(1500); await flush();
            expect(savedQueues()).toEqual([]); // 壳还在 store 里：不许把磁盘上完整队列覆盖掉
            gate.resolve([fullA, fullB]); await flush();
            const queue = usePlaybackStore.getState().playQueue;
            expect(queue.map(s => s.id)).toEqual(['a', 'b']);
            expect(queue[0]).toMatchObject({ album: { name: 'Real Album' }, navidromeData: { id: 'nav-a' } });
            expect(usePlaybackStore.getState().currentSong).toMatchObject({ navidromeData: { id: 'nav-a' } });
            expect(h.audio).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1500); await flush();
            for (const saved of savedQueues()) expect(saved[0]).toMatchObject({ navidromeData: { id: 'nav-a' } });
        });
        it('认领之后用户点了别的歌并改了队列：恢复不覆盖用户意图', async () => {
            const gate = gateQueueRead(); watchPersistence();
            restore(); await flush(); adoptNativePlaybackState(alive());
            startPlay(); makeSongCurrent(songB); usePlaybackStore.getState().setPlayQueue([songB]);
            gate.resolve([fullA, fullB]); await flush();
            expect(usePlaybackStore.getState().playQueue.map(s => s.id)).toEqual(['b']);
            expect(usePlaybackStore.getState().currentSong?.id).toBe('b');
        });
        it('读盘期间重排、删除和加入歌曲，保留队列编辑并只补全剩下的镜像条目', async () => {
            const gate = gateQueueRead(); watchPersistence();
            adoptNativePlaybackState(alive());
            restore(); await flush();
            const added: SongResult = { ...song, id: 'c', sourceRef: { kind: 'online', providerId: 'bodian', mediaId: 'c' } };
            const [, shellB] = usePlaybackStore.getState().playQueue;
            usePlaybackStore.getState().setPlayQueue([added, shellB]);
            vi.advanceTimersByTime(1500); await flush();
            expect(savedQueues()).toEqual([]);
            gate.resolve([fullA, fullB]); await flush();
            const queue = usePlaybackStore.getState().playQueue;
            expect(queue.map(s => s.id)).toEqual(['c', 'b']);
            expect(queue[0]).toBe(added);
            expect(queue[1]).toMatchObject({ album: { name: 'B Album' } });
            expect(usePlaybackStore.getState().currentSong).toMatchObject({ navidromeData: { id: 'nav-a' } });
        });
        it.each([
            ['整表替换', noteWholeQueueWrite],
            ['切换队列模式', noteQueueStart],
            ['重播同一首', startPlay],
        ] as const)('%s使认领失效，即使队列数组未换也不回填旧数据', async (_name, supersede) => {
            const gate = gateQueueRead(); watchPersistence();
            adoptNativePlaybackState(alive());
            restore(); await flush();
            const queue = usePlaybackStore.getState().playQueue;
            supersede();
            vi.advanceTimersByTime(1500); await flush();
            expect(savedQueues()).toHaveLength(1);
            gate.resolve([fullA, fullB]); await flush();
            expect(usePlaybackStore.getState().playQueue).toBe(queue);
        });
        it('磁盘没有队列可补时，恢复收尾后持久化不再被壳拦住', async () => {
            h.cache.set('last_queue', []); watchPersistence();
            adoptNativePlaybackState(alive()); restore(); await flush();
            vi.advanceTimersByTime(1500); await flush();
            expect(savedQueues().length).toBeGreaterThan(0);
        });
    });
    it('读本地 catalog 期间播放新曲，不把旧队列写回磁盘', async () => {
        const local = { ...song, isLocal: true, localRef: { songId: localRecord.id }, sourceRef: { kind: 'local', mediaId: localRecord.id } };
        h.cache.set('last_song', local); h.cache.set('last_queue', [local]);
        const catalog = deferred<{ entities: []; assignments: [] }>(); h.catalog.mockReturnValueOnce(catalog.promise);
        restore(); await flush(); expect(h.catalog).toHaveBeenCalledTimes(1);
        startPlay(); makeSongCurrent(song); catalog.resolve({ entities: [], assignments: [] }); await flush();
        expect(h.persist).not.toHaveBeenCalled(); expect(h.localAudio).not.toHaveBeenCalled();
    });
    it.each(['matched', 'mismatch', 'unplayable fallback'])('fromDisk 冷启动：%s 只取最终可播曲目的位置', async mode => {
        const oldSong: SongResult = { ...song, id: 'old', name: 'Old', sourceRef: { kind: 'online', providerId: 'bodian', mediaId: 'old' } };
        if (mode === 'unplayable fallback') {
            h.cache.set('last_song', oldSong); h.cache.set('last_queue', [oldSong, song]);
            h.canPlay.mockImplementation((s: SongResult) => s.id !== oldSong.id);
        }
        h.native.mockResolvedValue({ fromDisk: true, hasSong: true, index: 0, entries: [],
            songKey: mode === 'matched' ? songKey : getPlaybackSongKey(oldSong), positionMs: 72000, positionSavedAtMs: 2000, durationMs: 120000 });
        restore(); await flush(); renderSource(); await flush();
        expect(h.position).toHaveBeenCalledWith(expect.objectContaining({ id: song.id }));
        expect(usePlaybackStore.getState().currentSong?.id).toBe(song.id);
        expect(h.seek.mock.calls.map(([ms]) => ms)).toEqual([mode === 'matched' ? 72000 : 47000]);
    });
    it.each([
        ['原生后台从 100s 倒回 20s（原生记录较新）', { positionSec: 100, durationSec: 120, savedAt: 1000 }, 20000, 2000, 20000],
        ['Web 记录较新且比原生小', { positionSec: 47, durationSec: 120, savedAt: 2000 }, 72000, 1000, 47000],
        ['原生记录没有时间戳不能凭数值压过 Web', { positionSec: 20, durationSec: 120, savedAt: 1000 }, 100000, undefined, 20000],
    ])('磁盘位置按有效记录时间取权威来源：%s', async (_name, web, nativeMs, nativeAt, expected) => {
        h.position.mockResolvedValue(web);
        h.native.mockResolvedValue({ fromDisk: true, hasSong: true, index: 0, entries: [], songKey, positionMs: nativeMs, positionSavedAtMs: nativeAt, durationMs: 120000 });
        restore(); await flush(); renderSource(); await flush();
        expect(h.seek.mock.calls.map(([ms]) => ms)).toEqual([expected]);
    });
    it('恢复 seek 过桥时必须携带该次 prepare 的媒体身份和令牌', async () => {
        restore(); await flush(); renderSource(); await flush();
        expect(h.seek).toHaveBeenCalledWith(47000, { songKey, sourceToken: h.prepare.mock.calls[0][0].sourceToken });
    });
    it('读位置时出现尚未发布新曲目的 play，恢复不抢先发布音源', async () => {
        const reading = deferred<{ positionSec: number; durationSec: number }>(); h.position.mockReturnValueOnce(reading.promise);
        restore(); await flush(); startPlay(); reading.resolve({ positionSec: 47, durationSec: 120 }); await flush();
        expect(h.audio).not.toHaveBeenCalled(); expect(ref.current).toBeNull(); expect(usePendingResumeStore.getState().pending).toBeNull();
    });
});
