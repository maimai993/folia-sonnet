// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSongThemeAutoGeneration } from '@/hooks/useSongThemeAutoGeneration';
import type { GenerateAIThemeOptions, GenerateAIThemeResult } from '@/hooks/useThemeController';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import type { LyricData, SongResult } from '@/types';

/** 与 hook 期望的签名一致；vi.fn 那一侧在赋值时强转一次。 */
type GenerateAITheme = (
    lyrics: LyricData | null,
    currentSong: SongResult | null,
    options?: GenerateAIThemeOptions,
) => Promise<GenerateAIThemeResult>;

// test/unit/hooks/useSongThemeAutoGeneration.test.ts
// 切歌之后的自动生成到底有没有发起 —— 「后台播着，下一首却没去问云缓存」就在这一段。
//
// 这段逻辑靠一个 650ms 的 `setTimeout` 起跳。界面没人看的时候 WebView 会把定时器
// 节流甚至冻住：那一拍可能要等上一分钟，而这一分钟里多半又切了一首歌，effect 的
// cleanup 会把那个定时器**直接清掉** —— 于是这首歌的生成一次都没发起过，云缓存
// 也就一次都没问。后台改成条件到了就当场发起，不再赌定时器会不会按时响。

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const buildSong = (id: string): SongResult => ({
    id,
    name: `song-${id}`,
    artists: [{ id: `artist-${id}`, name: 'artist' }],
    album: { id: `album-${id}`, name: 'album' },
    source: 'local',
}) as unknown as SongResult;

const buildLyrics = (text: string): LyricData => ({
    lines: [{ fullText: text, words: [], time: 0 }],
}) as unknown as LyricData;

type Call = { songId: string | null };

let container: HTMLDivElement;
let root: Root;
let calls: Call[];
let generateAITheme: GenerateAITheme;

const Probe = ({ enabled, isLyricsLoading }: { enabled: boolean; isLyricsLoading: boolean }) => {
    useSongThemeAutoGeneration({
        enabled,
        isLyricsLoading,
        themeGenerationSource: 'ai',
        generateAITheme,
    });
    return null;
};

const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (hidden ? 'hidden' : 'visible'),
    });
};

const setPlayback = (song: SongResult | null, lyrics: LyricData | null) => {
    act(() => {
        usePlaybackStore.setState({ currentSong: song, lyrics });
    });
};

/** async 的 attempt 里没有 await，但函数自身要过一次微任务才走到发起那一步。 */
const flush = async () => {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
};

const render = async (enabled: boolean, isLyricsLoading: boolean) => {
    await act(async () => {
        root.render(createElement(Probe, { enabled, isLyricsLoading }));
    });
    await flush();
};

const advance = async (ms: number) => {
    await act(async () => {
        vi.advanceTimersByTime(ms);
        await Promise.resolve();
        await Promise.resolve();
    });
};

beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    generateAITheme = vi.fn(async (lyrics: LyricData | null, song: SongResult | null) => {
        /* MediaId 可能是数字，统一记成字符串好比对。 */
        calls.push({ songId: song?.id != null ? String(song.id) : null });
        return { status: 'generated', applied: true } as const;
    }) as unknown as GenerateAITheme;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    setHidden(false);
    setPlayback(null, null);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setPlayback(null, null);
    vi.useRealTimers();
});

describe('useSongThemeAutoGeneration', () => {
    it('waits out the settle delay while the page is visible', async () => {
        setPlayback(buildSong('a'), buildLyrics('la la la'));
        await render(true, false);

        expect(calls).toEqual([]);
        await advance(700);
        expect(calls).toEqual([{ songId: 'a' }]);
    });

    /*
     * 这条就是后台丢歌的那一段：不看定时器还有没有机会响，条件到了就当场发起。
     */
    it('starts right away when nobody is watching, without waiting for the timer', async () => {
        setHidden(true);
        setPlayback(buildSong('a'), buildLyrics('la la la'));
        await render(true, false);

        expect(calls).toEqual([{ songId: 'a' }]);
    });

    /*
     * 连着切歌时最容易丢：前台那 650ms 还没到，下一首已经把上一首的定时器清掉了。
     * 后台不再排定时器，于是每一首都真的发起了。
     */
    it('keeps every song when the next one arrives before the delay would have fired', async () => {
        setHidden(true);
        setPlayback(buildSong('a'), buildLyrics('first'));
        await render(true, false);

        setPlayback(buildSong('b'), buildLyrics('second'));
        await flush();
        setPlayback(buildSong('c'), buildLyrics('third'));
        await flush();

        expect(calls).toEqual([{ songId: 'a' }, { songId: 'b' }, { songId: 'c' }]);
    });

    it('does nothing while the switch is off', async () => {
        setHidden(true);
        setPlayback(buildSong('a'), buildLyrics('la la la'));
        await render(false, false);

        await advance(2000);
        expect(calls).toEqual([]);
    });

    /*
     * 歌词还在路上时不该把这首歌记成「试过了」—— 记了的话，等歌词真正回来，
     * effect 重跑也会被 `hasAttempted` 直接挡回去，这首歌本次会话再也不会生成。
     */
    it('does not burn the song when the lyrics have not arrived yet', async () => {
        setHidden(true);
        setPlayback(buildSong('a'), null);
        await render(true, false);

        expect(calls).toEqual([]);

        /* 歌词到了：自动触发应当照常补上，而不是被上一次的放弃挡住。 */
        setPlayback(buildSong('a'), buildLyrics('late but here'));
        await flush();

        expect(calls).toEqual([{ songId: 'a' }]);
    });

    it('revokes old A after A-B-A and retries a new playback epoch', async () => {
        setHidden(true);
        const a = buildSong('a');
        const aLyrics = buildLyrics('first');
        setPlayback(a, aLyrics);
        await render(true, false);
        const oldOptions = vi.mocked(generateAITheme).mock.calls[0][2]!;
        expect(oldOptions.shouldApply?.()).toBe(true);
        // Both transitions occur before React can rerender; the store guard still revokes A.
        act(() => {
            usePlaybackStore.setState({ currentSong: buildSong('b') });
            usePlaybackStore.setState({ currentSong: a });
        });
        expect(oldOptions.shouldApply?.()).toBe(false);
        expect(oldOptions.signal?.aborted).toBe(true);
        setPlayback(buildSong('b'), buildLyrics('second')); await flush();
        setPlayback(a, aLyrics); await flush();
        expect(calls.map(call => call.songId)).toEqual(['a', 'a', 'b', 'a']);
    });

    it('replaces same-song lyric input and cancels the previous consumer', async () => {
        setHidden(true);
        const a = buildSong('a');
        setPlayback(a, buildLyrics('first')); await render(true, false);
        const oldOptions = vi.mocked(generateAITheme).mock.calls[0][2]!;
        setPlayback(a, buildLyrics('replacement')); await flush();
        expect(oldOptions.shouldApply?.()).toBe(false);
        expect(oldOptions.signal?.aborted).toBe(true);
        expect(calls).toHaveLength(2);
    });

    it('asks only once for a stable input', async () => {
        setHidden(true);
        setPlayback(buildSong('a'), buildLyrics('la la la'));
        await render(true, false);
        await advance(2000);

        expect(calls).toEqual([{ songId: 'a' }]);
    });

    /*
     * 「播下一首再切回来，主题变成下一首的」就在这一条。
     *
     * 「已经问过」记的是**当前这一首**，不是「本次会话问过这首歌」。以前是个只增不减
     * 的 Set，切回 a 时 `hasAttempted` 恒为真 → 不生成、也不去问云缓存，画面就一直
     * 挂着 b 的主题（生成结果只存在云端，不问一次永远拿不回来）。
     */
    it('asks again when a song that already played comes back', async () => {
        setHidden(true);
        setPlayback(buildSong('a'), buildLyrics('first'));
        await render(true, false);

        setPlayback(buildSong('b'), buildLyrics('second'));
        await flush();

        /* 切回 a：必须重新问一次，否则 a 拿不到自己的主题。 */
        setPlayback(buildSong('a'), buildLyrics('first'));
        await flush();

        expect(calls).toEqual([{ songId: 'a' }, { songId: 'b' }, { songId: 'a' }]);
    });

    /*
     * 用户报的场景：一整张列表播完，再从头播一遍，前面的歌就没有 AI 高亮色了。
     * 一轮里每一首都被记成「试过」，第二轮全部被挡回去。
     */
    it('keeps generating when the queue wraps around and plays from the top again', async () => {
        setHidden(true);
        setPlayback(buildSong('a'), buildLyrics('1'));
        await render(true, false);

        setPlayback(buildSong('b'), buildLyrics('2'));
        await flush();
        setPlayback(buildSong('c'), buildLyrics('3'));
        await flush();

        /* 队列播完，从头再来一轮。 */
        setPlayback(buildSong('a'), buildLyrics('1'));
        await flush();
        setPlayback(buildSong('b'), buildLyrics('2'));
        await flush();

        expect(calls).toEqual([
            { songId: 'a' },
            { songId: 'b' },
            { songId: 'c' },
            { songId: 'a' },
            { songId: 'b' },
        ]);
    });
});
