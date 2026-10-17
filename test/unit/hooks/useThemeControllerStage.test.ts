// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useThemeController } from '@/hooks/useThemeController';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useStatusMessageStore } from '@/stores/useStatusMessageStore';
import { normalizeStageIdentity } from '@/services/stageCache/identity';
import { resolveStageCloudNamespace } from '@/services/stageCache/cloud';
import { FALLBACK_AI_DUAL_THEME } from '@/services/themeSanitizer';
import type { StageUpdate } from '@/services/stageCache/runtime';
import type { DualTheme, LyricData, SongResult } from '@/types';

// test/unit/hooks/useThemeControllerStage.test.ts — 真实 React 提交链；只隔离生成与存储 IO。
const io = vi.hoisted(() => ({
    generate: vi.fn(), save: vi.fn(), sync: vi.fn(), restore: vi.fn(),
    rollback: vi.fn(), accept: vi.fn(), request: vi.fn(), extract: vi.fn(),
    listeners: new Set<(event: StageUpdate) => void>(),
}));
vi.mock('@/services/gemini', async importOriginal => ({
    ...await importOriginal<typeof import('@/services/gemini')>(),
    generateThemeFromLyrics: io.generate,
}));
vi.mock('@/services/db', () => ({ saveToCache: io.save }));
vi.mock('@/services/themeCache', () => ({ getLastDualTheme: vi.fn(), getLastLegacyTheme: vi.fn() }));
vi.mock('@/services/sync/syncRepository', () => ({ saveSyncedThemeForSong: io.sync }));
vi.mock('@/utils/colorExtractor', () => ({ extractColors: io.extract }));
vi.mock('@/services/aiThemeClient', () => ({ isLocalAiThemeAvailable: () => false }));
vi.mock('@/services/runtimeConfig', () => ({ getWebAiProvider: () => 'openai' }));
vi.mock('@/services/webApi', () => ({ resolveFoliaApiUrl: () => 'https://ai.test/generate' }));
vi.mock('@/services/aiStage', () => ({
    notifyStageResolved: vi.fn(), restorePersistentStage: io.restore,
    rollbackStageUpdate: io.rollback, acceptStageUpdate: io.accept,
    requestStage: io.request,
    subscribeStageCacheDiagnostics: () => () => {},
    resolveStageLyricSource: () => ({ isPureMusic: false }),
    subscribeStageUpdates: (listener: (event: StageUpdate) => void) => {
        io.listeners.add(listener);
        return () => { io.listeners.delete(listener); };
    },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const song = (id: string): SongResult => ({ id, name: id,
    artists: [{ id: 1, name: 'artist' }], album: { id: 1, name: 'album', cover: '' }, durationMs: 180_000 } as unknown as SongResult);
const lyrics = { lines: [{ fullText: 'lyric', words: [], time: 0 }] } as unknown as LyricData;
const dual = (name: string): DualTheme => ({
    light: { ...FALLBACK_AI_DUAL_THEME.light, name: `${name}-light` },
    dark: { ...FALLBACK_AI_DUAL_THEME.dark, name: `${name}-dark` },
});
const base = dual('base');
const t = (key: string) => key;
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
};
let root: Root;
let container: HTMLDivElement;
let controller: ReturnType<typeof useThemeController>;
const Probe = () => {
    controller = useThemeController({ defaultTheme: base.dark, daylightTheme: base.light,
        isDaylight: false, setDaylightPreference: () => {}, coverUrl: 'cover', t });
    return null;
};
const playback = (value: SongResult) => act(() => {
    usePlaybackStore.setState({ currentSong: value, transitionDisplay: null, lyrics });
});
const emit = async (value: SongResult, revision = 'old', reason: StageUpdate['reason'] = 'update', isCurrent?: () => boolean, redoRevision?: string) => {
    const identityKey = normalizeStageIdentity({ title: value.name, artists: ['artist'] })!.key;
    await act(async () => {
        io.listeners.forEach(listener => listener({ identityKey, namespace: resolveStageCloudNamespace(), revision, reason, isCurrent, redoRevision, payload: { theme: dual(revision) } }));
    });
};

beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    io.sync.mockResolvedValue(undefined);
    io.restore.mockResolvedValue(null);
    io.rollback.mockResolvedValue(null);
    io.accept.mockResolvedValue(null);
    useStatusMessageStore.setState({ message: null });
    playback(song('A'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(Probe)));
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (window as unknown as { electron?: unknown }).electron;
});

describe('真实 useThemeController 的 stage 提交边界', () => {
    it('手动 A→B→A 后拒绝旧 A 画面与 last_dual_theme 写入', async () => {
        const pending = deferred<{ theme: DualTheme; source: 'ai' }>();
        io.generate.mockReturnValue(pending.promise);
        const a = usePlaybackStore.getState().currentSong!;
        let result!: ReturnType<typeof controller.generateAITheme>;
        act(() => { result = controller.generateAITheme(lyrics, a); });
        playback(song('B'));
        playback(a);
        await act(async () => { pending.resolve({ theme: dual('old'), source: 'ai' }); await result; });
        expect(await result).toEqual({ status: 'generated', applied: false });
        expect(controller.aiTheme).toBeNull();
        expect(io.save).not.toHaveBeenCalledWith('last_dual_theme', expect.anything());
    });

    it('当前手动结果正常经过 React 提交并保存 last_dual_theme', async () => {
        io.generate.mockResolvedValue({ theme: dual('current'), source: 'ai' });
        await act(async () => {
            const result = await controller.generateAITheme(lyrics, usePlaybackStore.getState().currentSong);
            expect(result).toEqual({ status: 'generated', applied: true });
        });
        expect(controller.theme.name).toBe('current-dark');
        expect(controller.bgMode).toBe('ai');
        expect(controller.themeSourceModel.hasLocalAiTheme).toBe(true);
        expect(io.save).toHaveBeenCalledWith('last_dual_theme', controller.aiTheme);
    });

    it('旧 A 任务完成时不能把 B 标成已有本地 AI 主题', async () => {
        const pending = deferred<{ theme: DualTheme; source: 'ai' }>();
        io.generate.mockReturnValue(pending.promise);
        let result!: ReturnType<typeof controller.generateAITheme>;
        act(() => { result = controller.generateAITheme(lyrics, usePlaybackStore.getState().currentSong); });
        playback(song('B'));
        await act(async () => controller.restoreCachedThemeForSong(usePlaybackStore.getState().currentSong!));
        expect(controller.themeSourceModel.hasLocalAiTheme).toBe(false);
        await act(async () => { pending.resolve({ theme: dual('old'), source: 'ai' }); await result; });
        expect(controller.themeSourceModel.hasLocalAiTheme).toBe(false);
    });

    it('旧封面取色任务也不能污染 B 的已有主题标记', async () => {
        const pending = deferred<string[]>();
        io.extract.mockReturnValue(pending.promise);
        act(() => controller.handleThemeGenerationSourceChange('cover'));
        let result!: ReturnType<typeof controller.generateAITheme>;
        act(() => { result = controller.generateAITheme(lyrics, usePlaybackStore.getState().currentSong); });
        playback(song('B'));
        await act(async () => { pending.resolve(['#ffffff']); await result; });
        expect(await result).toEqual({ status: 'generated', applied: false });
        expect(controller.themeSourceModel.hasLocalAiTheme).toBe(false);
    });

    it('歌词已导入的同名歌曲不能被公共云更新覆盖', async () => {
        const customized = { ...song('A'), onlineLyricsState: { lyricsSource: 'imported' } } as SongResult;
        playback(customized);
        await emit(customized);
        expect(controller.aiTheme).toBeNull();
        expect(io.save).not.toHaveBeenCalled();
    });

    it('A→B→A 后来自旧 A 请求的更新事件不能取得新播放的提交权', async () => {
        const a = usePlaybackStore.getState().currentSong!;
        // 取真实 hook 传给 stage 的提交权，模拟云检查跨过两次切歌才返回。
        io.generate.mockResolvedValue({ theme: dual('initial'), source: 'local' });
        await act(async () => { await controller.generateAITheme(lyrics, a); });
        const oldIsCurrent = io.generate.mock.calls[0][1].isCurrent;
        act(() => controller.applyThemeFallback());
        io.save.mockClear();
        playback(song('B'));
        playback(a);
        expect(oldIsCurrent()).toBe(false);
        await emit(a, 'old-playback-result', 'update', oldIsCurrent);
        expect(controller.aiTheme).toBeNull();
        expect(io.save).not.toHaveBeenCalled();
    });

    it('导入歌词的歌曲不能从仅按歌名和艺人查询的公共记录恢复主题', async () => {
        const customized = { ...song('A'), onlineLyricsState: { lyricsSource: 'imported' } } as SongResult;
        playback(customized);
        io.restore.mockResolvedValue({ current: { payload: { theme: dual('public') } } });
        await act(async () => { await controller.restoreCachedThemeForSong(customized); });
        expect(controller.aiTheme).toBeNull();
    });

    it('同一播放轮次内较早的异步缓存恢复不能覆盖较新的手动生成', async () => {
        const a = usePlaybackStore.getState().currentSong!;
        const pending = deferred<unknown>();
        io.restore.mockReturnValue(pending.promise);
        let restoring!: ReturnType<typeof controller.restoreCachedThemeForSong>;
        act(() => { restoring = controller.restoreCachedThemeForSong(a); });
        io.generate.mockResolvedValue({ theme: dual('manual-new'), source: 'ai' });
        await act(async () => { await controller.generateAITheme(lyrics, a); });
        await act(async () => {
            pending.resolve({ current: { payload: { theme: dual('restore-old') } } });
            await restoring;
        });
        expect(controller.aiTheme?.dark.name).toBe('manual-new-dark');
        expect(io.save.mock.calls.at(-1)?.[1].dark.name).toBe('manual-new-dark');
    });

    it('在线歌词被用户覆盖后也不能被公共云更新覆盖', async () => {
        const customized = { ...song('A'), onlineLyricsState: { lyricsSource: 'online', hasOnlineOverride: true } } as SongResult;
        playback(customized);
        await emit(customized);
        expect(controller.aiTheme).toBeNull();
    });

    it('同首歌再更新后旧通知的撤销动作仍绑定原 revision 供存储层比较', async () => {
        const a = usePlaybackStore.getState().currentSong!;
        await emit(a, 'first');
        const action = useStatusMessageStore.getState().message!.onAction!;
        await emit(a, 'second');
        await act(async () => { action(); });
        expect(io.rollback).toHaveBeenCalledWith(expect.any(String), 'first');
    });

    it('切歌后旧通知的撤销动作失效', async () => {
        await emit(usePlaybackStore.getState().currentSong!);
        const action = useStatusMessageStore.getState().message!.onAction!;
        playback(song('B'));
        await act(async () => { action(); });
        expect(io.rollback).not.toHaveBeenCalled();
    });

    it('恢复通知的接受动作不能接受通知之后才出现的另一个版本', async () => {
        await emit(usePlaybackStore.getState().currentSong!, 'rollback-version', 'rollback', undefined, 'notified-redo-version');
        const action = useStatusMessageStore.getState().message!.onAction!;
        io.restore.mockResolvedValue({ remoteRevision: 'unseen-newer-version' });
        await act(async () => { action(); await Promise.resolve(); });
        expect(io.accept).toHaveBeenCalledWith(expect.any(String), 'notified-redo-version', 'rollback-version');
        expect(io.restore).not.toHaveBeenCalled();
    });

    it('Electron IPC 的 options 不携带函数或 AbortSignal', async () => {
        const actual = await vi.importActual<typeof import('@/services/gemini')>('@/services/gemini');
        const bridge = vi.fn().mockResolvedValue(dual('desktop'));
        (window as unknown as { electron: unknown }).electron = { generateTheme: bridge };
        io.request.mockImplementation(async request => ({
            ...await request.generate({ signal: new AbortController().signal }), source: 'ai',
        }));
        await actual.generateThemeFromLyrics('lyric', {
            songTitle: 'A', lines: lyrics.lines, signal: new AbortController().signal, isCurrent: () => true,
        });
        const options = bridge.mock.calls[0][1];
        expect(options).not.toHaveProperty('isCurrent');
        expect(options).not.toHaveProperty('signal');
        expect(options.songTitle).toBe('A');
    });

    it('部署生成闭包使用 stage 调度器信号，消费者取消不取消共享 IO', async () => {
        const actual = await vi.importActual<typeof import('@/services/gemini')>('@/services/gemini');
        const consumer = new AbortController();
        const shared = new AbortController();
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => dual('web') });
        vi.stubGlobal('fetch', fetchMock);
        io.request.mockImplementation(async request => ({
            ...await request.generate({ signal: shared.signal }), source: 'ai',
        }));
        await actual.generateThemeFromLyrics('lyric', { songTitle: 'A', lines: lyrics.lines, signal: consumer.signal });
        expect(fetchMock.mock.calls[0][1].signal).toBe(shared.signal);
        consumer.abort();
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    });
});
