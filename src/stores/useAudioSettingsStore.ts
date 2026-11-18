// src/stores/useAudioSettingsStore.ts
// Audio output and the media cache: stream quality, output device, the equalizer, how queued
// songs are added, and the cache ceiling.
//
// volume / isMuted / loopMode live here too. They are playback state rather than settings, but
// they are audio-output state, and this is their nearest owner until the Phase B transport store
// exists — at which point they may move once more.

import { create } from 'zustand';
import type { AudioQualityPreference } from '../types/onlineMusic';
import { type QueueAddBehavior } from '../types';
import { areAudioEqualizerSettingsEqual, planAudioSoundPreset, readStoredAudioEqualizerSettings, resolveAudioEqualizerSettings, writeStoredAudioEqualizerSettings, type AudioEqualizerCustomSlotId, type AudioEqualizerModeId, type AudioEqualizerSettings } from '../utils/audioEqualizer';
import {
    areAudioEqualizerModCurvesEqual,
    isSameOwnSound,
    normalizeAudioEqualizerModCurveGains,
    parseStoredAudioEqualizerModCurve,
    saveAudioEqualizerModCurveToSlot,
    serializeAudioEqualizerModCurve,
    type AudioEqualizerChangeOrigin,
    type AudioEqualizerModCurve,
} from '../utils/audioEqualizerModCurve';
import { getStoredBoolean, getStoredNumber, getStoredString, removeStoredKey, setStoredBoolean, setStoredNumber, setStoredString } from './storagePrimitives';
import { writeNativeLoopMode } from '../services/nativeQueueBridge';
import { writeNativeSettings } from '../services/nativeSettingsBridge';
import { setStatusMessage } from './useStatusMessageStore';
import { setAudioFocusPolicy } from '../platform/foliaNative';
import { isCapacitorAndroid } from '../platform/runtime';
import { nativePlayer } from '../services/playbackEngine/nativePlayerPlugin';
import { nativePlaybackEngine } from '../services/playbackEngine/nativePlaybackEngine';
import i18n from '../i18n/config';

export const CACHE_SIZE_KEY = 'folia_cache_size';

export const ENABLE_MEDIA_CACHE_KEY = 'folia_enable_media_cache';

/**
 * 缓存开关的第二代 key。
 *
 * 为什么换名而不是直接改默认值：老版本的包还认着旧 key，同一把 key 上翻转默认值，
 * 新旧两版对「用户到底选没选过」的判断会互相打架 —— 旧版升级上来读到的语义是错的，
 * 回退旧版时更可能直接起不来。另起 `folia_enable_media_cache_v2`：
 * 没写过的安装（绝大多数）默认**开**，写过的按用户自己的选择来。
 * 旧 key 不再读：谁升级到这一版，缓存就是开的，直到他亲手关掉。
 */
export const ENABLE_MEDIA_CACHE_V2_KEY = 'folia_enable_media_cache_v2';

/** What the toggle used to write to, before it was corrected to the prefixed key above. */
export const LEGACY_ENABLE_MEDIA_CACHE_KEY = 'enable_media_cache';

export const MEDIA_CACHE_LIMIT_GB_KEY = 'folia_media_cache_limit_gb';

/** Lab switch: start the restored last session playing instead of waiting for a press. */
export const AUTO_PLAY_ON_LAUNCH_KEY = 'folia_auto_play_on_launch';

/**
 * Lab switch, the one under the above: also walk straight to the lyrics page on launch.
 * Only meaningful together with AUTO_PLAY_ON_LAUNCH_KEY — with nothing playing there is no
 * page to watch. Off unless asked for: an app that reopens onto somebody else's screen is a
 * worse default than one that reopens onto the home wall.
 */
export const AUTO_JUMP_TO_VISUALIZER_ON_LAUNCH_KEY = 'folia_auto_jump_to_visualizer_on_launch';

export const ENABLE_TRANSCODE_FALLBACK_KEY = 'folia_enable_transcode_fallback';

/** Whether finished plays of online NetEase tracks are reported to the signed-in account. */
export const NETEASE_SCROBBLE_KEY = 'folia_netease_scrobble';

/** Whether pause fades out and resume fades in (services/playbackFade). On unless switched off. */
export const PLAYBACK_FADE_KEY = 'folia_playback_fade_enabled';

/** 播放倍速（0.5 ~ 2）。 */
export const PLAYBACK_SPEED_KEY = 'folia_playback_speed';
/** 升降调半音数（-6 ~ +6，0 = 原调）。 */
export const PLAYBACK_PITCH_KEY = 'folia_playback_pitch_semitones';

/**
 * 播放时保持屏幕常亮。默认关：常亮是"别给我熄屏"，不是每个人在播放页都想要，
 * 而且开着等于放弃了系统那套自动熄屏，属于该由用户点头的事。
 */
export const KEEP_SCREEN_ON_WHILE_PLAYING_KEY = 'folia_keep_screen_on_while_playing';

/**
 * Whether a song that cannot be played for an account restriction or an unknown reason counts down to
 * a skip, like a taken-down one (services/onlineMusic/failure/onlineFailureCase). Off unless asked for.
 */
export const AUTO_SKIP_UNPLAYABLE_KEY = 'folia_auto_skip_unplayable';
/**
 * 后台自动静默跳过（Android）。
 *
 * 开（默认）：应用在后台时遇到无法播放的歌曲，原生直接换下一首，不等前台的倒计时或提示。
 * 关：后台遇到这类歌曲不自动跳过。
 */
export const BACKGROUND_SILENT_SKIP_KEY = 'background_silent_skip';

/**
 * 后台与其他音源同时播放（Android）。
 *
 * 开（默认）：播放器不请求音频焦点，别的应用出声不会打断我们 —— 打开抖音、微信、
 * 导航抢焦点时音乐继续响。原生 ExoPlayer 走 setAudioAttributes(..., handleAudioFocus=false)，
 * WebView 那套走 FoliaAudioManager，两边都不再响应焦点丢失。
 * 关：请求并持有焦点，别的应用一出声系统就把焦点收走，我们暂停（标准媒体 App 行为）。
 *
 * 默认开：切到后台再打开别的应用就断声是最常遇到的抱怨，默认让它不打断；需要在乎
 * 「独占焦点」的人仍可在设置里关掉。
 */
export const MIX_WITH_OTHER_AUDIO_KEY = 'folia_mix_with_other_audio';

/**
 * 关闭人声（中置相消）的存储键。
 *
 * 从没发布过，是这次新加的，所以名字现在定下来就不改了（见 AGENTS.md「存下来的数据」）。
 */
export const VOCAL_CANCEL_KEY = 'folia_vocal_cancel';
export const VOCAL_ONLY_KEY = 'folia_vocal_only';

/**
 * 「设置 → 存储」里「预先拆分音轨」总开关。
 *
 * 开：默认把当前歌与下一首的两轨（伴奏 / 清唱）提前拆好，拨「人声 / 伴奏」秒切；
 * 关（默认）：不预先跑 SCNet，只正常给智能动感提供整曲曲线数据。
 * 原生存一份（FoliaSettingsStore 的 prebuildTracks）：通知栏起播时 WebView 还没起来，
 * 装源那条路得自己知道要不要预拆。
 */
export const PREBUILD_TRACKS_KEY = 'folia_prebuild_tracks';

/*
 * 原来的 `folia_native_playback`（原生播放开关）已经删掉：安卓上原生播放恒开，
 * 不再给用户一条「回到网页音频图」的岔路。留在这里的说明是给读代码的人看的：
 *
 * 原生播放意味着 Web 音频图整体不参与出声 —— 均衡器、音效链、淡入淡出、automix
 * 交叉淡化、播放页频谱都挂在 `createMediaElementSource` 上，而它是单向不可逆的。
 * 这是已知代价，不是 bug。
 */

/**
 * Folium 1.7: the equalizer curve a mod put in place over the listener's own sound (utils/audioEqualizerModCurve.ts),
 * removed when the listener's own sound plays again. audio_equalizer_settings never holds it.
 */
export const AUDIO_EQUALIZER_MOD_CURVE_KEY = 'folia_audio_equalizer_mod_curve';

/** Gigabytes of cached audio to keep. Zero is the listener asking for no ceiling at all. */
export const DEFAULT_MEDIA_CACHE_LIMIT_GB = 5;

export type AudioQuality = AudioQualityPreference;

/**
 * 没有存过时用哪一档。
 *
 * `ultra` = 1080P（B 站）/ 超高音质（音乐平台）。以前默认是 `high`（720P），
 * 在 B 站上就是「默认给 720P」—— 而视频站的曲目几乎都是 1080P 源，
 * 默认看得清比默认省一点流量更重要。
 *
 * 只影响**没选过**的人：存过的那一档原样尊重。
 */
export const DEFAULT_AUDIO_QUALITY: AudioQuality = 'ultra';

export const resolveStoredAudioQuality = (saved: string | null): AudioQuality => {
    // 上一代网易云的那档叫 exhigh，含义就是现在的 high：迁移过来，不是回退到默认。
    if (saved === 'exhigh') return 'high';
    return saved === 'standard' || saved === 'high' || saved === 'ultra' || saved === 'lossless' || saved === 'hires'
        ? saved
        : DEFAULT_AUDIO_QUALITY;
};

/**
 * Reads the media cache toggle from the v2 key: default **on**.
 *
 * 旧 key（folia_enable_media_cache / enable_media_cache）不再参与：那是上一代
 * 默认关的开关，新 key 一换，这一版的语义是「默认缓存，除非用户亲手关」。
 */
/*
 * 取得到就用 localStorage，取不到就 null。
 *
 * 这些 read* 大多在模块求值时就跑（store 的初始 state 用它们），所以拿不到存储不能抛，
 * 只能当「没存过」。只判 `typeof window === 'undefined'` 不够：`window` 在、存储不在的
 * 环境是有的（无痕/受限的 WebView、被裁掉存储的沙箱、测试里只为别的事 stub 的 window）。
 */
const storageOrNull = (): Storage | null => {
    if (typeof window === 'undefined') {
        return null;
    }
    try {
        return window.localStorage ?? null;
    } catch {
        return null;
    }
};

export const readStoredEnableMediaCache = (): boolean => {
    const storage = storageOrNull();
    if (!storage) {
        return true;
    }

    const stored = storage.getItem(ENABLE_MEDIA_CACHE_V2_KEY);
    return stored === null ? true : stored === 'true';
};

export const readStoredMediaCacheLimitGb = (): number => {
    const storage = storageOrNull();
    if (!storage) {
        return DEFAULT_MEDIA_CACHE_LIMIT_GB;
    }

    const saved = storage.getItem(MEDIA_CACHE_LIMIT_GB_KEY);
    const parsed = saved === null ? NaN : Number(saved);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MEDIA_CACHE_LIMIT_GB;
};

const readStoredAudioQuality = (): AudioQuality => {
    const storage = storageOrNull();
    if (!storage) {
        return DEFAULT_AUDIO_QUALITY;
    }

    const saved = storage.getItem('default_audio_quality');
    const quality = resolveStoredAudioQuality(saved);
    if (saved === 'exhigh') {
        storage.setItem('default_audio_quality', 'high');
    }
    return quality;
};

const readStoredQueueAddBehavior = (): QueueAddBehavior => {
    const storage = storageOrNull();
    if (!storage) {
        return 'append';
    }

    const saved = storage.getItem('queue_add_behavior');
    return saved === 'next' ? 'next' : 'append';
};

const readStoredAudioOutputDeviceId = (): string => {
    const storage = storageOrNull();
    if (!storage) {
        return '';
    }

    return storage.getItem('audio_output_device_id') ?? '';
};

const readStoredLoopMode = (): 'off' | 'all' | 'one' | 'shuffle' => {
    const storage = storageOrNull();
    if (!storage) {
        return 'off';
    }

    const saved = storage.getItem('player_loop_mode');
    return saved === 'all' || saved === 'one' || saved === 'shuffle' ? saved : 'off';
};

/**
 * The mod curve kept from the last run, checked against the listener's own sound: one saved by a later
 * version is left in place unused (going back to that version finds it again), a broken one is removed, and
 * so is one whose base the listener's sound no longer matches (it was changed where nothing ended the curve,
 * an older version for one: the listener has chosen since).
 */
const readStoredAudioEqualizerModCurve = (settings: AudioEqualizerSettings): AudioEqualizerModCurve | null => {
    const raw = getStoredString(AUDIO_EQUALIZER_MOD_CURVE_KEY, '');
    if (!raw) {
        return null;
    }

    const stored = parseStoredAudioEqualizerModCurve(raw);
    if ('ignore' in stored) {
        console.info(`[AudioEqualizer] kept a mod curve saved by a later version (v=${String(stored.version)}); not used here`);
        return null;
    }
    if ('drop' in stored) {
        console.info('[AudioEqualizer] dropped a stored mod curve that could not be read');
        removeStoredKey(AUDIO_EQUALIZER_MOD_CURVE_KEY);
        return null;
    }
    if (!isSameOwnSound(stored.curve.base, settings)) {
        console.info(`[AudioEqualizer] dropped the curve of ${stored.curve.modId}: your own sound changed since it was applied`);
        removeStoredKey(AUDIO_EQUALIZER_MOD_CURVE_KEY);
        return null;
    }
    return stored.curve;
};

const writeStoredAudioEqualizerModCurve = (curve: AudioEqualizerModCurve | null) => {
    if (curve) {
        setStoredString(AUDIO_EQUALIZER_MOD_CURVE_KEY, serializeAudioEqualizerModCurve(curve));
    } else {
        removeStoredKey(AUDIO_EQUALIZER_MOD_CURVE_KEY);
    }
};

const USER_ORIGIN: AudioEqualizerChangeOrigin = { kind: 'user' };
const COMMAND_ORIGIN: AudioEqualizerChangeOrigin = { kind: 'command' };
const HOST_ORIGIN: AudioEqualizerChangeOrigin = { kind: 'host' };

const readStoredVolume = () => {
    const storage = storageOrNull();
    if (!storage) {
        return 1;
    }

    const saved = storage.getItem('player_volume');
    const parsed = saved !== null ? parseFloat(saved) : 1;
    return Number.isFinite(parsed) ? parsed : 1;
};

export type AudioSettingsState = {
    audioQuality: AudioQuality;
    enableMediaCache: boolean;
    /** Gigabytes of cached audio to keep before the oldest is dropped. Zero means no ceiling. */
    mediaCacheLimitGb: number;
    queueAddBehavior: QueueAddBehavior;
    /** Whether entering the app starts the restored session by itself. Off unless asked for. */
    autoPlayOnLaunch: boolean;
    /** Whether that same launch also walks straight to the lyrics page. Off unless asked for. */
    autoJumpToVisualizerOnLaunch: boolean;
    /** Electron-only recovery for local and Navidrome formats Chromium cannot decode. */
    enableTranscodeFallback: boolean;
    /** Report finished plays of online NetEase tracks to the signed-in account. Off by default. */
    neteaseScrobbleEnabled: boolean;
    /** Short fade when pausing and resuming instead of cutting the sound. On by default. */
    playbackFadeEnabled: boolean;
    /** 播放倍速（0.5 ~ 2，1 = 原速）。由 ExoPlayer 的 PlaybackParameters 执行，启动时推给原生。 */
    playbackSpeed: number;
    /** 升降调（半音，-6 ~ +6，0 = 原调）。只移频不改时长，由 PlaybackParameters 的 pitch 执行。 */
    playbackPitch: number;
    /** Count down to a skip when a song is restricted or fails for an unknown reason. Off by default. */
    autoSkipUnplayable: boolean;
    /** 后台遇到无法播放的歌曲时静默跳过（Android）。默认开，见 BACKGROUND_SILENT_SKIP_KEY。 */
    backgroundSilentSkip: boolean;
    /** 播放时保持屏幕常亮（Android 的 FLAG_KEEP_SCREEN_ON）。Off by default. */
    keepScreenOnWhilePlaying: boolean;
    /** 后台与其他音源同时播放（Android）。On by default（PR 作者刻意翻转：默认关=播放器接管焦点，应用内/其他应用一出声音乐就被系统按焦点丢失打断，过渡还会被自己的第二台播放器暂停）。 */
    mixWithOtherAudio: boolean;
    /**
     * 关闭人声（中置相消）。Off by default，见 VOCAL_CANCEL_KEY。
     *
     * 安卓上由原生 AudioSink 的处理链实时做（VocalCancelProcessor）；
     * 桌面端没有这条链路，开关不出现。
     */
    vocalCancelEnabled: boolean;
    /** 只留人声（清唱轨）。与 vocalCancelEnabled 互斥，同时最多一个为真。 */
    vocalOnlyEnabled: boolean;
    /**
     * 「关闭人声」此刻实际走到哪一步（原生上报，不落盘）。
     *
     * 开关只是意图；真正的实现是「离线分离出伴奏、再切过去播」，
     * 那件事要几十秒，所以界面必须能说出「还在生成」而不是让用户以为开关没反应。
     */
    vocalCancelState: 'idle' | 'building' | 'ready' | 'failed';
    vocalCancelPercent: number;
    /** 伴奏缓存：已缓存首数、占用字节、当前上限（上限跟着磁盘剩余走）。 */
    vocalCancelCachedCount: number;
    vocalCancelCacheBytes: number;
    vocalCancelCacheLimit: number;
    /** 原生此刻真正生效的模式：两个开关的意图可能被互斥改写，界面以它为准。 */
    vocalTrackMode: 'instrumental' | 'vocal' | 'off';
    /** 「设置 → 存储」里的总开关：是否预先拆分音轨、提前分析下一首。默认关。 */
    prebuildTracksEnabled: boolean;
    audioOutputDeviceId: string;
    /** The listener's own sound, always: a mod's curve is never written into it. */
    audioEqualizerSettings: AudioEqualizerSettings;
    /** A curve a mod put in place over the listener's own sound; null while the listener's own sound plays. Persisted. */
    audioEqualizerModCurve: AudioEqualizerModCurve | null;
    /**
     * True while the mod of that curve is disabled or removed: the curve is kept but not heard. Not persisted; the
     * Folium host layer sets it from the mod list (runtime/equalizer/hostEqualizer.ts). False whenever there is no curve.
     */
    audioEqualizerModCurveSuspended: boolean;
    /** Who made the last equalizer change; not persisted. Read by the Folium host layer and the audio bridge. */
    audioEqualizerChangeOrigin: AudioEqualizerChangeOrigin;
    isAudioEqualizerOpen: boolean;
    volume: number;
    isMuted: boolean;
    loopMode: 'off' | 'all' | 'one' | 'shuffle';
    setAudioQuality: (quality: AudioQuality) => void;
    handleToggleMediaCache: (enable: boolean) => void;
    handleSetMediaCacheLimitGb: (gigabytes: number) => void;
    handleSetQueueAddBehavior: (behavior: QueueAddBehavior) => void;
    handleToggleAutoPlayOnLaunch: (enable: boolean) => void;
    handleToggleAutoJumpToVisualizerOnLaunch: (enable: boolean) => void;
    handleToggleTranscodeFallback: (enable: boolean) => void;
    handleToggleNeteaseScrobble: (enable: boolean) => void;
    handleTogglePlaybackFade: (enable: boolean) => void;
    handleSetPlaybackSpeed: (speed: number) => void;
    handleSetPlaybackPitch: (semitones: number) => void;
    handleToggleAutoSkipUnplayable: (enable: boolean) => void;
    handleToggleBackgroundSilentSkip: (enable: boolean) => void;
    handleToggleKeepScreenOnWhilePlaying: (enable: boolean) => void;
    handleToggleMixWithOtherAudio: (enable: boolean) => void;
    handleToggleVocalCancel: (enable: boolean) => void;
    /** 只留人声；打开时自动关掉「关闭人声」。 */
    handleToggleVocalOnly: (enable: boolean) => void;
    /** 三态「全部 / 人声 / 伴奏」：一次原子写两个键，避免切换时留下「两个都开」的中间态。 */
    handleSetVocalMode: (mode: 'off' | 'vocal' | 'instrumental') => void;
    /** 总开关：预先拆分音轨 + 提前分析下一首。同时推给原生，冷启动也能读到。 */
    handleTogglePrebuildTracks: (enable: boolean) => void;
    /** 原生上报的生成进度。界面只读，不参与持久化。 */
    handleSetVocalCancelStatus: (state: 'idle' | 'building' | 'ready' | 'failed', percent: number) => void;
    /** 原生报回来的缓存用量。界面只读，不参与持久化。 */
    handleSetVocalCancelCache: (count: number, bytes: number, limit: number) => void;
    /** 原生报回来的当前模式。 */
    handleSetVocalTrackMode: (mode: 'instrumental' | 'vocal' | 'off') => void;
    handleSetAudioOutputDeviceId: (deviceId: string) => void;
    /*
     * The equalizer actions below return whether anything changed: the listener's settings they leave
     * (compared field by field) or the mod curve record. When nothing did they neither set nor save.
     * Each change is one set, with the origin beside the settings.
     */
    /** Writes the listener's whole sound (the window: a preset, the reset, an edit); ends a mod's curve. */
    handleSetAudioEqualizerSettings: (settings: AudioEqualizerSettings, origin?: AudioEqualizerChangeOrigin) => boolean;
    /** Flips only the processing switch; a mod's curve stays. */
    handleSetAudioEqualizerEnabled: (enabled: boolean, origin?: AudioEqualizerChangeOrigin) => boolean;
    /**
     * Applies a built-in sound or a saved custom slot and ends a mod's curve. Turns processing on unless
     * `keepEnabled` (a mod's write never touches the switch). The origin is `command` unless given.
     */
    handleApplyAudioSoundPreset: (
        modeId: AudioEqualizerModeId,
        options?: { origin?: AudioEqualizerChangeOrigin; keepEnabled?: boolean },
    ) => boolean;
    /** Folium 1.7: puts a mod's curve in place over the listener's own sound, which stays as it is. */
    handleApplyModEqualizerCurve: (curve: { modId: string; modName: string; gains: readonly number[] }) => boolean;
    /** Takes the mod curve off, back to the listener's own sound; false when there is none. */
    handleReleaseModEqualizerCurve: (origin: AudioEqualizerChangeOrigin) => boolean;
    /** The window's "save to custom N": that slot becomes the curve with the listener's effects, and is chosen. */
    handleSaveModEqualizerCurveToSlot: (slotId: AudioEqualizerCustomSlotId) => boolean;
    /** For the Folium host layer only: holds the curve back while its mod is disabled or removed. No-op without a curve. */
    handleSetAudioEqualizerModCurveSuspended: (suspended: boolean) => boolean;
    openAudioEqualizer: () => void;
    closeAudioEqualizer: () => void;
    handleSetVolume: (val: number) => void;
    /** Sets the mute switch; the same value is a no-op. */
    handleSetMuted: (muted: boolean) => void;
    handleToggleMute: () => void;
    /** Sets the repeat mode and toasts it like the repeat button; the mode already in effect is a no-op. */
    handleSetLoopMode: (mode: 'off' | 'all' | 'one' | 'shuffle') => void;
    handleToggleLoopMode: () => void;
};

/*
 * One equalizer change: the listener's settings it leaves and the mod curve record after it. Nothing
 * changes when both are the same as now: then no set and nothing saved, and false. Otherwise what changed
 * is saved and set at once, with the origin. A curve that changes is heard (the mod putting it there runs,
 * and with none there is nothing to hold back), so the suspension goes with it.
 */
const commitAudioEqualizerChange = (
    get: () => AudioSettingsState,
    set: (partial: Partial<AudioSettingsState>) => void,
    settings: AudioEqualizerSettings,
    curve: AudioEqualizerModCurve | null,
    origin: AudioEqualizerChangeOrigin,
): boolean => {
    const current = get();
    const settingsChanged = !areAudioEqualizerSettingsEqual(settings, current.audioEqualizerSettings);
    const curveChanged = !areAudioEqualizerModCurvesEqual(curve, current.audioEqualizerModCurve);
    if (!settingsChanged && !curveChanged) {
        return false;
    }

    if (settingsChanged) {
        writeStoredAudioEqualizerSettings(settings);
    }
    if (curveChanged) {
        writeStoredAudioEqualizerModCurve(curve);
    }
    set({
        ...(settingsChanged ? { audioEqualizerSettings: settings } : {}),
        ...(curveChanged ? { audioEqualizerModCurve: curve, audioEqualizerModCurveSuspended: false } : {}),
        audioEqualizerChangeOrigin: origin,
    });
    return true;
};

const initialAudioEqualizerSettings = readStoredAudioEqualizerSettings();

export const useAudioSettingsStore = create<AudioSettingsState>((set, get) => ({
    audioQuality: readStoredAudioQuality(),
    enableMediaCache: readStoredEnableMediaCache(),
    mediaCacheLimitGb: readStoredMediaCacheLimitGb(),
    queueAddBehavior: readStoredQueueAddBehavior(),
    autoPlayOnLaunch: getStoredBoolean(AUTO_PLAY_ON_LAUNCH_KEY, false),
    autoJumpToVisualizerOnLaunch: getStoredBoolean(AUTO_JUMP_TO_VISUALIZER_ON_LAUNCH_KEY, false),
    enableTranscodeFallback: getStoredBoolean(
        ENABLE_TRANSCODE_FALLBACK_KEY,
        typeof window !== 'undefined' && Boolean(window.electron?.requestTranscodeFallback),
    ),
    // Off unless asked for: it writes to the listener's music account, so it is never a default.
    neteaseScrobbleEnabled: getStoredBoolean(NETEASE_SCROBBLE_KEY, false),
    playbackFadeEnabled: getStoredBoolean(PLAYBACK_FADE_KEY, true),
    playbackSpeed: getStoredNumber(PLAYBACK_SPEED_KEY, 1),
    playbackPitch: getStoredNumber(PLAYBACK_PITCH_KEY, 0),
    // Off unless asked for: skipping a song the listener picked is not something to do by default.
    autoSkipUnplayable: getStoredBoolean(AUTO_SKIP_UNPLAYABLE_KEY, false),
    backgroundSilentSkip: getStoredBoolean(BACKGROUND_SILENT_SKIP_KEY, true),
    // 默认关：常亮等于放弃系统那套自动熄屏，该由用户点头，不该替他决定。
    keepScreenOnWhilePlaying: getStoredBoolean(KEEP_SCREEN_ON_WHILE_PLAYING_KEY, false),
    mixWithOtherAudio: getStoredBoolean(MIX_WITH_OTHER_AUDIO_KEY, true),
    // 默认关：它改变的是这首歌本来的样子，该由用户自己拨。
    vocalCancelEnabled: getStoredBoolean(VOCAL_CANCEL_KEY, false),
    vocalOnlyEnabled: getStoredBoolean(VOCAL_ONLY_KEY, false),
    vocalCancelState: 'idle',
    vocalCancelPercent: 0,
    vocalCancelCachedCount: 0,
    vocalCancelCacheBytes: 0,
    vocalCancelCacheLimit: 0,
    vocalTrackMode: 'off',
    // 默认关：预拆两轨是几十秒的推理，不替用户决定要不要占这份负载。
    // 默认打开：这首歌与下一首的伴奏 / 清唱提前备好，切「人声 / 伴奏」才不用等几十秒。
    prebuildTracksEnabled: getStoredBoolean(PREBUILD_TRACKS_KEY, true),
    audioOutputDeviceId: readStoredAudioOutputDeviceId(),
    audioEqualizerSettings: initialAudioEqualizerSettings,
    audioEqualizerModCurve: readStoredAudioEqualizerModCurve(initialAudioEqualizerSettings),
    audioEqualizerModCurveSuspended: false,
    audioEqualizerChangeOrigin: HOST_ORIGIN,
    isAudioEqualizerOpen: false,
    volume: readStoredVolume(),
    isMuted: getStoredBoolean('player_is_muted', false),
    loopMode: readStoredLoopMode(),
    setAudioQuality: (quality) => {
        if (typeof window !== 'undefined') {
            storageOrNull()?.setItem('default_audio_quality', quality);
        }
        set({ audioQuality: quality });
    },
    handleToggleMediaCache: (enable) => {
        setStoredBoolean(ENABLE_MEDIA_CACHE_V2_KEY, enable);
        set({ enableMediaCache: enable });
    },
    handleSetMediaCacheLimitGb: (gigabytes) => {
        const next = Number.isFinite(gigabytes) && gigabytes >= 0 ? gigabytes : DEFAULT_MEDIA_CACHE_LIMIT_GB;
        if (typeof window !== 'undefined') {
            storageOrNull()?.setItem(MEDIA_CACHE_LIMIT_GB_KEY, String(next));
        }
        set({ mediaCacheLimitGb: next });
    },
    handleSetQueueAddBehavior: (behavior) => {
        if (typeof window !== 'undefined') {
            storageOrNull()?.setItem('queue_add_behavior', behavior);
        }
        set({ queueAddBehavior: behavior });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (behavior === 'next' ? 'queueInsertNext' : 'queueAppend')),
        });
    },
    handleToggleAutoPlayOnLaunch: (enable) => {
        setStoredBoolean(AUTO_PLAY_ON_LAUNCH_KEY, enable);
        set({ autoPlayOnLaunch: enable });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'autoPlayOnLaunchOn' : 'autoPlayOnLaunchOff')),
        });
    },
    handleToggleAutoJumpToVisualizerOnLaunch: (enable) => {
        setStoredBoolean(AUTO_JUMP_TO_VISUALIZER_ON_LAUNCH_KEY, enable);
        set({ autoJumpToVisualizerOnLaunch: enable });
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'autoJumpToVisualizerOn' : 'autoJumpToVisualizerOff')),
        });
    },
    handleToggleTranscodeFallback: (enable) => {
        setStoredBoolean(ENABLE_TRANSCODE_FALLBACK_KEY, enable);
        set({ enableTranscodeFallback: enable });
    },
    handleToggleNeteaseScrobble: (enable) => {
        setStoredBoolean(NETEASE_SCROBBLE_KEY, enable);
        set({ neteaseScrobbleEnabled: enable });
    },
    handleTogglePlaybackFade: (enable) => {
        setStoredBoolean(PLAYBACK_FADE_KEY, enable);
        set({ playbackFadeEnabled: enable });
        /*
         * 这一项现在由原生执行：出声交给 ExoPlayer 之后，Web Audio 上那条 gain 斜坡不再参与，
         * 淡入淡出改成播放器自己做的音量斜坡（见 FoliaNativePlayer.rampVolume）。不推过去，
         * 界面上关掉它也不会有任何变化。
         */
        void writeNativeSettings({ playbackFade: enable });
    },
    /*
     * 倍速与升降调都归 ExoPlayer 的 PlaybackParameters 执行：speed 管时长，pitch 只移频。
     * speed 必须走引擎（它要把引擎侧的位置外推速率同步改掉），pitch 引擎只记值不参与外推。
     * 原生对空播放器也只是记下 requestedSpeed / requestedPitch，下一次 prepare 一起带上 ——
     * 所以在播放页拨了设置、还没出声前装源也不会丢。
     */
    handleSetPlaybackSpeed: (speed) => {
        const clamped = Math.min(2, Math.max(0.5, speed));
        setStoredNumber(PLAYBACK_SPEED_KEY, clamped);
        set({ playbackSpeed: clamped });
        nativePlaybackEngine.setSpeed(clamped);
    },
    handleSetPlaybackPitch: (semitones) => {
        const clamped = Math.min(6, Math.max(-6, Math.round(semitones)));
        setStoredNumber(PLAYBACK_PITCH_KEY, clamped);
        set({ playbackPitch: clamped });
        // 半音 → 频率倍率：每 +12 半音频率翻倍。
        nativePlaybackEngine.setPitch(Math.pow(2, clamped / 12));
    },
    handleToggleAutoSkipUnplayable: (enable) => {
        setStoredBoolean(AUTO_SKIP_UNPLAYABLE_KEY, enable);
        set({ autoSkipUnplayable: enable });
        /*
         * 原生也要知道。这一项不止 Web 那条路在用：WebView 冻结时、换源失败时，
         * 原生兜底（FoliaPlaybackService.onEntryUnplayable）自己决定跳不跳，读的是
         * 原生设置。以前没人推过它，原生永远按默认的 true 走 —— 用户把开关关掉，
         * 后台那条路照样一路跳。
         */
        void writeNativeSettings({ autoSkipUnplayable: enable });
    },
    handleToggleBackgroundSilentSkip: (enable) => {
        setStoredBoolean(BACKGROUND_SILENT_SKIP_KEY, enable);
        set({ backgroundSilentSkip: enable });
        /*
         * 后台那条路由原生自己判断（FoliaPlaybackService），它读的是落盘的原生设置：
         * 不推过去，界面上关掉它，后台遇到无法播放的歌照样会跳。
         */
        void writeNativeSettings({ backgroundSilentSkip: enable });
    },
    handleToggleKeepScreenOnWhilePlaying: (enable) => {
        setStoredBoolean(KEEP_SCREEN_ON_WHILE_PLAYING_KEY, enable);
        set({ keepScreenOnWhilePlaying: enable });
    },
    handleToggleMixWithOtherAudio: (enable) => {
        setStoredBoolean(MIX_WITH_OTHER_AUDIO_KEY, enable);
        set({ mixWithOtherAudio: enable });
        /*
         * 立刻过桥一次，别等下次播放才写：原生那边（FoliaApplication 决定给 WebView
         * 哪一种 AudioManager）读的是**落盘的**开关，而 WebView 只有在下一次**开始播放**
         * 时才会重新来问 —— 正在响的这首拿到的还是切换前那一个，新策略要到下一次
         * 开始播放才生效。被打断后的自动恢复走的是 JS 那条路，不依赖它，拨过去就管用。
         */
        void setAudioFocusPolicy(enable);
    },
    handleToggleVocalCancel: (enable) => {
        setStoredBoolean(VOCAL_CANCEL_KEY, enable);
        if (enable) setStoredBoolean(VOCAL_ONLY_KEY, false);
        /*
         * 打开就先按「正在准备」显示：原生那边第一件事是查缓存，
         * 命中会立刻回 ready，没命中才是几十秒的分离 —— 两种都不会让开关
         * 看起来像没反应。关掉则立刻回到 idle（原生会把音源切回原曲）。
         */
        set({
            vocalCancelEnabled: enable,
            vocalOnlyEnabled: enable ? false : get().vocalOnlyEnabled,
            vocalCancelState: enable ? 'building' : 'idle',
            vocalCancelPercent: enable ? 0 : 0,
        });
        /*
         * 立刻推给原生：处理器每帧读 NativeEqualizerState.vocalCancelEnabled，
         * 所以拨过去正在响的这首当场就变，不用等下一次播放。
         *
         * 只落在安卓：桌面端没有 AudioSink 那条链，也没有这个插件方法。
         * 失败就忽略 —— 开关状态已经存下了，下次启动会对表一次
         * （nativeEqualizer.ts 的 pushNativeVocalCancel），原生侧自己也会落盘。
         */
        if (!isCapacitorAndroid()) return;
        void nativePlayer.setVocalCancelEnabled(enable).catch(() => undefined);
    },
    handleToggleVocalOnly: (enable) => {
        setStoredBoolean(VOCAL_ONLY_KEY, enable);
        if (enable) setStoredBoolean(VOCAL_CANCEL_KEY, false);
        set({
            vocalOnlyEnabled: enable,
            vocalCancelEnabled: enable ? false : get().vocalCancelEnabled,
            // 与伴奏共用同一套进度状态：同一时刻只有一轨在切。
            vocalCancelState: enable ? 'building' : 'idle',
            vocalCancelPercent: 0,
        });
        if (!isCapacitorAndroid()) return;
        /*
         * 顺序要紧：先把另一个关掉，再打开这个。原生那边两个 setter 都会写盘，
         * 反过来会在中间留下「两个都开」的一瞬，换源逻辑会摇摆。
         */
        void (async () => {
            if (enable) {
                await nativePlayer.setVocalCancelEnabled(false).catch(() => undefined);
            }
            await nativePlayer.setVocalOnlyEnabled(enable).catch(() => undefined);
        })();
    },
    /*
     * 三态切换（全部 / 人声 / 伴奏）。两个旧 handler 保留：命令面板与冷启动对表
     * 各自只拨一个开关。这里专供界面那条三选一。
     *
     * ⚠️ 必须走**一次原子调用**（setVocalTrackMode），不能把一次切换拆成两条独立的
     * 桥命令：每条都会各自触发一次原生 reconcile，中间态会被当成真的意图去换源 ——
     * 切「全部」时先关伴奏的那一发里清唱还开着，播放器当场被换到清唱轨；两条命令
     * 在桥上再乱序一次就停在错轨。用户反馈的「切人声放的是全部、切全部放的是人声、
     * 有时切了不生效」正是这条路径。原生侧两个布尔一次落定、只 reconcile 一次。
     *
     * 旧包没有这个插件方法时降级到两个旧 setter，顺序刻意排成「先关掉不是目标的
     * 那一路，再开目标」，让降级路径也不会先闪一下清唱。
     */
    handleSetVocalMode: (mode) => {
        const cancel = mode === 'instrumental';
        const only = mode === 'vocal';
        setStoredBoolean(VOCAL_CANCEL_KEY, cancel);
        setStoredBoolean(VOCAL_ONLY_KEY, only);
        set({
            vocalCancelEnabled: cancel,
            vocalOnlyEnabled: only,
            // 打开任一路先按「正在准备」显示，命中缓存会立刻回 ready；全关则回 idle。
            vocalCancelState: (cancel || only) ? 'building' : 'idle',
            vocalCancelPercent: 0,
        });
        if (!isCapacitorAndroid()) return;
        // Promise.resolve().then 包一层：旧包的代理可能直接把「方法不存在」同步抛出来，
        // 不包这一层 .catch() 接不住，降级路径就断了。
        void Promise.resolve()
            .then(() => nativePlayer.setVocalTrackMode(mode))
            .catch(() => {
                void (async () => {
                    if (mode === 'off') {
                        await nativePlayer.setVocalOnlyEnabled(false).catch(() => undefined);
                        await nativePlayer.setVocalCancelEnabled(false).catch(() => undefined);
                    } else if (mode === 'vocal') {
                        await nativePlayer.setVocalCancelEnabled(false).catch(() => undefined);
                        await nativePlayer.setVocalOnlyEnabled(true).catch(() => undefined);
                    } else {
                        await nativePlayer.setVocalOnlyEnabled(false).catch(() => undefined);
                        await nativePlayer.setVocalCancelEnabled(true).catch(() => undefined);
                    }
                })();
            });
    },
    handleTogglePrebuildTracks: (enable) => {
        if (get().prebuildTracksEnabled === enable) return;
        setStoredBoolean(PREBUILD_TRACKS_KEY, enable);
        set({ prebuildTracksEnabled: enable });
        // 原生存一份：通知栏 / 锁屏先把播放拉起来时 WebView 还没起来，
        // 装源那条路得自己知道要不要预拆。失败不抛，下次启动对表会再推。
        if (!isCapacitorAndroid()) return;
        void nativePlayer.setPrebuildTracksEnabled(enable).catch(() => undefined);
    },
    handleSetVocalTrackMode: (mode) => {
        if (get().vocalTrackMode === mode) return;
        set({ vocalTrackMode: mode });
    },
    handleSetVocalCancelCache: (count, bytes, limit) => {
        const current = get();
        if (
            current.vocalCancelCachedCount === count
            && current.vocalCancelCacheBytes === bytes
            && current.vocalCancelCacheLimit === limit
        ) {
            return;
        }
        set({ vocalCancelCachedCount: count, vocalCancelCacheBytes: bytes, vocalCancelCacheLimit: limit });
    },
    handleSetVocalCancelStatus: (state, percent) => {
        const current = get();
        if (current.vocalCancelState === state && current.vocalCancelPercent === percent) return;
        set({ vocalCancelState: state, vocalCancelPercent: percent });
    },
    handleSetAudioOutputDeviceId: (deviceId) => {
        set({ audioOutputDeviceId: deviceId });
        if (typeof window === 'undefined') {
            return;
        }

        if (deviceId) {
            storageOrNull()?.setItem('audio_output_device_id', deviceId);
        } else {
            storageOrNull()?.removeItem('audio_output_device_id');
        }
    },
    handleSetAudioEqualizerSettings: (settings, origin = USER_ORIGIN) => (
        commitAudioEqualizerChange(get, set, resolveAudioEqualizerSettings(settings), null, origin)
    ),
    // The switch stops the processing and keeps every value, a mod's curve included.
    handleSetAudioEqualizerEnabled: (enabled, origin = USER_ORIGIN) => {
        const current = get();
        return commitAudioEqualizerChange(
            get,
            set,
            { ...current.audioEqualizerSettings, enabled },
            current.audioEqualizerModCurve,
            origin,
        );
    },
    // Applies a built-in sound preset or a saved custom slot, and turns processing on.
    handleApplyAudioSoundPreset: (modeId, options = {}) => {
        const next = planAudioSoundPreset(get().audioEqualizerSettings, modeId, { keepEnabled: options.keepEnabled });
        if (!next) {
            return false;
        }
        return commitAudioEqualizerChange(get, set, next, null, options.origin ?? COMMAND_ORIGIN);
    },
    // The listener's own settings stay as they are: the curve lies over them and is taken off again whole.
    handleApplyModEqualizerCurve: ({ modId, modName, gains }) => {
        const settings = get().audioEqualizerSettings;
        const curve: AudioEqualizerModCurve = {
            modId,
            modName,
            gains: normalizeAudioEqualizerModCurveGains(gains),
            base: { preset: settings.preset, gains: [...settings.gains], effects: { ...settings.effects } },
        };
        return commitAudioEqualizerChange(get, set, settings, curve, { kind: 'mod', modId });
    },
    handleReleaseModEqualizerCurve: (origin) => {
        const current = get();
        if (!current.audioEqualizerModCurve) {
            return false;
        }
        return commitAudioEqualizerChange(get, set, current.audioEqualizerSettings, null, origin);
    },
    handleSaveModEqualizerCurveToSlot: (slotId) => {
        const current = get();
        if (!current.audioEqualizerModCurve) {
            return false;
        }
        return commitAudioEqualizerChange(
            get,
            set,
            saveAudioEqualizerModCurveToSlot(current.audioEqualizerSettings, current.audioEqualizerModCurve, slotId),
            null,
            USER_ORIGIN,
        );
    },
    // Not saved: the host layer works it out again from the mod list at every start.
    handleSetAudioEqualizerModCurveSuspended: (suspended) => {
        const current = get();
        const next = current.audioEqualizerModCurve ? suspended : false;
        if (next === current.audioEqualizerModCurveSuspended) {
            return false;
        }
        set({ audioEqualizerModCurveSuspended: next, audioEqualizerChangeOrigin: HOST_ORIGIN });
        return true;
    },
    openAudioEqualizer: () => set({ isAudioEqualizerOpen: true }),
    closeAudioEqualizer: () => set({ isAudioEqualizerOpen: false }),
    handleSetVolume: (val) => {
        if (typeof window !== 'undefined') {
            storageOrNull()?.setItem('player_volume', String(val));
        }
        set({ volume: val });
    },
    // The toggles below delegate to these setters, so persistence and the toast live in one place
    // (Folium's playback.setMuted / setLoopMode call the setters directly).
    handleSetMuted: (muted) => {
        if (muted === get().isMuted) {
            return;
        }
        setStoredBoolean('player_is_muted', muted);
        set({ isMuted: muted });
    },
    handleToggleMute: () => {
        get().handleSetMuted(!get().isMuted);
    },
    handleSetLoopMode: (mode) => {
        if (mode === get().loopMode) {
            return;
        }
        if (typeof window !== 'undefined') {
            storageOrNull()?.setItem('player_loop_mode', mode);
        }
        set({ loopMode: mode });
        /*
         * 下发原生。**放完往哪走是原生按这个决定的**（NativePlayQueue 的 loopMode/shuffle），
         * 不下发的话原生永远按默认的「顺序」行事 —— 用户在界面里切成列表循环/单曲循环/
         * 随机，后台放完一首就停，切回来才发现没接着放。
         *
         * 随机在 Web 这边是一个独立的模式值（'shuffle'），在原生那边是「列表循环 + 随机
         * 标志」两个东西 —— 换算在这里做一次，别让原生猜 Web 的枚举。
         */
        void writeNativeLoopMode(
            mode === 'shuffle' ? 'all' : mode,
            mode === 'shuffle' ? true : false,
        );
        const loopModeKey = mode === 'off'
            ? 'loopOff'
            : mode === 'one'
                ? 'loopOne'
                : mode === 'shuffle'
                    ? 'loopShuffle'
                    : 'loopAll';
        setStatusMessage({
            type: 'success',
            text: i18n.t(`player.${loopModeKey}`),
            nonce: Date.now(),
        });
    },
    handleToggleLoopMode: () => {
        // 顺序（off）→ 列表循环（all）→ 单曲循环（one）→ 随机播放（shuffle）→ 回到顺序。
        // 随机放在最后：它是这一圈里唯一的「会把队列重排一遍」的模式，挨着顺序放容易误触。
        const prev = get().loopMode;
        const next = prev === 'off'
            ? 'all'
            : prev === 'all'
                ? 'one'
                : prev === 'one'
                    ? 'shuffle'
                    : 'off';
        get().handleSetLoopMode(next);
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
    autoPlayOnLaunch: state.autoPlayOnLaunch,
    autoJumpToVisualizerOnLaunch: state.autoJumpToVisualizerOnLaunch,
    enableTranscodeFallback: state.enableTranscodeFallback,
    neteaseScrobbleEnabled: state.neteaseScrobbleEnabled,
    playbackFadeEnabled: state.playbackFadeEnabled,
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
    handleToggleAutoPlayOnLaunch: state.handleToggleAutoPlayOnLaunch,
    handleToggleAutoJumpToVisualizerOnLaunch: state.handleToggleAutoJumpToVisualizerOnLaunch,
    handleToggleTranscodeFallback: state.handleToggleTranscodeFallback,
    handleToggleNeteaseScrobble: state.handleToggleNeteaseScrobble,
    handleTogglePlaybackFade: state.handleTogglePlaybackFade,
    handleSetPlaybackSpeed: state.handleSetPlaybackSpeed,
    handleSetPlaybackPitch: state.handleSetPlaybackPitch,
    handleSetAudioOutputDeviceId: state.handleSetAudioOutputDeviceId,
    handleSetAudioEqualizerSettings: state.handleSetAudioEqualizerSettings,
    handleApplyAudioSoundPreset: state.handleApplyAudioSoundPreset,
    openAudioEqualizer: state.openAudioEqualizer,
    closeAudioEqualizer: state.closeAudioEqualizer,
    handleSetVolume: state.handleSetVolume,
    handleToggleMute: state.handleToggleMute,
    handleToggleLoopMode: state.handleToggleLoopMode,
});

// Module-level handles for the assembly layer; actions need no subscription, so importing them
// where they are used keeps App.tsx out of the chain (see setStatusMessage).
export const handleSetVolume = (val: number) => useAudioSettingsStore.getState().handleSetVolume(val);
export const handleToggleMute = () => useAudioSettingsStore.getState().handleToggleMute();
export const setAudioQuality = (quality: AudioQuality) => useAudioSettingsStore.getState().setAudioQuality(quality);
