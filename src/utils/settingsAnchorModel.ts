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
    // 姝岃瘝鍔ㄦ€佸绾搁偅涓€鑺傦紙fork 鐙湁锛屽彧鏈夊畨鍗撶敾锛涜 LyricsWallpaperSettingsSection锛夈€?    lyricsWallpaper: { section: 'appearance' },
    // 鏄剧ず閭ｅ嚑椤癸紙fork 鐙湁锛涜澶囩被鍨嬩笌妯珫灞忓彧鏈夊畨鍗撶敾锛岃繍琛屾椂鍒ゆ柇鍦ㄩ偅涓や釜缁勪欢閲岋級銆?    // 娑叉€佺幓鐠冪殑寮€鍏充笌鍙傛暟鎼幓浜嗐€屾€ц兘涓庡姩鏁堛€嶉〉閭ｄ竴缁勶紙瀹冨悓鏃舵槸鎬ц兘璁剧疆锛夛紝閿氱偣瑙佽〃閲?graphics 閭ｄ竴娈点€?    lyricFlat: { section: 'appearance' },
    // 鍘熸潵杩欓噷杩樻湁涓€鏉?`phoneFit`锛堛€屾墜鏈洪€傞厤銆嶆€诲紑鍏筹級銆傞偅涓€琛屾寜鐢ㄦ埛瑕佹眰鍒犳帀浜?鈥斺€?    // 鎵撳紑涔熶笉鐢熸晥锛岃€屽畠闂ㄧ潃鐨勩€屾í绔栧睆鍏煎銆嶄篃涓€骞舵崲鎴愪簡涓婇潰 `deviceType` 涓?    // `forceLandscape` 涓よ锛堣 AndroidForceLandscapeSetting锛夈€傞敋鐐硅窡鐫€鍒狅紝
    // 鐣欑潃灏辨槸涓€鏉℃寚鍚戠┖澶勭殑娣遍摼锛氭寚浠ょ収鏍疯兘璺戯紝鍙槸钀戒笉鍒颁换浣曚竴琛屼笂銆?    // 浜戠紦瀛橀偅涓ら」锛坒ork 鐙湁锛孉iProviderSettings 閭ｅ潡閲岀殑锛涘彧鏈夐潪妗岄潰鎵嶇敾锛夈€?    cloudCache: { section: 'appearance' },
    cloudCacheBaseUrl: { section: 'appearance' },
    themePresets: { section: 'appearance' },

    // pages/AiServicePage 鈥?the one AI connection every AI feature reads
    electronSettings: { section: 'ai' },

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
    // 閫熻绨块偅涓€缁勶紙fork 鐙湁锛夛細鎬诲紑鍏炽€佺敾甯冧笌鎺掑簭銆?
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
    // 灞忓箷甯镐寒锛坒ork 鐙湁锛屽彧鏈夊畨鍗撶敾锛涜 AndroidScreenAwakeSetting锛夈€?    keepScreenAwake: { section: 'general' },

    // pages/GeneralPage (start-up and window)
    labWindowAndTools: { section: 'general' },

    // pages/InteractionPage
    gridActionButton: { section: 'interaction' },
    gridPaletteHotkey: { section: 'interaction' },
    customShortcut: { section: 'interaction' },
    globalShortcuts: { section: 'interaction' },

    // pages/IntegrationPage 鈥?the desktop app and the web build draw stage mode with different
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

    // pages/RemotePage (desktop app only)
    remoteControl: { section: 'remote' },
    remoteLyrics: { section: 'remote' },

    // pages/GraphicsPage; the render GPU row only in the Windows desktop app.
    graphicsPerformance: { section: 'graphics' },
    graphicsMotion: { section: 'graphics' },
    // 姝岃瘝鐢诲竷鍒嗚鲸鐜囦笌鎶楅敮榻块偅涓€琛岋紙瑙?renderQuality/LyricRenderQualityRows锛夈€?
    lyricRenderScale: { section: 'graphics' },
    gpuPreference: { section: 'graphics' },
    // HiFi 寮曟搸閭ｄ竴缁勶紙fork 鐙湁锛屽彧鍦ㄦ闈?Electron 閲岀敾锛夈€?
    hifiEngine: { section: 'playback' },
    // 娑叉€佺幓鐠冮偅涓€缁勶紙fork 鐙湁锛夛細鎬诲紑鍏炽€侀璁俱€佸弬鏁颁笌鏁堟灉寮€鍏炽€?    liquidGlass: { section: 'graphics' },
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
