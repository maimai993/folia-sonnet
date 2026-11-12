// src/stores/useVisualizerSettingsStore.ts
// Visualizer and background settings: the active mode, the background mode and URL background
// list, opacity/frame-rate, and the per-mode tuning objects.
//
// Split out of useSettingsUiStore. Persistence (localStorage reads, clamping, defaults) lives in
// ./visualizerSettingsPersistence; this file owns the state and the actions only.
//
// A lyric style's or a background's tuning has no line here: its tuning.ts says where it is stored
// (its `storage`), its field and its actions are built from that declaration by `tuningFields`,
// and its part of the type comes from VisualizerTuningSettings, which each tuning.ts adds to. A
// background's settings that are no tuning object come whole from its settings.ts.
//
// @note 帧率上限（visualizer_frame_rate）和辉光模糊量化（visualizer_glow_blur_quantize）是用户明确决定「不进外观配置导入导出」的
// 设置（2026-11-08）：配置码也用于 web 版 OBS 链接，只加 OBS 页面看得到的；OBS 的浏览器源按 OBS 自己设的帧率渲染，辉光量化
// 开关看起来几乎一样。同一批里的歌词画布分辨率与抗锯齿（lyricRenderQuality）进了配置码。不要按 settings-feature-integration
// 「视觉设置必须进 buildCurrentConfig / compressConfig / decompressConfig / validKeys / handleImportConfig」的规则把这两个补进去。

import { create } from 'zustand';
import { getVisualizerModeLabel } from '../components/visualizer/registry';
import type { StoredTuning, VisualizerTuningSettings } from '../components/visualizer/tuningDefinition';
import { getBackgroundSettingsSlices, getStoredVisualizerTunings } from '../components/visualizer/tuningRegistry';
import { type LyricRenderQuality, type RenderPixelRatio, type SmartBeatSettings, type VisualizerBackgroundMode, type VisualizerFrameRate, type VisualizerMode } from '../types';
import { VISUALIZER_FRAME_RATE_STORAGE_KEY, setGlobalVisualizerFrameRate } from '../utils/frameRateLimiter';
import { LYRIC_RENDER_QUALITY_STORAGE_KEY, normalizeLyricRenderQuality } from '../utils/lyricRenderQuality';
import { RENDER_PIXEL_RATIO_STORAGE_KEY, readStoredRenderPixelRatio, setGlobalRenderPixelRatio } from '../utils/renderPixelRatio';
import { GLOW_BLUR_QUANTIZE_STORAGE_KEY, readStoredGlowBlurQuantize, setGlowBlurQuantized } from '../utils/glowBlurQuantize';
import i18n from '../i18n/config';
import { setStatusMessage } from './useStatusMessageStore';
import { SMART_BEAT_STORAGE_KEY, type SmartBeatPatch, VISUALIZER_OPACITY_STORAGE_KEY, readStoredBackgroundOpacity, readStoredLyricRenderQuality, readStoredSmartBeatSettings, resolveSmartBeatSettings, readStoredTuning, readStoredVisualizerBackgroundMode, readStoredVisualizerFrameRate, readStoredVisualizerMode, readStoredVisualizerOpacity, toStoredSmartBeat, writeStoredTuning, WALLPAPER_OVERLAY_OPACITY_STORAGE_KEY, readStoredWallpaperOverlayOpacity, WALLPAPER_FLOATING_OPACITY_STORAGE_KEY, readStoredWallpaperFloatingOpacity, WALLPAPER_FLOATING_OVER_SAFE_AREA_STORAGE_KEY, readStoredWallpaperFloatingOverSafeArea, WALLPAPER_FLOATING_OFFSET_X_STORAGE_KEY, readStoredWallpaperFloatingOffsetX, WALLPAPER_FLOATING_WIDTH_STORAGE_KEY, readStoredWallpaperFloatingWidth, WALLPAPER_LYRICS_FONT_MODE_STORAGE_KEY, readStoredWallpaperLyricsFontMode, WALLPAPER_FLOATING_FILL_SAFE_AREA_STORAGE_KEY, readStoredWallpaperFloatingFillSafeArea, WALLPAPER_FLOATING_AVOID_WIDTH_STORAGE_KEY, readStoredWallpaperFloatingAvoidWidth, WALLPAPER_FLOATING_AVOID_OFFSET_X_STORAGE_KEY, readStoredWallpaperFloatingAvoidOffsetX, WALLPAPER_FLOATING_FONT_SIZE_MODE_STORAGE_KEY, readStoredWallpaperFloatingFontSizeMode, WALLPAPER_FLOATING_FONT_SIZE_STORAGE_KEY, readStoredWallpaperFloatingFontSize, WALLPAPER_OVERLAY_ENABLED_STORAGE_KEY, readStoredWallpaperOverlayEnabled, WALLPAPER_OVERLAY_LOCK_SCREEN_STORAGE_KEY, readStoredWallpaperOverlayLockScreen, WALLPAPER_OVERLAY_LOCK_SCREEN_ONLY_STORAGE_KEY, readStoredWallpaperOverlayLockScreenOnly, WALLPAPER_OVERLAY_ALL_APPS_STORAGE_KEY, readStoredWallpaperOverlayAllApps, WALLPAPER_OVERLAY_HIDE_NATIVE_LYRICS_STORAGE_KEY, readStoredWallpaperOverlayHideNativeLyrics, WALLPAPER_OVERLAY_HIDE_COVER_ART_STORAGE_KEY, readStoredWallpaperOverlayHideCoverArt, WALLPAPER_OVERLAY_HIDE_AFTER_LYRICS_END_STORAGE_KEY, readStoredWallpaperOverlayHideAfterLyricsEnd, WALLPAPER_OVERLAY_SKIP_INSTRUMENTAL_STORAGE_KEY, WALLPAPER_OVERLAY_HIDE_WHEN_PAUSED_STORAGE_KEY, readStoredWallpaperOverlayHideWhenPaused, readStoredWallpaperOverlaySkipInstrumental, WALLPAPER_OVERLAY_HIDE_NATIVE_PROGRESS_STORAGE_KEY, readStoredWallpaperOverlayHideNativeProgress, WALLPAPER_VIDEO_ROTATION_STORAGE_KEY, readStoredWallpaperVideoRotation } from './visualizerSettingsPersistence';
import { getStoredBoolean, getStoredString, setStoredBoolean, setStoredString } from './storagePrimitives';
import { RANDOM_VISUALIZER_MODES_STORAGE_KEY, readStoredRandomVisualizerModes } from './visualizerSettingsPersistence';
import { normalizeRandomVisualizerModes, type RandomVisualizerMode } from '../utils/randomVisualizerModes';

export type SetVisualizerModeOptions = { notify?: boolean; preserveRandom?: boolean };

// 歌词壁纸（Android 壁纸画面与叠层）的偏好，dev 独有能力。
export const LYRICS_WALLPAPER_FEED_STORAGE_KEY = 'folia.lyricsWallpaperFeed';
export const LYRICS_WALLPAPER_BACKGROUND_STORAGE_KEY = 'folia.lyricsWallpaperBackground';
export const LYRICS_WALLPAPER_IMAGE_STORAGE_KEY = 'folia.lyricsWallpaperImage';
export const LYRICS_WALLPAPER_BLUR_STORAGE_KEY = 'folia.lyricsWallpaperBlur';
export const LYRICS_WALLPAPER_PROGRESS_STORAGE_KEY = 'folia.lyricsWallpaperProgress';
export const LYRICS_WALLPAPER_TRANSLATION_STORAGE_KEY = 'folia.lyricsWallpaperTranslation';
export const LYRICS_WALLPAPER_STYLE_STORAGE_KEY = 'folia.lyricsWallpaperStyle';
const DEFAULT_WALLPAPER_BLUR = 0.35;

const resolveWallpaperBackground = (value: string): 'cover' | 'color' | 'image' | 'video' =>
    value === 'color' || value === 'image' || value === 'video' ? value : 'cover';

const clampWallpaperBlur = (value: number): number => {
    if (!Number.isFinite(value)) return DEFAULT_WALLPAPER_BLUR;
    return Math.min(1, Math.max(0, value));
};
type OwnSettingsState = {
    disableVisualizerVignette: boolean;
    disableVisualizerGeometricBackground: boolean;
    backgroundOpacity: number;
    visualizerOpacity: number;
    visualizerBackgroundMode: VisualizerBackgroundMode | null;
    visualizerFrameRate: VisualizerFrameRate;
    /** 歌词画布的全局分辨率与抗锯齿挡位；样式自己的覆盖在各自的 tuning 里（utils/lyricRenderQuality.ts）。 */
    lyricRenderQuality: LyricRenderQuality;
    /**
     * 画布渲染分辨率的上限，null = 跟随屏幕。
     *
     * 存的是用户「想要的上限」，不是生效值：屏幕只有 1× 时选 2× 什么都不会变，库里的值仍然是 2×，
     * 换到高分屏上才生效。见 utils/renderPixelRatio.ts。
     */
    renderPixelRatio: RenderPixelRatio | null;
    visualizerMode: VisualizerMode;
    randomVisualizerModePerSong: boolean;
    randomVisualizerModes: RandomVisualizerMode[];
    /** Snap animated glow blur radii to a bounded set. See components/visualizer/wordGlow.ts. */
    glowBlurQuantize: boolean;
    /**
     * 歌词关键词着色：高亮的词按它的语气/关键词上色。
     *
     * 一颗总闸管所有画面（莫奈 / 镜台 / 绘光 / 海报墙）—— 以前各样式面板里各有一颗，
     * 而且海报墙看的是莫奈那颗，彼此不该有这种牵连，于是收编成全局一份。
     */
    keywordColoringEnabled: boolean;
    /** 智能动感模式, shared by every visualizer and background that draws beat FX: no one style's tuning. */
    smartBeat: SmartBeatSettings;
    handleToggleDisableVisualizerVignette: (disable: boolean) => void;
    handleToggleDisableVisualizerGeometricBackground: (disable: boolean) => void;
    handleSetBackgroundOpacity: (opacity: number) => void;
    handleSetVisualizerOpacity: (opacity: number) => void;
    handleSetVisualizerBackgroundMode: (mode: VisualizerBackgroundMode) => void;
    handleResetVisualizerBackgroundMode: () => void;
    handleSetVisualizerFrameRate: (frameRate: VisualizerFrameRate) => void;
    handleSetLyricRenderQuality: (patch: Partial<LyricRenderQuality>) => void;
    handleSetRenderPixelRatio: (limit: RenderPixelRatio | null) => void;
    handleSetVisualizerMode: (mode: VisualizerMode, options?: SetVisualizerModeOptions) => void;
    handleToggleRandomVisualizerModePerSong: (enable: boolean, options?: { notify?: boolean }) => void;
    handleSetRandomVisualizerModes: (modes: readonly VisualizerMode[]) => void;
    handleToggleGlowBlurQuantize: (enable: boolean) => void;
    handleSetKeywordColoringEnabled: (enable: boolean) => void;
    handleSetSmartBeat: (patch: SmartBeatPatch) => void;
    lyricsWallpaperFeed: boolean;
    /** 歌词壁纸的背景：'cover' 模糊封面，'color' 主题色渐变，'image' 自选图片，'video' 自选视频。 */
    lyricsWallpaperBackground: 'cover' | 'color' | 'image' | 'video';
    /** 自选背景图的 base64，lyricsWallpaperBackground='image' 时生效。 */
    lyricsWallpaperImage: string | null;
    /**
     * 桌面壁纸视频背景的旋转角度（0/90/180/270）。
     *
     * 存在这里而不是只下发一次：原生那份 tuning 每次 setAppearance 都会整体重建，
     * 不持久化的话重启后角度就没了。
     */
    wallpaperVideoRotation: number;
    /** 背景模糊强度 0..1：同时作用于模糊封面与自选背景图。 */
    lyricsWallpaperBlur: number;
    /** 是否在歌词区顶部下方显示整首歌的进度条。 */
    lyricsWallpaperProgress: boolean;
    /** 桌面歌词是否在主行下面再挂一行翻译。歌词本身没翻译时不会因此多出空行。 */
    lyricsWallpaperTranslation: boolean;
    /** 壁纸样式：'minimal' 固定精简风格，'follow' 跟随播放页的可视化模式。 */
    lyricsWallpaperStyle: 'minimal' | 'follow';
    /** 可视化叠层总开关。关掉之后一层都不挂。 */
    wallpaperOverlayEnabled: boolean;
    /** 音乐锁屏：锁屏界面上也挂叠层（画面与桌面叠层完全一致）。 */
    wallpaperOverlayLockScreen: boolean;
    /** 叠层只在锁屏上出现：桌面 / 所有应用 / App 内一律不挂。 */
    wallpaperOverlayLockScreenOnly: boolean;
    /** 可视化叠层整体窗口的不透明度，0.1..1。 */
    wallpaperOverlayOpacity: number;
    /**
     * 歌词字体的来路：'follow' = 跟随播放页那套，'custom' = 单独指定一个字体文件。
     *
     * 'custom' 才需要那个「选择字体」按钮 —— 'follow' 时选了也不该用
     * （见 persistence 里的说明：原生那两层拿不到播放页那个字体字节）。
     */
    wallpaperLyricsFontMode: 'follow' | 'custom';
    /**
     * 「精简」样式那颗悬浮歌词小窗的底色不透明度，0..1。
     *
     * 单独一份：小窗是另一层系统窗口，底色的浓淡和壁纸那头、跟随样式那层 WebView
     * 叠层都无关，复用那两个滑条只会两头都对不上。
     */
    wallpaperFloatingOpacity: number;
    /**
     * 「精简」样式那颗小窗直接叠在安全区（状态栏那一条）上面。
     *
     * 打开之后小窗贴在屏幕最顶上，高度方向不再参与摆放，只给左右 ——
     * 有人就是想让它压住状态栏那一条当「状态栏歌词」用，但不是所有人都接受挡住时间/电量，
     * 所以默认关。
     */
    wallpaperFloatingOverSafeArea: boolean;
    /**
     * 叠加安全区时小窗的左右位置，0 = 贴左，1 = 贴右。
     *
     * 只在这个开关打开时生效，而且只是**初值**：原生那边拖过之后记的是拖出来的比例，
     * 这里再改一次会覆盖回去（原生拿它当设置值而不是当前值）。
     */
    wallpaperFloatingOffsetX: number;
    /**
     * 叠加安全区时小窗占屏幕宽度的比例，0.5..1。
     *
     * 它是屏幕宽度的比例而不是像素：这个模式要的是「占住状态栏这一条的多宽」，
     * 百分比比像素直观，换台设备也不会变样。
     */
    wallpaperFloatingWidth: number;
    /**
     * 叠加安全区时直接**占满整条**（左右不再留空）。
     *
     * 打开后上面那两根（左右位置、宽度）都不参与 —— 整条都要了，没有位置可言。
     * 非竖屏时原生那边不认这一条，自动退回宽度滑条给的宽（转回来又占满）。
     */
    wallpaperFloatingFillSafeArea: boolean;
    /**
     * 占满时留出的「避开区域」宽度（占整条宽的比例），0..0.5。0 = 不避让。
     *
     * 挖孔 / 刘海那一条上字压上去就像被切了一块，而各家 ROM 都不往外报挖孔在哪，
     * 只能让用户自己指。字是**绕过去**的（洞左半继续、右半接着），不是被裁掉。
     */
    wallpaperFloatingAvoidWidth: number;
    /** 避开区域的左右位置，0 = 贴左，1 = 贴右。只在上面的宽度大于 0 时有意义。 */
    wallpaperFloatingAvoidOffsetX: number;
    /**
     * 设置页正开着 → 原生那层小窗即使在 App 里也挂出来（预览）。不持久化。
     *
     * 没有它，「实时预览」这几根滑条是空的：正常逻辑在 App 里不挂这一层，
     * 而调设置恰恰是在 App 里做的 —— 拖到底也看不见任何东西。
     */
    wallpaperFloatingPreview: boolean;
    /**
     * 悬浮小窗的字号模式：'dynamic' = 跟着窗口高度算，'custom' = 自己指定。
     *
     * 默认 dynamic —— 拖大窗口字就跟着大，对多数人够用。custom 是给「就想让字小一点」
     * 和叠加模式（窗口只有状态栏那么高，算出来的字号小到看不清）留的。
     */
    wallpaperFloatingFontSizeMode: 'dynamic' | 'custom';
    /** 自定义模式的字号（dp），10..32。只在上面那个模式为 'custom' 时生效。 */
    wallpaperFloatingFontSize: number;
    /** 叠层是否在所有应用之上显示。关掉时只在桌面（壁纸可见）时挂着。 */
    wallpaperOverlayAllApps: boolean;
    /** 跟随 + 叠层时，隐藏原生那层歌词，避免和可视化的歌词叠在一起。 */
    wallpaperOverlayHideNativeLyrics: boolean;
    /** 跟随 + 叠层时，隐藏原生那层的进度条。 */
    wallpaperOverlayHideNativeProgress: boolean;
    /** 纯音乐（没有歌词）时不显示叠层。 */
    wallpaperOverlaySkipInstrumental: boolean;
    /** 暂停时自动隐藏叠层。 */
    wallpaperOverlayHideWhenPaused: boolean;
    /** 歌词唱完之后自动隐藏叠层。 */
    wallpaperOverlayHideAfterLyricsEnd: boolean;
    /**
     * 桌面叠层里隐藏封面。
     *
     * 封面是一整块不透明的方形图，挂在叠层上就把底下的原生壁纸糊掉一大块 ——
     * 而叠层存在的意义恰恰是透出壁纸，所以默认隐藏，想要完整构图的再打开。
     */
    wallpaperOverlayHideCoverArt: boolean;
    handleToggleLyricsWallpaperFeed: (enable: boolean) => void;
    handleSetLyricsWallpaperBackground: (mode: 'cover' | 'color' | 'image' | 'video') => void;
    handleSetLyricsWallpaperImage: (image: string | null) => void;
    /** 设定桌面壁纸视频的旋转角度（0/90/180/270），会持久化。 */
    handleSetWallpaperVideoRotation: (degrees: number) => void;
    handleSetLyricsWallpaperBlur: (blur: number) => void;
    handleToggleLyricsWallpaperProgress: (enable: boolean) => void;
    handleToggleLyricsWallpaperTranslation: (enable: boolean) => void;
    handleSetLyricsWallpaperStyle: (style: 'minimal' | 'follow') => void;
    handleToggleWallpaperOverlayEnabled: (enable: boolean) => void;
    handleToggleWallpaperOverlayLockScreen: (enable: boolean) => void;
    handleToggleWallpaperOverlayLockScreenOnly: (enable: boolean) => void;
    handleSetWallpaperOverlayOpacity: (value: number) => void;
    /** 「精简」样式那颗悬浮歌词小窗的底色不透明度。见 wallpaperFloatingOpacity 的说明。 */
    handleSetWallpaperFloatingOpacity: (value: number) => void;
    /** 小窗叠在安全区上面。见 wallpaperFloatingOverSafeArea 的说明。 */
    handleToggleWallpaperFloatingOverSafeArea: (enable: boolean) => void;
    /** 叠加模式下小窗的左右位置。见 wallpaperFloatingOffsetX 的说明。 */
    handleSetWallpaperFloatingOffsetX: (value: number) => void;
    /** 叠加模式下小窗的宽度（屏幕宽度比例）。见 wallpaperFloatingWidth 的说明。 */
    handleSetWallpaperFloatingWidth: (value: number) => void;
    /** 占满整条安全区。见 wallpaperFloatingFillSafeArea 的说明。 */
    handleToggleWallpaperFloatingFillSafeArea: (enable: boolean) => void;
    /** 避开区域的宽度（整条宽的比例）。见 wallpaperFloatingAvoidWidth 的说明。 */
    handleSetWallpaperFloatingAvoidWidth: (value: number) => void;
    /** 避开区域的左右位置。见 wallpaperFloatingAvoidOffsetX 的说明。 */
    handleSetWallpaperFloatingAvoidOffsetX: (value: number) => void;
    /**
     * 设置页正开着（预览）。**不落盘** —— 它是「此刻在看不在看」，不是偏好。
     *
     * 页面挂载 / 卸载时由设置页自己拨，关掉之后下一次启动不该还挂在那儿。
     */
    handleSetWallpaperFloatingPreview: (enable: boolean) => void;
    /** 歌词字体来路。见 wallpaperLyricsFontMode 的说明。 */
    handleSetWallpaperLyricsFontMode: (mode: 'follow' | 'custom') => void;
    handleSetWallpaperFloatingFontSizeMode: (mode: 'dynamic' | 'custom') => void;
    /** 自定义字号（dp）。见 wallpaperFloatingFontSize 的说明。 */
    handleSetWallpaperFloatingFontSize: (value: number) => void;
    handleToggleWallpaperOverlayAllApps: (enable: boolean) => void;
    handleToggleWallpaperOverlayHideNativeLyrics: (enable: boolean) => void;
    handleToggleWallpaperOverlayHideNativeProgress: (enable: boolean) => void;
    handleToggleWallpaperOverlaySkipInstrumental: (enable: boolean) => void;
    handleToggleWallpaperOverlayHideWhenPaused: (enable: boolean) => void;
    handleToggleWallpaperOverlayHideAfterLyricsEnd: (enable: boolean) => void;
    handleToggleWallpaperOverlayHideCoverArt: (enable: boolean) => void;
};

export type VisualizerSettingsState = OwnSettingsState & VisualizerTuningSettings;

type Fields = Record<string, unknown>;

/** The names of the store fields the styles' and the backgrounds' folders declared: what a caller that edits them all picks up. */
const declaredFieldNames: string[] = [];

/**
 * What the store holds for one stored tuning, built from its declaration: the tuning as it was
 * read at start-up, the action that lays a patch onto it, the action that puts the defaults
 * back, and the tuning's own further actions. They write the whole tuning under the declared key.
 */
const tuningFields = (
    { settingsKey, settingsSetterKey, settingsResetterKey, defaults, storage }: StoredTuning,
    set: (fields: object) => void,
    get: () => Fields,
): Fields => {
    const held = () => get()[settingsKey];
    const hold = (tuning: unknown) => {
        writeStoredTuning(storage.key, tuning);
        set({ [settingsKey]: tuning });
    };
    return {
        [settingsKey]: readStoredTuning({ defaults, storage }),
        [settingsSetterKey]: (patch: object) => {
            storage.onChange?.(patch);
            hold(storage.merge(held(), patch));
        },
        [settingsResetterKey]: () => {
            hold(storage.reset ? storage.reset(held(), defaults) : defaults);
            if (storage.resetNotice) {
                setStatusMessage({ type: 'info', text: i18n.t(storage.resetNotice) });
            }
        },
        ...storage.actions?.({ held, hold }),
    };
};

/** Everything the styles' and the backgrounds' folders declared for the store: the stored tunings, and the backgrounds' other settings. */
const declaredFields = (set: (fields: object) => void, get: () => Fields) => {
    const fields: Fields = Object.assign(
        {},
        ...getStoredVisualizerTunings().map(tuning => tuningFields(tuning, set, get)),
        ...getBackgroundSettingsSlices().map(slice => slice(set, get)),
    );
    declaredFieldNames.push(...Object.keys(fields));
    return fields as unknown as VisualizerTuningSettings;
};

export const useVisualizerSettingsStore = create<VisualizerSettingsState>((set, get) => ({
    lyricsWallpaperFeed: getStoredBoolean(LYRICS_WALLPAPER_FEED_STORAGE_KEY, true),
    lyricsWallpaperBackground: resolveWallpaperBackground(
        getStoredString(LYRICS_WALLPAPER_BACKGROUND_STORAGE_KEY, 'cover')),
    lyricsWallpaperImage: getStoredString(LYRICS_WALLPAPER_IMAGE_STORAGE_KEY, '') || null,
    wallpaperVideoRotation: readStoredWallpaperVideoRotation(),
    lyricsWallpaperBlur: clampWallpaperBlur(Number(getStoredString(LYRICS_WALLPAPER_BLUR_STORAGE_KEY, ''))),
    lyricsWallpaperProgress: getStoredBoolean(LYRICS_WALLPAPER_PROGRESS_STORAGE_KEY, true),
    lyricsWallpaperTranslation: getStoredBoolean(LYRICS_WALLPAPER_TRANSLATION_STORAGE_KEY, true),
    lyricsWallpaperStyle: getStoredString(LYRICS_WALLPAPER_STYLE_STORAGE_KEY, 'follow') === 'minimal'
        ? 'minimal'
        : 'follow',
    wallpaperOverlayEnabled: readStoredWallpaperOverlayEnabled(),
    wallpaperOverlayLockScreen: readStoredWallpaperOverlayLockScreen(),
    wallpaperOverlayLockScreenOnly: readStoredWallpaperOverlayLockScreenOnly(),
    wallpaperOverlayOpacity: readStoredWallpaperOverlayOpacity(),
    wallpaperLyricsFontMode: readStoredWallpaperLyricsFontMode(),
    wallpaperFloatingOpacity: readStoredWallpaperFloatingOpacity(),
    wallpaperFloatingOverSafeArea: readStoredWallpaperFloatingOverSafeArea(),
    wallpaperFloatingOffsetX: readStoredWallpaperFloatingOffsetX(),
    wallpaperFloatingWidth: readStoredWallpaperFloatingWidth(),
    wallpaperFloatingFillSafeArea: readStoredWallpaperFloatingFillSafeArea(),
    wallpaperFloatingAvoidWidth: readStoredWallpaperFloatingAvoidWidth(),
    wallpaperFloatingAvoidOffsetX: readStoredWallpaperFloatingAvoidOffsetX(),
    // 预览不读存储：它是「此刻在不在设置页」，不是用户偏好。
    wallpaperFloatingPreview: false,
    wallpaperFloatingFontSizeMode: readStoredWallpaperFloatingFontSizeMode(),
    wallpaperFloatingFontSize: readStoredWallpaperFloatingFontSize(),
    wallpaperOverlayAllApps: readStoredWallpaperOverlayAllApps(),
    wallpaperOverlayHideNativeLyrics: readStoredWallpaperOverlayHideNativeLyrics(),
    wallpaperOverlayHideNativeProgress: readStoredWallpaperOverlayHideNativeProgress(),
    wallpaperOverlaySkipInstrumental: readStoredWallpaperOverlaySkipInstrumental(),
    wallpaperOverlayHideWhenPaused: readStoredWallpaperOverlayHideWhenPaused(),
    wallpaperOverlayHideAfterLyricsEnd: readStoredWallpaperOverlayHideAfterLyricsEnd(),
    wallpaperOverlayHideCoverArt: readStoredWallpaperOverlayHideCoverArt(),
    ...declaredFields(set as (fields: object) => void, get as unknown as () => Fields),
    disableVisualizerVignette: getStoredBoolean('disable_visualizer_vignette', false),
    disableVisualizerGeometricBackground: getStoredBoolean('disable_visualizer_geometric_background', false),
    backgroundOpacity: readStoredBackgroundOpacity(),
    visualizerOpacity: readStoredVisualizerOpacity(),
    visualizerBackgroundMode: readStoredVisualizerBackgroundMode(),
    visualizerFrameRate: readStoredVisualizerFrameRate(),
    lyricRenderQuality: readStoredLyricRenderQuality(),
    renderPixelRatio: readStoredRenderPixelRatio(),
    visualizerMode: readStoredVisualizerMode(),
    randomVisualizerModePerSong: getStoredBoolean('random_visualizer_mode_per_song', false),
    randomVisualizerModes: readStoredRandomVisualizerModes(),
    glowBlurQuantize: readStoredGlowBlurQuantize(),
    keywordColoringEnabled: getStoredBoolean('keyword_coloring_enabled', true),
    smartBeat: readStoredSmartBeatSettings(),
    handleSetSmartBeat: (patch) => {
        const next = resolveSmartBeatSettings(patch, get().smartBeat);
        if (typeof window !== 'undefined') localStorage.setItem(SMART_BEAT_STORAGE_KEY, JSON.stringify(toStoredSmartBeat(next)));
        set({ smartBeat: next });
    },
    handleToggleDisableVisualizerVignette: (disable) => {
        setStoredBoolean('disable_visualizer_vignette', disable);
        set({ disableVisualizerVignette: disable });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (disable ? 'vignetteOff' : 'vignetteOn')),
        });
    },
    handleToggleDisableVisualizerGeometricBackground: (disable) => {
        setStoredBoolean('disable_visualizer_geometric_background', disable);
        set({ disableVisualizerGeometricBackground: disable });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (disable ? 'geometricBgHidden' : 'geometricBgShown')),
        });
    },
    handleSetBackgroundOpacity: (opacity) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('background_opacity', String(opacity));
        }
        set({ backgroundOpacity: opacity });
    },
    handleSetVisualizerOpacity: (opacity) => {
        const next = Math.min(1, Math.max(0.2, opacity));
        if (typeof window !== 'undefined') {
            localStorage.setItem(VISUALIZER_OPACITY_STORAGE_KEY, String(next));
        }
        set({ visualizerOpacity: next });
    },
    handleSetVisualizerBackgroundMode: (mode) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('visualizer_background_mode', mode);
        }
        set({ visualizerBackgroundMode: mode });
    },
    handleResetVisualizerBackgroundMode: () => {
        if (typeof window !== 'undefined') {
            localStorage.removeItem('visualizer_background_mode');
        }
        set({ visualizerBackgroundMode: null });
    },
    handleSetVisualizerFrameRate: (frameRate) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem(VISUALIZER_FRAME_RATE_STORAGE_KEY, String(frameRate));
        }
        setGlobalVisualizerFrameRate(frameRate);
        set({ visualizerFrameRate: frameRate });
    },
    handleSetLyricRenderQuality: (patch) => {
        const next = normalizeLyricRenderQuality({ ...get().lyricRenderQuality, ...patch });
        const current = get().lyricRenderQuality;
        if (next.scale === current.scale && next.antialias === current.antialias) return;
        setStoredString(LYRIC_RENDER_QUALITY_STORAGE_KEY, JSON.stringify(next));
        set({ lyricRenderQuality: next });
    },
    handleSetRenderPixelRatio: (limit) => {
        if (typeof window !== 'undefined') {
            if (limit === null) {
                localStorage.removeItem(RENDER_PIXEL_RATIO_STORAGE_KEY);
            } else {
                localStorage.setItem(RENDER_PIXEL_RATIO_STORAGE_KEY, String(limit));
            }
        }
        setGlobalRenderPixelRatio(limit);
        set({ renderPixelRatio: limit });
    },
    handleSetVisualizerMode: (mode, options) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('visualizer_mode', mode);
        }
        if (!options?.preserveRandom && get().randomVisualizerModePerSong) {
            setStoredBoolean('random_visualizer_mode_per_song', false);
            set({ visualizerMode: mode, randomVisualizerModePerSong: false });
        } else {
            set({ visualizerMode: mode });
        }
        if (options?.notify !== false) {
            setStatusMessage({
                type: 'info',
                text: i18n.t('notifications.visualizerSwitched', {
                    mode: getVisualizerModeLabel(mode, key => i18n.t(key)),
                }),
            });
        }
    },
    handleToggleRandomVisualizerModePerSong: (enable, options) => {
        setStoredBoolean('random_visualizer_mode_per_song', enable);
        set({ randomVisualizerModePerSong: enable });
        if (options?.notify !== false) {
            setStatusMessage({
                type: 'info',
                text: i18n.t(`status.randomVisualizerModePerSong${enable ? 'On' : 'Off'}`),
            });
        }
    },
    handleSetRandomVisualizerModes: (modes) => {
        const next = normalizeRandomVisualizerModes(modes);
        setStoredString(RANDOM_VISUALIZER_MODES_STORAGE_KEY, JSON.stringify(next));
        set({ randomVisualizerModes: next });
    },
    handleToggleGlowBlurQuantize: (enable) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem(GLOW_BLUR_QUANTIZE_STORAGE_KEY, String(enable));
        }
        // The renderers read the module flag every frame; the store only persists and drives the UI.
        setGlowBlurQuantized(enable);
        set({ glowBlurQuantize: enable });
    },
    handleSetKeywordColoringEnabled: (enable) => {
        setStoredBoolean('keyword_coloring_enabled', enable);
        set({ keywordColoringEnabled: enable });
    },
    handleToggleLyricsWallpaperFeed: (enable) => {
        setStoredBoolean(LYRICS_WALLPAPER_FEED_STORAGE_KEY, enable);
        set({ lyricsWallpaperFeed: enable });
    },
    handleSetLyricsWallpaperBackground: (mode) => {
        setStoredString(LYRICS_WALLPAPER_BACKGROUND_STORAGE_KEY, mode);
        set({ lyricsWallpaperBackground: mode });
    },
    handleSetLyricsWallpaperImage: (image) => {
        setStoredString(LYRICS_WALLPAPER_IMAGE_STORAGE_KEY, image || '');
        set({ lyricsWallpaperImage: image });
    },
    handleSetWallpaperVideoRotation: (degrees) => {
        const normalized = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
        setStoredString(WALLPAPER_VIDEO_ROTATION_STORAGE_KEY, String(normalized));
        set({ wallpaperVideoRotation: normalized });
    },
    handleSetLyricsWallpaperBlur: (blur) => {
        const next = clampWallpaperBlur(blur);
        setStoredString(LYRICS_WALLPAPER_BLUR_STORAGE_KEY, String(next));
        set({ lyricsWallpaperBlur: next });
    },
    handleToggleLyricsWallpaperProgress: (enable) => {
        setStoredBoolean(LYRICS_WALLPAPER_PROGRESS_STORAGE_KEY, enable);
        set({ lyricsWallpaperProgress: enable });
    },
    handleToggleLyricsWallpaperTranslation: (enable) => {
        setStoredBoolean(LYRICS_WALLPAPER_TRANSLATION_STORAGE_KEY, enable);
        set({ lyricsWallpaperTranslation: enable });
    },
    handleSetLyricsWallpaperStyle: (style) => {
        setStoredString(LYRICS_WALLPAPER_STYLE_STORAGE_KEY, style);
        set({ lyricsWallpaperStyle: style });
    },
    handleToggleWallpaperOverlayEnabled: (enable) => {
        localStorage.setItem(WALLPAPER_OVERLAY_ENABLED_STORAGE_KEY, enable ? 'true' : 'false');
        set({ wallpaperOverlayEnabled: enable });
    },
    handleToggleWallpaperOverlayLockScreen: (enable) => {
        localStorage.setItem(WALLPAPER_OVERLAY_LOCK_SCREEN_STORAGE_KEY, enable ? 'true' : 'false');
        set({ wallpaperOverlayLockScreen: enable });
    },
    handleToggleWallpaperOverlayLockScreenOnly: (enable) => {
        localStorage.setItem(WALLPAPER_OVERLAY_LOCK_SCREEN_ONLY_STORAGE_KEY, enable ? 'true' : 'false');
        /*
         * 「只在锁屏显示」隐含着「锁屏上要显示」。
         *
         * 原生那边 lockScreenWanted() 已经把两个开关做了或运算（兜住了只发一个的情况），
         * 但这里还是要顺手把音乐锁屏打开：设置页上那一行显示的是关着的，
         * 用户会以为"只在锁屏显示"和"音乐锁屏"是两个互不相干的东西，
         * 关掉其中一个就莫名其妙没效果了。
         */
        if (enable) {
            localStorage.setItem(WALLPAPER_OVERLAY_LOCK_SCREEN_STORAGE_KEY, 'true');
            set({ wallpaperOverlayLockScreen: true });
        }
        set({ wallpaperOverlayLockScreenOnly: enable });
    },
    handleSetWallpaperOverlayOpacity: (value) => {
        // 下限 0.1：0 等于整层看不见，用户会以为功能坏了。
        const clamped = Math.min(1, Math.max(0.1, value));
        localStorage.setItem(WALLPAPER_OVERLAY_OPACITY_STORAGE_KEY, String(clamped));
        set({ wallpaperOverlayOpacity: clamped });
    },
    handleSetWallpaperFloatingOpacity: (value) => {
        // 下限 0：要的就是「只有字、没有底」（见 persistence 那边的说明）。
        const clamped = Math.min(1, Math.max(0, value));
        localStorage.setItem(WALLPAPER_FLOATING_OPACITY_STORAGE_KEY, String(clamped));
        set({ wallpaperFloatingOpacity: clamped });
    },
    handleToggleWallpaperFloatingOverSafeArea: (enable) => {
        localStorage.setItem(
            WALLPAPER_FLOATING_OVER_SAFE_AREA_STORAGE_KEY, enable ? 'true' : 'false');
        set({ wallpaperFloatingOverSafeArea: enable });
    },
    handleSetWallpaperFloatingOffsetX: (value) => {
        const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
        localStorage.setItem(WALLPAPER_FLOATING_OFFSET_X_STORAGE_KEY, String(clamped));
        set({ wallpaperFloatingOffsetX: clamped });
    },
    handleSetWallpaperFloatingWidth: (value) => {
        // 下限 0.5：再窄的话一行歌词基本每句都要靠横向滚动才看得完。
        const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0.5, value)) : 0.8;
        localStorage.setItem(WALLPAPER_FLOATING_WIDTH_STORAGE_KEY, String(clamped));
        set({ wallpaperFloatingWidth: clamped });
    },
    handleToggleWallpaperFloatingFillSafeArea: (enable) => {
        localStorage.setItem(
            WALLPAPER_FLOATING_FILL_SAFE_AREA_STORAGE_KEY, enable ? 'true' : 'false');
        set({ wallpaperFloatingFillSafeArea: enable });
    },
    handleSetWallpaperFloatingAvoidWidth: (value) => {
        // 上限 0.5：划掉一半以上就没什么地方画字了。0 = 不避让。
        const clamped = Number.isFinite(value) ? Math.min(0.5, Math.max(0, value)) : 0.12;
        localStorage.setItem(WALLPAPER_FLOATING_AVOID_WIDTH_STORAGE_KEY, String(clamped));
        set({ wallpaperFloatingAvoidWidth: clamped });
    },
    handleSetWallpaperFloatingAvoidOffsetX: (value) => {
        const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
        localStorage.setItem(WALLPAPER_FLOATING_AVOID_OFFSET_X_STORAGE_KEY, String(clamped));
        set({ wallpaperFloatingAvoidOffsetX: clamped });
    },
    handleSetWallpaperFloatingPreview: (enable) => {
        set({ wallpaperFloatingPreview: enable });
    },
    handleSetWallpaperLyricsFontMode: (mode) => {
        localStorage.setItem(WALLPAPER_LYRICS_FONT_MODE_STORAGE_KEY, mode);
        set({ wallpaperLyricsFontMode: mode });
    },
    handleSetWallpaperFloatingFontSizeMode: (mode) => {
        localStorage.setItem(WALLPAPER_FLOATING_FONT_SIZE_MODE_STORAGE_KEY, mode);
        set({ wallpaperFloatingFontSizeMode: mode });
    },
    handleSetWallpaperFloatingFontSize: (value) => {
        // 10~32dp：再小看不清，再大一行就装不下。
        const clamped = Number.isFinite(value) ? Math.min(32, Math.max(10, value)) : 14;
        localStorage.setItem(WALLPAPER_FLOATING_FONT_SIZE_STORAGE_KEY, String(clamped));
        set({ wallpaperFloatingFontSize: clamped });
    },
    handleToggleWallpaperOverlayAllApps: (enable) => {
        localStorage.setItem(WALLPAPER_OVERLAY_ALL_APPS_STORAGE_KEY, enable ? 'true' : 'false');
        set({ wallpaperOverlayAllApps: enable });
    },
    handleToggleWallpaperOverlayHideNativeLyrics: (enable) => {
        localStorage.setItem(WALLPAPER_OVERLAY_HIDE_NATIVE_LYRICS_STORAGE_KEY, enable ? 'true' : 'false');
        set({ wallpaperOverlayHideNativeLyrics: enable });
    },
    handleToggleWallpaperOverlayHideNativeProgress: (enable) => {
        localStorage.setItem(WALLPAPER_OVERLAY_HIDE_NATIVE_PROGRESS_STORAGE_KEY, enable ? 'true' : 'false');
        set({ wallpaperOverlayHideNativeProgress: enable });
    },
    handleToggleWallpaperOverlaySkipInstrumental: (enable) => {
        localStorage.setItem(WALLPAPER_OVERLAY_SKIP_INSTRUMENTAL_STORAGE_KEY, enable ? 'true' : 'false');
        set({ wallpaperOverlaySkipInstrumental: enable });
    },
    handleToggleWallpaperOverlayHideWhenPaused: (enable) => {
        localStorage.setItem(WALLPAPER_OVERLAY_HIDE_WHEN_PAUSED_STORAGE_KEY, enable ? 'true' : 'false');
        set({ wallpaperOverlayHideWhenPaused: enable });
    },
    handleToggleWallpaperOverlayHideAfterLyricsEnd: (enable) => {
        localStorage.setItem(WALLPAPER_OVERLAY_HIDE_AFTER_LYRICS_END_STORAGE_KEY, enable ? 'true' : 'false');
        set({ wallpaperOverlayHideAfterLyricsEnd: enable });
    },
    handleToggleWallpaperOverlayHideCoverArt: (enable) => {
        localStorage.setItem(WALLPAPER_OVERLAY_HIDE_COVER_ART_STORAGE_KEY, enable ? 'true' : 'false');
        set({ wallpaperOverlayHideCoverArt: enable });
    },
}));

/**
 * The visualizer half of what selectSettingsUiSnapshot used to expose, kept as one grouped
 * selector for the settings surfaces that legitimately edit the whole domain at once.
 * Ordinary consumers should select the single field they need instead.
 */
export const selectVisualizerSettingsSnapshot = (state: VisualizerSettingsState) => ({
    ...Object.fromEntries(declaredFieldNames.map(name => [name, (state as unknown as Fields)[name]])) as unknown as VisualizerTuningSettings,
    backgroundOpacity: state.backgroundOpacity,
    disableVisualizerGeometricBackground: state.disableVisualizerGeometricBackground,
    disableVisualizerVignette: state.disableVisualizerVignette,
    handleResetVisualizerBackgroundMode: state.handleResetVisualizerBackgroundMode,
    handleSetBackgroundOpacity: state.handleSetBackgroundOpacity,
    handleSetVisualizerBackgroundMode: state.handleSetVisualizerBackgroundMode,
    handleSetVisualizerFrameRate: state.handleSetVisualizerFrameRate,
    handleSetVisualizerMode: state.handleSetVisualizerMode,
    handleSetVisualizerOpacity: state.handleSetVisualizerOpacity,
    handleSetSmartBeat: state.handleSetSmartBeat,
    handleToggleDisableVisualizerGeometricBackground: state.handleToggleDisableVisualizerGeometricBackground,
    handleToggleDisableVisualizerVignette: state.handleToggleDisableVisualizerVignette,
    handleToggleRandomVisualizerModePerSong: state.handleToggleRandomVisualizerModePerSong,
    randomVisualizerModePerSong: state.randomVisualizerModePerSong,
    randomVisualizerModes: state.randomVisualizerModes,
    handleSetRandomVisualizerModes: state.handleSetRandomVisualizerModes,
    smartBeat: state.smartBeat,
    visualizerBackgroundMode: state.visualizerBackgroundMode,
    visualizerFrameRate: state.visualizerFrameRate,
    visualizerMode: state.visualizerMode,
    visualizerOpacity: state.visualizerOpacity,
});

// Module-level handle for the assembly layer; an action needs no subscription.
export const handleSetVisualizerMode = (mode: VisualizerMode, options?: SetVisualizerModeOptions) => (
    useVisualizerSettingsStore.getState().handleSetVisualizerMode(mode, options)
);
