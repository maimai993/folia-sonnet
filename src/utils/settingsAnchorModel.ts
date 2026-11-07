import type { SettingsSubviewId } from '../stores/useSettingsModalStore';

// src/components/modal/settings/navigation/settingsAnchorModel.ts
// The places inside the settings that other code names: commands, Ponder scenes and links open the
// dialog on one of these. Each entry says which category's page the place is on, which a caller has
// to know before that page exists. The id itself is carried by a group or a row of the page:
// settingsAnchorCoverage.test.ts holds this table against the options the pages declare. The
// settings search finds a place by that group or row, under the page's name for it, and leaves it
// out where the page does not draw it (kit/options.ts); the table says nothing about either.

export const SETTINGS_ANCHOR_DEFINITIONS = {
    // pages/AppearancePage
    lyricsRenderer: { section: 'appearance' },
    // 歌词动态壁纸那一节（fork 独有，只有安卓画；见 LyricsWallpaperSettingsSection）。
    lyricsWallpaper: { section: 'appearance' },
    // 显示那几项（fork 独有；设备类型与横竖屏只有安卓画，运行时判断在那两个组件里）。
    // 液态玻璃的开关与参数搬去了「性能与动效」页那一组（它同时是性能设置），锚点见表里 graphics 那一段。
    lyricFlat: { section: 'appearance' },
    deviceType: { section: 'appearance' },
    // 原来这里还有一条 `phoneFit`（「手机适配」总开关）。那一行按用户要求删掉了 ——
    // 打开也不生效，而它门着的「横竖屏兼容」也一并换成了上面 `deviceType` 与
    // `forceLandscape` 两行（见 AndroidForceLandscapeSetting）。锚点跟着删，
    // 留着就是一条指向空处的深链：指令照样能跑，只是落不到任何一行上。
    // 云缓存那两项（fork 独有，AiProviderSettings 那块里的；只有非桌面才画）。
    cloudCache: { section: 'appearance' },
    cloudCacheBaseUrl: { section: 'appearance' },
    themePresets: { section: 'appearance' },
    electronSettings: { section: 'appearance' },

    // pages/PlayerPage
    playbackEntryView: { section: 'player' },
    latticeSettings: { section: 'player' },
    bottomUiSettings: { section: 'player' },
    stageTrackPill: { section: 'player' },
    videoLayerSettings: { section: 'player' },
    labPlayerUi: { section: 'player' },

    // pages/HomePage; the library UI is drawn only where there is more than one to choose from, and
    // the Bravais group only while bravais is the one in effect.
    librarySuite: { section: 'home' },
    bravaisSettings: { section: 'home' },
    // 速记簿那一组（fork 独有）：总开关、画布与排序。
    scratchpadSettings: { section: 'home' },
    homeTabsVisibility: { section: 'home' },
    grid3dCardStyle: { section: 'home' },
    rememberHomeCardPosition: { section: 'home' },
    gridViewCardSettings: { section: 'home' },

    // pages/LyricsPage
    localLyricFormatOrder: { section: 'lyrics' },

    // pages/PlaybackPage, pages/LyricsPage, and the listening report on pages/IntegrationPage
    queueSettings: { section: 'playback' },
    transitionSettings: { section: 'playback' },
    replayGainSettings: { section: 'playback' },
    audioOutputSettings: { section: 'playback' },
    lyrics: { section: 'lyrics' },
    scrobbleSettings: { section: 'integration' },

    // pages/GeneralPage, and the pinned commands on pages/InteractionPage
    languageSettings: { section: 'general' },
    ponderHints: { section: 'general' },
    pinnedCommands: { section: 'interaction' },
    // 屏幕常亮（fork 独有，只有安卓画；见 AndroidScreenAwakeSetting）。
    keepScreenAwake: { section: 'general' },

    // pages/GeneralPage (start-up and window)
    labWindowAndTools: { section: 'general' },

    // pages/InteractionPage
    gridActionButton: { section: 'interaction' },
    gridPaletteHotkey: { section: 'interaction' },
    customShortcut: { section: 'interaction' },
    globalShortcuts: { section: 'interaction' },

    // pages/IntegrationPage — the desktop app and the web build draw stage mode with different
    // rows; it is one destination.
    discordRichPresence: { section: 'integration' },
    obsBrowserSource: { section: 'integration' },
    lyricApi: { section: 'integration' },
    stageMode: { section: 'integration' },
    navidrome: { section: 'integration' },

    // pages/StoragePage, and the sync server on pages/IntegrationPage
    cacheDetails: { section: 'storage' },
    localLibraryWatch: { section: 'storage' },
    mediaCache: { section: 'storage' },
    r2Sync: { section: 'integration' },

    // pages/StoragePage (backup and import)
    importExportTitle: { section: 'storage' },

    // pages/DesktopPage, and the update check on pages/GeneralPage
    desktopTrayBehavior: { section: 'desktop' },
    wallpaperMode: { section: 'desktop' },
    updateCheck: { section: 'general' },

    // pages/GraphicsPage; the render GPU row only in the Windows desktop app.
    graphicsPerformance: { section: 'graphics' },
    graphicsMotion: { section: 'graphics' },
    // 歌词画布分辨率与抗锯齿那一行（见 renderQuality/LyricRenderQualityRows）。
    lyricRenderScale: { section: 'graphics' },
    gpuPreference: { section: 'graphics' },
    // HiFi 引擎那一组（fork 独有，只在桌面 Electron 里画）。
    hifiEngine: { section: 'playback' },
    // 液态玻璃那一组（fork 独有）：总开关、预设、参数与效果开关。
    liquidGlass: { section: 'graphics' },
    liquidGlassEnabled: { section: 'graphics' },

    // pages/ModsPage
    modSystem: { section: 'mods' },
    modList: { section: 'mods' },
} as const satisfies Record<string, { section: SettingsSubviewId }>;

export type SettingsAnchorId = keyof typeof SETTINGS_ANCHOR_DEFINITIONS;

export const SETTINGS_ANCHOR_SECTION = Object.fromEntries(
    Object.entries(SETTINGS_ANCHOR_DEFINITIONS).map(([id, definition]) => [id, definition.section]),
) as Record<SettingsAnchorId, SettingsSubviewId>;

export const settingsAnchorSubview = (anchorId: SettingsAnchorId): SettingsSubviewId => (
    SETTINGS_ANCHOR_SECTION[anchorId]
);
