import { collectVisualizerTunings } from '../../utils/visualizer/tunings';
import { readStoredThemeAutoGenerateEnabled, readStoredThemeAutoSwitchEnabled, readStoredThemeGenerationSource } from '../themePreferences';
import type { CappellaAvatarImage, CappellaEmojiImage, CappellaTuning, MonetBackgroundImage, MonetBackgroundTuning, MonetPortraitImage, MonetTuning, NomandBackgroundTuning } from '../../types';
import { useVisualizerSettingsStore } from '../../stores/useVisualizerSettingsStore';
import { useVisualizerAssetStore } from '../../stores/useVisualizerAssetStore';
import { useTypographySettingsStore } from '../../stores/useTypographySettingsStore';
import { useThemeSettingsStore } from '../../stores/useThemeSettingsStore';
import { useStageSettingsStore } from '../../stores/useStageSettingsStore';
import { useLibraryWallLookStore } from '../../stores/useLibraryWallLookStore';
import { usePlayerChromeSettingsStore } from '../../stores/usePlayerChromeSettingsStore';
import { useGlassSurfaceSettingsStore } from '../../stores/useGlassSurfaceSettingsStore';
import type { LiquidGlassEffects, LiquidGlassParams } from '../../shinoinject/liquidglass';
import { useLatticeSettingsStore } from '../../stores/useLatticeSettingsStore';
import { useScratchpadSettingsStore } from '../../stores/useScratchpadSettingsStore';

// src/services/obs/visualSettingsConfig.ts
// Everything compressConfig serializes except the theme. Reads the live settings store, so both
// the import/export "copy config" and the OBS URL builder stay in sync from a single field list.

export function buildVisualSettingsConfig(): Record<string, unknown> {
  const storeStageSettings = useStageSettingsStore.getState();
  const storeThemeSettings = useThemeSettingsStore.getState();
  const storeTypographySettings = useTypographySettingsStore.getState();
  const storeVisualizer = useVisualizerSettingsStore.getState();
  // The song-theme automation flags live in theme preferences, not the settings store. The overlay
  // ignores them, but a copied OBS URL is also a restore payload (the import box accepts one), so
  // dropping them here would silently lose both toggles on re-import. Auto-generate is ANDed with
  // auto-switch exactly as useThemeController composes it at mount, so a config can never carry the
  // impossible "generate on, switch off" pair.
  const songThemeAutoSwitchEnabled = readStoredThemeAutoSwitchEnabled();
  const songThemeAutoGenerateEnabled = songThemeAutoSwitchEnabled && readStoredThemeAutoGenerateEnabled();
  return {
    songThemeAutoSwitchEnabled,
    songThemeAutoGenerateEnabled,
    themeGenerationSource: readStoredThemeGenerationSource(),
    followSystemTheme: storeThemeSettings.followSystemTheme,
    visualizerMode: storeVisualizer.visualizerMode,
    randomVisualizerModePerSong: storeVisualizer.randomVisualizerModePerSong,
    randomVisualizerModes: storeVisualizer.randomVisualizerModes,
    visualizerBackgroundMode: storeVisualizer.visualizerBackgroundMode,
    backgroundOpacity: storeVisualizer.backgroundOpacity,
    // The other three legs of background.common, alongside the opacity above. The local OBS browser
    // source has always carried them (it publishes the whole VisualizerBackgroundConfig), so leaving
    // them out here made the two OBS paths disagree — and a copied config silently lost the cover-color,
    // geometric-background and vignette toggles on re-import.
    useCoverColorBg: storeThemeSettings.useCoverColorBg,
    disableVisualizerGeometricBackground: storeVisualizer.disableVisualizerGeometricBackground,
    disableVisualizerVignette: storeVisualizer.disableVisualizerVignette,
    // Static mode is not merely an audio-reactivity switch: it selects the low-motion branch inside
    // several renderers, so a web overlay without it animates where the main window does not.
    staticMode: storeThemeSettings.staticMode,
    visualizerOpacity: storeVisualizer.visualizerOpacity,
    // 歌词画布的分辨率与抗锯齿：OBS 页面读不到本机的设置，只能经配置码带过去（用户 2026-11-08 定，只带 OBS 页面看得到的）。
    lyricRenderQuality: storeVisualizer.lyricRenderQuality,
    hidePlayerTranslationSubtitle: storeTypographySettings.hidePlayerTranslationSubtitle,
    showSubtitleTranslation: storeTypographySettings.showSubtitleTranslation,
    subtitleContentMode: storeTypographySettings.subtitleContentMode,
    subtitleOverlayLayout: storeTypographySettings.subtitleOverlayLayout,
    subtitleOverlayBackground: storeTypographySettings.subtitleOverlayBackground,
    subtitleUpcomingLyricsBlur: storeTypographySettings.subtitleUpcomingLyricsBlur,
    subtitleOverlayOpacity: storeTypographySettings.subtitleOverlayOpacity,
    showHarmonySubtitle: storeTypographySettings.showHarmonySubtitle,
    harmonySubtitleBackground: storeTypographySettings.harmonySubtitleBackground,
    lyricsFontStyle: storeTypographySettings.lyricsFontStyle,
    lyricsFontScale: storeTypographySettings.lyricsFontScale,
    // The codec, the OBS overlay (obsWebAppearance -> buildVisualizerTheme) and the import path all
    // already handle the custom font weights; this field table is the only place they were missing,
    // so without them a copied link and the OBS overlay silently fall back to the mode's default
    // weight. null means "use the mode default" and is carried as-is so it round-trips.
    lyricsFontWeight: storeTypographySettings.lyricsFontWeight,
    lyricsFontFallbackFamilies: storeTypographySettings.lyricsFontFallbackFamilies,
    subtitleFontInheritsLyrics: storeTypographySettings.subtitleFontInheritsLyrics,
    subtitleFontScale: storeTypographySettings.subtitleFontScale,
    subtitleFontStyle: storeTypographySettings.subtitleFontStyle,
    subtitleFontWeight: storeTypographySettings.subtitleFontWeight,
    subtitleFontFamily: storeTypographySettings.subtitleFontFamily,
    subtitleFontFallbackFamilies: storeTypographySettings.subtitleFontFallbackFamilies,
    // Only a system font's family name is portable; an uploaded font is a browser-local FontFace
    // (its generated family resolves nowhere else), so it is not carried.
    lyricsCustomFontFamily: storeTypographySettings.lyricsCustomFont?.source === 'system' ? storeTypographySettings.lyricsCustomFont.family : null,
    visualizerTunings: collectVisualizerTunings(storeVisualizer as unknown as Record<string, unknown>),
    // Frozen: the 13 lyric-style tunings below predate the visualizerTunings bundle, which carries any
    // new style. Do not add a lyric style here.
    classicTuning: storeVisualizer.classicTuning,
    cadenzaTuning: storeVisualizer.cadenzaTuning,
    partitaTuning: storeVisualizer.partitaTuning,
    fumeTuning: storeVisualizer.fumeTuning,
    claddaghTuning: storeVisualizer.claddaghTuning,
    cappellaTuning: storeVisualizer.cappellaTuning,
    tiltTuning: storeVisualizer.tiltTuning,
    dioramaTuning: storeVisualizer.dioramaTuning,
    monetBackgroundTuning: storeVisualizer.monetBackgroundTuning,
    nomandBackgroundTuning: storeVisualizer.nomandBackgroundTuning,
    latentBackgroundTuning: storeVisualizer.latentBackgroundTuning,
    soraBackgroundTuning: storeVisualizer.soraBackgroundTuning,
    monetTuning: storeVisualizer.monetTuning,
    pendoloTuning: storeVisualizer.pendoloTuning,
    sonnetTuning: storeVisualizer.sonnetTuning,
    smartBeat: storeVisualizer.smartBeat,
    temperaTuning: storeVisualizer.temperaTuning,
    lumiereTuning: storeVisualizer.lumiereTuning,
    urlBackgroundList: storeVisualizer.urlBackgroundList,
    urlBackgroundSelectedId: storeVisualizer.urlBackgroundSelectedId,
    // The now playing card. Not a visualizer setting, but it is chrome the listener sees over the
    // same picture, and all three legs are needed together: the mode alone restores a card that
    // hides after someone else's timeout, and on a page the importer never asked for.
    stageTrackPillMode: storeStageSettings.stageTrackPillMode,
    stageTrackPillTimeoutSec: storeStageSettings.stageTrackPillTimeoutSec,
    stageTrackPillOnHome: storeStageSettings.stageTrackPillOnHome,
    stageTrackPillPosition: storeStageSettings.stageTrackPillPosition,
    // Whether the web link's overlay draws the card at all: without it the three legs above travel
    // but the overlay has no word on whether the streamer wanted the card in the source.
    stageTrackPillInObs: storeStageSettings.stageTrackPillInObs,
    // The bravais wall's collection stack edges (a tile look, so it travels with a shared look by the
    // settings rule). The wall's transparency and windows per block deliberately stay out — the user
    // decided so; see useLibraryWallLookStore.
    libraryWallStackEdges: useLibraryWallLookStore.getState().collectionStackEdges,
    // The bravais info strip's material (always see-through, or the solid preset) and how the
    // visualizer behind the wall is drawn (lyrics, blur): visual settings with no user exception,
    // so they travel with a shared look as well.
    libraryWallSeamClear: useLibraryWallLookStore.getState().seamClear,
    libraryWallSeamStyle: useLibraryWallLookStore.getState().seamStyle,
    libraryWallBackdropLyrics: useLibraryWallLookStore.getState().backdropLyrics,
    libraryWallBackdropBlur: useLibraryWallLookStore.getState().backdropBlur,
    // Which way the info strip opens (a column split, a row split across the wall, or by the screen's
    // shape): part of the wall's look, no user exception.
    libraryWallSeamDirection: useLibraryWallLookStore.getState().seamDirection,
    // 播放页标题栏后面那层磨砂底：属于播放页的样子，不给用户例外。OBS 覆盖层不画标题栏，用不上它，
    // 但它跟着一起走，导出的「样子」才是完整的。
    playerHeaderBlur: usePlayerChromeSettingsStore.getState().playerHeaderBlur,
    // 液态玻璃：总开关、四个参数与两个效果开关。界面材质，属于「长什么样」，随外观配置一起走。
    // 存成一整对象而不是六个平铺字段，短码只占一个键（llg）。
    liquidGlass: snapshotLiquidGlass(),
    ...snapshotTileLooks(),
  };
}

/** 液态玻璃的当前设置，导出用；没开也照样带走参数，导入方才能原样恢复。 */
function snapshotLiquidGlass(): LiquidGlassParams & LiquidGlassEffects & { enabled: boolean } {
  const glass = useGlassSurfaceSettingsStore.getState();
  return {
    enabled: glass.liquidGlassEnabled,
    strength: glass.strength,
    blur: glass.blur,
    sat: glass.sat,
    bend: glass.bend,
    light: glass.light,
    jelly: glass.jelly,
    // The frosted bar behind the player page's titlebar: a look of the player page, no user exception.
    // The OBS overlay draws no titlebar and ignores it; it rides along so a copied look keeps it.
  };
}

/**
 * 液态玻璃之外、但同样属于「长什么样」的几项。
 *
 * 它们不是一个 tunin 对象、也不归液态玻璃，所以跟着外观配置走的是顶层的平铺字段
 * （短码里各占一个键、导入计划里各自归组，见 utils/appearanceCodec 与 appearanceImportPlan）。
 * 放在这里而不是塞进 snapshotLiquidGlass：塞进去就只覆盖到液态玻璃那一块，导入方拿不到。
 */
function snapshotTileLooks(): Record<string, unknown> {
  return {
    // Numbering only the playing song on both tile walls (the queue collage and the bravais wall): a tile
    // look with no user exception, so it travels too (#930).
    latticeBadgeCurrentOnly: useLatticeSettingsStore.getState().latticeBadgeCurrentOnly,
    // The frosted bar behind the player page's titlebar: a look of the player page, no user exception.
    // The OBS overlay draws no titlebar and ignores it; it rides along so a copied look keeps it.
    playerHeaderBlur: usePlayerChromeSettingsStore.getState().playerHeaderBlur,
    // How the scratchpad's side tab looks while the pointer is away: a look of the library chrome, no user
    // exception, so it travels with a shared look. The OBS overlay draws no scratchpad and ignores it.
    scratchpadHandleStyle: useScratchpadSettingsStore.getState().handleStyle,
  };
}

// Whether the current settings use a custom font (a picked system font, an uploaded font, or a
// custom fallback family) rather than only a builtin sans/serif/mono style — used to warn on copy
// that the font may be unavailable on the OBS machine (and that an uploaded font never transfers).
export function hasCustomObsFont(): boolean {
  const storeTypographySettings = useTypographySettingsStore.getState();
  return Boolean(storeTypographySettings.lyricsCustomFont)
    || (storeTypographySettings.lyricsFontFallbackFamilies?.length ?? 0) > 0
    || Boolean(storeTypographySettings.subtitleFontFamily)
    || (storeTypographySettings.subtitleFontFallbackFamilies?.length ?? 0) > 0;
}

// The subset of settings that decide whether an uploaded image asset is in play. Kept structural
// (not the whole store type) so both the store snapshot and a reactive selector can feed it.
export interface UploadedObsAssetInputs {
  monetBackgroundTuning: MonetBackgroundTuning;
  nomandBackgroundTuning: NomandBackgroundTuning;
  monetTuning: MonetTuning;
  monetBackgroundImage: MonetBackgroundImage | null;
  monetPortraitImage: MonetPortraitImage | null;
  cappellaTuning: CappellaTuning;
  cappellaCustomEmojiImages: CappellaEmojiImage[];
  cappellaCustomAvatarImages: CappellaAvatarImage[];
}

// Whether the current settings rely on an uploaded image asset that the copied cfg URL cannot carry
// (an IndexedDB blob has no shareable URL). These ride the separate OBS Custom CSS payload instead,
// so this predicate both gates the "copy CSS" affordance and reshapes the copy hint. Only flag an
// asset when its custom source is actually selected and populated, so an unpicked toggle never warns.
// The uploaded background is shared by the Monet and Nomand modes, hence both source checks.
export function computeHasUploadedObsAsset(inputs: UploadedObsAssetInputs): boolean {
  const usesUploadedBackground = inputs.monetBackgroundTuning.backgroundSource === 'uploaded-global'
    || inputs.nomandBackgroundTuning.imageSource === 'uploaded-global';
  const usesCustomPortrait = inputs.monetTuning.portraitSource === 'custom';
  const usesCustomEmojis = inputs.cappellaTuning.emojiPackSource === 'custom'
    && inputs.cappellaCustomEmojiImages.length > 0;
  const usesCustomAvatars = inputs.cappellaTuning.avatarSource === 'custom'
    && inputs.cappellaCustomAvatarImages.length > 0;
  return (usesUploadedBackground && Boolean(inputs.monetBackgroundImage))
    || (usesCustomPortrait && Boolean(inputs.monetPortraitImage))
    || usesCustomEmojis
    || usesCustomAvatars;
}

export function hasUploadedObsAsset(): boolean {
  return computeHasUploadedObsAsset({
    ...useVisualizerSettingsStore.getState(),
    ...useVisualizerAssetStore.getState(),
  });
}

// Single source of truth for the OBS copy toast: an uploaded image is the more surprising loss
// (silent fall-back to the song cover), so it takes precedence over the font hint; neither in play
// means a plain success. Returns i18n keys, not text, so it stays free of any component's t().
export function resolveObsCopyHintKey(): { type: 'info' | 'success'; key: string; } {
  if (hasUploadedObsAsset()) {
    return { type: 'info', key: 'options.obsUrlUploadedAssetHint' };
  }
  if (hasCustomObsFont()) {
    return { type: 'info', key: 'options.obsUrlCustomFontHint' };
  }
  return { type: 'success', key: 'status.copied' };
}
