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
const AUTOMIX_ENABLED_KEY = 'folia_automix_enabled';
/** Set only by the reminder's own "don't remind me" button. Absent = still worth asking. */
export const AUTOMIX_MODEL_REMINDER_MUTED_KEY = 'folia_automix_model_reminder_muted';
const TRANSITION_MODE_KEY = 'folia_transition_mode';
const CROSSFADE_MAX_SEC_KEY = 'folia_crossfade_max_sec';
const TRANSITION_PERFORMANCE_KEY = 'folia_transition_performance';
const TRANSITION_ANIMATION_KEY = 'folia_transition_animation';
const TRANSITION_ANIMATION_CARD_KEY = 'folia_transition_animation_card';
const LAST_SEEN_GUIDE_VERSION_STORAGE_KEY = 'folia_last_seen_guide_version';

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
export const SLEEP_TIMER_HOURS_STORAGE_KEY = 'sleep_timer_hours';
export const SLEEP_TIMER_MINUTES_STORAGE_KEY = 'sleep_timer_minutes';
export const HIDE_TASKBAR_ICON_STORAGE_KEY = 'hide_taskbar_icon';
export const REMOTE_CONTROL_SKIP_TASKBAR_STORAGE_KEY = 'remote_control_skip_taskbar';
export const WALLPAPER_MODE_STORAGE_KEY = 'wallpaper_mode';
export const OPEN_PLAYER_ON_LAUNCH_STORAGE_KEY = 'open_player_on_launch';
export const FOLLOW_SYSTEM_THEME_STORAGE_KEY = 'follow_system_theme';

/**
 * The card border's switch, seeded once from the switch the two renderers used to share.
 *
 * Before the split, that switch on meant the card's border was what you actually saw on the lyrics
 * page - the ring stood down wherever the card was up - so starting this one off would read as the
 * update having taken something away.
 *
 * Written back rather than derived on every start, and that is the part worth keeping: the old key
 * now belongs to the RING alone, so a listener who turns the ring on later would otherwise find the
 * border had switched itself back on at the next launch. A migration has to happen once and then be
 * over.
 */
const readTransitionAnimationCard = (): boolean => {
    if (typeof window === 'undefined') {
        return false;
    }

    if (localStorage.getItem(TRANSITION_ANIMATION_CARD_KEY) !== null) {
        return getStoredBoolean(TRANSITION_ANIMATION_CARD_KEY, false);
    }

    const inherited = getStoredBoolean(TRANSITION_ANIMATION_KEY, false);
    setStoredBoolean(TRANSITION_ANIMATION_CARD_KEY, inherited);
    return inherited;
};

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

const readStoredTransitionMode = (): TransitionMode => {
    if (typeof window === 'undefined') return DEFAULT_TRANSITION_SETTINGS.mode;
    const saved = localStorage.getItem(TRANSITION_MODE_KEY);
    return isTransitionMode(saved) ? saved : DEFAULT_TRANSITION_SETTINGS.mode;
};

const readStoredCrossfadeMaxSec = (): number => {
    if (typeof window === 'undefined') return CROSSFADE_DEFAULT_SEC;
    const saved = localStorage.getItem(CROSSFADE_MAX_SEC_KEY);
    return saved === null ? CROSSFADE_DEFAULT_SEC : clampCrossfadeSeconds(Number(saved));
};

export const readSystemThemeIsDaylight = (): boolean | null => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return null;
    }

    return window.matchMedia('(prefers-color-scheme: light)').matches;
};


// OBS overlay theme mode for the copied web OBS URL (default 'builtin' — per-song follow):
//   'static'  – bake the current theme into cfg (the original behavior; frozen in OBS).
//   'builtin' – bake no theme; the overlay derives a per-song builtin palette from the cover.
//   'ai'      – like 'builtin', plus the overlay regenerates an AI theme per song (opt-in).
const readStoredWebObsThemeMode = (): 'static' | 'builtin' | 'ai' => {
    if (typeof window === 'undefined') return 'builtin';
    const value = localStorage.getItem('web_obs_theme_mode') || 'builtin';
    return value === 'static' || value === 'ai' ? value : 'builtin';
};

const readStoredDisableHomeDynamicBackground = (): boolean => {
    if (typeof window === 'undefined') {
        return false;
    }

    const saved = localStorage.getItem('disable_home_dynamic_background');
    if (saved !== null) {
        return saved === 'true';
    }

    const legacySaved = localStorage.getItem('enable_home_dynamic_background');
    if (legacySaved !== null) {
        return legacySaved !== 'true';
    }

    return false;
};

export const resolveStoredAudioQuality = (saved: string | null): AudioQuality => (
    saved === 'standard' || saved === 'lossless' || saved === 'hires' ? saved : 'high'
);

const readStoredAudioQuality = (): AudioQuality => {
    if (typeof window === 'undefined') {
        return 'high';
    }

    const saved = localStorage.getItem('default_audio_quality');
    const quality = resolveStoredAudioQuality(saved);
    if (saved === 'exhigh') {
        localStorage.setItem('default_audio_quality', 'high');
    }
    return quality;
};

















const readStoredLoopMode = (): 'off' | 'all' | 'one' => {
    if (typeof window === 'undefined') {
        return 'off';
    }

    const saved = localStorage.getItem('player_loop_mode');
    return saved === 'all' || saved === 'one' ? saved : 'off';
};

export type StageTrackPillMode = 'auto' | 'always' | 'never';

const readStoredStageTrackPillMode = (): StageTrackPillMode => {
    if (typeof window === 'undefined') {
        return 'auto';
    }

    const saved = localStorage.getItem('stage_track_pill_mode');
    return saved === 'always' || saved === 'never' ? saved : 'auto';
};

const readStoredStageTrackPillTimeoutSec = (): number => {
    if (typeof window === 'undefined') {
        return 10;
    }

    const saved = Number(localStorage.getItem('stage_track_pill_timeout_sec'));
    return Number.isFinite(saved) && saved >= 3 && saved <= 60 ? Math.round(saved) : 10;
};

const readStoredQueueAddBehavior = (): QueueAddBehavior => {
    if (typeof window === 'undefined') {
        return 'append';
    }

    const saved = localStorage.getItem('queue_add_behavior');
    return saved === 'next' ? 'next' : 'append';
};

const readStoredAudioOutputDeviceId = (): string => {
    if (typeof window === 'undefined') {
        return '';
    }

    return localStorage.getItem('audio_output_device_id') ?? '';
};

const readStoredHomeLayoutStyle = (): 'carousel' | 'grid' => {
    if (typeof window === 'undefined') {
        return 'grid';
    }

    const saved = localStorage.getItem('home_layout_style');
    if (saved === 'carousel' || saved === 'desktop') {
        localStorage.setItem('home_layout_style', 'grid');
    }
    return 'grid';
};




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

const readStoredVolume = () => {
    if (typeof window === 'undefined') {
        return 1;
    }

    const saved = localStorage.getItem('player_volume');
    const parsed = saved !== null ? parseFloat(saved) : 1;
    return Number.isFinite(parsed) ? parsed : 1;
};

const readStoredSleepTimerPart = (key: string, max: number): number => {
    if (typeof window === 'undefined') {
        return 0;
    }

    const saved = Number(localStorage.getItem(key));
    return Number.isInteger(saved) && saved >= 0 && saved <= max ? saved : 0;
};

const readStoredSleepTimerHours = () => readStoredSleepTimerPart(SLEEP_TIMER_HOURS_STORAGE_KEY, 999);

const readStoredSleepTimerMinutes = () => readStoredSleepTimerPart(SLEEP_TIMER_MINUTES_STORAGE_KEY, 59);

export type SettingsUiState = {
    audioQuality: AudioQuality;
    useCoverColorBg: boolean;
    staticMode: boolean;
    disableHomeDynamicBackground: boolean;
    hidePlayerProgressBar: boolean;
    hidePlayerRightPanelButton: boolean;
    alwaysShowPlayerBackButton: boolean;
    alwaysShowTrackSwitchButtons: boolean;
    alwaysShowMainWindowTitlebar: boolean;
    transparentPlayerBackground: boolean;
    enablePlayerPageNativeBlur: boolean;
    autoHidePlayerChrome: boolean;
    minimizeToTray: boolean;
    voiceInputPauseEnabled: boolean;
    preventDisplaySleepDuringPlayback: boolean;
    /**
     * Master switch for the experimental mod system. Off by default: while it is
     * off the main process loads no mod at all and the mod commands stay out of
     * the palette, so an unfinished apiVersion 1 is opt-in rather than ambient.
     */
    modSystemEnabled: boolean;
    sleepTimerEnabled: boolean;
    sleepTimerHours: number;
    sleepTimerMinutes: number;
    sleepTimerDeadlineMs: number | null;
    sleepTimerActivationId: number;
    hideTaskbarIcon: boolean;
    hideRemoteControlTaskbarIcon: boolean;
    wallpaperMode: boolean;
    openPlayerOnLaunch: boolean;
    enableMediaCache: boolean;
    /** Gigabytes of cached audio to keep before the oldest is dropped. Zero means no ceiling. */
    mediaCacheLimitGb: number;
    automixEnabled: boolean;
    /** Whether the "you have no weights yet" prompt is showing. See `handleToggleAutomix`. */
    isAutomixModelReminderOpen: boolean;
    /** Which strategy plans a song change once blending is on. */
    transitionMode: TransitionMode;
    /** Seconds. The crossfade mode's ceiling; automix computes its own and ignores this. */
    crossfadeMaxSec: number;
    /** Let the mix be heard. Only reachable with automix on, and only where stems exist. */
    transitionPerformance: boolean;
    /**
     * Draw the mix as a ring in the middle of the screen. Automix only, and only for blends long
     * enough to watch.
     */
    transitionAnimation: boolean;
    /**
     * Draw the same mix on the now playing card's border, on the pages that card appears on.
     *
     * Its own switch rather than a placement rule under the one above, because the two are two
     * pictures in two places and only the listener knows which they want where. They used to share
     * a switch, with the ring standing down wherever the card was up - which meant turning the
     * animation on and never seeing the ring again on the page most people watch.
     */
    transitionAnimationCard: boolean;
    isDaylight: boolean;
    followSystemTheme: boolean;
    appLanguagePreference: AppLanguagePreference;
    showOpenPanelCloseButton: boolean;
    enableNowPlayingStage: boolean;
    // PlayerCap lyrics source (third stage source) config. enablePlayerCapStage is Web-only (Electron uses stageStatus.source).
    enablePlayerCapStage: boolean;
    playerCapHost: string;
    playerCapPlayer: string;
    playerCapTimeBasis: 'timestamp' | 'play_time';
    playerCapSticky: boolean;
    // Theme mode baked into the copied web OBS URL (static burn-in vs per-song dynamic; see readStoredWebObsThemeMode).
    webObsThemeMode: 'static' | 'builtin' | 'ai';
    queueAddBehavior: QueueAddBehavior;
    audioOutputDeviceId: string;
    audioEqualizerSettings: AudioEqualizerSettings;
    isAudioEqualizerOpen: boolean;
    volume: number;
    isMuted: boolean;
    loopMode: 'off' | 'all' | 'one';
    /** 歌词页左下角曲目卡片显示模式：auto=显示一段时间后隐藏，always=常驻，never=不显示 */
    stageTrackPillMode: StageTrackPillMode;
    /** auto 模式下的显示时长（秒），3-60 */
    stageTrackPillTimeoutSec: number;
    stageTrackPillOnHome: boolean;
    homeLayoutStyle: 'carousel' | 'grid';
    grid3dCardStyle: 'image' | 'card';
    showHomeTabPlaylist: boolean;
    showHomeTabRadio: boolean;
    showHomeTabAlbums: boolean;
    showHomeTabLocal: boolean;
    pinnedCommandIds: PinnedCommandIds;
    isSubSettingsViewOpen: boolean;
    settingsModalState: SettingsModalState;
    lastSeenGuideVersion: string | null;
    isUserGuideModalOpen: boolean;
    setLastSeenGuideVersion: (version: string) => void;
    setIsUserGuideModalOpen: (isOpen: boolean) => void;
    setAudioQuality: (quality: AudioQuality) => void;
    setTransparentPlayerBackgroundFromSystem: (enabled: boolean) => void;
    handleTogglePlayerPageNativeBlur: (enable: boolean) => void;
    setDesktopPreferenceSnapshot: (settings: { MINIMIZE_TO_TRAY?: unknown; HIDE_TASKBAR_ICON?: unknown; REMOTE_CONTROL_SKIP_TASKBAR?: unknown; VOICE_INPUT_PAUSE_ENABLED?: unknown; PREVENT_DISPLAY_SLEEP_DURING_PLAYBACK?: unknown; MOD_SYSTEM_ENABLED?: unknown; wallpaper_mode?: unknown; }) => void;
    setIsSubSettingsViewOpen: (open: boolean) => void;
    openSettings: (initialTab?: SettingsModalInitialTab, initialSubview?: SettingsSubviewId | null, initialVisualizerSection?: VisualizerSettingsSection | null) => void;
    closeSettings: () => void;
    handleToggleCoverColorBg: (enable: boolean) => void;
    handleToggleStaticMode: (enable: boolean) => void;
    handleToggleDisableHomeDynamicBackground: (disable: boolean) => void;
    handleToggleHidePlayerProgressBar: (enable: boolean) => void;
    handleToggleHidePlayerRightPanelButton: (enable: boolean) => void;
    handleToggleAlwaysShowPlayerBackButton: (enable: boolean) => void;
    handleToggleAlwaysShowTrackSwitchButtons: (enable: boolean) => void;
    handleToggleAlwaysShowMainWindowTitlebar: (enable: boolean) => void;
    handleToggleTransparentPlayerBackground: (enable: boolean) => void;
    handleWallpaperTransparentRefused: () => void;
    handleToggleAutoHidePlayerChrome: (enable: boolean) => void;
    handleToggleMinimizeToTray: (enable: boolean) => void;
    handleToggleVoiceInputPause: (enable: boolean) => void;
    handleToggleModSystem: (enable: boolean) => void;
    handleTogglePreventDisplaySleepDuringPlayback: (enable: boolean) => void;
    handleToggleSleepTimer: (enable: boolean) => void;
    handleSetSleepTimerHours: (hours: number) => void;
    handleSetSleepTimerMinutes: (minutes: number) => void;
    handleToggleHideTaskbarIcon: (enable: boolean) => void;
    handleToggleHideRemoteControlTaskbarIcon: (enable: boolean) => void;
    handleToggleWallpaperMode: (enable: boolean) => void;
    handleToggleOpenPlayerOnLaunch: (enable: boolean) => void;
    handleToggleMediaCache: (enable: boolean) => void;
    handleSetMediaCacheLimitGb: (gigabytes: number) => void;
    handleToggleAutomix: (enable: boolean) => void;
    /** Closes the model prompt. `mute` is the listener choosing never to see it again. */
    dismissAutomixModelReminder: (mute: boolean) => void;
    handleSetTransitionMode: (mode: TransitionMode) => void;
    handleSetCrossfadeMaxSec: (seconds: number) => void;
    handleToggleTransitionPerformance: (enable: boolean) => void;
    handleToggleTransitionAnimation: (enable: boolean) => void;
    handleToggleTransitionAnimationCard: (enable: boolean) => void;
    setDaylightPreference: (isDaylight: boolean) => void;
    setDaylightPreferenceFromSystem: (isDaylight: boolean) => void;
    setFollowSystemTheme: (enabled: boolean) => void;
    handleSetAppLanguagePreference: (preference: AppLanguagePreference) => Promise<void>;
    handleToggleOpenPanelCloseButton: (enable: boolean) => void;
    handleToggleNowPlayingStage: (enable: boolean) => void;
    // Web stage-source tri-state mutually-exclusive selection: null disables, else one of 'now-playing' or 'playercap'. Electron uses stageStatus.source.
    setWebStageSource: (source: 'now-playing' | 'playercap' | null) => void;
    setPlayerCapHost: (host: string) => void;
    setPlayerCapPlayer: (player: string) => void;
    setPlayerCapTimeBasis: (basis: 'timestamp' | 'play_time') => void;
    setPlayerCapSticky: (sticky: boolean) => void;
    setWebObsThemeMode: (mode: 'static' | 'builtin' | 'ai') => void;
    handleSetQueueAddBehavior: (behavior: QueueAddBehavior) => void;
    handleSetAudioOutputDeviceId: (deviceId: string) => void;
    handleSetAudioEqualizerSettings: (settings: AudioEqualizerSettings) => void;
    handleApplyAudioSoundPreset: (modeId: AudioEqualizerModeId) => void;
    openAudioEqualizer: () => void;
    closeAudioEqualizer: () => void;
    handleSetVolume: (val: number) => void;
    handleToggleMute: () => void;
    handleToggleLoopMode: () => void;
    handleSetStageTrackPillMode: (mode: StageTrackPillMode) => void;
    handleSetStageTrackPillTimeoutSec: (sec: number) => void;
    handleToggleStageTrackPillOnHome: (enable: boolean) => void;
    handleSetHomeLayoutStyle: (style: 'carousel' | 'grid') => void;
    handleSetGrid3dCardStyle: (style: 'image' | 'card') => void;
    handleToggleHomeTabPlaylist: (show: boolean) => void;
    handleToggleHomeTabRadio: (show: boolean) => void;
    handleToggleHomeTabAlbums: (show: boolean) => void;
    handleToggleHomeTabLocal: (show: boolean) => void;
    setPinnedCommandId: (slotIndex: number, commandId: string | null) => void;
};

const initialFollowSystemTheme = getStoredBoolean(FOLLOW_SYSTEM_THEME_STORAGE_KEY, false);
const initialStoredDaylight = getStoredBoolean('default_theme_daylight', false);
const initialDaylight = initialFollowSystemTheme
    ? (readSystemThemeIsDaylight() ?? initialStoredDaylight)
    : initialStoredDaylight;

export const useSettingsUiStore = create<SettingsUiState>((set, get) => ({
    audioQuality: readStoredAudioQuality(),
    useCoverColorBg: getStoredBoolean('use_cover_color_bg', false),
    staticMode: getStoredBoolean('static_mode', false),
    disableHomeDynamicBackground: readStoredDisableHomeDynamicBackground(),
    hidePlayerProgressBar: getStoredBoolean('hide_player_progress_bar', false),
    hidePlayerRightPanelButton: getStoredBoolean('hide_player_right_panel_button', false),
    alwaysShowPlayerBackButton: getStoredBoolean('always_show_player_back_button', false),
    alwaysShowTrackSwitchButtons: getStoredBoolean('always_show_track_switch_buttons', false),
    alwaysShowMainWindowTitlebar: getStoredBoolean('always_show_main_window_titlebar', false),
    transparentPlayerBackground: getStoredBoolean('transparent_player_background', false),
    enablePlayerPageNativeBlur: getStoredBoolean('enable_player_page_native_blur', false),
    autoHidePlayerChrome: getStoredBoolean('auto_hide_player_chrome', false),
    minimizeToTray: getStoredBoolean(MINIMIZE_TO_TRAY_STORAGE_KEY, false),
    voiceInputPauseEnabled: getStoredBoolean(VOICE_INPUT_PAUSE_STORAGE_KEY, false),
    preventDisplaySleepDuringPlayback: getStoredBoolean(PREVENT_DISPLAY_SLEEP_DURING_PLAYBACK_STORAGE_KEY, false),
    modSystemEnabled: getStoredBoolean(MOD_SYSTEM_ENABLED_STORAGE_KEY, false),
    // A sleep timer is a one-shot action. Persist its preferred duration, never an armed state.
    sleepTimerEnabled: false,
    sleepTimerHours: readStoredSleepTimerHours(),
    sleepTimerMinutes: readStoredSleepTimerMinutes(),
    sleepTimerDeadlineMs: null,
    sleepTimerActivationId: 0,
    hideTaskbarIcon: getStoredBoolean(HIDE_TASKBAR_ICON_STORAGE_KEY, false),
    hideRemoteControlTaskbarIcon: getStoredBoolean(REMOTE_CONTROL_SKIP_TASKBAR_STORAGE_KEY, false),
    wallpaperMode: getStoredBoolean(WALLPAPER_MODE_STORAGE_KEY, false),
    openPlayerOnLaunch: getStoredBoolean(OPEN_PLAYER_ON_LAUNCH_STORAGE_KEY, false),
    enableMediaCache: readStoredEnableMediaCache(),
    mediaCacheLimitGb: readStoredMediaCacheLimitGb(),
    automixEnabled: getStoredBoolean(AUTOMIX_ENABLED_KEY, false),
    isAutomixModelReminderOpen: false,
    transitionMode: readStoredTransitionMode(),
    crossfadeMaxSec: readStoredCrossfadeMaxSec(),
    transitionPerformance: getStoredBoolean(
        TRANSITION_PERFORMANCE_KEY, DEFAULT_TRANSITION_SETTINGS.performance,
    ),
    // Off by default: it draws over whatever the listener is already looking at, which is a
    // choice to make rather than one to arrive at after an update.
    transitionAnimation: getStoredBoolean(TRANSITION_ANIMATION_KEY, false),
    transitionAnimationCard: readTransitionAnimationCard(),
    followSystemTheme: initialFollowSystemTheme,
    isDaylight: initialDaylight,
    appLanguagePreference: readStoredAppLanguagePreference(),
    showOpenPanelCloseButton: getStoredBoolean('show_open_panel_close_button', true),
    enableNowPlayingStage: getStoredBoolean('enable_now_playing_stage', false),
    enablePlayerCapStage: getStoredBoolean('enable_playercap_stage', false),
    playerCapHost: getStoredString('playercap_host', 'localhost:8765'),
    playerCapPlayer: getStoredString('playercap_player', ''),
    playerCapTimeBasis: getStoredString('playercap_time_basis', 'play_time') === 'timestamp' ? 'timestamp' : 'play_time',
    playerCapSticky: getStoredBoolean('playercap_sticky', true),
    webObsThemeMode: readStoredWebObsThemeMode(),
    queueAddBehavior: readStoredQueueAddBehavior(),
    audioOutputDeviceId: readStoredAudioOutputDeviceId(),
    audioEqualizerSettings: readStoredAudioEqualizerSettings(),
    isAudioEqualizerOpen: false,
    volume: readStoredVolume(),
    isMuted: getStoredBoolean('player_is_muted', false),
    loopMode: readStoredLoopMode(),
    stageTrackPillMode: readStoredStageTrackPillMode(),
    stageTrackPillTimeoutSec: readStoredStageTrackPillTimeoutSec(),
    stageTrackPillOnHome: getStoredBoolean('stage_track_pill_on_home', false),
    homeLayoutStyle: readStoredHomeLayoutStyle(),
    grid3dCardStyle: readStoredGrid3dCardStyle(),
    showHomeTabPlaylist: getStoredBoolean('show_home_tab_playlist', true),
    showHomeTabRadio: getStoredBoolean('show_home_tab_radio', true),
    showHomeTabAlbums: getStoredBoolean('show_home_tab_albums', true),
    showHomeTabLocal: getStoredBoolean('show_home_tab_local', true),
    pinnedCommandIds: readPinnedCommandIds(),
    isSubSettingsViewOpen: false,
    settingsModalState: {
        isOpen: false,
        initialTab: 'help',
        initialSubview: null,
        initialVisualizerSection: null,
    },
    lastSeenGuideVersion: typeof window !== 'undefined' ? localStorage.getItem(LAST_SEEN_GUIDE_VERSION_STORAGE_KEY) : null,
    isUserGuideModalOpen: false,
    setLastSeenGuideVersion: (version) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem(LAST_SEEN_GUIDE_VERSION_STORAGE_KEY, version);
        }
        set({ lastSeenGuideVersion: version });
    },
    setIsUserGuideModalOpen: (isOpen) => set({ isUserGuideModalOpen: isOpen }),
    setAudioQuality: (quality) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('default_audio_quality', quality);
        }
        set({ audioQuality: quality });
    },
    setTransparentPlayerBackgroundFromSystem: (enabled) => {
        setStoredBoolean('transparent_player_background', enabled);
        set({ transparentPlayerBackground: enabled });
    },
    handleTogglePlayerPageNativeBlur: (enable) => {
        setStoredBoolean('enable_player_page_native_blur', enable);
        set({ enablePlayerPageNativeBlur: enable });
        if (window.electron?.saveSettings) {
            void window.electron.saveSettings('enable_player_page_native_blur', enable);
        }
    },
    handleToggleAutoHidePlayerChrome: (enabled: boolean) => {
        localStorage.setItem('auto_hide_player_chrome', enabled ? 'true' : 'false');
        set({ autoHidePlayerChrome: enabled });
    },
    setDesktopPreferenceSnapshot: (settings) => {
        const patch: Partial<SettingsUiState> = {};
        if (typeof settings.MINIMIZE_TO_TRAY === 'boolean') {
            patch.minimizeToTray = settings.MINIMIZE_TO_TRAY;
            setStoredBoolean(MINIMIZE_TO_TRAY_STORAGE_KEY, settings.MINIMIZE_TO_TRAY);
        }
        if (typeof settings.VOICE_INPUT_PAUSE_ENABLED === 'boolean') {
            patch.voiceInputPauseEnabled = settings.VOICE_INPUT_PAUSE_ENABLED;
            setStoredBoolean(VOICE_INPUT_PAUSE_STORAGE_KEY, settings.VOICE_INPUT_PAUSE_ENABLED);
        }
        if (typeof settings.PREVENT_DISPLAY_SLEEP_DURING_PLAYBACK === 'boolean') {
            patch.preventDisplaySleepDuringPlayback = settings.PREVENT_DISPLAY_SLEEP_DURING_PLAYBACK;
            setStoredBoolean(PREVENT_DISPLAY_SLEEP_DURING_PLAYBACK_STORAGE_KEY, settings.PREVENT_DISPLAY_SLEEP_DURING_PLAYBACK);
        }
        if (typeof settings.MOD_SYSTEM_ENABLED === 'boolean') {
            patch.modSystemEnabled = settings.MOD_SYSTEM_ENABLED;
            setStoredBoolean(MOD_SYSTEM_ENABLED_STORAGE_KEY, settings.MOD_SYSTEM_ENABLED);
        }
        if (typeof settings.HIDE_TASKBAR_ICON === 'boolean') {
            patch.hideTaskbarIcon = settings.HIDE_TASKBAR_ICON;
            setStoredBoolean(HIDE_TASKBAR_ICON_STORAGE_KEY, settings.HIDE_TASKBAR_ICON);
        }
        if (typeof settings.REMOTE_CONTROL_SKIP_TASKBAR === 'boolean') {
            patch.hideRemoteControlTaskbarIcon = settings.REMOTE_CONTROL_SKIP_TASKBAR;
            setStoredBoolean(REMOTE_CONTROL_SKIP_TASKBAR_STORAGE_KEY, settings.REMOTE_CONTROL_SKIP_TASKBAR);
        }
        if (typeof settings.wallpaper_mode === 'boolean') {
            patch.wallpaperMode = settings.wallpaper_mode;
            setStoredBoolean(WALLPAPER_MODE_STORAGE_KEY, settings.wallpaper_mode);
        }
        set(patch);
    },
    setIsSubSettingsViewOpen: (open) => set({ isSubSettingsViewOpen: open }),
    openSettings: (initialTab = 'help', initialSubview = null, initialVisualizerSection = null) => set({
        settingsModalState: {
            isOpen: true,
            initialTab,
            initialSubview,
            initialVisualizerSection,
        },
    }),
    closeSettings: () => set(state => ({
        settingsModalState: {
            ...state.settingsModalState,
            isOpen: false,
        },
    })),
    handleToggleCoverColorBg: (enable) => {
        setStoredBoolean('use_cover_color_bg', enable);
        set({ useCoverColorBg: enable });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'coverColorAdded' : 'coverColorDefault')),
        });
    },
    handleToggleStaticMode: (enable) => {
        setStoredBoolean('static_mode', enable);
        set({ staticMode: enable });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'staticModeOn' : 'staticModeOff')),
        });
    },
    handleToggleDisableHomeDynamicBackground: (disable) => {
        setStoredBoolean('disable_home_dynamic_background', disable);
        set({ disableHomeDynamicBackground: disable });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (disable ? 'homeBgDisabled' : 'homeBgEnabled')),
        });
    },
    handleToggleHidePlayerProgressBar: (enable) => {
        setStoredBoolean('hide_player_progress_bar', enable);
        set({ hidePlayerProgressBar: enable });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'progressBarHidden' : 'progressBarShown')),
        });
    },
    handleToggleAlwaysShowPlayerBackButton: (enable) => {
        setStoredBoolean('always_show_player_back_button', enable);
        set({ alwaysShowPlayerBackButton: enable });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'playerBackButtonAlwaysShown' : 'playerBackButtonAutoHidden')),
        });
    },
    handleToggleAlwaysShowTrackSwitchButtons: (enable) => {
        setStoredBoolean('always_show_track_switch_buttons', enable);
        set({ alwaysShowTrackSwitchButtons: enable });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'trackSwitchButtonsAlwaysShown' : 'trackSwitchButtonsAutoHidden')),
        });
    },
    handleToggleAlwaysShowMainWindowTitlebar: (enable) => {
        setStoredBoolean('always_show_main_window_titlebar', enable);
        set({ alwaysShowMainWindowTitlebar: enable });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'mainWindowTitlebarAlwaysShown' : 'mainWindowTitlebarAutoHidden')),
        });
    },
    handleToggleHidePlayerRightPanelButton: (enable) => {
        setStoredBoolean('hide_player_right_panel_button', enable);
        set({ hidePlayerRightPanelButton: enable });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'rightBtnHidden' : 'rightBtnShown')),
        });
    },
    handleToggleTransparentPlayerBackground: (enable) => {
        setStoredBoolean('transparent_player_background', enable);
        set({ transparentPlayerBackground: enable });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'transparentBgOn' : 'transparentBgOff')),
        });
    },
    // Main-process guard fired the refusal (classic Windows wallpaper mode cannot present a
    // transparent wallpaper window): surface why the toggle did not take effect.
    handleWallpaperTransparentRefused: () => {
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.transparentBgWallpaperUnsupported'),
        });
    },
    handleToggleMinimizeToTray: (enable) => {
        setStoredBoolean(MINIMIZE_TO_TRAY_STORAGE_KEY, enable);
        set({ minimizeToTray: enable });
        if (window.electron?.saveSettings) {
            void window.electron.saveSettings('MINIMIZE_TO_TRAY', enable);
        }
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'minimizeToTray' : 'minimizeToTaskbar')),
        });
    },
    handleToggleVoiceInputPause: (enable) => {
        setStoredBoolean(VOICE_INPUT_PAUSE_STORAGE_KEY, enable);
        set({ voiceInputPauseEnabled: enable });
        if (window.electron?.saveSettings) {
            void window.electron.saveSettings('VOICE_INPUT_PAUSE_ENABLED', enable);
        }
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'voiceInputPauseOn' : 'voiceInputPauseOff')),
        });
    },
    // The main process owns the authoritative value: it decides whether any mod
    // is loaded at all, so the switch is persisted there and only mirrored here.
    handleToggleModSystem: (enable) => {
        setStoredBoolean(MOD_SYSTEM_ENABLED_STORAGE_KEY, enable);
        set({ modSystemEnabled: enable });
        if (window.electron?.saveSettings) {
            void window.electron.saveSettings('MOD_SYSTEM_ENABLED', enable);
        }
    },
    handleTogglePreventDisplaySleepDuringPlayback: (enable) => {
        setStoredBoolean(PREVENT_DISPLAY_SLEEP_DURING_PLAYBACK_STORAGE_KEY, enable);
        set({ preventDisplaySleepDuringPlayback: enable });
        if (window.electron?.saveSettings) {
            void window.electron.saveSettings('PREVENT_DISPLAY_SLEEP_DURING_PLAYBACK', enable);
        }
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'preventDisplaySleepOn' : 'preventDisplaySleepOff')),
        });
    },
    handleToggleSleepTimer: (enable) => {
        if (enable && get().sleepTimerHours === 0 && get().sleepTimerMinutes === 0) {
            setStatusMessage({
                type: 'error',
                text: i18n.t('commandPalette.sleepTimerDurationRequired'),
            });
            return;
        }
        set(state => ({
            sleepTimerEnabled: enable,
            // Every explicit activation starts a fresh countdown, even when its duration is unchanged.
            sleepTimerActivationId: enable
                ? state.sleepTimerActivationId + 1
                : state.sleepTimerActivationId,
        }));
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'sleepTimerOn' : 'sleepTimerOff')),
        });
    },
    handleSetSleepTimerHours: (hours) => {
        const clamped = Math.min(999, Math.max(0, Math.floor(hours) || 0));
        if (typeof window !== 'undefined') {
            localStorage.setItem(SLEEP_TIMER_HOURS_STORAGE_KEY, String(clamped));
        }
        set(state => ({
            sleepTimerHours: clamped,
            sleepTimerEnabled: clamped === 0 && state.sleepTimerMinutes === 0
                ? false
                : state.sleepTimerEnabled,
        }));
    },
    handleSetSleepTimerMinutes: (minutes) => {
        const clamped = Math.min(59, Math.max(0, Math.floor(minutes) || 0));
        if (typeof window !== 'undefined') {
            localStorage.setItem(SLEEP_TIMER_MINUTES_STORAGE_KEY, String(clamped));
        }
        set(state => ({
            sleepTimerMinutes: clamped,
            sleepTimerEnabled: state.sleepTimerHours === 0 && clamped === 0
                ? false
                : state.sleepTimerEnabled,
        }));
    },
    handleToggleHideTaskbarIcon: (enable) => {
        setStoredBoolean(HIDE_TASKBAR_ICON_STORAGE_KEY, enable);
        set({ hideTaskbarIcon: enable });
        if (window.electron?.saveSettings) {
            void window.electron.saveSettings('HIDE_TASKBAR_ICON', enable);
        }
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'taskbarHidden' : 'taskbarRestored')),
        });
    },
    handleToggleHideRemoteControlTaskbarIcon: (enable) => {
        setStoredBoolean(REMOTE_CONTROL_SKIP_TASKBAR_STORAGE_KEY, enable);
        set({ hideRemoteControlTaskbarIcon: enable });
        if (window.electron?.saveSettings) {
            void window.electron.saveSettings('REMOTE_CONTROL_SKIP_TASKBAR', enable);
        }
    },
    handleToggleWallpaperMode: (enable) => {
        setStoredBoolean(WALLPAPER_MODE_STORAGE_KEY, enable);
        set({ wallpaperMode: enable });
        if (window.electron?.saveSettings) {
            // The main process schedules a full relaunch after this IPC returns.
            void window.electron.saveSettings('wallpaper_mode', enable);
        }
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'wallpaperModeOn' : 'wallpaperModeOff')),
        });
    },
    handleToggleOpenPlayerOnLaunch: (enable) => {
        setStoredBoolean(OPEN_PLAYER_ON_LAUNCH_STORAGE_KEY, enable);
        set({ openPlayerOnLaunch: enable });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'openPlayerOnLaunch' : 'openHomeOnLaunch')),
        });
    },
    handleToggleMediaCache: (enable) => {
        setStoredBoolean(ENABLE_MEDIA_CACHE_KEY, enable);
        set({ enableMediaCache: enable });
    },
    handleSetMediaCacheLimitGb: (gigabytes) => {
        const next = Number.isFinite(gigabytes) && gigabytes >= 0 ? gigabytes : DEFAULT_MEDIA_CACHE_LIMIT_GB;
        if (typeof window !== 'undefined') {
            localStorage.setItem(MEDIA_CACHE_LIMIT_GB_KEY, String(next));
        }
        set({ mediaCacheLimitGb: next });
    },
    handleToggleAutomix: (enable) => {
        setStoredBoolean(AUTOMIX_ENABLED_KEY, enable);
        // Asked here rather than in the settings section because there are two switches - the
        // options page and the volume row - and a prompt wired to one of them is missing from the
        // one people actually reach mid-song.
        set({ automixEnabled: enable, isAutomixModelReminderOpen: enable && shouldRemindAboutModels() });
    },
    dismissAutomixModelReminder: (mute) => {
        if (mute) setStoredBoolean(AUTOMIX_MODEL_REMINDER_MUTED_KEY, true);
        set({ isAutomixModelReminderOpen: false });
    },
    handleSetTransitionMode: (mode) => {
        if (!isTransitionMode(mode)) return;
        if (typeof window !== 'undefined') {
            localStorage.setItem(TRANSITION_MODE_KEY, mode);
        }
        set({ transitionMode: mode });
    },
    handleSetCrossfadeMaxSec: (seconds) => {
        const next = clampCrossfadeSeconds(seconds);
        if (typeof window !== 'undefined') {
            localStorage.setItem(CROSSFADE_MAX_SEC_KEY, String(next));
        }
        set({ crossfadeMaxSec: next });
    },
    handleToggleTransitionPerformance: (enable) => {
        setStoredBoolean(TRANSITION_PERFORMANCE_KEY, enable);
        set({ transitionPerformance: enable });
    },
    handleToggleTransitionAnimation: (enable) => {
        setStoredBoolean(TRANSITION_ANIMATION_KEY, enable);
        set({ transitionAnimation: enable });
    },
    handleToggleTransitionAnimationCard: (enable) => {
        setStoredBoolean(TRANSITION_ANIMATION_CARD_KEY, enable);
        set({ transitionAnimationCard: enable });
    },
    // System updates are kept separate from the manual setter so a user click can disable auto-follow.
    setDaylightPreferenceFromSystem: (enabled) => {
        if (!get().followSystemTheme) {
            return;
        }

        setStoredBoolean('default_theme_daylight', enabled);
        set({ isDaylight: enabled });
        if (typeof window !== 'undefined' && window.electron?.setNativeTheme) {
            void window.electron.setNativeTheme('system');
        }
    },
    setFollowSystemTheme: (enabled) => {
        setStoredBoolean(FOLLOW_SYSTEM_THEME_STORAGE_KEY, enabled);
        set({ followSystemTheme: enabled });

        if (typeof window !== 'undefined' && window.electron?.setNativeTheme) {
            void window.electron.setNativeTheme(enabled ? 'system' : (get().isDaylight ? 'light' : 'dark'));
        }

        if (enabled) {
            const systemThemeIsDaylight = readSystemThemeIsDaylight();
            if (systemThemeIsDaylight !== null) {
                get().setDaylightPreferenceFromSystem(systemThemeIsDaylight);
            }
        }
    },
    setDaylightPreference: (enabled) => {
        const wasFollowingSystem = get().followSystemTheme;
        if (wasFollowingSystem) {
            setStoredBoolean(FOLLOW_SYSTEM_THEME_STORAGE_KEY, false);
        }
        setStoredBoolean('default_theme_daylight', enabled);
        set({ isDaylight: enabled, ...(wasFollowingSystem ? { followSystemTheme: false } : {}) });
        if (typeof window !== 'undefined' && window.electron?.setNativeTheme) {
            void window.electron.setNativeTheme(enabled ? 'light' : 'dark');
        }
    },
    handleSetAppLanguagePreference: async (preference) => {
        await applyAppLanguagePreference(preference);
        set({ appLanguagePreference: preference });
        const getLanguageLabel = (pref: AppLanguagePreference): string => {
            switch (pref) {
                case 'zh-CN': return i18n.t('options.appLanguageZhCN', { lng: 'zh-CN' });
                case 'in': return i18n.t('options.appLanguageInID', { lng: 'in' });
                case 'en': return i18n.t('options.appLanguageEnUS', { lng: 'en' });
                default: return '';
            }
        };

        setStatusMessage({
            type: 'info',
            text: preference === 'system'
                ? i18n.t('notifications.langFollowSystem')
                : i18n.t('notifications.langManual', { language: getLanguageLabel(preference) }),
        });
    },
    handleToggleOpenPanelCloseButton: (enable) => {
        setStoredBoolean('show_open_panel_close_button', enable);
        set({ showOpenPanelCloseButton: enable });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'panelCloseBtnShown' : 'panelCloseBtnHidden')),
        });
    },
    setWebStageSource: (source) => {
        const wasEnabled = get().enableNowPlayingStage || get().enablePlayerCapStage;
        const enableNowPlaying = source === 'now-playing';
        const enablePlayerCap = source === 'playercap';
        setStoredBoolean('enable_now_playing_stage', enableNowPlaying);
        setStoredBoolean('enable_playercap_stage', enablePlayerCap);
        set({ enableNowPlayingStage: enableNowPlaying, enablePlayerCapStage: enablePlayerCap });
        const nowEnabled = enableNowPlaying || enablePlayerCap;
        // Only notify on the enable/disable transition; switching between the two sources is silent. On disable, the controller's stageSource→null reactive effect handles teardown automatically.
        if (wasEnabled !== nowEnabled) {
            setStatusMessage({
                type: 'info',
                text: i18n.t('notifications.' + (nowEnabled ? 'stageModeOn' : 'stageModeOff')),
            });
        }
    },
    setPlayerCapHost: (host) => {
        localStorage.setItem('playercap_host', host);
        set({ playerCapHost: host });
    },
    setPlayerCapPlayer: (player) => {
        localStorage.setItem('playercap_player', player);
        set({ playerCapPlayer: player });
    },
    setPlayerCapTimeBasis: (basis) => {
        localStorage.setItem('playercap_time_basis', basis);
        set({ playerCapTimeBasis: basis });
    },
    setPlayerCapSticky: (sticky) => {
        setStoredBoolean('playercap_sticky', sticky);
        set({ playerCapSticky: sticky });
    },
    handleToggleNowPlayingStage: (enable) => {
        setStoredBoolean('enable_now_playing_stage', enable);
        set({ enableNowPlayingStage: enable });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'stageModeOn' : 'stageModeOff')),
        });
    },
    setWebObsThemeMode: (mode) => {
        if (typeof window !== 'undefined') localStorage.setItem('web_obs_theme_mode', mode);
        set({ webObsThemeMode: mode });
    },
    handleSetQueueAddBehavior: (behavior) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('queue_add_behavior', behavior);
        }
        set({ queueAddBehavior: behavior });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (behavior === 'next' ? 'queueInsertNext' : 'queueAppend')),
        });
    },
    handleSetAudioOutputDeviceId: (deviceId) => {
        set({ audioOutputDeviceId: deviceId });
        if (typeof window === 'undefined') {
            return;
        }

        if (deviceId) {
            localStorage.setItem('audio_output_device_id', deviceId);
        } else {
            localStorage.removeItem('audio_output_device_id');
        }
    },
    handleSetAudioEqualizerSettings: (settings) => {
        const resolved = resolveAudioEqualizerSettings(settings);
        writeStoredAudioEqualizerSettings(resolved);
        set({ audioEqualizerSettings: resolved });
    },
    // Applies a built-in sound preset or a saved custom slot, and turns processing on.
    handleApplyAudioSoundPreset: (modeId) => {
        const current = get().audioEqualizerSettings;
        const source = isAudioEqualizerCustomSlotId(modeId)
            ? current.customSlots[getAudioEqualizerCustomSlotIndex(modeId)]
            : AUDIO_SOUND_PRESETS[modeId];
        if (!source) {
            return;
        }

        const resolved = resolveAudioEqualizerSettings({
            ...current,
            enabled: true,
            preset: modeId,
            gains: [...source.gains],
            effects: { ...source.effects },
        });
        writeStoredAudioEqualizerSettings(resolved);
        set({ audioEqualizerSettings: resolved });
    },
    openAudioEqualizer: () => set({ isAudioEqualizerOpen: true }),
    closeAudioEqualizer: () => set({ isAudioEqualizerOpen: false }),
    handleSetVolume: (val) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('player_volume', String(val));
        }
        set({ volume: val });
    },
    handleToggleMute: () => {
        const next = !get().isMuted;
        setStoredBoolean('player_is_muted', next);
        set({ isMuted: next });
    },
    handleToggleLoopMode: () => {
        const prev = get().loopMode;
        const next = prev === 'off'
            ? 'all'
            : prev === 'all'
                ? 'one'
                : 'off';
        if (typeof window !== 'undefined') {
            localStorage.setItem('player_loop_mode', next);
        }
        set({ loopMode: next });
    },
    handleSetStageTrackPillMode: (mode) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('stage_track_pill_mode', mode);
        }
        set({ stageTrackPillMode: mode });
    },
    handleSetStageTrackPillTimeoutSec: (sec) => {
        const next = Math.max(3, Math.min(60, Math.round(sec)));
        if (typeof window !== 'undefined') {
            localStorage.setItem('stage_track_pill_timeout_sec', String(next));
        }
        set({ stageTrackPillTimeoutSec: next });
    },
    handleToggleStageTrackPillOnHome: (enable) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('stage_track_pill_on_home', String(enable));
        }
        set({ stageTrackPillOnHome: enable });
    },
    handleSetHomeLayoutStyle: () => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('home_layout_style', 'grid');
        }
        set({ homeLayoutStyle: 'grid' });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.homeLayoutGrid'),
        });
    },
    handleSetGrid3dCardStyle: (style) => {
        set({ grid3dCardStyle: style });
        if (typeof window !== 'undefined') localStorage.setItem('grid3d_card_style', style);
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (style === 'image' ? 'cardStyleImage' : 'cardStyleCard')),
        });
    },
    handleToggleHomeTabPlaylist: (show) => {
        set({ showHomeTabPlaylist: show });
        if (typeof window !== 'undefined') localStorage.setItem('show_home_tab_playlist', show.toString());
    },
    handleToggleHomeTabRadio: (show) => {
        set({ showHomeTabRadio: show });
        if (typeof window !== 'undefined') localStorage.setItem('show_home_tab_radio', show.toString());
    },
    handleToggleHomeTabAlbums: (show) => {
        set({ showHomeTabAlbums: show });
        if (typeof window !== 'undefined') localStorage.setItem('show_home_tab_albums', show.toString());
    },
    handleToggleHomeTabLocal: (show) => {
        set({ showHomeTabLocal: show });
        if (typeof window !== 'undefined') localStorage.setItem('show_home_tab_local', show.toString());
    },
    setPinnedCommandId: (slotIndex, commandId) => {
        if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= 3) {
            return;
        }
        const current = get().pinnedCommandIds;
        const next = normalizePinnedCommandIds(
            current.map((currentCommandId, index) => (
                index === slotIndex ? commandId : currentCommandId
            )),
        );
        writePinnedCommandIds(next);
        set({ pinnedCommandIds: next });
    },
}));

export const selectSettingsUiSnapshot = (state: SettingsUiState) => ({
    audioQuality: state.audioQuality,
    setAudioQuality: state.setAudioQuality,
    useCoverColorBg: state.useCoverColorBg,
    staticMode: state.staticMode,
    disableHomeDynamicBackground: state.disableHomeDynamicBackground,
    hidePlayerProgressBar: state.hidePlayerProgressBar,
    hidePlayerRightPanelButton: state.hidePlayerRightPanelButton,
    alwaysShowPlayerBackButton: state.alwaysShowPlayerBackButton,
    alwaysShowTrackSwitchButtons: state.alwaysShowTrackSwitchButtons,
    alwaysShowMainWindowTitlebar: state.alwaysShowMainWindowTitlebar,
    transparentPlayerBackground: state.transparentPlayerBackground,
    autoHidePlayerChrome: state.autoHidePlayerChrome,
    minimizeToTray: state.minimizeToTray,
    voiceInputPauseEnabled: state.voiceInputPauseEnabled,
    preventDisplaySleepDuringPlayback: state.preventDisplaySleepDuringPlayback,
    modSystemEnabled: state.modSystemEnabled,
    sleepTimerEnabled: state.sleepTimerEnabled,
    sleepTimerHours: state.sleepTimerHours,
    sleepTimerMinutes: state.sleepTimerMinutes,
    sleepTimerDeadlineMs: state.sleepTimerDeadlineMs,
    handleToggleSleepTimer: state.handleToggleSleepTimer,
    handleSetSleepTimerHours: state.handleSetSleepTimerHours,
    handleSetSleepTimerMinutes: state.handleSetSleepTimerMinutes,
    hideTaskbarIcon: state.hideTaskbarIcon,
    hideRemoteControlTaskbarIcon: state.hideRemoteControlTaskbarIcon,
    wallpaperMode: state.wallpaperMode,
    handleToggleWallpaperMode: state.handleToggleWallpaperMode,
    openPlayerOnLaunch: state.openPlayerOnLaunch,
    enableMediaCache: state.enableMediaCache,
    mediaCacheLimitGb: state.mediaCacheLimitGb,
    isDaylight: state.isDaylight,
    followSystemTheme: state.followSystemTheme,
    lastSeenGuideVersion: state.lastSeenGuideVersion,
    isUserGuideModalOpen: state.isUserGuideModalOpen,
    homeLayoutStyle: state.homeLayoutStyle,
    handleSetHomeLayoutStyle: state.handleSetHomeLayoutStyle,
    grid3dCardStyle: state.grid3dCardStyle,
    handleSetGrid3dCardStyle: state.handleSetGrid3dCardStyle,
    appLanguagePreference: state.appLanguagePreference,
    showOpenPanelCloseButton: state.showOpenPanelCloseButton,
    enableNowPlayingStage: state.enableNowPlayingStage,
    enablePlayerCapStage: state.enablePlayerCapStage,
    playerCapHost: state.playerCapHost,
    playerCapPlayer: state.playerCapPlayer,
    playerCapTimeBasis: state.playerCapTimeBasis,
    playerCapSticky: state.playerCapSticky,
    webObsThemeMode: state.webObsThemeMode,
    queueAddBehavior: state.queueAddBehavior,
    audioOutputDeviceId: state.audioOutputDeviceId,
    loopMode: state.loopMode,
    stageTrackPillMode: state.stageTrackPillMode,
    stageTrackPillTimeoutSec: state.stageTrackPillTimeoutSec,
    stageTrackPillOnHome: state.stageTrackPillOnHome,
    handleSetStageTrackPillMode: state.handleSetStageTrackPillMode,
    handleSetStageTrackPillTimeoutSec: state.handleSetStageTrackPillTimeoutSec,
    handleToggleStageTrackPillOnHome: state.handleToggleStageTrackPillOnHome,
    handleToggleCoverColorBg: state.handleToggleCoverColorBg,
    handleToggleStaticMode: state.handleToggleStaticMode,
    handleToggleDisableHomeDynamicBackground: state.handleToggleDisableHomeDynamicBackground,
    handleToggleHidePlayerProgressBar: state.handleToggleHidePlayerProgressBar,
    handleToggleHidePlayerRightPanelButton: state.handleToggleHidePlayerRightPanelButton,
    handleToggleAlwaysShowPlayerBackButton: state.handleToggleAlwaysShowPlayerBackButton,
    handleToggleAlwaysShowTrackSwitchButtons: state.handleToggleAlwaysShowTrackSwitchButtons,
    handleToggleAlwaysShowMainWindowTitlebar: state.handleToggleAlwaysShowMainWindowTitlebar,
    handleToggleTransparentPlayerBackground: state.handleToggleTransparentPlayerBackground,
    enablePlayerPageNativeBlur: state.enablePlayerPageNativeBlur,
    handleTogglePlayerPageNativeBlur: state.handleTogglePlayerPageNativeBlur,
    handleToggleAutoHidePlayerChrome: state.handleToggleAutoHidePlayerChrome,
    handleToggleMinimizeToTray: state.handleToggleMinimizeToTray,
    handleToggleVoiceInputPause: state.handleToggleVoiceInputPause,
    handleToggleModSystem: state.handleToggleModSystem,
    handleTogglePreventDisplaySleepDuringPlayback: state.handleTogglePreventDisplaySleepDuringPlayback,
    handleToggleHideTaskbarIcon: state.handleToggleHideTaskbarIcon,
    handleToggleHideRemoteControlTaskbarIcon: state.handleToggleHideRemoteControlTaskbarIcon,
    handleToggleOpenPlayerOnLaunch: state.handleToggleOpenPlayerOnLaunch,
    handleToggleMediaCache: state.handleToggleMediaCache,
    handleSetMediaCacheLimitGb: state.handleSetMediaCacheLimitGb,
    setDaylightPreference: state.setDaylightPreference,
    setDaylightPreferenceFromSystem: state.setDaylightPreferenceFromSystem,
    setFollowSystemTheme: state.setFollowSystemTheme,
    setLastSeenGuideVersion: state.setLastSeenGuideVersion,
    setIsUserGuideModalOpen: state.setIsUserGuideModalOpen,
    handleSetAppLanguagePreference: state.handleSetAppLanguagePreference,
    handleToggleOpenPanelCloseButton: state.handleToggleOpenPanelCloseButton,
    handleToggleNowPlayingStage: state.handleToggleNowPlayingStage,
    handleSetQueueAddBehavior: state.handleSetQueueAddBehavior,
    handleSetAudioOutputDeviceId: state.handleSetAudioOutputDeviceId,
    volume: state.volume,
    isMuted: state.isMuted,
    handleSetVolume: state.handleSetVolume,
    handleToggleMute: state.handleToggleMute,
    handleToggleLoopMode: state.handleToggleLoopMode,
});

if (typeof window !== 'undefined' && window.electron?.setNativeTheme) {
    const initialSettings = useSettingsUiStore.getState();
    void window.electron.setNativeTheme(
        initialSettings.followSystemTheme ? 'system' : (initialSettings.isDaylight ? 'light' : 'dark'),
    );
}
