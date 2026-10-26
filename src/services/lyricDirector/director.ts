import i18n from '../../i18n/config';
import { useVisualizerSettingsStore } from '../../stores/useVisualizerSettingsStore';
import { selectDisplayLyrics, selectDisplaySong, usePlaybackStore } from '../../stores/usePlaybackStore';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { setStatusMessage } from '../../stores/useStatusMessageStore';
import { omni } from '../onlineMusic/omni';
import { requestStage } from '../aiStage';
import type { AiCloudCacheSource } from '../aiCloudCache';
import { isFoliaCloudCacheEnabled } from '../foliaCloud';
import { getPrefetchedData } from '../prefetchService';
import {
    describeAiTarget,
    isAiNotConfiguredError,
    translateAiCompletionError,
} from '../aiCompletion';
import type { AiCompletionTarget } from '../aiCompletion';
import {
    formatParamValue,
    gateSatisfied,
    gatesFor,
    isBlockedDirectorMode,
    isInertValue,
    isKnownDirectorMode,
    modeLabel,
    sanitizeParams,
    tuningStateKey,
    MODE_PARAMS,
} from './catalog';
import type {
    DirectorLyricLine,
    DirectorSongInfo,
} from './prompt';
import {
    noteRecentMode,
    readDirectorSettings,
    readSnapshot,
    writeSnapshotOnce,
} from './state';
import { readStoredThemeAutoGenerateEnabled } from '../themePreferences';
import { resolveSongPlatform } from '../../utils/songPlatform';
import type { SongResult, VisualizerMode } from '../../types';

// src/services/lyricDirector/director.ts
// The feature itself: ask the AI which lyric animation a song should use, then
// write the answer through the player's own settings so it behaves exactly like
// a manual edit — same clamping, same storage keys, and it rides into exports.
//
// It used to be a Folium mod, which only the desktop build can load (the Android
// build has no mod system at all), so the whole thing moved in here: the writes
// go straight to the visualizer store instead of through `folium.internals`, and
// the AI call goes through services/aiCompletion, the same connection the mods
// now share.
//
// Every await is followed by an "is this still the song we asked about" check:
// a decision can be in flight for seconds, and the user may well have moved on
// by then.

const LYRICS_WAIT_FALLBACK_MS = 4000;
const LYRICS_SETTLE_MS = 250;

type VisualizerState = ReturnType<typeof useVisualizerSettingsStore.getState>;

type SongKeySource = {
    sourceRef?: { kind?: string; providerId?: string; mediaId?: string | number } | null;
    isStage?: boolean;
    localRef?: { songId?: string | number } | null;
    navidromeData?: { isNavidrome?: boolean; id?: string | number } | null;
    isNavidrome?: boolean;
    id?: string | number;
    providerId?: string;
    name?: string;
    artists?: { name?: string }[] | null;
};

export type DirectorOutcome =
    | { kind: 'applied'; text: string }
    | { kind: 'failed'; text: string }
    | { kind: 'queued' }
    | { kind: 'stale' }
    /* 跑完了、也上传了，但「允许自动切换」是关的 —— 只当给云缓存添一块砖。 */
    | { kind: 'produced'; text: string }
    /* 这台机器现在没有可以用的 AI 连接：请求根本发不出去，重试也一样。 */
    | { kind: 'unavailable'; text: string }
    | { kind: 'no-song' };

export interface DirectorRuntime {
    busy: boolean;
    lastSummary: string;
    lastReason: string;
    currentMode: string;
    currentModeLabel: string;
    aiKnown: boolean;
    aiTarget: AiCompletionTarget | null;
}

// ------------------------------------------------------------------ song identity

/* Mirrors the host's own getPlaybackSourceRef + getPlaybackSongKey: an explicit
 * `sourceRef` wins, otherwise the song is classified the same way the host does.
 * The classification matters — a queue entry usually has no `sourceRef` yet while
 * the same song carries one once it plays, so guessing "online" for a Navidrome
 * track would file a prefetched decision under a key the playing song never
 * looks up. */
const songKeyOf = (song: unknown): string | null => {
    const raw = song as SongKeySource | null;
    if (!raw || typeof raw !== 'object') return null;
    const ref = raw.sourceRef;
    if (ref && ref.kind) {
        return ref.kind === 'online'
            ? `online:${ref.providerId ?? 'netease'}:${ref.mediaId ?? raw.id}`
            : `${ref.kind}:${ref.mediaId ?? raw.id}`;
    }
    if (raw.isStage === true) return `stage:${raw.id}`;
    if (raw.localRef?.songId) return `local:${raw.localRef.songId}`;
    const navidromeCarrier = raw.navidromeData && raw.navidromeData.isNavidrome === true
        ? raw.navidromeData
        : (raw.isNavidrome === true && raw.navidromeData ? raw : null);
    if (navidromeCarrier) {
        const navidromeId = navidromeCarrier.id ?? raw.id;
        if (navidromeId !== undefined && navidromeId !== null) return `navidrome:${navidromeId}`;
    }
    if (raw.id !== undefined && raw.id !== null) return `online:${raw.providerId ?? 'netease'}:${raw.id}`;
    const title = String(raw.name ?? '').trim().toLowerCase();
    if (!title) return null;
    const artist = Array.isArray(raw.artists)
        ? raw.artists.map((entry) => entry?.name).filter(Boolean).join('/').toLowerCase()
        : '';
    return `title:${title}|${artist}`;
};

const songInfoOf = (song: unknown): DirectorSongInfo | null => {
    const raw = song as SongKeySource | null;
    if (!raw) return null;
    return {
        title: raw.name ?? '',
        artist: Array.isArray(raw.artists) ? raw.artists.map((artist) => artist?.name).filter(Boolean).join(' / ') : '',
        album: null,
        /*
         * 平台名跟着上传走：服务端拿它去对应平台把歌词原文件取回来重算哈希。
         *
         * 以前这里不带，于是导演这条链（含预取）推上去的条目平台名一律为空 —— 服务端
         * 只能按 netease → qq → kugou 的顺序逐个试，很容易拿一首同名歌的歌词来比对，
         * 于是把一份好答案判成「歌词对不上」拒掉。主题那条链一直带得对，两条链的待遇
         * 就不一样了。
         */
        platform: resolveSongPlatform(raw as SongResult),
    };
};

const lyricLinesOf = (lyrics: unknown): DirectorLyricLine[] => {
    const lines = (lyrics as { lines?: unknown } | null)?.lines;
    if (!Array.isArray(lines)) return [];
    return lines.map((line) => {
        const raw = line as { fullText?: unknown; translation?: unknown; songPart?: unknown; isChorus?: unknown };
        return {
            fullText: typeof raw?.fullText === 'string' ? raw.fullText : '',
            translation: typeof raw?.translation === 'string' ? raw.translation : '',
            songPart: typeof raw?.songPart === 'string' ? raw.songPart : '',
            isChorus: Boolean(raw?.isChorus),
        };
    });
};

const displaySong = () => selectDisplaySong(usePlaybackStore.getState());
const displayLyrics = () => selectDisplayLyrics(usePlaybackStore.getState());
const currentSongKey = () => songKeyOf(displaySong());
const currentLines = () => lyricLinesOf(displayLyrics());

// ------------------------------------------------------------------ runtime

let busy = false;
let inFlightSongKey: string | null = null;
let pendingSongKey: string | null = null;
let pendingForce = false;
let prefetchedSongKey: string | null = null;
let awaitingLyricsSongKey: string | null = null;
let lyricsTimer: ReturnType<typeof setTimeout> | null = null;
let lastReason = '';
let lastSummary = '';
let aiTarget: AiCompletionTarget | null = null;
let aiKnown = false;
/*
 * 「这台机器发不出去 AI 请求」已经确认过一次。
 *
 * 缓存命中的那次根本走不到生成，所以这个标记**不挡** requestStage —— 它只挡
 * 提示：自动切歌这条路没有调用方在等结果，弹出来的「失败」既没人请求也没法处理，
 * 每切一首歌来一遍。手动点「重新决策」的人不一样，他要的就是反馈 —— 那种情况由
 * 调用方拿 `unavailable` 自己弹。
 */
let aiUnavailable = false;
const inFlight = new Set<AbortController>();
const listeners = new Set<() => void>();

const translate = (key: string) => i18n.t(key) as string;

let runtimeSnapshot: DirectorRuntime = buildRuntime();

function buildRuntime(): DirectorRuntime {
    const state = useVisualizerSettingsStore.getState();
    const mode = typeof state?.visualizerMode === 'string' ? state.visualizerMode : 'classic';
    return {
        busy,
        lastSummary,
        lastReason,
        currentMode: mode,
        currentModeLabel: modeLabel(mode, translate),
        aiKnown,
        aiTarget,
    };
}

const refreshRuntime = () => {
    runtimeSnapshot = buildRuntime();
    listeners.forEach((listener) => {
        try {
            listener();
        } catch {
            /* a broken listener must not stop the others */
        }
    });
};

export const subscribeDirectorRuntime = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

export const getDirectorRuntime = (): DirectorRuntime => runtimeSnapshot;

/** Reads what Settings → AI is set to. Never throws: a missing key is a state to show. */
export const refreshDirectorAiStatus = (): void => {
    try {
        aiTarget = describeAiTarget();
    } catch {
        aiTarget = null;
    }
    aiKnown = true;
    /* 设置刚被改过：上一次的「不可用」结论可能已经过期，给一次重新尝试的机会。 */
    aiUnavailable = false;
    refreshRuntime();
};

// ------------------------------------------------------------------ applying

const currentModeOf = (state: VisualizerState): string => (
    typeof state?.visualizerMode === 'string' ? state.visualizerMode : 'classic'
);

/* An id the registry does not know is a hallucination; a mode the user blocked is
 * one the AI was never shown, so an answer naming it is treated the same way —
 * both degrade to the mode that is already playing. */
const validatedMode = (mode: unknown, fallback: string, blockedModes: readonly string[] = []): string => {
    const candidate = typeof mode === 'string' ? mode.trim() : '';
    if (isKnownDirectorMode(candidate) && !isBlockedDirectorMode(candidate, blockedModes)) return candidate;
    return fallback;
};

interface ApplyResult {
    mode: string;
    applied: string[];
}

const applyDecision = (
    decision: { mode?: unknown; params?: unknown },
    options: { applyParams: boolean; blockedModes: readonly string[] },
): ApplyResult => {
    const state = useVisualizerSettingsStore.getState();
    const previousMode = currentModeOf(state);
    const mode = validatedMode(decision?.mode, previousMode, options.blockedModes);
    const label = modeLabel(mode, translate);
    const applied: string[] = [];

    if (mode !== previousMode) {
        // notify:false keeps the store from stacking its own toast on top of ours.
        state.handleSetVisualizerMode(mode, { notify: false });
        applied.push(translate('aiDirector.lineMode').replace('{{label}}', label));
    } else {
        // Report the pick even when it agrees with the player: a summary with no
        // mode line reads as "it never chose a mode".
        applied.push(translate('aiDirector.lineModeUnchanged').replace('{{label}}', label));
    }
    if (!options.applyParams) return { mode, applied };

    const spec = MODE_PARAMS[mode];
    const raw = state as unknown as Record<string, unknown>;
    if (!spec || !spec.setter || typeof raw[spec.setter] !== 'function') return { mode, applied };

    const patch = sanitizeParams(mode, decision?.params);
    if (Object.keys(patch).length === 0) return { mode, applied };

    const tuningKey = tuningStateKey(spec.setter);
    const currentTuning = (tuningKey ? raw[tuningKey] : null) as Record<string, unknown> | null;

    /* A value behind a closed switch changes nothing on screen, so open the gate
     * in the same write — but only when opening it actually unblocks the value,
     * and never for a switch the AI spoke about itself. */
    const requested = Object.keys(patch);
    const openedFor = new Set<string>();
    requested.forEach((key) => {
        if (isInertValue(spec.params[key], patch[key])) return;
        const gates = gatesFor(mode, key);
        if (gates.length === 0) return;
        const preview = { ...(currentTuning ?? {}), ...patch };
        if (gates.every((gate) => gateSatisfied(preview, gate))) return;
        const injectable = gates.filter((gate) => !gateSatisfied(preview, gate));
        if (injectable.some((gate) => gate.key in patch)) return; // the AI decided this switch
        const trial = { ...preview };
        injectable.forEach((gate) => {
            trial[gate.key] = gate.setTo ?? gate.mustBe;
        });
        if (!gates.every((gate) => gateSatisfied(trial, gate))) return; // opening it would not help
        injectable.forEach((gate) => {
            patch[gate.key] = gate.setTo ?? gate.mustBe;
        });
        openedFor.add(key);
    });
    (raw[spec.setter] as (next: Record<string, unknown>) => void)(patch);

    /* Read the values back from a FRESH state: the setters call the store's own
     * `set`, which replaces the state object, so the snapshot above holds the old
     * tuning. Cappella rewrites a custom emoji pack to builtin when none is
     * uploaded, and partita sorts the stagger pair — reporting the request would
     * claim a value the store does not hold. */
    const afterState = useVisualizerSettingsStore.getState() as unknown as Record<string, unknown>;
    const storedTuning = tuningKey && afterState?.[tuningKey] && typeof afterState[tuningKey] === 'object'
        ? afterState[tuningKey] as Record<string, unknown>
        : null;
    const actualValueOf = (key: string): unknown => (
        storedTuning && key in storedTuning ? storedTuning[key] : patch[key]
    );
    const finalTuning = { ...(currentTuning ?? {}), ...patch, ...(storedTuning ?? {}) };

    requested.forEach((key) => {
        const zh = spec.params[key]?.zh ?? key;
        const inert = isInertValue(spec.params[key], patch[key]);
        const blocked = !inert && gatesFor(mode, key).some((gate) => !gateSatisfied(finalTuning, gate));
        const actual = actualValueOf(key);
        const rewritten = storedTuning !== null && key in storedTuning && storedTuning[key] !== patch[key];
        let suffix = '';
        if (blocked) suffix = translate('aiDirector.suffixBlocked');
        else if (openedFor.has(key)) suffix = translate('aiDirector.suffixGateOpened');
        if (rewritten) suffix += translate('aiDirector.suffixAdjusted');
        applied.push(`${zh}→${formatParamValue(actual)}${suffix}`);
    });
    return { mode, applied };
};

// ------------------------------------------------------------------ snapshot

const snapshotSettings = (): void => {
    const state = useVisualizerSettingsStore.getState() as unknown as Record<string, unknown>;
    if (!state) return;
    if (readSnapshot()) return;
    const tunings: Record<string, Record<string, unknown>> = {};
    Object.entries(MODE_PARAMS).forEach(([mode, spec]) => {
        const key = tuningStateKey(spec.setter);
        if (key && state[key] && typeof state[key] === 'object') {
            tunings[mode] = state[key] as Record<string, unknown>;
        }
    });
    writeSnapshotOnce({
        mode: currentModeOf(useVisualizerSettingsStore.getState()),
        tunings,
        at: Date.now(),
    });
};

/** Puts the mode and every tuning back to what they were before the first decision. */
export const restoreLyricDirectorSnapshot = (): string => {
    const snapshot = readSnapshot();
    if (!snapshot) return translate('aiDirector.restoreNone');
    const typed = useVisualizerSettingsStore.getState();
    const state = typed as unknown as Record<string, unknown>;
    if (typeof snapshot.mode === 'string') {
        typed.handleSetVisualizerMode(snapshot.mode as VisualizerMode, { notify: false });
    }
    Object.entries(snapshot.tunings ?? {}).forEach(([mode, tuning]) => {
        const setter = MODE_PARAMS[mode]?.setter;
        if (setter && typeof state[setter] === 'function' && tuning && typeof tuning === 'object') {
            (state[setter] as (next: Record<string, unknown>) => void)(tuning);
        }
    });
    return translate('aiDirector.restoreDone');
};

// ------------------------------------------------------------------ the request

/*
 * 动画决策走统一 stage 入口（services/aiStage.ts）。
 *
 * 切歌后主题那条链路通常已经先问过同一段歌词了 —— policy 由同一个函数算出来，指纹相同，
 * 这里直接命中它留下的结果，不再发第二次请求。以前这两件事是各自单独问一次模型的。
 *
 * 「按歌记住」现在由云缓存承担：命中缓存 = 沿用这首歌上次的答案，跨设备也一样。
 */
const requestDecision = async (input: {
    song: DirectorSongInfo | null;
    lines: DirectorLyricLine[];
    targetSongKey: string | null;
    force: boolean;
}): Promise<{
    decision: { mode: string; reason: string; params: Record<string, unknown> };
    source: AiCloudCacheSource;
    /** 这一趟有没有真的往云端写东西（false = 只是拿了进程里现成的答案）。 */
    contributed: boolean;
}> => {
    const settings = readDirectorSettings();
    /*
     * 请求自己不带中止，登记到 inFlight 里，好让 abortLyricDirectorRequests()
     * 在切歌时把它掐掉 —— 否则一首歌切走之后，上一次的判断还在路上，回来时
     * 会把结果画到已经换了的那首歌上。
     */
    const controller = new AbortController();
    inFlight.add(controller);
    try {
        const { decision, source, reused } = await requestStage({
            song: input.song,
            lines: input.lines,
            /* 没歌词就是纯音乐，和主题那条链路同一个判定 —— 指纹要对得上。 */
            isPureMusic: input.lines.length === 0,
            songTitle: input.song?.title ?? '',
            /* 平台名只跟着上传走，服务端拿它去核对歌词；没有就留空，由它逐个平台试。 */
            platform: input.song?.platform ?? '',
            hint: settings.userHint,
            blockedModes: settings.blockedModes,
            currentMode: currentModeOf(useVisualizerSettingsStore.getState()),
            /* 关掉「按歌记住」= 每次都重新问一次模型，不复用云缓存里那份旧答案。 */
            force: input.force || !settings.rememberPerSong,
            signal: controller.signal,
            require: 'decision',
        });
        if (!decision) throw new Error('AI 没有返回可用的动画决策。');
        return { decision, source, contributed: source !== 'cloud' && reused !== true };
    } finally {
        inFlight.delete(controller);
    }
};

const toast = (text: string, type: 'info' | 'success' | 'error') => {
    setStatusMessage({ type, text, nonce: Date.now() });
};

export const runLyricDirectorDecision = async (options: { announce?: boolean; force?: boolean; apply?: boolean } = {}): Promise<DirectorOutcome> => {
    const announce = options.announce !== false;
    const force = options.force === true;
    const settings = readDirectorSettings();
    /*
     * 「允许自动切换」只管**应用**，不管**生成**。
     *
     * 关掉它依然要把动画决策算出来传上云端 —— 否则这台机器白听一遍，别人撞上同一段
     * 歌词还是得重新烧一次调用。它挡的是「AI 能不能动我当前在用的样式」，不是「AI
     * 要不要想」。
     *
     * 但 `force` 是用户亲手点的「重新决策」—— 那一刻他要的就是换掉当前样式，
     * 不该被同一个开关挡在门外。
     */
    /*
     * 「随机动画」开着时，AI 自动给的那一个让位 —— 随机的那一票优先级更高。
     *
     * 两者干的都是「切歌时替你换一个样式」，同时开就会互相覆盖：AI 算完把样式改了，随机那
     * 一笔等于白掷一次，看上去就是「随机没生效」。所以自动这条路停手 —— 与上面那个开关关
     * 掉时一样，答案照样算、照样推上云端。
     *
     * 亲手点「重新决策」不受影响（`force`）：那一刻人是冲着 AI 的答案来的，不是被自动覆盖。
     *
     * 两个开关都开着时听谁的由「自动切换谁说了算」定（settings.autoDecisionPriority）：
     * 默认 AI 优先 —— AI 的答案覆盖随机那一票，随机兜 AI 没给的底；选「随机优先」才是
     * 上面注释里那条老规矩 —— 随机先定，AI 照算照上传但不应用。
     */
    const randomAnimation = useVisualizerSettingsStore.getState().randomVisualizerModePerSong === true;
    const randomPriority = randomAnimation && settings.autoDecisionPriority === 'random';
    const applyAllowed = options.apply !== false && (force || (!randomPriority && settings.autoOnSongChange));
    const songKey = currentSongKey();
    if (!songKey || !songInfoOf(displaySong())) return { kind: 'no-song' };

    const liveKey = currentSongKey();
    if (!liveKey || !songInfoOf(displaySong())) return { kind: 'no-song' };

    if (busy) {
        pendingSongKey = liveKey;
        pendingForce = pendingForce || force;
        return { kind: 'queued' };
    }

    busy = true;
    inFlightSongKey = liveKey;
    refreshRuntime();
    try {
        const { decision, contributed } = await requestDecision({
            song: songInfoOf(displaySong()),
            lines: currentLines(),
            targetSongKey: liveKey,
            force,
        });

        /* The track changed while the AI was thinking: this answer describes a
         * song that is no longer playing, so it is dropped rather than painted
         * onto the new one. It stays in the cloud cache under *that* song's
         * fingerprint, so the next play comes back for free. */
        const nowKey = currentSongKey();
        if (nowKey !== inFlightSongKey) {
            return { kind: 'stale' };
        }

        /*
         * 上传那条提示**不看**「允许自动切换」。
         *
         * 那个开关挡的是「AI 能不能动我当前在用的样式」，不是「AI 要不要算」—— 这条
         * 纪律上面已经说过一遍。答案照样推上云端了，那就照样该跟用户说一声。以前它跟
         * apply 绑在一起，于是关掉那个开关的人**永远看不到自己贡献了什么**，明明每首
         * 歌都在替别人烧调用。
         */
        /*
         * 只有**这一趟真的往云端写了东西**才说感谢。
         *
         * 切走再切回来时，这首歌的答案还在进程内的 recent 里，问一次直接拿现成的 ——
         * `source` 沿用的是当初那次的 'ai'（那句注释见 aiStage.readRecent），可这一趟
         * 一个字节都没上传。照着 source 判就会把「上传成功，感谢你的贡献」再说一遍。
         */
        if (announce && contributed) toast(translate('aiDirector.toastUploaded'), 'success');

        /* 开关关着：答案已经躺在云端了，别动用户手上的样式。 */
        if (!applyAllowed) {
            // 让位给「随机动画」也得说出来：否则导演面板上停着上一次的说明，看上去像这一趟
            // 什么都没发生（其实答案已经算出来并推上云端了）。
            if (randomPriority) {
                lastSummary = translate('aiDirector.randomWins');
                lastReason = '';
                refreshRuntime();
            }
            return { kind: 'produced', text: decision.reason };
        }

        snapshotSettings();
        const result = applyDecision(decision, {
            applyParams: settings.applyParams,
            blockedModes: settings.blockedModes,
        });
        lastReason = typeof decision?.reason === 'string' ? decision.reason : '';
        lastSummary = result.applied.length > 0
            ? result.applied.join('，')
            : translate('aiDirector.nothingToChange');
        noteRecentMode(result.mode);
        const text = `${lastSummary}${lastReason ? `（${lastReason}）` : ''}`;
        refreshRuntime();
        /*
         * 跑完这次，主题与动画决策已经推上云端了 —— 下一个人撞到同一段歌词
         * 就是白捡。所以提示说的是「上传成功，感谢你的贡献」，而不是把
         * 模型那串理由贴出来；理由在导演面板里还看得到。
         *
         * 命中缓存那次一个字节都没上传，也就不能说「上传成功」—— 那正是
         * 云缓存替用户省掉的那次调用。
         */
        return { kind: 'applied', text };
    } catch (error) {
        /*
         * 「没配 AI」不是失败，是这台机器根本发不出去。
         *
         * 云缓存的用处就是让没配密钥的人白拿别人生成好的结果：缓存里有动画决策时
         * 他照常切换样式；缓存里只有主题（部署端点那条路只出主题）时他这一半天生
         * 拿不到 —— 那不是这一次出了问题，是重来多少次都一样。
         *
         * 自动切歌这条路上没人等结果，弹一条「AI 导演失败」既不是用户要的，也没人
         * 处理；手动点的那种由调用方拿 kind:'unavailable' 自己说。
         */
        if (isAiNotConfiguredError(error)) {
            aiUnavailable = true;
            lastSummary = translate('aiDirector.unavailable');
            lastReason = '';
            refreshRuntime();
            return { kind: 'unavailable', text: '' };
        }
        const message = translateAiCompletionError(String((error as Error)?.message ?? error));
        lastSummary = `${translate('aiDirector.failed')}${message}`;
        lastReason = '';
        refreshRuntime();
        if (announce) toast(translate('aiDirector.toastFailed').replace('{{text}}', message), 'error');
        return { kind: 'failed', text: message };
    } finally {
        busy = false;
        inFlightSongKey = null;
        refreshRuntime();
        if (pendingSongKey !== null) {
            const queued = pendingSongKey;
            const queuedForce = pendingForce;
            pendingSongKey = null;
            pendingForce = false;
            if (queued === currentSongKey()) {
                void runLyricDirectorDecision({ announce: true, force: queuedForce });
            }
        } else {
            void prefetchNextSong();
        }
    }
};

// ------------------------------------------------------------------ prefetch

/* The complaint this solves: the first seconds of a track played under the
 * previous song's animation, because a decision only started once the song was
 * already on screen. The next queued track is prepared ahead of time and stored
 * in its memory; when it starts, the decision above finds the entry at once.
 * Only the *memory* is written here — a queued song is not on screen yet. */
const nextQueuedSong = (): unknown => {
    const state = usePlaybackStore.getState();
    const queue = Array.isArray(state?.playQueue) ? state.playQueue : null;
    const current = state?.currentSong ?? null;
    if (!queue || queue.length === 0 || !current) return null;
    const currentKey = songKeyOf(current);
    const index = queue.findIndex((song) => songKeyOf(song) === currentKey);
    const lastIndex = queue.length - 1;
    if (index >= 0 && index < lastIndex) return queue[index + 1] ?? null;
    if (index < 0) return queue[0] ?? null;
    const loopMode = useAudioSettingsStore.getState()?.loopMode;
    return loopMode === 'all' ? (queue[0] ?? null) : null;
};

/*
 * 下一首的歌词行 —— **优先用预取服务手里那份**。
 *
 * 播放时真正显示的就是它（onlinePlayback 直接吃 `prefetched.lyrics`）。另开一次
 * `omni.getLyrics` 拿到的未必是同一份：IndexedDB 里的缓存、自动最佳匹配、手动在线
 * 覆盖都会换掉它。指纹差一个字就是另一个键 —— 预取热好的是 A，真播那一刻查的是 B，
 * 于是「提前准备」在用户眼里等于没做、云缓存也像是没拉，其实两份答案都在，只是对不上。
 *
 * 预取那份读不出来（还没跑到、或者这首歌不是在线源）才回落到现取一次。
 */
const nextSongLyricLines = async (song: SongResult): Promise<DirectorLyricLine[]> => {
    try {
        const prefetched = getPrefetchedData(song);
        const lines = lyricLinesOf(prefetched?.lyrics);
        if (lines.length > 0) return lines;
        /*
         * 只有预取明确记下「这首是纯音乐」才算真的没有歌词。
         * 缓存里还没跑到这首歌时 lyrics 也是 null —— 那不是纯音乐，别拿歌名去当指纹。
         */
        if (prefetched?.lyricRaw?.isPureMusic === true) return [];
    } catch {
        /* 预取那份读不出来就当没有，回落到现取。 */
    }
    const result = await omni.getLyrics(song);
    return lyricLinesOf((result as { lyrics?: unknown } | null)?.lyrics);
};

const prefetchNextSong = async (): Promise<void> => {
    const settings = readDirectorSettings();
    if (!settings.prefetchNext) return;
    // 导演关着也要预先问 —— 见 scheduleLyricDirectorDecision 里那条纪律。
    if (!settings.autoOnSongChange && !readStoredThemeAutoGenerateEnabled()) return;
    /*
     * 「这台机器发不出**模型**请求」**不再**一票否决预取。
     *
     * 那个标记说的是模型，而预取要做的第一件事是**拉云缓存** —— 拉缓存不是模型调用，
     * 恰恰是没配密钥的人唯一能拿到答案的那条路。拿它当总闸，等于把最需要缓存的人挡在
     * 门外：他的下一首永远只能等到真播那一刻才现问一次，而问也问不出来。它还不轻易复位
     * （只在挂载与 AI 设置变更时），于是第一次失败之后整个会话的预取都死了。
     *
     * 云缓存也关着才真的没什么可预取的。缓存没命中时 `generate` 会在发出任何网络请求
     * 之前就抛「未配置」（aiCompletion 里那句 `if (!configured) throw`），白跑的代价是零。
     */
    if (aiUnavailable && !isFoliaCloudCacheEnabled()) return;
    if (busy) return; // never race the song that is on screen
    const song = nextQueuedSong();
    if (!song) return;
    const key = songKeyOf(song);
    if (!key || key === prefetchedSongKey) return;
    if (key === songKeyOf(displaySong())) return;
    if (!settings.rememberPerSong) return; // 关掉「按歌记住」就不预先问

    prefetchedSongKey = key;
    try {
        const lines = await nextSongLyricLines(song as SongResult);
        if (busy || songKeyOf(displaySong()) === key) return;
        /*
         * 纯音乐（没有歌词行）也要问：它的指纹是**歌名**，真播那一轮用的也是歌名，
         * 云缓存照样能命中。以前在这里直接 return，于是下一首是伴奏时永远现算一次。
         *
         * 预先问一次：答案由 requestStage 自己推进云端缓存与进程内缓存，等这首歌真正
         * 开始播放时，导演链路按同一个指纹命中它，就不用再等一次模型了。
         * 本地不再落盘 —— 结果只有一份，存在云端。
         */
        const { contributed } = await requestDecision({
            song: songInfoOf(song),
            lines,
            targetSongKey: key,
            force: false,
        });
        /*
         * 提前这一趟也要说一声 —— **但只在这一趟真上传了的时候**。
         *
         * 它真的把下一首的答案推上云端了 —— 那正是「感谢你的贡献」要说的事，跟切歌
         * 那条路一样。命中缓存的那次一个字节都没上传，也就不能说感谢。
         *
         * 「命中缓存」也包括**进程内**那一层：播 A 时预取过 B，切到 B 再切回 A，B 又
         * 成了下一首，而它的答案还躺在 recent 里、且云端已经有了 —— 这一趟是白拿，
         * 不该再报一次「已提前为下一首生成并上传」。这就是用户看到的「提示两遍」。
         */
        if (contributed) toast(translate('aiDirector.toastPrefetchUploaded'), 'success');
    } catch (error) {
        /*
         * 「没配 AI」不是这次运气不好，是这台机器的固定状态 —— 留着标记，别每切一首歌
         * 都重试一次。其它错误才清掉，好让这一首还有下一次机会。
         */
        if (!isAiNotConfiguredError(error)) prefetchedSongKey = null;
    }
};

// ------------------------------------------------------------------ scheduling

/* The auto decision waits for the lyrics instead of running on a fixed delay:
 * lyrics arrive after the song does, and deciding before they land would send
 * "(这首歌没有歌词)" for a song that has them. The fallback timer covers tracks
 * whose lyrics never come. */
export const scheduleLyricDirectorDecision = (): void => {
    const settings = readDirectorSettings();
    /*
     * 生成**不看**「允许自动切换」这个开关。
     *
     * 它挡的是「AI 能不能改我当前在用的主题 / 动画」，不是「AI 要不要算」。算出来传上
     * 云端，下一个人撞上同一段歌词就能白拿 —— 这才是云缓存的意义。所以只要导演开着
     * **或者**主题自动生成开着，这一轮就得跑；两个都关才真的不必问模型。
     */
    if (!settings.autoOnSongChange && !readStoredThemeAutoGenerateEnabled()) return;
    if (lyricsTimer !== null) {
        clearTimeout(lyricsTimer);
        lyricsTimer = null;
    }
    const key = currentSongKey();
    if (!key || !songInfoOf(displaySong())) {
        awaitingLyricsSongKey = null;
        return;
    }
    const decide = () => {
        lyricsTimer = null;
        awaitingLyricsSongKey = null;
        void runLyricDirectorDecision({ announce: true });
    };
    if (currentLines().length > 0) {
        lyricsTimer = setTimeout(decide, LYRICS_SETTLE_MS);
        return;
    }
    awaitingLyricsSongKey = key;
    lyricsTimer = setTimeout(decide, LYRICS_WAIT_FALLBACK_MS);
};

/** Called when lyrics land while a decision is waiting for them. */
export const notifyLyricDirectorLyricsLoaded = (): void => {
    if (awaitingLyricsSongKey === null) return;
    if (currentLines().length === 0) return;
    awaitingLyricsSongKey = null;
    if (lyricsTimer !== null) {
        clearTimeout(lyricsTimer);
        lyricsTimer = null;
    }
    lyricsTimer = setTimeout(() => {
        lyricsTimer = null;
        void runLyricDirectorDecision({ announce: true });
    }, LYRICS_SETTLE_MS);
};

/** A new track is on screen: whatever was prepared for the queue is stale now. */
export const notifyLyricDirectorSongChanged = (): void => {
    prefetchedSongKey = null;
    scheduleLyricDirectorDecision();
};

export const abortLyricDirectorRequests = (): void => {
    if (lyricsTimer !== null) {
        clearTimeout(lyricsTimer);
        lyricsTimer = null;
    }
    awaitingLyricsSongKey = null;
    inFlight.forEach((controller) => {
        try {
            controller.abort();
        } catch {
            /* already settled */
        }
    });
    inFlight.clear();
};

/** The song key the panel is talking about; null when nothing is on screen. */
export const currentDirectorSongKey = (): string | null => currentSongKey();

export const currentDirectorSong = (): DirectorSongInfo | null => songInfoOf(displaySong());
