// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_NOT_CONFIGURED } from '@/services/aiCompletion';
import { DEFAULT_BLOCKED_DIRECTOR_MODES } from '@/services/lyricDirector/state';
import type { SongResult } from '@/types';

// test/unit/services/lyricDirector/prefetchNextSong.test.ts
// 「提前为下一首做准备」到底有没有去问云缓存。
//
// 这条链路以前是当**生成**写的，一路都在做「问模型」的前置判断，于是它在几种最常见
// 的情形里根本走不到 requestStage —— 也就一次云缓存都不拉：
//
//  1. `aiUnavailable` 一票否决。那个标记说的是「这台机器发不出**模型**请求」，而预取
//     要做的第一件事是**拉缓存**；偏偏最需要缓存的正是没配密钥的人。它还不轻易复位
//     （只在挂载与 AI 设置变更时），于是第一次失败之后整个会话的预取都死了。
//  2. 没歌词就直接 return。纯音乐的指纹是**歌名**，真播那一轮就是拿歌名算的。
//  3. 歌词另开一次 omni.getLyrics 去取。播放时真正显示的是预取服务手里那份，两者
//     未必同一份 —— 指纹差一个字就是另一个键，预取热好的是 A，真播查的是 B。
//
// 这里不 mock `requestStage`，而是 mock 它下面的 `withAiCloudCache`（拉缓存那一层），
// 于是「有没有问云端」是被直接断言的，不是靠调用次数猜的。

// 上游的 ytm / spotify provider 在模块加载时就往 i18n 上挂 languageChanged，
// 所以这个替身也得有 on / off（真机上是真的 i18next 实例）。
vi.mock('@/i18n/config', () => ({ default: { t: (key: string) => key, on: () => { }, off: () => { } } }));

/*
 * `withAiCloudCache` 是唯一被换掉的那个：它正是「先问云端，没有再生成」的实现，
 * 断言它收到什么指纹 / 什么 platform / 有没有 skipPull，就等于断言预取有没有拉缓存。
 * 其余（指纹怎么算、决策怎么校验）全部走真代码。
 */
let cloudHandler: (options: Record<string, any>) => Promise<{ value: unknown; source: string }>;

vi.mock('@/services/aiCloudCache', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        withAiCloudCache: (options: Record<string, any>) => cloudHandler(options),
    };
});

let prefetchedLyrics: unknown = null;
let prefetchedIsPureMusic = false;

vi.mock('@/services/prefetchService', () => ({
    getPrefetchedData: () => (prefetchedLyrics === null && !prefetchedIsPureMusic
        ? null
        : {
            lyrics: prefetchedLyrics,
            lyricRaw: {
                mainLrc: null,
                yrcLrc: null,
                transLrc: null,
                isPureMusic: prefetchedIsPureMusic,
            },
        }),
}));

let omniLyricLines: unknown = null;

vi.mock('@/services/onlineMusic/omni', () => ({
    omni: {
        getLyrics: async () => ({ lyrics: omniLyricLines }),
    },
}));

let cloudEnabled = true;

/*
 * 提示都从 `setStatusMessage` 出去 —— 换掉它，就能直接断言「这一趟有没有跟用户说一声」。
 * i18n 被 mock 成「返回 key 本身」，所以断言的是 key 而不是文案。
 */
const { messages } = vi.hoisted(() => ({ messages: [] as { type: string; text: string }[] }));

vi.mock('@/stores/useStatusMessageStore', () => ({
  setStatusMessage: (value: { type: string; text: string }) => {
    messages.push({ type: String(value?.type ?? ''), text: String(value?.text ?? '') });
  },
}));

vi.mock('@/services/foliaCloud', () => ({
    isFoliaCloudCacheEnabled: () => cloudEnabled,
    resolveCloudApiUrl: (path: string) => `https://cloud.test/api/${path}`,
    DEFAULT_CLOUD_BASE_URL: 'https://cloud.test',
}));

const buildSong = (id: string, providerId = 'netease'): SongResult => ({
    id,
    name: `歌-${id}`,
    artists: [{ id: `artist-${id}`, name: '某人' }],
    album: { id: `album-${id}`, name: '某专辑' },
    source: providerId,
    sourceRef: { kind: 'online', providerId, mediaId: id },
}) as unknown as SongResult;

const buildLyricData = (...texts: string[]) => ({
    lines: texts.map((fullText, index) => ({ fullText, words: [], time: index })),
});

type CloudCall = {
    fingerprint: string;
    platform: string;
    songTitle: string;
    skipPull: boolean;
    isPureMusic: boolean;
};

const loadDirector = async () => {
    vi.resetModules();
    const director = await import('@/services/lyricDirector/director');
    const stage = await import('@/services/aiStage');
    const playback = await import('@/stores/usePlaybackStore');
    return { director, stage, playback };
};

/**
 * 当前歌跑完一次决策 —— 预取就挂在它 finally 的尾巴上。
 *
 * 预取是 `void prefetchNextSong()`，不返回句柄。v0.7.26 又在它前面垫了两层 await
 * （先问原生后台算过没有，再问云缓存），早先「等一个 setTimeout(0) 就断言」的写法
 * 已经等不到它跑完。这里让事件循环真多空转几轮，压掉那两层排队。
 */
const runOnce = async (
    director: typeof import('@/services/lyricDirector/director'),
) => {
    await director.runLyricDirectorDecision({ announce: false });
    for (let turn = 0; turn < 8; turn += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

let calls: CloudCall[] = [];

beforeEach(() => {
    calls = [];
    messages.length = 0;
    prefetchedLyrics = null;
    prefetchedIsPureMusic = false;
    omniLyricLines = null;
    cloudEnabled = true;
    localStorage.clear();
    cloudHandler = async (options) => {
        calls.push({
            fingerprint: String(options.fingerprint ?? ''),
            platform: String(options.platform ?? ''),
            songTitle: String(options.songTitle ?? ''),
            skipPull: options.skipPull === true,
            isPureMusic: options.isPureMusic === true,
        });
        return { value: { decision: { mode: 'flow', reason: 'r', params: {} } }, source: 'cloud' };
    };
});

describe('prefetchNextSong —— 提前为下一首做准备', () => {
    it('当前歌决策跑完之后，下一首会被问一次云缓存（不 skipPull）', async () => {
        omniLyricLines = buildLyricData('下一首的歌词');
        const { director, playback } = await loadDirector();
        const current = buildSong('a');
        const next = buildSong('b');
        playback.usePlaybackStore.setState({
            currentSong: current,
            playQueue: [current, next],
            lyrics: buildLyricData('当前这首的歌词') as never,
            transitionDisplay: null,
        });

        await runOnce(director);

        expect(calls.length).toBe(2);
        expect(calls[1].songTitle).toBe('歌-b');
        /* skipPull 为真就是「别去问云端」—— 预取绝不能走那条。 */
        expect(calls[1].skipPull).toBe(false);
    });

    it('本机发不出模型请求时也要拉云缓存：aiUnavailable 不再一票否决', async () => {
        omniLyricLines = buildLyricData('下一首的歌词');
        const { director, playback } = await loadDirector();
        const current = buildSong('a');
        const next = buildSong('b');
        playback.usePlaybackStore.setState({
            currentSong: current,
            playQueue: [current, next],
            lyrics: buildLyricData('当前这首的歌词') as never,
            transitionDisplay: null,
        });

        /* 当前这首让模型报「没配密钥」—— 那正是 aiUnavailable 被置上的那一刻。 */
        cloudHandler = async (options) => {
            calls.push({
                fingerprint: String(options.fingerprint ?? ''),
                platform: String(options.platform ?? ''),
                songTitle: String(options.songTitle ?? ''),
                skipPull: options.skipPull === true,
                isPureMusic: options.isPureMusic === true,
            });
            if (String(options.songTitle ?? '') === '歌-a') throw new Error(AI_NOT_CONFIGURED);
            return { value: { decision: { mode: 'flow', reason: 'r', params: {} } }, source: 'cloud' };
        };

        await runOnce(director);

        /* 旧代码在这里只会有 1 次：预取被 aiUnavailable 挡在门外，云缓存一次都没问。 */
        expect(calls.map((call) => call.songTitle)).toEqual(['歌-a', '歌-b']);
    });

    it('下一首是纯音乐也要问：指纹按歌名算', async () => {
        /* 预取明确记着「这首没有歌词」—— 不能因为拿不到歌词就放弃。 */
        prefetchedIsPureMusic = true;
        const { director, stage, playback } = await loadDirector();
        const current = buildSong('a');
        const next = buildSong('b');
        playback.usePlaybackStore.setState({
            currentSong: current,
            playQueue: [current, next],
            lyrics: buildLyricData('当前这首的歌词') as never,
            transitionDisplay: null,
        });

        await runOnce(director);

        expect(calls.length).toBe(2);
        const { lyricSource, isPureMusic } = stage.resolveStageLyricSource({
            lines: [],
            songTitle: '歌-b',
        });
        expect(calls[1].isPureMusic).toBe(true);
        expect(calls[1].fingerprint).toBe(stage.fingerprintStage(
            lyricSource,
            stage.buildStagePolicy({ isPureMusic, hint: '', blocked: DEFAULT_BLOCKED_DIRECTOR_MODES }),
        ));
    });

    it('歌词优先用预取服务手里那份 —— 不再另开一次 omni.getLyrics', async () => {
        prefetchedLyrics = buildLyricData('预取到的歌词');
        const { director, stage, playback } = await loadDirector();
        const omni = await import('@/services/onlineMusic/omni');
        const spy = vi.spyOn(omni.omni, 'getLyrics');
        const current = buildSong('a');
        const next = buildSong('b');
        playback.usePlaybackStore.setState({
            currentSong: current,
            playQueue: [current, next],
            lyrics: buildLyricData('当前这首的歌词') as never,
            transitionDisplay: null,
        });

        await runOnce(director);

        expect(spy).not.toHaveBeenCalled();
        const { lyricSource, isPureMusic } = stage.resolveStageLyricSource({
            lines: [{ fullText: '预取到的歌词' }],
            songTitle: '歌-b',
        });
        expect(calls[1].fingerprint).toBe(stage.fingerprintStage(
            lyricSource,
            stage.buildStagePolicy({ isPureMusic, hint: '', blocked: DEFAULT_BLOCKED_DIRECTOR_MODES }),
        ));
    });

    it('推上去的条目带平台名，服务端才拿得对平台的歌词去核对', async () => {
        omniLyricLines = buildLyricData('下一首的歌词');
        const { director, playback } = await loadDirector();
        const current = buildSong('a', 'netease');
        const next = buildSong('b', 'kugou');
        playback.usePlaybackStore.setState({
            currentSong: current,
            playQueue: [current, next],
            lyrics: buildLyricData('当前这首的歌词') as never,
            transitionDisplay: null,
        });

        await runOnce(director);

        expect(calls[1].platform).toBe('kugou');
    });

    /*
     * 提前生成**真的上传了** —— 那就跟切歌那条路一样该说一声「感谢你的贡献」。
     * 以前预取拿到的结果直接丢掉，用户一句反馈都没有，看上去像什么都没做。
     */
    it('announces the upload it just made for the next track', async () => {
        omniLyricLines = buildLyricData('下一首的歌词');
        const { director, playback } = await loadDirector();
        const current = buildSong('a');
        const next = buildSong('b');
        playback.usePlaybackStore.setState({
            currentSong: current,
            playQueue: [current, next],
            lyrics: buildLyricData('当前这首的歌词') as never,
            transitionDisplay: null,
        });

        cloudHandler = async (options) => {
            calls.push({
                fingerprint: String(options.fingerprint ?? ''),
                platform: String(options.platform ?? ''),
                songTitle: String(options.songTitle ?? ''),
                skipPull: options.skipPull === true,
                isPureMusic: options.isPureMusic === true,
            });
            return { value: { decision: { mode: 'flow', reason: 'r', params: {} } }, source: 'ai' };
        };

        await runOnce(director);

        expect(messages.map((entry) => entry.text)).toContain('aiDirector.toastPrefetchUploaded');
    });

    /*
     * 用户报的「提示两遍」：播 A 时预取了 B（真的上传 → 说一声），切到 B 再切回 A，
     * B 又变成了下一首。可它的答案还躺在进程内的 recent 里、云端也已经有了 ——
     * 这一趟是白拿，一个字节都没上传，不该再报一次「已提前为下一首生成并上传」。
     *
     * `source` 沿用的是当初那次的 'ai'（见 aiStage.readRecent 上的注释），它回答不了
     * 「这一趟有没有真的贡献」，所以这里看的是 `reused`。
     */
    it('does not thank twice when the same next track is prefetched again', async () => {
        omniLyricLines = buildLyricData('下一首的歌词');
        const { director, playback } = await loadDirector();
        const a = buildSong('a');
        const b = buildSong('b');
        playback.usePlaybackStore.setState({
            currentSong: a,
            playQueue: [a, b],
            lyrics: buildLyricData('当前这首的歌词') as never,
            transitionDisplay: null,
        });

        cloudHandler = async () => (
            { value: { decision: { mode: 'flow', reason: 'r', params: {} } }, source: 'ai' }
        );

        const thanks = () => messages.filter((entry) => entry.text === 'aiDirector.toastPrefetchUploaded').length;

        /* 第一遍：预取 b，真的上传了 —— 该说一声。 */
        await runOnce(director);
        expect(thanks()).toBe(1);

        /* 切到 b，再切回 a：b 重新变成下一首。 */
        playback.usePlaybackStore.setState({
            currentSong: b,
            lyrics: buildLyricData('下一首的歌词') as never,
        });
        director.notifyLyricDirectorSongChanged();
        await runOnce(director);

        playback.usePlaybackStore.setState({
            currentSong: a,
            lyrics: buildLyricData('当前这首的歌词') as never,
        });
        director.notifyLyricDirectorSongChanged();
        await runOnce(director);

        expect(thanks()).toBe(1);
    });

    /* 命中缓存那次一个字节都没上传 —— 那不能说「感谢」，本来就是白拿别人的。 */
    it('stays quiet when the prefetch just pulled someone else’s answer', async () => {
        omniLyricLines = buildLyricData('下一首的歌词');
        const { director, playback } = await loadDirector();
        const current = buildSong('a');
        const next = buildSong('b');
        playback.usePlaybackStore.setState({
            currentSong: current,
            playQueue: [current, next],
            lyrics: buildLyricData('当前这首的歌词') as never,
            transitionDisplay: null,
        });

        await runOnce(director);

        expect(messages.map((entry) => entry.text)).not.toContain('aiDirector.toastPrefetchUploaded');
    });

    /*
     * 「允许自动切换」只管**应用**，不管**生成** —— 关着照样要把答案推上云端，
     * 那就照样该说一声。以前那条提示被绑在 apply 后面，于是关掉开关的人永远看不到
     * 自己贡献了什么，而他们每首歌都在替别人烧调用。
     */
    it('still says thank you when auto-switch is off and nothing is applied', async () => {
        omniLyricLines = buildLyricData('下一首的歌词');
        localStorage.setItem('folia_lyric_director_v2', JSON.stringify({
            settings: { autoOnSongChange: false, prefetchNext: false },
        }));
        const { director, playback } = await loadDirector();
        const current = buildSong('a');
        playback.usePlaybackStore.setState({
            currentSong: current,
            playQueue: [current],
            lyrics: buildLyricData('当前这首的歌词') as never,
            transitionDisplay: null,
        });

        cloudHandler = async () => (
            { value: { decision: { mode: 'flow', reason: 'r', params: {} } }, source: 'ai' }
        );

        const outcome = await director.runLyricDirectorDecision({ announce: true });

        expect(outcome.kind).toBe('produced');
        expect(messages.map((entry) => entry.text)).toContain('aiDirector.toastUploaded');
    });

    it('云缓存也关着就没什么可预取的', async () => {
        cloudEnabled = false;
        omniLyricLines = buildLyricData('下一首的歌词');
        const { director, playback } = await loadDirector();
        const current = buildSong('a');
        const next = buildSong('b');
        playback.usePlaybackStore.setState({
            currentSong: current,
            playQueue: [current, next],
            lyrics: buildLyricData('当前这首的歌词') as never,
            transitionDisplay: null,
        });

        cloudHandler = async (options) => {
            calls.push({
                fingerprint: String(options.fingerprint ?? ''),
                platform: String(options.platform ?? ''),
                songTitle: String(options.songTitle ?? ''),
                skipPull: options.skipPull === true,
                isPureMusic: options.isPureMusic === true,
            });
            if (String(options.songTitle ?? '') === '歌-a') throw new Error(AI_NOT_CONFIGURED);
            return { value: { decision: { mode: 'flow', reason: 'r', params: {} } }, source: 'cloud' };
        };

        await runOnce(director);

        expect(calls.map((call) => call.songTitle)).toEqual(['歌-a']);
    });
});
