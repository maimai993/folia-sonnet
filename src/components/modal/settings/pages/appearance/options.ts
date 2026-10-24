import { hasElectronBridge, isCapacitorAndroid } from '../../../../../platform/runtime';
import { option, type SettingsGroupDef } from '../../kit';

// src/components/modal/settings/pages/appearance/options.ts
// The groups and options of the 外观 page, declared apart from the page so the files that draw its
// rows name the same ones. The wallpaper section draws its rows on its own (it keeps the older
// two-line shape); its rows are declared here as well, so the settings search lists them under the
// page and a landing can reach them.
//
// `noteKey` is the row's explanation, the one kept behind its "i" rather than printed under its
// label. The search matches it too: what people look for is usually a word in the explanation, and
// writing it here rather than in the row puts it in the index without a second copy of the string.

export const LYRICS: SettingsGroupDef = { id: 'lyricsRenderer', titleKey: 'options.lyricsRenderer' };

/**
 * 歌词动态壁纸那一组（fork 独有，只有安卓画）。
 *
 * 组里每一行都是壁纸那套自己的行（见 LyricsWallpaperSettingsSection），所以这里的声明只
 * 做两件事：让设置搜索能搜到它们，让点搜索结果能落到那一行。组的 `available` 一并决定了
 * 非安卓上整组连搜索结果一起退场。
 */
export const LYRICS_WALLPAPER: SettingsGroupDef = {
    id: 'lyricsWallpaper',
    titleKey: 'options.lyricsWallpaperSection',
    available: isCapacitorAndroid,
};

export const THEME: SettingsGroupDef = { id: 'themePresets', titleKey: 'options.settingsHeadingTheme' };
export const SONG_THEME: SettingsGroupDef = { id: 'songTheme', titleKey: 'options.settingsHeadingSongTheme' };
export const AI: SettingsGroupDef = { id: 'electronSettings', titleKey: 'options.electronSettings', electronOnly: true };

/**
 * 显示那一组（fork 独有）：毛玻璃、歌词扁平两端都画；设备类型与手机适配只有安卓有。
 * 原在「通用」页，那里剩下的都是语言、启动、更新这类「行为」，这几项讲的是「长什么样」，
 * 所以搬到这里，排在歌词那组之后。
 */
export const VIEW: SettingsGroupDef = { id: 'surfaceView', titleKey: 'options.settingsHeadingView' };

/** The wallpaper section's rows, in the order it draws them. */
export const WALLPAPER = {
    apply: option(LYRICS_WALLPAPER, 'lyricsWallpaperApply', 'options.lyricsWallpaperApply', { noteKey: 'options.lyricsWallpaperApplyDesc' }),
    style: option(LYRICS_WALLPAPER, 'lyricsWallpaperStyle', 'options.lyricsWallpaperStyle'),
    floatingOpacity: option(LYRICS_WALLPAPER, 'floatingLyricsOpacity', 'options.floatingLyricsOpacity', { noteKey: 'options.floatingLyricsOpacityDesc' }),
    floatingOverSafeArea: option(LYRICS_WALLPAPER, 'floatingLyricsOverSafeArea', 'options.floatingLyricsOverSafeArea', { noteKey: 'options.floatingLyricsOverSafeAreaDesc' }),
    floatingOffsetX: option(LYRICS_WALLPAPER, 'floatingLyricsOffsetX', 'options.floatingLyricsOffsetX', { noteKey: 'options.floatingLyricsOffsetXDesc' }),
    floatingWidth: option(LYRICS_WALLPAPER, 'floatingLyricsWidth', 'options.floatingLyricsWidth', { noteKey: 'options.floatingLyricsWidthDesc' }),
    floatingFillSafeArea: option(LYRICS_WALLPAPER, 'floatingLyricsFillSafeArea', 'options.floatingLyricsFillSafeArea', { noteKey: 'options.floatingLyricsFillSafeAreaDesc' }),
    floatingAvoidWidth: option(LYRICS_WALLPAPER, 'floatingLyricsAvoidWidth', 'options.floatingLyricsAvoidWidth', { noteKey: 'options.floatingLyricsAvoidWidthDesc' }),
    floatingAvoidOffsetX: option(LYRICS_WALLPAPER, 'floatingLyricsAvoidOffsetX', 'options.floatingLyricsAvoidOffsetX', { noteKey: 'options.floatingLyricsAvoidOffsetXDesc' }),
    floatingFontSize: option(LYRICS_WALLPAPER, 'floatingLyricsFontSize', 'options.floatingLyricsFontSize', { noteKey: 'options.floatingLyricsFontSizeDesc' }),
    floatingFontSizeCustom: option(LYRICS_WALLPAPER, 'floatingLyricsFontSizeCustom', 'options.floatingLyricsFontSizeCustom', { noteKey: 'options.floatingLyricsFontSizeCustomDesc' }),
    floatingWindow: option(LYRICS_WALLPAPER, 'floatingLyricsWindow', 'options.floatingLyricsWindow', { noteKey: 'options.floatingLyricsResetDesc' }),
    overlay: option(LYRICS_WALLPAPER, 'lyricsWallpaperOverlay', 'options.lyricsWallpaperOverlay', { noteKey: 'options.lyricsWallpaperOverlayDesc' }),
    overlayEnabled: option(LYRICS_WALLPAPER, 'wallpaperOverlayEnabled', 'options.wallpaperOverlayEnabled', { noteKey: 'options.wallpaperOverlayEnabledDesc' }),
    overlayOpacity: option(LYRICS_WALLPAPER, 'wallpaperOverlayOpacity', 'options.wallpaperOverlayOpacity', { noteKey: 'options.wallpaperOverlayOpacityDesc' }),
    overlayAllApps: option(LYRICS_WALLPAPER, 'wallpaperOverlayAllApps', 'options.wallpaperOverlayAllApps', { noteKey: 'options.wallpaperOverlayAllAppsDesc' }),
    overlayLockScreen: option(LYRICS_WALLPAPER, 'wallpaperOverlayLockScreen', 'options.wallpaperOverlayLockScreen', { noteKey: 'options.wallpaperOverlayLockScreenDesc' }),
    overlayLockScreenOnly: option(LYRICS_WALLPAPER, 'wallpaperOverlayLockScreenOnly', 'options.wallpaperOverlayLockScreenOnly', { noteKey: 'options.wallpaperOverlayLockScreenOnlyDesc' }),
    overlayHideNativeLyrics: option(LYRICS_WALLPAPER, 'wallpaperOverlayHideNativeLyrics', 'options.wallpaperOverlayHideNativeLyrics', { noteKey: 'options.wallpaperOverlayHideNativeLyricsDesc' }),
    overlayHideWhenPaused: option(LYRICS_WALLPAPER, 'wallpaperOverlayHideWhenPaused', 'options.wallpaperOverlayHideWhenPaused', { noteKey: 'options.wallpaperOverlayHideWhenPausedDesc' }),
    overlayHideAfterLyricsEnd: option(LYRICS_WALLPAPER, 'wallpaperOverlayHideAfterLyricsEnd', 'options.wallpaperOverlayHideAfterLyricsEnd', { noteKey: 'options.wallpaperOverlayHideAfterLyricsEndDesc' }),
    overlayHideCoverArt: option(LYRICS_WALLPAPER, 'wallpaperOverlayHideCoverArt', 'options.wallpaperOverlayHideCoverArt', { noteKey: 'options.wallpaperOverlayHideCoverArtDesc' }),
    overlaySkipInstrumental: option(LYRICS_WALLPAPER, 'wallpaperOverlaySkipInstrumental', 'options.wallpaperOverlaySkipInstrumental', { noteKey: 'options.wallpaperOverlaySkipInstrumentalDesc' }),
    overlayHideNativeProgress: option(LYRICS_WALLPAPER, 'wallpaperOverlayHideNativeProgress', 'options.wallpaperOverlayHideNativeProgress', { noteKey: 'options.wallpaperOverlayHideNativeProgressDesc' }),
    background: option(LYRICS_WALLPAPER, 'lyricsWallpaperBackground', 'options.lyricsWallpaperBackground', { noteKey: 'options.lyricsWallpaperBackgroundDesc' }),
    blur: option(LYRICS_WALLPAPER, 'lyricsWallpaperBlur', 'options.lyricsWallpaperBlur', { noteKey: 'options.lyricsWallpaperBlurDesc' }),
    progress: option(LYRICS_WALLPAPER, 'lyricsWallpaperProgress', 'options.lyricsWallpaperProgress', { noteKey: 'options.lyricsWallpaperProgressDesc' }),
    translation: option(LYRICS_WALLPAPER, 'lyricsWallpaperTranslation', 'options.lyricsWallpaperTranslation', { noteKey: 'options.lyricsWallpaperTranslationDesc' }),
    fontMode: option(LYRICS_WALLPAPER, 'lyricsWallpaperFontMode', 'options.lyricsWallpaperFontMode', { noteKey: 'options.lyricsWallpaperFontModeDesc' }),
    font: option(LYRICS_WALLPAPER, 'lyricsWallpaperFont', 'options.lyricsWallpaperFont', { noteKey: 'options.lyricsWallpaperFontDesc' }),
    feed: option(LYRICS_WALLPAPER, 'lyricsWallpaperFeed', 'options.lyricsWallpaperFeed', { noteKey: 'options.lyricsWallpaperFeedDesc' }),
};

export const O = {
    lyricsAnimation: option(LYRICS, 'lyricsAnimationAdjust', 'options.lyricsAnimationAdjust'),
    // 歌词动态壁纸（fork 独有）：整节只有安卓画，搜索里跟着一起退场（组上的 available）。
    lyricsWallpaper: option(LYRICS_WALLPAPER, 'lyricsWallpaper', 'options.lyricsWallpaperSection'),
    daylight: option(THEME, 'daylightMode', 'options.daylightMode'),
    preset: option(THEME, 'themePreset', 'options.themePresets'),
    themePark: option(THEME, 'openThemePark', 'options.openThemePark'),
    autoSwitch: option(SONG_THEME, 'autoSwitchSongTheme', 'options.autoSwitchSongTheme'),
    autoGenerate: option(SONG_THEME, 'autoGenerateSongTheme', 'options.autoGenerateSongTheme'),
    source: option(SONG_THEME, 'themeGenerationSource', 'options.themeGenerationSource'),
    preferCustom: option(SONG_THEME, 'preferCustomTheme', 'options.preferCustomTheme'),
    // 下面两项是 AiProviderSettings 那块卡片里的（fork 独有）：桌面端那块由 Electron 主进程
    // 设置顶掉，非桌面才画，搜索里跟着一起退场。
    cloudCache: option(SONG_THEME, 'cloudCache', 'options.cloudCache', {
        noteKey: 'options.cloudCacheDesc',
        available: () => !hasElectronBridge(),
    }),
    cloudCacheBaseUrl: option(SONG_THEME, 'cloudCacheBaseUrl', 'options.cloudCacheBaseUrl', {
        noteKey: 'options.cloudCacheBaseUrlDesc',
        available: () => !hasElectronBridge(),
    }),
    glassSurface: option(VIEW, 'glassSurface', 'options.glassSurface', { noteKey: 'options.glassSurfaceDesc' }),
    lyricFlat: option(VIEW, 'lyricFlat', 'options.lyricFlat', { noteKey: 'options.lyricFlatDesc' }),
    deviceType: option(VIEW, 'deviceType', 'options.deviceType', {
        noteKey: 'options.deviceTypeDesc',
        available: isCapacitorAndroid,
    }),
    // 界面缩放：设备类型底下的另一根滑条，自己占一行（滑条铺满整行宽）。
    uiScale: option(VIEW, 'uiScale', 'uiScale.title', {
        noteKey: 'uiScale.desc',
        available: isCapacitorAndroid,
    }),
    forceLandscape: option(VIEW, 'forceLandscape', 'options.forceLandscape', {
        noteKey: 'options.forceLandscapeDesc',
        available: isCapacitorAndroid,
    }),
    // 「进入可视化自动横屏」（fork 独有）：跟着上面那一行，因为两行讲的是同一件事（屏幕
    // 朝哪边）。这一行只在「播放后进入的视图」是可视化、且「强制横屏」关着时才真的转，
    // 说明里交代清楚，行本身照旧可拨。
    autoLandscapeVisualizer: option(VIEW, 'autoLandscapeVisualizer', 'options.autoLandscapeVisualizer', {
        noteKey: 'options.autoLandscapeVisualizerDesc',
        available: isCapacitorAndroid,
    }),
    aiProvider: option(AI, 'aiProvider', 'options.aiProvider'),
    geminiKey: option(AI, 'geminiApiKey', 'options.geminiApiKey'),
    openaiUrl: option(AI, 'openaiApiUrl', 'options.openaiApiUrl'),
    openaiModel: option(AI, 'openaiApiModel', 'options.openaiApiModel'),
    openaiTemperature: option(AI, 'openaiApiTemperature', 'options.openaiApiTemperature'),
    openaiStream: option(AI, 'openaiApiStream', 'options.openaiApiStream'),
    openaiKey: option(AI, 'openaiApiKey', 'options.openaiApiKey'),
    aiProxy: option(AI, 'useSystemProxyAI', 'options.useSystemProxyAI'),
};

/** What the wallpaper section draws, which the search lists under the page. */
export const LYRICS_WALLPAPER_OPTIONS = Object.values(WALLPAPER);
