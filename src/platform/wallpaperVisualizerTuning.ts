import type { VisualizerMode } from '../types';

// src/platform/wallpaperVisualizerTuning.ts
// 把「歌词动画实验台」里当前生效那个模式的配置，摊平成一张键值表发给壁纸。
//
// 为什么是键值表：十几个模式合计一百多项，逐个做成桥上的字段的话，
// 每加一项都要改 TS 接口、Java 插件方法、原生状态类、还有落盘格式。
// 摊平之后四者只需要一张 map；同一时刻只有一个模式在渲染，
// 所以不同模式的同名字段（比如都叫 glowIntensity）不会打架。

/** 模式 → store 里存放它那份 tuning 的字段名。 */
const TUNING_FIELD: Record<string, string> = {
    sonnet: 'sonnetTuning',
    tempera: 'temperaTuning',
    lumiere: 'lumiereTuning',
    classic: 'classicTuning',
    cadenza: 'cadenzaTuning',
    partita: 'partitaTuning',
    fume: 'fumeTuning',
    claddagh: 'claddaghTuning',
    cappella: 'cappellaTuning',
    tilt: 'tiltTuning',
    diorama: 'dioramaTuning',
    monet: 'monetTuning',
    pendolo: 'pendoloTuning',
};

/** 字符串枚举在这里翻成序号：桥上不传字符串，省得原生还要记枚举表。 */
const OUTER_FRAME_INDEX: Record<string, number> = {
    none: 0,
    minimal: 1,
    full: 2,
};

/** 模式 → store 里存放它那份 tuning 的字段名。找不到的模式（静止等）返回 null。 */
export const tuningFieldFor = (mode: VisualizerMode | string | null | undefined): string | null => {
    if (!mode) return null;
    return TUNING_FIELD[mode] ?? null;
};

/**
 * 把某个模式那份 tuning 摊平成 number map。
 *
 * 值一律压成 number：布尔开关当 0/1、字符串枚举按上面的表翻成序号、
 * 其余数字原样带走。拿不到的字段不进表 —— 原生那边缺项自然退到默认值。
 *
 * 这里必须返回 store 里的原始对象引用（zustand 用 Object.is 比较），
 * 摊平要放在 useMemo 里做 —— 直接在 selector 里摊平的话每次都是新对象，
 * 会触发无限重渲染。
 */
export const flattenTuning = (raw: unknown): Record<string, number> | null => {
    if (!raw || typeof raw !== 'object') return null;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            out[key] = value;
        } else if (typeof value === 'boolean') {
            out[key] = value ? 1 : 0;
        } else if (typeof value === 'string') {
            const index = OUTER_FRAME_INDEX[value];
            if (index !== undefined) out[key] = index;
        }
    }
    return Object.keys(out).length > 0 ? out : null;
};

/**
 * 应用侧「视觉设置」里那几个跟背景有关的全局开关。
 *
 * 它们不属于某个歌词动画模式，但跟随模式要连它们一起跟随，
 * 所以也塞进同一张表 —— 用 `wp.` 前缀和 per-mode 字段区分开。
 */
export const WALLPAPER_GLOBAL_KEYS = {
    backgroundOpacity: 'wp.backgroundOpacity',
    vignetteDisabled: 'wp.vignetteDisabled',
    geometricDisabled: 'wp.geometricDisabled',
    /** 叠层整体窗口的不透明度。 */
    overlayOpacity: 'wp.overlayOpacity',
    /** 叠层总开关。关掉就一层都不挂。 */
    overlayEnabled: 'wp.overlayEnabled',
    /** 音乐锁屏：锁屏之上也挂叠层。 */
    showOnLockScreen: 'wp.showOnLockScreen',
    /** 叠层只在锁屏上出现：桌面 / 所有应用 / App 内一律不挂。 */
    overlayLockScreenOnly: 'wp.overlayLockScreenOnly',
    /** 叠层是否在所有应用之上显示。 */
    overlayAllApps: 'wp.overlayAllApps',
    /** 跟随 + 叠层时隐藏原生那层歌词。 */
    hideNativeLyrics: 'wp.hideNativeLyrics',
    /** 跟随 + 叠层时隐藏原生那层的进度条。 */
    hideNativeProgress: 'wp.hideNativeProgress',
    /** 纯音乐（没有歌词）时不显示叠层。 */
    skipInstrumental: 'wp.skipInstrumental',
    /** 暂停时自动隐藏叠层。 */
    hideWhenPaused: 'wp.hideWhenPaused',
    /** 歌词唱完之后（长尾奏）自动隐藏叠层。 */
    hideAfterLyricsEnd: 'wp.hideAfterLyricsEnd',
    /**
     * 「和外观有关的那几个 store 变了」的计数。
     *
     * 叠层是**另一个 WebView**，它里面那份 store 只在页面加载那一刻读过一次 localStorage。
     * 主 WebView 改了「歌词动画实验台」里的参数，写的是主上下文的存储 ——
     * 两边没有同步机制，已经挂着的那一页永远看不到这次改动，
     * 用户看到的就是「App 里改了、叠层没反应」。
     *
     * 值只要变了就让原生那边的全局开关散列表跟着变，
     * `reloadOnTuningChange` 会把页面重载一份 —— 新页面重新读存储，改动就到位了。
     */
    settingsStamp: 'wp.settingsStamp',
} as const;

export const withGlobalSettings = (
    tuning: Record<string, number> | null,
    settings: Record<string, unknown>,
): Record<string, number> => {
    const out: Record<string, number> = { ...(tuning ?? {}) };
    const stamp = settings.settingsStamp;
    if (typeof stamp === 'number' && Number.isFinite(stamp)) {
        out[WALLPAPER_GLOBAL_KEYS.settingsStamp] = Math.abs(Math.trunc(stamp)) % 1000000;
    }
    const opacity = settings.backgroundOpacity;
    if (typeof opacity === 'number' && Number.isFinite(opacity)) {
        out[WALLPAPER_GLOBAL_KEYS.backgroundOpacity] = opacity;
    }
    out[WALLPAPER_GLOBAL_KEYS.vignetteDisabled] = settings.disableVisualizerVignette ? 1 : 0;
    out[WALLPAPER_GLOBAL_KEYS.geometricDisabled] =
        settings.disableVisualizerGeometricBackground ? 1 : 0;
    const overlayOpacity = settings.wallpaperOverlayOpacity;
    if (typeof overlayOpacity === 'number' && Number.isFinite(overlayOpacity)) {
        out[WALLPAPER_GLOBAL_KEYS.overlayOpacity] = overlayOpacity;
    }
    out[WALLPAPER_GLOBAL_KEYS.overlayEnabled] = settings.wallpaperOverlayEnabled === false ? 0 : 1;
    out[WALLPAPER_GLOBAL_KEYS.showOnLockScreen] = settings.wallpaperOverlayLockScreen ? 1 : 0;
    out[WALLPAPER_GLOBAL_KEYS.overlayLockScreenOnly] = settings.wallpaperOverlayLockScreenOnly ? 1 : 0;
    out[WALLPAPER_GLOBAL_KEYS.overlayAllApps] = settings.wallpaperOverlayAllApps ? 1 : 0;
    out[WALLPAPER_GLOBAL_KEYS.hideNativeLyrics] = settings.wallpaperOverlayHideNativeLyrics ? 1 : 0;
    out[WALLPAPER_GLOBAL_KEYS.hideNativeProgress] = settings.wallpaperOverlayHideNativeProgress ? 1 : 0;
    out[WALLPAPER_GLOBAL_KEYS.skipInstrumental] = settings.wallpaperOverlaySkipInstrumental ? 1 : 0;
    out[WALLPAPER_GLOBAL_KEYS.hideWhenPaused] = settings.wallpaperOverlayHideWhenPaused ? 1 : 0;
    out[WALLPAPER_GLOBAL_KEYS.hideAfterLyricsEnd] = settings.wallpaperOverlayHideAfterLyricsEnd ? 1 : 0;
    return out;
};
