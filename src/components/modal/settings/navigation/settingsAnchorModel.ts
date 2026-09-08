import type { SettingsSubviewId } from '../../../../stores/useSettingsModalStore';

// src/components/modal/settings/navigation/settingsAnchorModel.ts
// Which options-tab section each <SettingsAnchor> lives in.
//
// The sidebar table of contents discovers anchors at render time, which is right for a list that
// has to follow conditional sections. But a command that wants to *land* on one has to know its
// section before the panel exists, and that fact cannot be discovered — so it is declared here,
// once. settingsAnchorCoverage.test.ts holds this table against the anchors actually rendered, so
// a section that moves cannot leave a command pointing at the wrong page.

export const SETTINGS_ANCHOR_SECTION = {
    // AppearanceSettingsSubview
    themePresets: 'appearance',
    lyricsRenderer: 'appearance',
    stageTrackPill: 'appearance',
    grid3dCardStyle: 'appearance',
    latticeSettings: 'appearance',
    importExportTitle: 'appearance',

    // GeneralSettingsSubview (PinnedCommandSettings renders inside it)
    languageSettings: 'general',
    homeTabsVisibility: 'general',
    bottomUiSettings: 'general',
    pinnedCommands: 'general',

    // PlaybackSettingsSubview (TransitionSettingsSection renders inside it)
    queueSettings: 'playback',
    replayGainSettings: 'playback',
    lyrics: 'playback',
    audioOutputSettings: 'playback',
    transitionSettings: 'playback',

    // InteractionSettingsSubview
    gridActionButton: 'interaction',
    gridPaletteHotkey: 'interaction',
    customShortcut: 'interaction',

    // IntegrationSettingsSubview — stageMode is declared twice on purpose, the Electron and web
    // panels being mutually exclusive; it is still one destination.
    discordRichPresence: 'integration',
    obsBrowserSource: 'integration',
    lyricApi: 'integration',
    stageMode: 'integration',
    navidrome: 'integration',

    // StorageSettingsSection (LocalLibraryWatchSection renders inside it)
    cacheDetails: 'storage',
    r2Sync: 'storage',
    mediaCache: 'storage',
    localLibraryWatch: 'storage',

    // DesktopSettingsSubview
    desktopTrayBehavior: 'desktop',
    wallpaperMode: 'desktop',
    updateCheck: 'desktop',
    electronSettings: 'desktop',

    // LabSettingsModal
    labPerformance: 'lab',
    labPlayerUi: 'lab',
    labWindowAndTools: 'lab',
} as const satisfies Record<string, SettingsSubviewId>;

export type SettingsAnchorId = keyof typeof SETTINGS_ANCHOR_SECTION;

export const settingsAnchorSubview = (anchorId: SettingsAnchorId): SettingsSubviewId => (
    SETTINGS_ANCHOR_SECTION[anchorId]
);
