import i18n from '../i18n/config';
import type { DualTheme } from '../types';
import { sanitizeDualTheme } from './themeSanitizer';
import { isPureMusicLyricText } from '../utils/lyrics/pureMusic';
import { THEME_GENERATION_STAGE_PREFIX, buildThemeSourcePrompt } from '../utils/aiThemePrompts';
import {
    fingerprintLyricSource,
    type AiCloudCacheSource,
} from './aiCloudCache';
import { requestAiCompletion } from './aiCompletion';
import {
    isBlockedDirectorMode,
    isKnownDirectorMode,
    listDirectorModes,
    sanitizeParams,
    type DirectorModeInfo,
} from './lyricDirector/catalog';
import {
    REASON_MAX_CHARS,
    buildLyricSnippet,
    buildSourcePrompt,
    buildSystemPrompt,
    extractJsonText,
    type DirectorLyricLine,
    type DirectorPreviousChoice,
    type DirectorSongInfo,
} from './lyricDirector/prompt';
import { readDirectorSettings, readRecentModes } from './lyricDirector/state';
import { setStatusMessage } from '../stores/useStatusMessageStore';
import { createStageRuntime } from './stageCache/runtime';
export { subscribeStageUpdates, StageCacheMissError, setProtectedStageKeys, subscribeStageCacheDiagnostics,
    type StageUpdate, type StageCacheDiagnostic } from './stageCache/runtime';

// src/services/aiStage.ts
// 一次 AI 调用，两份答案：视觉主题 + 歌词动画决策。
//
// 以前这两件事是分开问的 —— 主题一条请求、动画导演另一条，切一首歌烧两次模型调用，
// 两次喂的都是同一段歌词。合并之后一次往返就把「这首歌长什么样、歌词怎么动」都定下来，
// 云端也只留一条缓存（kind='stage'），拉一次两条链路都用。
//
// 缓存里的东西**一律当不可信输入**：它从任何人都能推的服务器来，形状不对就跟没命中一样。

export const STAGE_CACHE_KIND = 'stage';

/** 主题 JSON 与动画 JSON 一起出，输出上限按更占地方的那份给。 */
const STAGE_MAX_TOKENS = 8192;

const translate = (key: string): string => i18n.t(key) as string;

const isRecord = (value: unknown): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isThemeShaped = (value: unknown): boolean => (
    isRecord(value) && typeof value.backgroundColor === 'string' && typeof value.primaryColor === 'string'
);

export interface StageDecision {
    mode: string;
    reason: string;
    params: Record<string, unknown>;
}

/**
 * 一份 stage 答案的两半。都可选 —— 模型偶尔只答出一半，或者缓存里的条目是早期版本推的。
 * 缺的那一半由调用方决定要不要重新问：`require` 指明这次到底离不开哪一半。
 */
export interface StageParts {
    theme?: DualTheme;
    decision?: StageDecision;
}

export type StageRequirement = 'theme' | 'decision' | 'both';

export interface StageRequest {
    song?: DirectorSongInfo | null;
    /**
     * 这首歌来自哪个音乐平台（netease / qq / kugou …）。本地歌曲没有，留空即可。
     * 只跟着上传走：服务端拿它去对应平台核对歌词，键仍然是那个 MD5。
     */
    platform?: string;
    lines?: readonly StageLyricLine[];
    /** 纯音乐：喂给模型的应当是标题，不是歌词正文。不传就按「有没有歌词行」自己判。 */
    isPureMusic?: boolean;
    songTitle?: string;
    hint?: string;
    blockedModes?: readonly string[];
    currentMode?: string;
    /** 「重新判断」：缓存里的旧答案一律不看，直接生成。 */
    force?: boolean;
    /** 切歌时可以拿它掐掉还在飞的那次请求。 */
    signal?: AbortSignal;
    require?: StageRequirement;
    priority?: 'manual' | 'current' | 'next';
    cacheOnly?: boolean;
    isCurrent?: () => boolean;
    publicEligible?: boolean;
    /**
     * 答案从哪来。默认是「一次调用同时问主题与动画」；桌面版走 Electron 主进程时
     * 拿不到合并 prompt，由调用方自己给一个只产主题的实现。
     */
    generate?: (ctx: StageContext) => Promise<StageParts>;
}

export interface StageResult extends StageParts {
    source: AiCloudCacheSource;
}

const hasRequired = (parts: StageParts, require: StageRequirement): boolean => {
    if (require === 'theme') return Boolean(parts.theme);
    if (require === 'decision') return Boolean(parts.decision);
    return Boolean(parts.theme) && Boolean(parts.decision);
};

/*
 * 歌词行的最小形状 —— 指纹只用到正文。
 *
 * 主题那条链路拿的是 `LyricData.lines`，导演那条拿的是 `DirectorLyricLine[]`，
 * 两边字段集并不一样；这里只要能拼出正文就够了，别把类型绑死在任一边。
 */
export type StageLyricLine = { fullText?: string };

/**
 * 「喂给模型的那段歌词」—— 缓存指纹与提示词共用这一个结果。
 *
 * 两条链路必须算出同一个值，否则指纹不同、缓存永远命中不了，合并也就白合并了。
 * 所以纯音乐的判定收在这里：`isPureMusic` 一旦为真，喂进去的就是标题而不是空歌词。
 */
export const resolveStageLyricSource = (input: {
    lines?: readonly StageLyricLine[];
    isPureMusic?: boolean;
    songTitle?: string;
}): { lyricSource: string; isPureMusic: boolean } => {
    const lines = input.lines ?? [];
    const allText = lines
        .map((line) => String((line as { fullText?: unknown } | null | undefined)?.fullText ?? ''))
        .join('\n')
        .trim();
    const isPureMusic = input.isPureMusic === true || lines.length === 0 || isPureMusicLyricText(allText);
    return {
        lyricSource: isPureMusic ? String(input.songTitle ?? '').trim() : allText,
        isPureMusic,
    };
};

/**
 * 缓存键里那一段「设置」。
 *
 * 只按歌词做键不够：屏蔽了某个样式、或者改了偏好提示之后，同一份歌词的最优答案会变。
 * 这些都并进 policy，设置一改就重新问，不会拿到上一个设置下的旧答案。
 *
 * 候选模式列表**不进** policy —— 它跟着「最近用过的样式」漂，进去会让同一首歌每次算出
 * 不同的键，缓存反而永远命中不了。
 */
export const buildStagePolicy = (options: {
    isPureMusic?: boolean;
    hint?: string;
    blocked?: readonly string[];
} = {}): string => JSON.stringify({
    pure: options.isPureMusic === true,
    hint: String(options.hint ?? '').trim(),
    blocked: [...(options.blocked ?? [])].map(String).sort(),
});

export const fingerprintStage = (lyricSource: string, policy: string): string => (
    fingerprintLyricSource(STAGE_CACHE_KIND, lyricSource, policy)
);

/* 主题那半用「舞台版」契约：主题整体收进 "theme" 键，旁边并列 mode / reason / params。 */
export const buildStageSystemPrompt = (hint?: string): string => [
    THEME_GENERATION_STAGE_PREFIX,
    '',
    '除了上面这套主题，这一轮还要顺带定下歌词的动画 —— 两份答案放进同一个 JSON 一起返回。',
    '',
    buildSystemPrompt(hint),
].join('\n');

/*
 * 歌词只发一次，放在整段提示的最后。
 *
 * 主题那半和动画那半都要看歌词，各发一份就是同样的字交两遍、输入直接翻倍。所以导演那份
 * 用 `includeLyrics: false` 关掉自己的歌词段，由这里统一补一次。
 */
export const buildStageSourcePrompt = (input: {
    snippet: string;
    isPureMusic: boolean;
    songTitle?: string;
    song: DirectorSongInfo | null;
    lines: readonly DirectorLyricLine[];
    modes: DirectorModeInfo[];
    currentMode: string;
    hint?: string;
    recentModes?: readonly string[];
    previousChoice?: DirectorPreviousChoice | null;
    blockedModes?: readonly string[];
}): string => ([
    buildThemeSourcePrompt(input.snippet, input.isPureMusic, input.songTitle),
    '',
    buildSourcePrompt({
        song: input.song,
        lines: input.lines as DirectorLyricLine[],
        modes: input.modes,
        currentMode: input.currentMode,
        userHint: input.hint,
        recentModes: input.recentModes as string[] | undefined,
        previousChoice: input.previousChoice,
        blockedModes: input.blockedModes,
        includeLyrics: false,
    }),
    '',
    '歌词片段：',
    buildLyricSnippet(input.lines as DirectorLyricLine[]),
].join('\n'));

const normalizeTheme = (value: unknown): DualTheme | null => (
    isRecord(value) && isThemeShaped(value.light) && isThemeShaped(value.dark)
        ? sanitizeDualTheme(value as unknown as DualTheme)
        : null
);

/** 缓存里的动画决策也要过一遍目录：不认识的 id、本机屏蔽掉的样式，都当没有。 */
const normalizeDecision = (
    raw: unknown,
    blockedModes: readonly string[],
): StageDecision | null => {
    if (!isRecord(raw)) return null;
    if (typeof raw.mode !== 'string' || !raw.mode.trim()) return null;
    const mode = raw.mode.trim();
    if (!isKnownDirectorMode(mode)) return null;
    if (isBlockedDirectorMode(mode, blockedModes)) return null;
    return {
        mode,
        reason: typeof raw.reason === 'string' ? raw.reason.slice(0, REASON_MAX_CHARS) : '',
        params: sanitizeParams(mode, raw.params),
    };
};

export const normalizeStagePayload = (
    payload: unknown,
    blockedModes: readonly string[],
): StageParts | null => {
    if (!isRecord(payload)) return null;
    const theme = normalizeTheme(payload.theme) ?? undefined;
    /*
     * 动画决策有两种来处，形状不一样：
     *  - 模型刚答出来的：mode / reason / params 与 theme 并列在顶层；
     *  - 缓存条目里的：已经收进 decision 那半。
     *
     * 以前只认前一种。于是任何人推上去的决策，被下一个人拉回来时一律认成
     * 「没有决策」—— 导演链路 require:'decision' 因此永远判成未命中，每切一首歌
     * 都重新问一次模型；没配密钥的人每次都撞一次「AI 导演失败」，而缓存里明明
     * 躺着别人做好的那一份。
     */
    const decision = normalizeDecision(payload.decision ?? payload, blockedModes) ?? undefined;
    /* 两半都没认出来 = 脏数据，当没命中。 */
    if (!theme && !decision) return null;
    return { ...(theme ? { theme } : {}), ...(decision ? { decision } : {}) };
};

export type StageContext = {
    fingerprint: string;
    requirement: StageRequirement;
    system: string;
    prompt: string;
    blockedModes: readonly string[];
    songTitle: string;
    /** 参与指纹的那段歌词正文（纯音乐时是歌名）。 */
    lyricSource: string;
    isPureMusic: boolean;
    /** 平台名，本地歌曲为空串。 */
    platform: string;
    skipPull: boolean;
    signal?: AbortSignal;
    generate?: (ctx: StageContext) => Promise<StageParts>;
};

const buildStageContext = (request: StageRequest): StageContext => {
    const settings = readDirectorSettings();
    const hint = request.hint ?? settings.userHint ?? '';
    const blockedModes = request.blockedModes ?? settings.blockedModes ?? [];
    const lines = (request.lines ?? []) as DirectorLyricLine[];
    const song = request.song ?? null;

    /* 两条链路都从这里取歌词正文与纯音乐标记，指纹才可能对上。 */
    const { lyricSource, isPureMusic } = resolveStageLyricSource({
        lines,
        isPureMusic: request.isPureMusic,
        songTitle: request.songTitle ?? song?.title ?? '',
    });

    const modes = listDirectorModes(translate)
        .filter((mode) => !isBlockedDirectorMode(mode.id, blockedModes));
    const policy = buildStagePolicy({ isPureMusic, hint, blocked: blockedModes });

    return {
        fingerprint: fingerprintStage(lyricSource, policy),
        requirement: request.require ?? 'both',
        system: buildStageSystemPrompt(hint),
        prompt: buildStageSourcePrompt({
            snippet: lyricSource,
            isPureMusic,
            songTitle: request.songTitle ?? song?.title,
            song,
            lines,
            modes,
            currentMode: request.currentMode ?? '',
            hint,
            /*
             * 最近用过的样式由这里统一读，两条链路不再各自传 —— 提示词一模一样，
             * 谁先触发都用同一份 prompt，结果也就能被另一条链路直接复用。
             */
            recentModes: readRecentModes(),
            blockedModes,
        }),
        blockedModes,
        songTitle: song?.title ?? '',
        lyricSource,
        isPureMusic,
        platform: String(request.platform ?? '').trim(),
        skipPull: request.force === true,
        signal: request.signal,
        generate: request.generate,
    };
};

const parseJsonAnswer = (text: string): unknown => {
    try {
        return JSON.parse(extractJsonText(text));
    } catch (error) {
        throw new Error(`AI 返回的内容无法解析为 JSON：${String((error as Error)?.message ?? error)}`);
    }
};

/**
 * 把两份 stage 答案并成一份，新的优先。
 *
 * 部署端点与 Electron 那条路只能出主题，它们拿到的「新答案」天生只有半份。整条覆盖
 * 会把云端已有的动画决策抹掉 —— 之后不管谁拉这条，动画那半永远是空的，导演于是再也
 * 不切换样式，而缓存里明明放着别人做好的那一份。
 *
 * 所以回传前先把已有的那半捞回来：这条条目始终是「到目前为止知道的全部」。
 *
 * `previous` 是缓存里的原始内容，一律当不可信输入 —— 照样过一遍校验，脏数据不跟着回传。
 */
export const combineStageParts = (
    previous: unknown,
    fresh: StageParts,
    blockedModes: readonly string[] = [],
): StageParts => {
    const known = normalizeStagePayload(previous, blockedModes) ?? {};
    const theme = fresh.theme ?? known.theme;
    const decision = fresh.decision ?? known.decision;
    return {
        ...(theme ? { theme } : {}),
        ...(decision ? { decision } : {}),
    };
};

/** 一次调用问两件事：主题 + 歌词动画。 */
export const generateStage = async (ctx: StageContext): Promise<StageParts> => {
    const { text } = await requestAiCompletion({
        system: ctx.system,
        prompt: ctx.prompt,
        maxTokens: STAGE_MAX_TOKENS,
        json: true,
        signal: ctx.signal,
    });
    const parts = normalizeStagePayload(parseJsonAnswer(text), ctx.blockedModes);
    if (!parts) throw new Error('AI 返回的内容里没有可用的主题或动画决策。');
    return parts;
};

const stageRuntime = createStageRuntime(payload => normalizeStagePayload(payload, []));
export const restorePersistentStage = stageRuntime.restore;
export const rollbackStageUpdate = stageRuntime.rollback;
export const acceptStageUpdate = stageRuntime.acceptUpdate;

export const notifyStageResolved = (source: AiCloudCacheSource): void => {
    setStatusMessage({ type: 'info', text: translate(source === 'local' ? 'stageCache.localHit' : source === 'cloud' ? 'options.cloudCacheHit' : 'stageCache.generated'), nonce: Date.now() });
};

/** 所有消费者共享歌曲身份、持久缓存及单生成调度，播放提交权留给调用者。 */
export const requestStage = async (request: StageRequest): Promise<StageResult> => {
    const ctx = buildStageContext(request);
    const result = await stageRuntime.resolve({ ...request, hint: request.hint ?? readDirectorSettings().userHint,
        priority: request.priority ?? (request.force ? 'manual' : 'current') }, ctx.fingerprint, async () => {
        setStatusMessage({ type: 'info', text: translate('stageCache.generating'), nonce: Date.now() });
        // 共享生成不继承某个消费者的取消信号，底层真正结束前一直占用生成槽。
        return (ctx.generate ?? generateStage)({ ...ctx, signal: AbortSignal.timeout(180_000) });
    });
    const parts = normalizeStagePayload(result, []);
    if (!parts || !hasRequired(parts, ctx.requirement)) throw new Error('No usable visual stage for this consumer');
    return { ...parts, source: result.source };
};
