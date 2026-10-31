import React from 'react';
import { AnimatePresence } from 'framer-motion';
import type { MotionValue } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import VisPlayground from '../../visualizer/window/VisPlayground';
import { useVisualizerTunings } from '../../visualizer/useVisualizerTunings';
import { backgroundTuningConfig } from '../../visualizer/tuningRegistry';
import ThemePark from '../ThemePark';
import LyricFilterSettingsModal from '../LyricFilterSettingsModal';
import type { LyricFilterDraft } from '../LyricFilterSettingsModal';
import GlobalLyricOffsetModal from './GlobalLyricOffsetModal';
import { AiHelpPromptModal } from '../AiHelpPromptModal';
import ReleaseNotesDialog from '../ReleaseNotesDialog';
import type { DualTheme, LyricData, SongResult, Theme } from '../../../types';
import type { ThemeCacheSongKey } from '../../../services/themeCache';
import type { VisualizerSettingsSection } from '../../../stores/useSettingsModalStore';
import { selectLyricSettingsSnapshot, useLyricSettingsStore } from '../../../stores/useLyricSettingsStore';
import { selectPlayerChromeSettingsSnapshot, usePlayerChromeSettingsStore } from '../../../stores/usePlayerChromeSettingsStore';
import { selectThemeSettingsSnapshot, useThemeSettingsStore } from '../../../stores/useThemeSettingsStore';
import { selectTypographySettingsSnapshot, useTypographySettingsStore } from '../../../stores/useTypographySettingsStore';
import { selectVisualizerAssetSnapshot, useVisualizerAssetStore } from '../../../stores/useVisualizerAssetStore';
import { selectVisualizerSettingsSnapshot, useVisualizerSettingsStore } from '../../../stores/useVisualizerSettingsStore';

// src/components/modal/settings/SettingsSubWindows.tsx
// 设置窗口上层的那些窗口：调参台、主题公园，以及歌词过滤、全局歌词偏移、AI 帮助和更新说明四个弹窗。
// 它们只吃各自的 store 和几项外部传入的值，和设置窗口的页面/导航无关，所以单独一片。

export type SettingsSubWindowsOpen = {
    visPlayground: boolean;
    themePark: boolean;
    lyricFilter: boolean;
    globalLyricOffset: boolean;
    aiHelp: boolean;
    releaseNotes: boolean;
};

export type SettingsSubWindowsProps = {
    isDaylight: boolean;
    theme?: Theme;
    initialVisualizerSection?: VisualizerSettingsSection | null;
    themeParkInitialTheme: DualTheme;
    currentSongTitle?: string | null;
    currentLyrics: LyricData | null;
    lyricCurrentTime: MotionValue<number>;
    loadLyricFilterPreview: () => Promise<LyricData | null>;
    onSaveLyricFilterPattern: (draft: LyricFilterDraft) => Promise<void> | void;
    onSaveCustomTheme: (dualTheme: DualTheme) => void;
    onSaveAiTheme: (dualTheme: DualTheme, song: SongResult | null, songKey: ThemeCacheSongKey | null) => void;
    open: SettingsSubWindowsOpen;
    onCloseVisPlayground: () => void;
    onCloseThemePark: () => void;
    onCloseLyricFilter: () => void;
    onCloseGlobalLyricOffset: () => void;
    onCloseAiHelp: () => void;
    onCloseReleaseNotes: () => void;
};

const SettingsSubWindows: React.FC<SettingsSubWindowsProps> = ({
    isDaylight,
    theme,
    initialVisualizerSection,
    themeParkInitialTheme,
    currentSongTitle,
    currentLyrics,
    lyricCurrentTime,
    loadLyricFilterPreview,
    onSaveLyricFilterPattern,
    onSaveCustomTheme,
    onSaveAiTheme,
    open,
    onCloseVisPlayground,
    onCloseThemePark,
    onCloseLyricFilter,
    onCloseGlobalLyricOffset,
    onCloseAiHelp,
    onCloseReleaseNotes,
}) => {
    const { useCoverColorBg, staticMode, handleToggleCoverColorBg: onToggleCoverColorBg } = useThemeSettingsStore(useShallow(selectThemeSettingsSnapshot));
    const { transparentPlayerBackground } = usePlayerChromeSettingsStore(useShallow(selectPlayerChromeSettingsSnapshot));

    const {
        lyricsCustomFontFamily,
        lyricsCustomFontLabel,
    } = useTypographySettingsStore(useShallow(selectTypographySettingsSnapshot));
    const {
        hidePlayerTranslationSubtitle,
        showSubtitleTranslation,
        subtitleContentMode,
        subtitleOverlayLayout,
        subtitleOverlayOpacity,
        subtitleOverlayBackground,
        subtitleUpcomingLyricsBlur,
        showHarmonySubtitle,
        harmonySubtitleBackground,
        lyricsFontStyle,
        lyricsFontScale,
        subtitleFontScale,
        lyricsFontWeight,
        lyricsFontFallbackFamilies,
        subtitleFontInheritsLyrics,
        subtitleFontStyle,
        subtitleFontWeight,
        subtitleFontFamily,
        subtitleFontFallbackFamilies,
        handleToggleHidePlayerTranslationSubtitle: onToggleHidePlayerTranslationSubtitle,
        handleToggleShowSubtitleTranslation: onToggleShowSubtitleTranslation,
        handleSetSubtitleContentMode: onSubtitleContentModeChange,
        handleSetSubtitleOverlayLayout: onSubtitleOverlayLayoutChange,
        handleSetSubtitleOverlayOpacity: setSubtitleOverlayOpacity,
        handleToggleSubtitleOverlayBackground: onToggleSubtitleOverlayBackground,
        handleToggleSubtitleUpcomingLyricsBlur: onToggleSubtitleUpcomingLyricsBlur,
        handleToggleShowHarmonySubtitle: onToggleShowHarmonySubtitle,
        handleToggleHarmonySubtitleBackground: onToggleHarmonySubtitleBackground,
        handleSetLyricsFontStyle: onLyricsFontStyleChange,
        handleSetLyricsFontScale: onLyricsFontScaleChange,
        handleSetSubtitleFontScale: onSubtitleFontScaleChange,
        handleSetLyricsFontWeight: onLyricsFontWeightChange,
        handleSetLyricsCustomFont: onLyricsCustomFontChange,
        handleUploadLyricsCustomFont: onLyricsCustomFontUpload,
        handleSetLyricsFontFallbackFamilies: onLyricsFontFallbackFamiliesChange,
        handleSetSubtitleFontInheritsLyrics: onSubtitleFontInheritsLyricsChange,
        handleSetSubtitleFontStyle: onSubtitleFontStyleChange,
        handleSetSubtitleFontWeight: onSubtitleFontWeightChange,
        handleSetSubtitleFontFamily: onSubtitleFontFamilyChange,
        handleSetSubtitleFontFallbackFamilies: onSubtitleFontFallbackFamiliesChange,
    } = useTypographySettingsStore(useShallow(selectTypographySettingsSnapshot));
    const {
        lyricFilterPattern,
        lyricFilterEnabled,
        lyricStaffPolicy,
        lyricStaffMinDwellSeconds,
        lyricStaffAbsorbMode,
        lyricStaffPattern,
    } = useLyricSettingsStore(useShallow(selectLyricSettingsSnapshot));
    const {
        handleToggleDisableVisualizerVignette: onToggleDisableVisualizerVignette,
        handleToggleDisableVisualizerGeometricBackground: onToggleDisableVisualizerGeometricBackground,
        handleSetBackgroundOpacity: setBackgroundOpacity,
        handleSetVisualizerOpacity: setVisualizerOpacity,
        handleSetVisualizerBackgroundMode: onVisualizerBackgroundModeChange,
        handleSetVisualizerMode: onVisualizerModeChange,
        handleUploadMonetBackgroundImage: onUploadMonetBackgroundImage,
        handleClearMonetBackgroundImage: onClearMonetBackgroundImage,
        handleAddUrlBackgroundItem: onAddUrlBackgroundItem,
        handleUpdateUrlBackgroundItem: onUpdateUrlBackgroundItem,
        handleDeleteUrlBackgroundItem: onDeleteUrlBackgroundItem,
        handleSetUrlBackgroundSelectedId: onSetUrlBackgroundSelectedId,
    } = useVisualizerSettingsStore(useShallow(selectVisualizerSettingsSnapshot));
    const {
        disableVisualizerVignette,
        disableVisualizerGeometricBackground,
        backgroundOpacity,
        visualizerOpacity,
        visualizerBackgroundMode,
        visualizerMode,
        urlBackgroundList,
        urlBackgroundSelectedId,
    } = useVisualizerSettingsStore(useShallow(selectVisualizerSettingsSnapshot));
    // The store's fields as one object: the backgrounds' tunings are taken from it by their declarations.
    const visualizerSettings = useVisualizerSettingsStore(useShallow(selectVisualizerSettingsSnapshot));
    const visualizerTunings = useVisualizerTunings();
    const {
        cappellaCustomEmojiImages,
        cappellaCustomAvatarImages,
        monetBackgroundImage,
        isLoadingMonetBackgroundImage,
        monetPortraitImage,
    } = useVisualizerAssetStore(useShallow(selectVisualizerAssetSnapshot));

    return (
        <>
            <AnimatePresence>
                {open.visPlayground && (
                    <VisPlayground
                        theme={theme}
                        isDaylight={isDaylight}
                        visualizerMode={visualizerMode}
                        initialEditSection={initialVisualizerSection ?? 'visualizer'}
                        visualizerOpacity={visualizerOpacity}
                        staticMode={staticMode}
                        backgroundConfig={{
                            mode: visualizerBackgroundMode,
                            transparent: transparentPlayerBackground,
                            common: {
                                useCoverColorBg,
                                opacity: backgroundOpacity,
                                disableVignette: disableVisualizerVignette,
                                disableGeometricBackground: disableVisualizerGeometricBackground,
                            },
                            customImage: monetBackgroundImage,
                            ...backgroundTuningConfig(visualizerSettings),
                            url: {
                                items: urlBackgroundList,
                                selectedId: urlBackgroundSelectedId,
                            },
                        }}
                        backgroundActions={{
                            onModeChange: onVisualizerBackgroundModeChange,
                            common: {
                                onCoverColorChange: onToggleCoverColorBg,
                                onOpacityChange: setBackgroundOpacity,
                                onDisableVignetteChange: onToggleDisableVisualizerVignette,
                                onDisableGeometricChange: onToggleDisableVisualizerGeometricBackground,
                            },
                            customImage: {
                                onUpload: onUploadMonetBackgroundImage,
                                onClear: onClearMonetBackgroundImage,
                                isLoading: isLoadingMonetBackgroundImage,
                            },
                            url: {
                                onAdd: onAddUrlBackgroundItem,
                                onUpdate: onUpdateUrlBackgroundItem,
                                onDelete: onDeleteUrlBackgroundItem,
                                onSelect: onSetUrlBackgroundSelectedId,
                            },
                        }}
                        hideTranslationSubtitle={hidePlayerTranslationSubtitle}
                        showSubtitleTranslation={showSubtitleTranslation}
                        subtitleContentMode={subtitleContentMode}
                        subtitleOverlayLayout={subtitleOverlayLayout}
                        subtitleOverlayOpacity={subtitleOverlayOpacity}
                        subtitleOverlayBackground={subtitleOverlayBackground}
                        subtitleUpcomingLyricsBlur={subtitleUpcomingLyricsBlur}
                        showHarmonySubtitle={showHarmonySubtitle}
                        harmonySubtitleBackground={harmonySubtitleBackground}
                        fontStyle={lyricsFontStyle}
                        fontScale={lyricsFontScale}
                        subtitleFontScale={subtitleFontScale}
                        fontWeight={lyricsFontWeight}
                        customFontFamily={lyricsCustomFontFamily}
                        customFontLabel={lyricsCustomFontLabel}
                        fontFallbackFamilies={lyricsFontFallbackFamilies}
                        subtitleFontInheritsLyrics={subtitleFontInheritsLyrics}
                        subtitleFontStyle={subtitleFontStyle}
                        subtitleFontWeight={subtitleFontWeight}
                        subtitleFontFamily={subtitleFontFamily}
                        subtitleFontFallbackFamilies={subtitleFontFallbackFamilies}
                        onFontStyleChange={onLyricsFontStyleChange}
                        onFontScaleChange={onLyricsFontScaleChange}
                        onSubtitleFontScaleChange={onSubtitleFontScaleChange}
                        onFontWeightChange={onLyricsFontWeightChange}
                        onCustomFontChange={onLyricsCustomFontChange}
                        onUploadCustomFont={onLyricsCustomFontUpload}
                        onFontFallbackFamiliesChange={onLyricsFontFallbackFamiliesChange}
                        onSubtitleFontInheritsLyricsChange={onSubtitleFontInheritsLyricsChange}
                        onSubtitleFontStyleChange={onSubtitleFontStyleChange}
                        onSubtitleFontWeightChange={onSubtitleFontWeightChange}
                        onSubtitleFontFamilyChange={onSubtitleFontFamilyChange}
                        onSubtitleFontFallbackFamiliesChange={onSubtitleFontFallbackFamiliesChange}
                        onVisualizerModeChange={onVisualizerModeChange}
                        onVisualizerOpacityChange={setVisualizerOpacity}
                        onToggleHideTranslationSubtitle={onToggleHidePlayerTranslationSubtitle}
                        onToggleShowSubtitleTranslation={onToggleShowSubtitleTranslation}
                        onSubtitleContentModeChange={onSubtitleContentModeChange}
                        onSubtitleOverlayLayoutChange={onSubtitleOverlayLayoutChange}
                        onSubtitleOverlayOpacityChange={setSubtitleOverlayOpacity}
                        onToggleSubtitleOverlayBackground={onToggleSubtitleOverlayBackground}
                        onToggleSubtitleUpcomingLyricsBlur={onToggleSubtitleUpcomingLyricsBlur}
                        onToggleShowHarmonySubtitle={onToggleShowHarmonySubtitle}
                        onToggleHarmonySubtitleBackground={onToggleHarmonySubtitleBackground}
                        onClose={onCloseVisPlayground}
                    />
                )}
            </AnimatePresence>
            <AnimatePresence>
                {open.themePark && (
                    <ThemePark
                        initialTheme={themeParkInitialTheme}
                        isDaylight={isDaylight}
                        visualizerMode={visualizerMode}
                        visualizerTunings={visualizerTunings}
                        staticMode={staticMode}
                        visualizerOpacity={visualizerOpacity}
                        backgroundConfig={{
                            mode: visualizerBackgroundMode,
                            common: {
                                useCoverColorBg,
                                opacity: backgroundOpacity,
                                disableVignette: disableVisualizerVignette,
                                disableGeometricBackground: disableVisualizerGeometricBackground,
                            },
                            customImage: monetBackgroundImage,
                            ...backgroundTuningConfig(visualizerSettings),
                            url: {
                                items: urlBackgroundList,
                                selectedId: urlBackgroundSelectedId,
                            },
                        }}
                        cappellaCustomEmojiImages={cappellaCustomEmojiImages}
                        cappellaCustomAvatarImages={cappellaCustomAvatarImages}
                        monetPortraitImage={monetPortraitImage}
                        showSubtitleTranslation={showSubtitleTranslation}
                        subtitleContentMode={subtitleContentMode}
                        subtitleOverlayLayout={subtitleOverlayLayout}
                        lyricsFontStyle={lyricsFontStyle}
                        lyricsFontScale={lyricsFontScale}
                        lyricsFontWeight={lyricsFontWeight}
                        lyricsCustomFontFamily={lyricsCustomFontFamily}
                        onSaveCustomTheme={(dualTheme) => {
                            onSaveCustomTheme(dualTheme);
                            onCloseThemePark();
                        }}
                        onSaveAiTheme={(dualTheme, song, songKey) => {
                            onSaveAiTheme(dualTheme, song, songKey);
                            onCloseThemePark();
                        }}
                        onClose={onCloseThemePark}
                    />
                )}
            </AnimatePresence>

            <LyricFilterSettingsModal
                isOpen={open.lyricFilter}
                isDaylight={isDaylight}
                currentSongTitle={currentSongTitle}
                initialPattern={lyricFilterPattern}
                initialFilterEnabled={lyricFilterEnabled}
                initialStaffPolicy={lyricStaffPolicy}
                initialStaffMinDwellSeconds={lyricStaffMinDwellSeconds}
                initialStaffAbsorbMode={lyricStaffAbsorbMode}
                initialStaffPattern={lyricStaffPattern}
                loadPreviewLyrics={loadLyricFilterPreview}
                onClose={onCloseLyricFilter}
                onSave={onSaveLyricFilterPattern}
            />
            <GlobalLyricOffsetModal
                isOpen={open.globalLyricOffset}
                isDaylight={isDaylight}
                lyrics={currentLyrics}
                lyricCurrentTime={lyricCurrentTime}
                onClose={onCloseGlobalLyricOffset}
            />
            <AiHelpPromptModal
                isOpen={open.aiHelp}
                isDaylight={isDaylight}
                onClose={onCloseAiHelp}
            />
            <ReleaseNotesDialog
                isOpen={open.releaseNotes}
                isDaylight={isDaylight}
                onClose={onCloseReleaseNotes}
            />
        </>
    );
};

export default SettingsSubWindows;
