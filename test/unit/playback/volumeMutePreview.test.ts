import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/playback/volumeMutePreview.test.ts
// Dragging the volume slider previews gain on the next animation frame. A positive preview must lift
// the settings store's mute flag through handleSetMuted, and that frame must not write the mute value
// captured by an older render back onto the audio element. Zero leaves mute alone.

const runtime = vi.hoisted(() => ({
    slots: [] as { current: unknown }[],
    cursor: 0,
}));

vi.mock('react', () => ({
    useRef: (initial: unknown) => {
        const index = runtime.cursor++;
        runtime.slots[index] ??= { current: initial };
        return runtime.slots[index];
    },
    useCallback: (callback: unknown) => callback,
    useMemo: (factory: () => unknown) => factory(),
    useEffect: () => {},
}));

const settings = vi.hoisted(() => ({
    state: {
        isMuted: true,
        handleSetMuted: vi.fn(),
    },
}));

vi.mock('@/stores/useAudioSettingsStore', () => ({
    useAudioSettingsStore: Object.assign(
        (selector: (state: typeof settings.state) => unknown) => selector(settings.state),
        { getState: () => settings.state },
    ),
}));

vi.mock('@/hooks/useAudioOutputDevice', () => ({
    useAudioOutputDevice: () => ({ handleAudioOutputDeviceChange: vi.fn() }),
}));

vi.mock('@/services/playbackEngine/nativePlaybackEngine', () => ({
    NATIVE_PLAYBACK_ENABLED: false,
    nativePlaybackEngine: { setVolume: vi.fn(), supports: () => false },
}));

vi.mock('@/services/playbackEngine/nativePlayerPlugin', () => ({
    isNativePlayerAvailable: () => false,
}));

vi.mock('@/utils/appPlaybackHelpers', () => ({
    clampMediaVolume: (value: number) => Math.min(1, Math.max(0, value)),
}));

vi.mock('@/utils/coverUrlResolver', () => ({
    createCoverUrlResolver: () => () => '',
}));

vi.mock('@/utils/lyrics/lyricOffsetMemory', () => ({
    writeLyricOffset: vi.fn(),
}));

vi.mock('@/components/app/playback/createLyricsSetter', () => ({
    createLyricsSetter: () => vi.fn(),
}));

vi.mock('@/components/app/playback/persistPlaybackCache', () => ({
    persistPlaybackCache: vi.fn(),
}));

vi.mock('@/components/app/playback/restore/createOnlineRecoveryController', () => ({
    createOnlineRecoveryController: () => ({
        shouldRefreshCurrentOnlineAudioSource: false,
        recoverOnlinePlaybackSource: vi.fn(),
    }),
}));

const { useAppAudioOutput } = await import('@/components/app/appWiring/useAppAudioOutput');

type FrameCallback = (time: number) => void;

let frameCallback: FrameCallback | null = null;

const renderAudioOutput = () => {
    runtime.cursor = 0;
    runtime.slots = [];
    const audio = { volume: 1, muted: true };
    const volumePreviewFrameRef = { current: null as number | null };
    const pendingVolumePreviewRef = { current: null as number | null };
    const model = {
        audioContextRef: { current: null },
        audioQuality: 'high',
        audioRef: { current: audio },
        audioSrc: 'https://example.com/song.mp3',
        blobUrlRef: { current: null },
        cachedCoverUrl: '',
        currentOnlineAudioUrlFetchedAtRef: { current: 0 },
        currentSong: null,
        currentSongFullRef: { current: null },
        gainNodeRef: { current: null },
        globalLyricTimelineOffsetMs: 0,
        isMuted: true,
        lastAudioRecoverySourceRef: { current: null },
        loopMode: 'off',
        lyricFilterEnabled: false,
        lyricFilterPattern: '',
        lyricStaffAbsorbMode: 'none',
        lyricStaffMinDwellSeconds: 0,
        lyricStaffPattern: '',
        lyricStaffPolicy: 'none',
        lyricTimelineOffsetMs: 0,
        onlinePlaybackRecoveryRef: { current: null },
        pendingResumeTimeRef: { current: null },
        pendingVolumePreviewRef,
        setAudioSrc: vi.fn(),
        setCurrentSong: vi.fn(),
        setLyricTimelineOffsetMs: vi.fn(),
        setLyricsState: vi.fn(),
        setPlayQueue: vi.fn(),
        shouldAutoPlay: { current: false },
        volume: 1,
        volumePreviewFrameRef,
    };
    const output = useAppAudioOutput(model as any);
    return { audio, output, pendingVolumePreviewRef, volumePreviewFrameRef };
};

beforeEach(() => {
    frameCallback = null;
    settings.state.isMuted = true;
    settings.state.handleSetMuted = vi.fn((muted: boolean) => {
        settings.state.isMuted = muted;
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameCallback) => {
        frameCallback = callback;
        return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('volume preview mute', () => {
    it('lifts mute through the settings store before writing a positive preview gain', () => {
        const { audio, output } = renderAudioOutput();

        output.handlePreviewVolume(0.5);
        expect(frameCallback).not.toBeNull();
        frameCallback!(0);

        expect(settings.state.handleSetMuted).toHaveBeenCalledWith(false);
        expect(audio.volume).toBe(0.5);
        expect(audio.muted).toBe(false);
    });

    it('a later mute click wins over an already queued preview frame', () => {
        const { audio, output } = renderAudioOutput();
        output.handlePreviewVolume(0.5);
        settings.state.handleSetMuted(true);
        frameCallback!(0);
        expect(settings.state.isMuted).toBe(true);
        expect(audio.volume).toBe(0);
        expect(audio.muted).toBe(true);
    });

    it('leaves mute untouched for a zero-volume preview', () => {
        const { audio, output } = renderAudioOutput();

        output.handlePreviewVolume(0);
        frameCallback!(0);

        expect(settings.state.handleSetMuted).not.toHaveBeenCalled();
        expect(audio.volume).toBe(0);
        expect(audio.muted).toBe(true);
    });
});