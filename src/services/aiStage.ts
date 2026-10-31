import i18n from '../i18n/config';
import type { DualTheme } from '../types';
import { sanitizeDualTheme } from './themeSanitizer';
import { isPureMusicLyricText } from '../utils/lyrics/pureMusic';
import { THEME_GENERATION_STAGE_PREFIX, buildThemeSourcePrompt } from '../utils/aiThemePrompts';
import {
    fingerprintLyricSource,
    pullAiCloudCache,
    pushAiCloudCache,
    withAiCloudCache,
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
import { isFoliaCloudCacheEnabled } from './foliaCloud';
import { setStatusMessage } from '../stores/useStatusMessageStore';
import { md5 } from '../utils/md5';

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
/** 同一首歌刚问过就别再问 —— 切歌后主题与导演会各触发一次，指纹相同。 */
const RECENT_TTL_MS = 10 * 60 * 1000;
const RECENT_MAX_ENTRIES = 32;

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
    /**
     * 答案从哪来。默认是「一次调用同时问主题与动画」；桌面版走 Electron 主进程时
     * 拿不到合并 prompt，由调用方自己给一个只产主题的实现。
     */
    generate?: (ctx: StageContext) => Promise<StageParts>;
}

export interface StageResult extends StageParts {
    source: AiCloudCacheSource;
    /**
     * 这一趟是「拿来主义」：答案直接从进程内取到（最近结果、或蹭了在飞的那次请求），
     * **这次调用既没调模型、也没往云端写一个字节**。
     *
     * `source` 说的是「这份答案当初是哪来的」（进程内命中时沿用那一次真实的来源，
     * 见 readRecent 上的注释），它回答不了「这一趟有没有真的贡献」—— 而「上传成功，
     * 感谢你的贡献」「已提前为下一首生成并上传」这两句问的正是后者。少了这个标记，
     * 同一首歌第二次问（切走再切回来、预取过的下一首再预取一次）会把那句感谢再说
     * 一遍，其实那趟什么都没上传。
     */
    reused?: boolean;
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
        /*
         * 歌名跟着「请求里给了就用请求里的」这条规矩走：有的调用方（比如从搜索结果里
         * 直接播一首）只给 songTitle、不给整首 song。以前这里只读 `song?.title`，
         * 于是那条链路的 songTitle 是空串 —— 云缓存按歌名找候选直接短路（见
         * aiCloudCache 的「第二次机会」），表现为「明明库里有答案，就是拉不到」，
         * 推上去的条目也带着空歌名，之后再也没人找得到它。
         */
        songTitle: request.songTitle ?? song?.title ?? '',
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

/*
 * 进程内的两级去重 —— 这是「合并成一次请求」真正落地的地方。
 *
 * 切歌后主题链路（650ms 后）与导演链路（等歌词 250ms 后）都会调进来，指纹又是同一个
 * （policy 与歌词正文都由上面那两个函数统一算）。没有这层就会打两次模型：
 *  - 在飞：后到的那个 await 同一个 Promise，只发一次请求；
 *  - 最近结果：前一次刚算完，后一次直接取答案，连缓存接口都不必再问。
 *
 * 两条链路谁先到都一样：先到的那次既拿到了主题也拿到了动画决策，后到的直接复用
 * 自己需要的那一半。
 *
 * 命中这一层时**沿用那次真实的来源**，不能一律说成「云端」。这台机器刚自己算出来的
 * 答案被标成 cloud，界面就会对刚生成完的用户说「已从云端拉取缓存」—— 而那一句本来
 * 是留给「这会儿没调模型、用的是别人推的那份」的。
 */
const inFlight = new Map<string, Promise<StageResult>>();
const recent = new Map<string, { parts: StageParts; at: number; source: AiCloudCacheSource }>();

const readRecent = (
    fingerprint: string,
): { parts: StageParts; source: AiCloudCacheSource } | null => {
    const entry = recent.get(fingerprint);
    if (!entry) return null;
    if (Date.now() - entry.at > RECENT_TTL_MS) {
        recent.delete(fingerprint);
        return null;
    }
    return { parts: entry.parts, source: entry.source };
};

const rememberRecent = (
    fingerprint: string,
    parts: StageParts,
    source: AiCloudCacheSource,
): void => {
    recent.delete(fingerprint);
    recent.set(fingerprint, { parts, at: Date.now(), source });
    while (recent.size > RECENT_MAX_ENTRIES) {
        const oldest = recent.keys().next();
        if (oldest.done) break;
        recent.delete(oldest.value);
    }
};

/**
 * 结果来源提示：生成完一条，命中时另一条。
 *
 * 命中时结果来得很突然 —— 界面上只会看到主题一瞬间变了，既没有「生成中」也没有
 * 任何说明。三条文案互斥，由 `source` 选，不会出现连着弹两次的情况。
 *
 * 本地那一层（`'local'`）单独一句：它确实没发请求，说「已从云端拉取缓存」是假话。
 *
 * 放在这里（而不是服务内部），是因为同一次请求可能被主题、导演两条链路复用：
 * 弹提示是「告知用户」这种只有调用方知道该不该做的事。
 */
export const notifyStageResolved = (source: AiCloudCacheSource): void => {
    const text = source === 'local'
        ? 'options.cloudCacheHitLocal'
        : source === 'cloud'
            ? 'options.cloudCacheHit'
            : 'status.themeGenerated';
    setStatusMessage({
        type: 'info',
        text: translate(text),
        nonce: Date.now(),
    });
};

/** 先问云端，没有（或不全）再生成，生成完回传。一次往返，一条缓存。 */
const resolveStage = async (ctx: StageContext): Promise<StageResult> => {
    const { value, source } = await withAiCloudCache({
        kind: STAGE_CACHE_KIND,
        fingerprint: ctx.fingerprint,
        generate: () => (ctx.generate ?? generateStage)(ctx),
        skipPull: ctx.skipPull,
        /* 缺了要用的那一半就跟没命中一样，重新生成一份完整的。 */
        validate: (payload) => {
            const parts = normalizeStagePayload(payload, ctx.blockedModes);
            return parts && hasRequired(parts, ctx.requirement) ? parts : null;
        },
        /* 回传前先把云端已有的那半捞回来，别让只出一半的生成结果把它抹掉。 */
        combine: (previous, fresh) => combineStageParts(previous, fresh, ctx.blockedModes),
        songTitle: ctx.songTitle,
        /*
         * 平台名 + 歌词正文的哈希只给服务端校验用。
         *
         * 键是「歌词 + policy」的 MD5，policy（屏蔽的样式、自定义提示词）只有本机能算，
         * 服务端复现不出来 —— 所以另外给它一份纯歌词的哈希，它拿平台上的歌词原文件
         * 重算一遍就能对上。算不出来（比如没有歌词正文）就不带，服务端按无从校验放行。
         */
        platform: ctx.platform,
        lyricHash: ctx.lyricSource ? md5(ctx.lyricSource) : '',
        /*
         * 歌词正文只给「精确键没中」那一次兜底判定用，不跟着上传 —— 判定在本机做，
         * 服务端只按歌名回一批高亮词。
         */
        lyricText: ctx.lyricSource,
        isPureMusic: ctx.isPureMusic,
    });
    return { ...value, source };
};

/**
 * **只匹配一次**：问云端，命中就把答案交回来，**绝不生成**。
 *
 * 面板那颗同步按钮要的正是这个（见 hooks/useAiThemeCloudSync.ts）。它和主题生成走
 * **同一个键**（`buildStageContext` 算出来的那一个），于是「切歌时刚从云端匹配上主题」
 * 之后按下同步就一定还能匹配上 —— 以前那颗按钮查的是 `kind='theme'`（按歌名 + 歌手
 * 算键），跟主题真正存的地方根本不是一个键，于是明明刚匹配上却报「云端还没有这首的
 * 主题」，看上去像缓存坏了。
 *
 * 跳过生成是硬要求：没配 Key 的人按下同步只该是「没命中」，不该平白撞一次「AI 不可用」。
 *
 * 返回 `null` = 云端没有（或者那条缺了这次要的那一半）。
 */
export const matchStage = async (request: StageRequest): Promise<StageResult | null> => {
    if (!isFoliaCloudCacheEnabled()) return null;
    /* 「重新判断」就是要一份跟缓存里不一样的答案 —— 只问缓存的这条路无话可说。 */
    if (request.force === true) return null;

    const ctx = buildStageContext(request);
    const pulled = await pullAiCloudCache(STAGE_CACHE_KIND, ctx.fingerprint, {
        songTitle: ctx.songTitle,
        /* 纯音乐那半的「歌词」其实是歌名，别拿它去判高亮词。 */
        lyricText: ctx.isPureMusic ? '' : ctx.lyricSource,
    });
    if (pulled.status !== 'hit') return null;

    /* 缓存里的东西照样当不可信输入：形状不对、缺了要的那一半，都跟没命中一样。 */
    const parts = normalizeStagePayload(pulled.payload, ctx.blockedModes);
    if (!parts || !hasRequired(parts, ctx.requirement)) return null;

    /*
     * 按内容捞到的那条**回填**到自己这个键上 —— 与 `withAiCloudCache` 里同一条纪律：
     * 同一份歌词下次还是同一个键，不回填就得再走一遍「搜歌名 + 逐条判」。
     */
    if (pulled.matched === 'words') {
        void pushAiCloudCache(STAGE_CACHE_KIND, ctx.fingerprint, parts, {
            songTitle: ctx.songTitle,
            platform: ctx.platform,
            lyricHash: ctx.lyricSource ? md5(ctx.lyricSource) : '',
            isPureMusic: ctx.isPureMusic,
        }).catch(() => false);
    }

    return { ...parts, source: 'cloud' };
};

/**
 * 唯一该被功能代码调用的那个入口。
 *
 * `require` 决定「哪一半没有就算没命中」：主题链路只要主题，导演链路只要动画，于是只答出
 * 一半的模型输出（或早期版本推的半截缓存）不会把另一条链路卡住。
 */
export const requestStage = async (request: StageRequest): Promise<StageResult> => {
    const ctx = buildStageContext(request);

    /*
     * 「重新判断」要跳过**每一层**，不是只跳过进程内缓存。
     *
     * 少跳一层，用户点「重新生成」拿到的还是服务器上那条旧答案 —— 他会觉得这个
     * 按钮是坏的。所以 force 时：不看最近结果、不蹭在飞的请求、不拉云端，
     * 直接生成，然后**覆盖**云端那条（写接口本来就是 upsert）。
     */
    if (!request.force) {
        const cached = readRecent(ctx.fingerprint);
        if (cached && hasRequired(cached.parts, ctx.requirement)) {
            return { ...cached.parts, source: cached.source, reused: true };
        }

        const pending = inFlight.get(ctx.fingerprint);
        if (pending) {
            const shared = await pending.catch(() => null);
            if (shared && hasRequired(shared, ctx.requirement)) {
                return { ...shared, source: shared.source, reused: true };
            }
        }
    }

    const promise = resolveStage(ctx);
    inFlight.set(ctx.fingerprint, promise);
    try {
        const result = await promise;
        /* 记下的是「这一首歌刚问出的答案」：主题与导演先后到，后到的那次不必再问一遍。 */
        rememberRecent(ctx.fingerprint, {
            ...(result.theme ? { theme: result.theme } : {}),
            ...(result.decision ? { decision: result.decision } : {}),
        }, result.source);
        return result;
    } finally {
        inFlight.delete(ctx.fingerprint);
    }
};
