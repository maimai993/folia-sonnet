import { create } from 'zustand';
import type React from 'react';
import { DEFAULT_CADENZA_TUNING, DEFAULT_CAPPELLA_TUNING, DEFAULT_CLASSIC_TUNING, DEFAULT_CLADDAGH_TUNING, DEFAULT_DIORAMA_TUNING, DEFAULT_FUME_TUNING, DEFAULT_LATENT_BACKGROUND_TUNING, DEFAULT_MONET_BACKGROUND_TUNING, DEFAULT_MONET_TUNING, DEFAULT_NOMAND_BACKGROUND_TUNING, DEFAULT_PARTITA_TUNING, DEFAULT_PENDOLO_TUNING, DEFAULT_SONNET_TUNING, DEFAULT_TEMPERA_LAYER_IMAGE, DEFAULT_TEMPERA_TUNING, DEFAULT_TILT_TUNING, DIORAMA_PARTICLE_DENSITY_MAX, DIORAMA_PARTICLE_DENSITY_MIN, DIORAMA_PARTICLE_GLOW_INTENSITY_MAX, DIORAMA_PARTICLE_GLOW_INTENSITY_MIN, DIORAMA_PARTICLE_SIZE_MAX, DIORAMA_PARTICLE_SIZE_MIN, TEMPERA_MAX_LAYER_IMAGES, type CadenzaTuning, type CappellaAvatarImage, type CappellaAvatarSource, type CappellaEmojiImage, type CappellaTuning, type ClassicTuning, type CladdaghTuning, type DioramaTuning, type FumeTuning, type LatentBackgroundColorSource, type LatentBackgroundDisplayMode, type LatentBackgroundTuning, type LocalLyricsPriority, type LyricProviderSource, type MonetBackgroundImage, type MonetBackgroundLayout, type MonetBackgroundSource, type MonetBackgroundTuning, type MonetBackgroundWashColorMode, type MonetPortraitImage, type MonetPortraitSource, type MonetTuning, type NomandBackgroundDitheringType, type NomandBackgroundEffect, type NomandBackgroundSource, type NomandBackgroundTuning, type PartitaTuning, type PendoloTuning, type QueueAddBehavior, type SonnetTuning, type StatusMessage, type StoredCappellaAvatarImage, type StoredCappellaEmojiImage, type StoredCustomLyricsFont, type StoredMonetBackgroundImage, type StoredMonetPortraitImage, type SubtitleContentMode, type TemperaLayerImage, type TemperaTuning, type Theme, type TiltTuning, type UrlBackgroundItem, type VisualizerBackgroundMode, type VisualizerFrameRate, type VisualizerMode } from '../types';
import { DEFAULT_VISUALIZER_MODE, getVisualizerModeLabel, getVisualizerRegistryEntry, hasVisualizerMode } from '../components/visualizer/registry';
import { DEFAULT_VISUALIZER_BACKGROUND_MODE, hasVisualizerBackgroundMode } from '../components/visualizer/backgrounds/registry';
import { resolveDioramaMoteCircumference, resolveDioramaMoteRadial } from '../components/visualizer/diorama/dioramaMoteField';
import { getLyricFilterError } from '../utils/lyrics/filtering';
import { getLyricStaffPatternError } from '../utils/lyrics/staffCredits';
import { DEFAULT_LYRIC_STAFF_MIN_DWELL_SECONDS, DEFAULT_LYRIC_STAFF_POLICY, LYRIC_STAFF_MIN_DWELL_RANGE, type LyricStaffPolicy } from '../utils/lyrics/staffCreditsPolicy';
import { buildStoredCappellaEmojiPack, clearCustomCappellaEmojiPack, isSupportedCappellaEmojiFile, saveCustomCappellaEmojiPack } from '../services/cappellaEmojiPack';
import { buildStoredCappellaAvatar, clearCustomCappellaAvatar, isSupportedCappellaAvatarFile, saveCustomCappellaAvatar } from '../services/cappellaAvatarPack';
import { clearUploadedLyricsFont, uploadAndRegisterLyricsFont } from '../services/customLyricsFont';
import { buildStoredMonetBackgroundImage, clearMonetBackgroundImage, isSupportedMonetBackgroundFile, saveMonetBackgroundImage } from '../services/monetBackgroundImage';
import { buildStoredMonetPortraitImage, clearMonetPortraitImage, isSupportedMonetPortraitFile, saveMonetPortraitImage } from '../services/monetPortraitImage';
import { parseVisualizerFrameRate, setGlobalVisualizerFrameRate, VISUALIZER_FRAME_RATE_STORAGE_KEY } from '../utils/frameRateLimiter';
import { sanitizeUrlBackgroundItem, sanitizeUrlBackgroundList } from '../utils/urlBackground';
import { getLyricProviderPreferenceLabel } from '../utils/lyrics/lyricSourceLabels';
import { migratePreferredLyricSource } from '../utils/lyrics/sourcePriority';
import { applyAppLanguagePreference, readStoredAppLanguagePreference, type AppLanguagePreference } from '../i18n/config';
import { normalizeFontFamilyStack, normalizeFontWeight } from '../utils/fontStacks';
import i18n from '../i18n/config';
import { clampCrossfadeSeconds, CROSSFADE_DEFAULT_SEC } from '../services/automix/crossfadePlanner';
import { DEFAULT_TRANSITION_SETTINGS, isTransitionMode, type TransitionMode } from '../services/automix/transitionStrategy';
import { modelsPresent } from '../services/automix/modelAvailability';
import type { AudioQualityPreference } from '../types/onlineMusic';
import {
    normalizePinnedCommandIds,
    readPinnedCommandIds,
    writePinnedCommandIds,
    type PinnedCommandIds,
} from '../components/command-palette/pinnedCommandPreferences';
import {
    getAudioEqualizerCustomSlotIndex,
    isAudioEqualizerCustomSlotId,
    readStoredAudioEqualizerSettings,
    resolveAudioEqualizerSettings,
    writeStoredAudioEqualizerSettings,
    type AudioEqualizerModeId,
    type AudioEqualizerSettings,
} from '../utils/audioEqualizer';
import { AUDIO_SOUND_PRESETS } from '../utils/audioPresets';
import { setStatusMessage, type StatusSetter } from './useStatusMessageStore';
import { getStoredBoolean, getStoredString, setStoredBoolean } from './storagePrimitives';
import {
    VISUALIZER_OPACITY_STORAGE_KEY,
    clampCladdaghEllipseTiltDeg,
    clampCladdaghFocusScaleRatio,
    clampCladdaghLetterSpacingOffset,
    clampCladdaghRadiusScale,
    clampClassicBreathingFloatMultiplier,
    clampClassicWordSpacing,
    clampFumeBackgroundObjectOpacity,
    clampFumeCameraSpeed,
    clampFumeGlowIntensity,
    clampFumeHeroScale,
    clampFumeTextHoldRatio,
    clampPartitaStagger,
    clampUnit,
    readStoredBackgroundOpacity,
    readStoredCadenzaTuning,
    readStoredCappellaTuning,
    readStoredCladdaghTuning,
    readStoredClassicTuning,
    readStoredDioramaTuning,
    readStoredFumeTuning,
    readStoredLatentBackgroundTuning,
    readStoredMonetBackgroundTuning,
    readStoredMonetTuning,
    readStoredNomandBackgroundTuning,
    readStoredPartitaTuning,
    readStoredPendoloTuning,
    readStoredSonnetTuning,
    readStoredTemperaTuning,
    readStoredTiltTuning,
    readStoredUrlBackgroundList,
    readStoredUrlBackgroundSelectedId,
    readStoredVisualizerBackgroundMode,
    readStoredVisualizerFrameRate,
    readStoredVisualizerMode,
    readStoredVisualizerOpacity,
    resolveCappellaAvatarSource,
    resolveFumeCameraTrackingMode,
    resolvePendoloNumber,
    resolveStoredDioramaTuning,
    resolveStoredLatentBackgroundTuning,
    resolveStoredMonetBackgroundTuning,
    resolveStoredMonetTuning,
    resolveStoredNomandBackgroundTuning,
    sanitizeTemperaLayerImages,
} from './visualizerSettingsPersistence';

// src/stores/useSettingsUiStore.ts
// Shared settings state and actions used by App, Home, and SettingsModal.

export type { StatusSetter };
export const CACHE_SIZE_KEY = 'folia_cache_size';
export const ENABLE_MEDIA_CACHE_KEY = 'folia_enable_media_cache';
/** What the toggle used to write to, before it was corrected to the prefixed key above. */
export const LEGACY_ENABLE_MEDIA_CACHE_KEY = 'enable_media_cache';
export const MEDIA_CACHE_LIMIT_GB_KEY = 'folia_media_cache_limit_gb';
/** Gigabytes of cached audio to keep. Zero is the listener asking for no ceiling at all. */
export const DEFAULT_MEDIA_CACHE_LIMIT_GB = 5;
/** Set only by the reminder's own "don't remind me" button. Absent = still worth asking. */
export const AUTOMIX_MODEL_REMINDER_MUTED_KEY = 'folia_automix_model_reminder_muted';

export type AudioQuality = AudioQualityPreference;
export type SettingsModalInitialTab = 'help' | 'options';
export type SettingsSubviewId = 'appearance' | 'general' | 'playback' | 'integration' | 'storage' | 'desktop' | 'lab' | 'visualizer' | 'themePark' | 'lyricFilter' | 'globalLyricOffset';
export type VisualizerSettingsSection = 'common' | 'background' | 'visualizer' | 'subtitle';
export type SettingsModalState = {
    isOpen: boolean;
    initialTab: SettingsModalInitialTab;
    initialSubview?: SettingsSubviewId | null;
    initialVisualizerSection?: VisualizerSettingsSection | null;
};

export const MINIMIZE_TO_TRAY_STORAGE_KEY = 'minimize_to_tray';
export const VOICE_INPUT_PAUSE_STORAGE_KEY = 'voice_input_pause_enabled';
export const PREVENT_DISPLAY_SLEEP_DURING_PLAYBACK_STORAGE_KEY = 'prevent_display_sleep_during_playback';
export const MOD_SYSTEM_ENABLED_STORAGE_KEY = 'mod_system_enabled';
export const HIDE_TASKBAR_ICON_STORAGE_KEY = 'hide_taskbar_icon';
export const REMOTE_CONTROL_SKIP_TASKBAR_STORAGE_KEY = 'remote_control_skip_taskbar';
export const WALLPAPER_MODE_STORAGE_KEY = 'wallpaper_mode';
export const OPEN_PLAYER_ON_LAUNCH_STORAGE_KEY = 'open_player_on_launch';


/**
 * Whether switching transitions on is worth interrupting for.
 *
 * Three ways to answer no, and they are three different reasons rather than one condition:
 *
 * - Not a desktop build. The browser cannot run either model no matter what it downloads, so a
 *   prompt there is an errand that does not exist - which is the same distinction the engine badge
 *   already draws between "a limit" and "something you can go and fix".
 * - The weights are already here. Asked of `modelsPresent()`, which the automix hook refreshes at
 *   startup, so a fresh launch with both files installed answers correctly without opening
 *   Settings first.
 * - The listener said not to ask again. That one is remembered rather than re-derived, because it
 *   is a preference and not a fact about the machine.
 *
 * Either model missing counts: the beat grid is what the crossfade mode reads for its alignment
 * too, so "I only use crossfade" is not a reason to be missing beat_this.
 */
export const shouldRemindAboutModels = (): boolean => {
    if (typeof window === 'undefined') return false;
    if (typeof window.electron?.separateStems !== 'function') return false;
    if (getStoredBoolean(AUTOMIX_MODEL_REMINDER_MUTED_KEY, false)) return false;
    const present = modelsPresent();
    return !present.beat_this || !present.htdemucs;
};

/**
 * Reads the media cache toggle, honouring the key its own setter used to write to.
 *
 * The setter wrote a bare 'enable_media_cache' while startup read the folia-prefixed key, so the
 * setting silently reverted to off on every restart. Anyone who switched it on has their real
 * preference sitting under the legacy key, and simply correcting the setter would throw that
 * away once more - so read it as a fallback and promote it to the canonical key.
 */
export const readStoredEnableMediaCache = (): boolean => {
    if (typeof window === 'undefined') {
        return false;
    }

    const canonical = localStorage.getItem(ENABLE_MEDIA_CACHE_KEY);
    if (canonical !== null) {
        return canonical === 'true';
    }

    const legacy = localStorage.getItem(LEGACY_ENABLE_MEDIA_CACHE_KEY);
    if (legacy === null) {
        return false;
    }

    localStorage.setItem(ENABLE_MEDIA_CACHE_KEY, legacy);
    return legacy === 'true';
};

export const readStoredMediaCacheLimitGb = (): number => {
    if (typeof window === 'undefined') {
        return DEFAULT_MEDIA_CACHE_LIMIT_GB;
    }

    const saved = localStorage.getItem(MEDIA_CACHE_LIMIT_GB_KEY);
    const parsed = saved === null ? NaN : Number(saved);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MEDIA_CACHE_LIMIT_GB;
};







export const resolveStoredAudioQuality = (saved: string | null): AudioQuality => (
    saved === 'standard' || saved === 'lossless' || saved === 'hires' ? saved : 'high'
);



















export type StageTrackPillMode = 'auto' | 'always' | 'never';









/**
 * Reads the stored card style for the Grid3D desktop home view from localStorage.
 * Returns 'image' (pure cover cover) or 'card' (Polaroid style with details).
 */
const readStoredGrid3dCardStyle = (): 'image' | 'card' => {
    if (typeof window === 'undefined') {
        return 'card';
    }

    const saved = localStorage.getItem('grid3d_card_style');
    return saved === 'image' ? 'image' : 'card';
};





export type SettingsUiState = {
    grid3dCardStyle: 'image' | 'card';
    handleSetGrid3dCardStyle: (style: 'image' | 'card') => void;
};


export const useSettingsUiStore = create<SettingsUiState>((set, get) => ({
    grid3dCardStyle: readStoredGrid3dCardStyle(),
    handleSetGrid3dCardStyle: (style) => {
        set({ grid3dCardStyle: style });
        if (typeof window !== 'undefined') localStorage.setItem('grid3d_card_style', style);
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (style === 'image' ? 'cardStyleImage' : 'cardStyleCard')),
        });
    },
}));

export const selectSettingsUiSnapshot = (state: SettingsUiState) => ({
    grid3dCardStyle: state.grid3dCardStyle,
    handleSetGrid3dCardStyle: state.handleSetGrid3dCardStyle,
});
