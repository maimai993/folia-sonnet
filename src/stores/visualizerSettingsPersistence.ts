import { DEFAULT_SMART_BEAT_SETTINGS, type LyricRenderQuality, type SmartBeatSettings, type VisualizerBackgroundMode, type VisualizerFrameRate, type VisualizerMode } from '../types';
// 只做字符串校验，走 types/visualizerModes 而不是 registry：后者的 eager glob 会把 13 个
// renderer（含 three.js）拉进来，而这里读的只是一个 localStorage 字符串。
// mod 模式在启动时本来就看不到——bootstrap.tsx 的 restoreStoredModVisualizer 在 mods 注册完
// 之后专门补一次，行为不变。
import {
    DEFAULT_VISUALIZER_BACKGROUND_MODE,
    DEFAULT_VISUALIZER_MODE,
    isBuiltinVisualizerBackgroundMode,
    isBuiltinVisualizerMode,
} from '../types/visualizerModes';
import type { StoredTuning } from '../components/visualizer/tuningDefinition';
import { resolveSmartBeatSettings, type SmartBeatPatch } from '../services/beatFx/smartBeatSettings';
import { resolveInitialVisualizerFrameRate, VISUALIZER_FRAME_RATE_STORAGE_KEY } from '../utils/frameRateLimiter';
import { DEFAULT_LYRIC_RENDER_QUALITY, LYRIC_RENDER_QUALITY_STORAGE_KEY, normalizeLyricRenderQuality } from '../utils/lyricRenderQuality';

import { getStoredString } from './storagePrimitives';
import { normalizeRandomVisualizerModes } from '../utils/randomVisualizerModes';

export const RANDOM_VISUALIZER_MODES_STORAGE_KEY = 'random_visualizer_modes';

export const readStoredRandomVisualizerModes = () => {
    try {
        return normalizeRandomVisualizerModes(JSON.parse(getStoredString(RANDOM_VISUALIZER_MODES_STORAGE_KEY, 'null')));
    } catch {
        return normalizeRandomVisualizerModes(null);
    }
};

export const VISUALIZER_OPACITY_STORAGE_KEY = 'visualizer_opacity';

// src/stores/visualizerSettingsPersistence.ts
// localStorage read/clamp/resolve helpers for every visualizer and background setting.
//
// Moved verbatim out of useSettingsUiStore so the visualizer domain can own its own store
// without either file importing the other. Storage keys and clamping behaviour are unchanged —
// this module is the persistence half of that domain, nothing more.

export const readStoredBackgroundOpacity = () => {
    if (typeof window === 'undefined') {
        return 0.75;
    }

    const saved = localStorage.getItem('background_opacity');
    const parsed = saved ? parseFloat(saved) : 0.75;
    return Number.isFinite(parsed) ? parsed : 0.75;
};

/** 可视化叠层（盖在壁纸之上那层 WebView）整体窗口的不透明度。 */
export const WALLPAPER_OVERLAY_OPACITY_STORAGE_KEY = 'folia.wallpaperOverlayOpacity';

export const readStoredWallpaperOverlayOpacity = () => {
    if (typeof window === 'undefined') {
        return 1;
    }
    const saved = localStorage.getItem(WALLPAPER_OVERLAY_OPACITY_STORAGE_KEY);
    const parsed = saved ? parseFloat(saved) : 1;
    // 下限给 0.1 而不是 0：0 等于整层看不见，用户会以为功能坏了。
    return Number.isFinite(parsed) ? Math.min(1, Math.max(0.1, parsed)) : 1;
};

/**
 * 「精简」样式那颗悬浮歌词小窗的底色不透明度。
 *
 * 单独一份，不复用 `backgroundOpacity`（那是壁纸背景的）也不复用
 * `wallpaperOverlayOpacity`（那是跟随样式那层 WebView 叠层的）：
 * 小窗是**另一层窗口**，它的底色浓淡跟壁纸那头的观感完全无关，
 * 跟着壁纸那个滑条一起动只会让人两头都对不上。
 *
 * 缺省 0.62：两行字压在桌面上要看得清，但又不能糊住后面的图标。
 */
export const WALLPAPER_FLOATING_OPACITY_STORAGE_KEY = 'folia.wallpaperFloatingOpacity';

export const readStoredWallpaperFloatingOpacity = () => {
    if (typeof window === 'undefined') {
        return 0.62;
    }
    const saved = localStorage.getItem(WALLPAPER_FLOATING_OPACITY_STORAGE_KEY);
    const parsed = saved ? parseFloat(saved) : 0.62;
    /*
     * 下限是 **0**，不是 0.05。
     *
     * 原来卡在 0.05 是怕「一块看不见的窗口」让人以为功能坏了，但有人要的就是
     * **只有字、没有底** —— 尤其叠加在安全区上时，那一条本来就该融进状态栏，
     * 多一块底色反而突兀。想要底的人往上调就是了。
     */
    return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.62;
};

/**
 * 「精简」小窗是否直接叠在安全区（状态栏那一条）上面。默认关 ——
 * 开着会压住状态栏，那是用户主动选的，不该是默认值。
 */
export const WALLPAPER_FLOATING_OVER_SAFE_AREA_STORAGE_KEY = 'folia.wallpaperFloatingOverSafeArea';

export const readStoredWallpaperFloatingOverSafeArea = () => {
    if (typeof window === 'undefined') {
        return false;
    }
    return localStorage.getItem(WALLPAPER_FLOATING_OVER_SAFE_AREA_STORAGE_KEY) === 'true';
};

/**
 * 叠加安全区时小窗的左右位置（0 = 贴左，1 = 贴右）。默认 0.5 = 居中。
 *
 * 它只是**初值**：用户上手拖过之后原生那边记的是拖出来的比例，
 * 这里再改会覆盖回去（真正的「拖不动」只能靠设置里改这个值来修）。
 */
export const WALLPAPER_FLOATING_OFFSET_X_STORAGE_KEY = 'folia.wallpaperFloatingOffsetX';

export const readStoredWallpaperFloatingOffsetX = () => {
    if (typeof window === 'undefined') {
        return 0.5;
    }
    const saved = localStorage.getItem(WALLPAPER_FLOATING_OFFSET_X_STORAGE_KEY);
    const parsed = saved ? parseFloat(saved) : 0.5;
    return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.5;
};

/**
 * 叠加安全区时小窗占屏幕宽度的比例，默认 0.8。
 *
 * 它是**屏幕宽度的比例**而不是像素：这个模式要的是「占住状态栏这一条的多宽」，
 * 百分比比像素直观，换台设备也不会变样。下限 0.5 —— 再窄的话一行歌词基本每句
 * 都要靠横向滚动才看得完。
 */
export const WALLPAPER_FLOATING_WIDTH_STORAGE_KEY = 'folia.wallpaperFloatingWidth';

export const readStoredWallpaperFloatingWidth = () => {
    if (typeof window === 'undefined') {
        return 0.8;
    }
    const saved = localStorage.getItem(WALLPAPER_FLOATING_WIDTH_STORAGE_KEY);
    const parsed = saved ? parseFloat(saved) : 0.8;
    return Number.isFinite(parsed) ? Math.min(1, Math.max(0.5, parsed)) : 0.8;
};

/**
 * 叠加安全区时是否**直接占满整条**（左右不再留空）。默认关 ——
 * 占满会压住整条状态栏，那是比「叠在安全区上」更进一步的选择。
 *
 * 非竖屏时原生那边不认这一条：横屏下状态栏那一条的意义完全不同，
 * 占满只会糊住一整条，所以自动退回宽度滑条给的宽。
 */
/**
 * 歌词字体的来路：'follow' = 跟随播放页那套，'custom' = 这两层单独指定一个字体文件。
 *
 * 默认 custom —— 老用户已经选过字体的，不该因为多了这个开关就悄悄失效。
 *
 * 为什么「跟随」在原生那两层上等于「用系统字体」：播放页的歌词字体是网页侧用
 * FontFace 注册的（文件存在 IndexedDB 里），原生拿不到那个字节，只能不覆盖、
 * 回落到系统 sans-serif。真正跟着播放页走的是 WebView 叠层那一层 ——
 * 它本来就是网页，用的就是主题里那个字体。
 */
export const WALLPAPER_LYRICS_FONT_MODE_STORAGE_KEY = 'folia.wallpaperLyricsFontMode';

export const readStoredWallpaperLyricsFontMode = (): 'follow' | 'custom' => {
    if (typeof window === 'undefined') {
        return 'custom';
    }
    return localStorage.getItem(WALLPAPER_LYRICS_FONT_MODE_STORAGE_KEY) === 'follow'
        ? 'follow'
        : 'custom';
};

export const WALLPAPER_FLOATING_FILL_SAFE_AREA_STORAGE_KEY = 'folia.wallpaperFloatingFillSafeArea';

export const readStoredWallpaperFloatingFillSafeArea = () => {
    if (typeof window === 'undefined') {
        return false;
    }
    return localStorage.getItem(WALLPAPER_FLOATING_FILL_SAFE_AREA_STORAGE_KEY) === 'true';
};

/**
 * 占满时留出的「避开区域」宽度（占整条宽的比例）。默认 0.12 ——
 * 一颗挖孔连着它周围那一圈差不多就是这个比例。0 = 不避让。
 */
export const WALLPAPER_FLOATING_AVOID_WIDTH_STORAGE_KEY = 'folia.wallpaperFloatingAvoidWidth';

export const readStoredWallpaperFloatingAvoidWidth = () => {
    if (typeof window === 'undefined') {
        return 0.12;
    }
    const saved = localStorage.getItem(WALLPAPER_FLOATING_AVOID_WIDTH_STORAGE_KEY);
    const parsed = saved ? parseFloat(saved) : 0.12;
    // 上限 0.5：划掉一半以上就没什么地方画字了。
    return Number.isFinite(parsed) ? Math.min(0.5, Math.max(0, parsed)) : 0.12;
};

/**
 * 避开区域的左右位置（0 = 贴左，1 = 贴右），默认 0.5 = 正中间
 * （挖孔绝大多数在正中）。
 */
export const WALLPAPER_FLOATING_AVOID_OFFSET_X_STORAGE_KEY = 'folia.wallpaperFloatingAvoidOffsetX';

export const readStoredWallpaperFloatingAvoidOffsetX = () => {
    if (typeof window === 'undefined') {
        return 0.5;
    }
    const saved = localStorage.getItem(WALLPAPER_FLOATING_AVOID_OFFSET_X_STORAGE_KEY);
    const parsed = saved ? parseFloat(saved) : 0.5;
    return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.5;
};

/**
 * 悬浮小窗的字号模式：'dynamic' = 跟着窗口高度算（拖大窗口字就跟着大），
 * 'custom' = 自己指定一个字号。
 *
 * 为什么要有 custom：叠加模式下窗口只有状态栏那么高，按高度算出来的字号小到看不清 ——
 * 那种情况必须能自己指定。
 */
export const WALLPAPER_FLOATING_FONT_SIZE_MODE_STORAGE_KEY = 'folia.wallpaperFloatingFontSizeMode';

export const readStoredWallpaperFloatingFontSizeMode = (): 'dynamic' | 'custom' => {
    if (typeof window === 'undefined') {
        return 'dynamic';
    }
    return localStorage.getItem(WALLPAPER_FLOATING_FONT_SIZE_MODE_STORAGE_KEY) === 'custom'
        ? 'custom'
        : 'dynamic';
};

/** 自定义模式的字号（dp）。默认 14 —— 一行歌词挂在小窗里这个大小看着最舒服。 */
export const WALLPAPER_FLOATING_FONT_SIZE_STORAGE_KEY = 'folia.wallpaperFloatingFontSize';

export const readStoredWallpaperFloatingFontSize = () => {
    if (typeof window === 'undefined') {
        return 14;
    }
    const saved = localStorage.getItem(WALLPAPER_FLOATING_FONT_SIZE_STORAGE_KEY);
    const parsed = saved ? parseFloat(saved) : 14;
    // 10~32dp：再小看不清，再大一行就装不下了。
    return Number.isFinite(parsed) ? Math.min(32, Math.max(10, parsed)) : 14;
};

/**
 * 叠层总开关。
 *
 * 关掉之后一层都不挂（原生那层歌词照旧）。它同时也是「叠层由应用进程托管」的开关 ——
 * 打开时不再要求系统的动态壁纸是我们，没设壁纸也能在桌面/锁屏上挂这一层。
 */
export const WALLPAPER_OVERLAY_ENABLED_STORAGE_KEY = 'folia.wallpaperOverlayEnabled';

export const readStoredWallpaperOverlayEnabled = () => {
    if (typeof window === 'undefined') {
        return true;
    }
    // 没写过这个 key 的老用户按「开」处理：叠层本来就是默认在用的功能。
    return localStorage.getItem(WALLPAPER_OVERLAY_ENABLED_STORAGE_KEY) !== 'false';
};

/** 音乐锁屏：锁屏界面上也挂叠层。默认关 —— 锁屏上多一层东西要先由用户点头。 */
export const WALLPAPER_OVERLAY_LOCK_SCREEN_STORAGE_KEY = 'folia.wallpaperOverlayLockScreen';

export const readStoredWallpaperOverlayLockScreen = () =>
    typeof window !== 'undefined'
    && localStorage.getItem(WALLPAPER_OVERLAY_LOCK_SCREEN_STORAGE_KEY) === 'true';

/**
 * 叠层只在锁屏上出现：桌面、所有应用、App 内一律不挂。
 *
 * 默认关 —— 大多数人是冲着「桌面歌词」开的叠层，只有想要"锁屏才出现"的人才会来拨它。
 */
export const WALLPAPER_OVERLAY_LOCK_SCREEN_ONLY_STORAGE_KEY = 'folia.wallpaperOverlayLockScreenOnly';

export const readStoredWallpaperOverlayLockScreenOnly = () =>
    typeof window !== 'undefined'
    && localStorage.getItem(WALLPAPER_OVERLAY_LOCK_SCREEN_ONLY_STORAGE_KEY) === 'true';

/** 叠层是否在所有应用之上显示。默认只在桌面（壁纸可见）时挂着。 */
export const WALLPAPER_OVERLAY_ALL_APPS_STORAGE_KEY = 'folia.wallpaperOverlayAllApps';

export const readStoredWallpaperOverlayAllApps = () =>
    typeof window !== 'undefined'
    && localStorage.getItem(WALLPAPER_OVERLAY_ALL_APPS_STORAGE_KEY) === 'true';

/**
 * 跟随模式下是否隐藏原生那层歌词。
 *
 * 叠层跑的是播放页同一套可视化，它自己会画歌词；原生 GLES 那层如果照旧画，
 * 两层歌词会叠在一起。默认「跟随 + 叠层可用」时把原生那层关掉更干净，
 * 但留成开关 —— 有些模式的可视化歌词位置和原生不同，用户可能想两层都要。
 */
export const WALLPAPER_OVERLAY_HIDE_NATIVE_LYRICS_STORAGE_KEY = 'folia.wallpaperOverlayHideNativeLyrics';

export const readStoredWallpaperOverlayHideNativeLyrics = () =>
    typeof window !== 'undefined'
    && localStorage.getItem(WALLPAPER_OVERLAY_HIDE_NATIVE_LYRICS_STORAGE_KEY) === 'true';

/**
 * 桌面叠层里要不要显示封面。
 *
 * 默认**隐藏**：叠层是浮在原生壁纸之上的一层，而封面是一整块不透明的方形图，
 * 画上去就是把壁纸糊掉一大块 —— 叠层存在的意义恰恰是透出壁纸。
 * 在此之前封面根本没推给叠层页面（那里只有一层半透明底板），
 * 现在链路修好了，想要完整构图的人可以按这个开关打开。
 */
export const WALLPAPER_OVERLAY_HIDE_COVER_ART_STORAGE_KEY = 'folia.wallpaperOverlayHideCoverArt';

export const readStoredWallpaperOverlayHideCoverArt = () =>
    typeof window === 'undefined'
    || localStorage.getItem(WALLPAPER_OVERLAY_HIDE_COVER_ART_STORAGE_KEY) !== 'false';

/**
 * 纯音乐（没有歌词）时是否不显示叠层。
 *
 * 纯音乐下可视化只能画背景，画不出歌词；有人要的就是这时候干净点，
 * 也有人想留着动效当氛围，所以做成开关，默认开。
 */
/**
 * 歌词唱完之后（尾奏很长 / 后半段是纯音乐）是否自动隐藏叠层。
 *
 * 有些曲目只在前半段有几句歌词，后面几分钟没有 —— 那时候叠层只是挂着一片空白。
 * 默认开：最后一句唱完 3 秒后收起，跳回有歌词的位置再自动回来。
 */
export const WALLPAPER_OVERLAY_HIDE_AFTER_LYRICS_END_STORAGE_KEY = 'folia.wallpaperOverlayHideAfterLyricsEnd';

export const readStoredWallpaperOverlayHideAfterLyricsEnd = () =>
    typeof window === 'undefined'
    || localStorage.getItem(WALLPAPER_OVERLAY_HIDE_AFTER_LYRICS_END_STORAGE_KEY) !== 'false';

export const WALLPAPER_OVERLAY_SKIP_INSTRUMENTAL_STORAGE_KEY = 'folia.wallpaperOverlaySkipInstrumental';

/**
 * 暂停时是否自动隐藏叠层。
 *
 * 暂停时画面是静止的，叠层继续挂着只是白占一层窗口（还持续跑 rAF）。
 * 默认开：暂停就收起，恢复播放再自动回来。
 */
export const WALLPAPER_OVERLAY_HIDE_WHEN_PAUSED_STORAGE_KEY = 'folia.wallpaperOverlayHideWhenPaused';

export const readStoredWallpaperOverlayHideWhenPaused = () =>
    typeof window === 'undefined'
    || localStorage.getItem(WALLPAPER_OVERLAY_HIDE_WHEN_PAUSED_STORAGE_KEY) !== 'false';

export const readStoredWallpaperOverlaySkipInstrumental = () =>
    typeof window === 'undefined'
    || localStorage.getItem(WALLPAPER_OVERLAY_SKIP_INSTRUMENTAL_STORAGE_KEY) !== 'false';

/** 跟随模式下是否隐藏原生那层的进度条（叠层里可视化自带的那条不受影响）。 */
export const WALLPAPER_OVERLAY_HIDE_NATIVE_PROGRESS_STORAGE_KEY = 'folia.wallpaperOverlayHideNativeProgress';

export const readStoredWallpaperOverlayHideNativeProgress = () =>
    typeof window !== 'undefined'
    && localStorage.getItem(WALLPAPER_OVERLAY_HIDE_NATIVE_PROGRESS_STORAGE_KEY) === 'true';

export const readStoredVisualizerOpacity = () => {
    if (typeof window === 'undefined') {
        return 1;
    }

    const saved = localStorage.getItem(VISUALIZER_OPACITY_STORAGE_KEY);
    const parsed = saved ? parseFloat(saved) : 1;
    return Number.isFinite(parsed) ? Math.min(1, Math.max(0.2, parsed)) : 1;
};

/**
 * Reads one stored tuning the way its tuning.ts declares it: under its key, else under a key of
 * an earlier version. Nothing stored, text that is no JSON and a value the declaration cannot
 * read all give the defaults.
 */
export const readStoredTuning = <T>({ defaults, storage }: Pick<StoredTuning<T>, 'defaults' | 'storage'>): T => {
    if (typeof window === 'undefined') {
        return defaults;
    }

    let saved = localStorage.getItem(storage.key);
    for (const olderKey of storage.olderKeys ?? []) {
        saved ??= localStorage.getItem(olderKey);
    }
    if (!saved) return defaults;

    try {
        return storage.read(JSON.parse(saved));
    } catch {
        return defaults;
    }
};

/** Writes a whole tuning under its key. */
export const writeStoredTuning = (key: string, tuning: unknown) => {
    if (typeof window !== 'undefined') {
        localStorage.setItem(key, JSON.stringify(tuning));
    }
};

export const readStoredVisualizerMode = (): VisualizerMode => {
    if (typeof window === 'undefined') {
        return DEFAULT_VISUALIZER_MODE;
    }

    const saved = localStorage.getItem('visualizer_mode');
    if (saved === 'cadenza' || saved === 'cadenze') {
        return 'cadenza';
    }

    return isBuiltinVisualizerMode(saved) ? saved : DEFAULT_VISUALIZER_MODE;
};

export const readStoredVisualizerFrameRate = (): VisualizerFrameRate => {
    if (typeof window === 'undefined') {
        return 'off';
    }

    const stored = localStorage.getItem(VISUALIZER_FRAME_RATE_STORAGE_KEY);
    /*
     * 从没设置过：手机给 60，桌面不限（判据在 frameRateLimiter 里，与启动装限帧器
     * 用的是同一个函数 —— 两边各写一份的话，会出现「启动不限、设置页显示 60」）。
     */
    return resolveInitialVisualizerFrameRate(stored);
};

export const readStoredVisualizerBackgroundMode = (): VisualizerBackgroundMode | null => {
    if (typeof window === 'undefined') {
        return null;
    }

    const saved = localStorage.getItem('visualizer_background_mode');
    return isBuiltinVisualizerBackgroundMode(saved) ? saved : null;
};

export const resolveVisualizerBackgroundMode = (
    storedMode: VisualizerBackgroundMode | null | undefined,
    _visualizerMode: VisualizerMode,
): VisualizerBackgroundMode => storedMode ?? DEFAULT_VISUALIZER_BACKGROUND_MODE;

export const SMART_BEAT_STORAGE_KEY = 'visualizer_smart_beat';

// 纯逻辑那部分搬去了 services/beatFx/smartBeatSettings.ts：utils 不许 import store（PR #750 复审，2026-10-19）。
// 三档（off / cached / on）也只在那里定义，这里照原样转出去。
export { resolveSmartBeatSettings, toStoredSmartBeat, type SmartBeatPatch } from '../services/beatFx/smartBeatSettings';

export const readStoredSmartBeatSettings = (): SmartBeatSettings => {
    if (typeof window === 'undefined') return DEFAULT_SMART_BEAT_SETTINGS;
    const saved = localStorage.getItem(SMART_BEAT_STORAGE_KEY);
    if (!saved) return DEFAULT_SMART_BEAT_SETTINGS;
    try {
        return resolveSmartBeatSettings(JSON.parse(saved) as SmartBeatPatch);
    } catch {
        return DEFAULT_SMART_BEAT_SETTINGS;
    }
};

/** 「性能与动效」里的全局歌词画质挡位；没存过就是各样式原来的样子。 */
export const readStoredLyricRenderQuality = (): LyricRenderQuality => {
    try {
        const raw = localStorage.getItem(LYRIC_RENDER_QUALITY_STORAGE_KEY);
        if (!raw) return DEFAULT_LYRIC_RENDER_QUALITY;
        return normalizeLyricRenderQuality(JSON.parse(raw));
    } catch {
        return DEFAULT_LYRIC_RENDER_QUALITY;
    }
};
