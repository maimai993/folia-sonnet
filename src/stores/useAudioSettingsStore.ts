// src/stores/useAudioSettingsStore.ts
// Audio output and the media cache: stream quality, output device, the equalizer, how queued
// songs are added, and the cache ceiling.
//
// volume / isMuted / loopMode live here too. They are playback state rather than settings, but
// they are audio-output state, and this is their nearest owner until the Phase B transport store
// exists — at which point they may move once more.

import { create } from 'zustand';
import { resolveStoredAudioQuality } from './useSettingsUiStore';
import { type QueueAddBehavior } from '../types';
import { getAudioEqualizerCustomSlotIndex, isAudioEqualizerCustomSlotId, readStoredAudioEqualizerSettings, resolveAudioEqualizerSettings, writeStoredAudioEqualizerSettings, type AudioEqualizerModeId, type AudioEqualizerSettings } from '../utils/audioEqualizer';
import { AUDIO_SOUND_PRESETS } from '../utils/audioPresets';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';
import { AudioQuality, DEFAULT_MEDIA_CACHE_LIMIT_GB, ENABLE_MEDIA_CACHE_KEY, MEDIA_CACHE_LIMIT_GB_KEY, readStoredEnableMediaCache, readStoredMediaCacheLimitGb } from './useSettingsUiStore';
import { setStatusMessage } from './useStatusMessageStore';
import i18n from '../i18n/config';

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

const readStoredLoopMode = (): 'off' | 'all' | 'one' => {
    if (typeof window === 'undefined') {
        return 'off';
    }

    const saved = localStorage.getItem('player_loop_mode');
    return saved === 'all' || saved === 'one' ? saved : 'off';
};

const readStoredVolume = () => {
    if (typeof window === 'undefined') {
        return 1;
    }

    const saved = localStorage.getItem('player_volume');
    const parsed = saved !== null ? parseFloat(saved) : 1;
    return Number.isFinite(parsed) ? parsed : 1;
};

export type AudioSettingsState = {
    audioQuality: AudioQuality;
    enableMediaCache: boolean;
    /** Gigabytes of cached audio to keep before the oldest is dropped. Zero means no ceiling. */
    mediaCacheLimitGb: number;
    queueAddBehavior: QueueAddBehavior;
    audioOutputDeviceId: string;
    audioEqualizerSettings: AudioEqualizerSettings;
    isAudioEqualizerOpen: boolean;
    volume: number;
    isMuted: boolean;
    loopMode: 'off' | 'all' | 'one';
    setAudioQuality: (quality: AudioQuality) => void;
    handleToggleMediaCache: (enable: boolean) => void;
    handleSetMediaCacheLimitGb: (gigabytes: number) => void;
    handleSetQueueAddBehavior: (behavior: QueueAddBehavior) => void;
    handleSetAudioOutputDeviceId: (deviceId: string) => void;
    handleSetAudioEqualizerSettings: (settings: AudioEqualizerSettings) => void;
    handleApplyAudioSoundPreset: (modeId: AudioEqualizerModeId) => void;
    openAudioEqualizer: () => void;
    closeAudioEqualizer: () => void;
    handleSetVolume: (val: number) => void;
    handleToggleMute: () => void;
    handleToggleLoopMode: () => void;
};

export const useAudioSettingsStore = create<AudioSettingsState>((set, get) => ({
    audioQuality: readStoredAudioQuality(),
    enableMediaCache: readStoredEnableMediaCache(),
    mediaCacheLimitGb: readStoredMediaCacheLimitGb(),
    queueAddBehavior: readStoredQueueAddBehavior(),
    audioOutputDeviceId: readStoredAudioOutputDeviceId(),
    audioEqualizerSettings: readStoredAudioEqualizerSettings(),
    isAudioEqualizerOpen: false,
    volume: readStoredVolume(),
    isMuted: getStoredBoolean('player_is_muted', false),
    loopMode: readStoredLoopMode(),
    setAudioQuality: (quality) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('default_audio_quality', quality);
        }
        set({ audioQuality: quality });
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
}));

/**
 * The AudioSettings half of the former settings snapshot, for the surfaces that
 * legitimately edit this whole domain at once. Ordinary consumers select one field instead.
 */
export const selectAudioSettingsSnapshot = (state: AudioSettingsState) => ({
    audioQuality: state.audioQuality,
    enableMediaCache: state.enableMediaCache,
    mediaCacheLimitGb: state.mediaCacheLimitGb,
    queueAddBehavior: state.queueAddBehavior,
    audioOutputDeviceId: state.audioOutputDeviceId,
    audioEqualizerSettings: state.audioEqualizerSettings,
    isAudioEqualizerOpen: state.isAudioEqualizerOpen,
    volume: state.volume,
    isMuted: state.isMuted,
    loopMode: state.loopMode,
    setAudioQuality: state.setAudioQuality,
    handleToggleMediaCache: state.handleToggleMediaCache,
    handleSetMediaCacheLimitGb: state.handleSetMediaCacheLimitGb,
    handleSetQueueAddBehavior: state.handleSetQueueAddBehavior,
    handleSetAudioOutputDeviceId: state.handleSetAudioOutputDeviceId,
    handleSetAudioEqualizerSettings: state.handleSetAudioEqualizerSettings,
    handleApplyAudioSoundPreset: state.handleApplyAudioSoundPreset,
    openAudioEqualizer: state.openAudioEqualizer,
    closeAudioEqualizer: state.closeAudioEqualizer,
    handleSetVolume: state.handleSetVolume,
    handleToggleMute: state.handleToggleMute,
    handleToggleLoopMode: state.handleToggleLoopMode,
});
