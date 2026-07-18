import { collectVisualizerTunings } from '../components/visualizer/tuningRegistry';
import { useSettingsUiStore } from '../stores/useSettingsUiStore';

// src/utils/visualSettingsConfig.ts
// The visual-settings subset of the shareable appearance config: everything compressConfig
// serializes except the theme and the song-theme automation flags. Reads the live settings
// store, so both the import/export "copy config" and the OBS URL builder stay in sync from a
// single field list.

export function buildVisualSettingsConfig(): Record<string, unknown> {
  const store = useSettingsUiStore.getState();
  return {
    visualizerMode: store.visualizerMode,
    randomVisualizerModePerSong: store.randomVisualizerModePerSong,
    visualizerBackgroundMode: store.visualizerBackgroundMode,
    backgroundOpacity: store.backgroundOpacity,
    visualizerOpacity: store.visualizerOpacity,
    hidePlayerTranslationSubtitle: store.hidePlayerTranslationSubtitle,
    showSubtitleTranslation: store.showSubtitleTranslation,
    subtitleOverlayBackground: store.subtitleOverlayBackground,
    lyricsFontStyle: store.lyricsFontStyle,
    lyricsFontScale: store.lyricsFontScale,
    lyricsFontFallbackFamilies: store.lyricsFontFallbackFamilies,
    subtitleFontInheritsLyrics: store.subtitleFontInheritsLyrics,
    subtitleFontStyle: store.subtitleFontStyle,
    subtitleFontFamily: store.subtitleFontFamily,
    subtitleFontFallbackFamilies: store.subtitleFontFallbackFamilies,
    visualizerTunings: collectVisualizerTunings(store as unknown as Record<string, unknown>),
    classicTuning: store.classicTuning,
    cadenzaTuning: store.cadenzaTuning,
    partitaTuning: store.partitaTuning,
    fumeTuning: store.fumeTuning,
    claddaghTuning: store.claddaghTuning,
    cappellaTuning: store.cappellaTuning,
    tiltTuning: store.tiltTuning,
    dioramaTuning: store.dioramaTuning,
    monetBackgroundTuning: store.monetBackgroundTuning,
    nomandBackgroundTuning: store.nomandBackgroundTuning,
    latentBackgroundTuning: store.latentBackgroundTuning,
    monetTuning: store.monetTuning,
    urlBackgroundList: store.urlBackgroundList,
    urlBackgroundSelectedId: store.urlBackgroundSelectedId,
  };
}
