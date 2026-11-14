import { isNativePlayerAvailable, nativePlayer, type NativeEqualizerSettings } from './nativePlayerPlugin';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { useAudioConsoleStore } from '../../stores/useAudioConsoleStore';
import { resolveHeardAudioEqualizerSettings } from '../../utils/audioEqualizerModCurve';
import {
    AUDIO_CONSOLE_COMPRESSOR_BANDS,
    AUDIO_CONSOLE_REVERB_PRESETS,
    type AudioConsoleReverbPreset,
} from '../../utils/audioConsole';

// src/services/playbackEngine/nativeEqualizer.ts
// 把 Web 侧的听感设置（含 mod 曲线）推给**原生播放内核**。
//
// 为什么需要这条线：安卓上出声的是 ExoPlayer，Web Audio 图不在信号路径上
// （见 nativePlaybackEngine 的文件头）。界面上拖滑杆只改了 localStorage 与那张图，
// 原生那边收不到 —— 用户听到的就是「EQ 没反应」。
//
// 推的是一整份「调音台」：十段增益、曲线形状（GEQ/PEQ）、总增益、多段压缩、后置均衡、混响。
// 分两条 store（增益在 useAudioSettingsStore，其余在 useAudioConsoleStore），
// 到原生那边合成一份设置 —— 原生只认「一次推一份」，这样音频线程每个块只读一个 volatile。
//
// 纪律（与 settings 推送同一套）：
//   · 只推变化，不轮询：Capacitor 的桥只有一条，拖滑杆时高频推送会跟批量拉取抢通道；
//   · 40 ms 合并：一次拖动可能触发几十次 store 更新，合并成一条；
//   · 失败重试 20 次（冷启动时桥可能还没就绪），失败不阻塞界面。

const NATIVE_EQUALIZER_PROTOCOL_VERSION = 2;

/** 与 Web 的 EQUALIZER_TIME_CONSTANT_SECONDS / MOD_EQUALIZER_GLIDE_SECONDS 对齐。 */
const USER_GLIDE_MS = 15;
const MOD_GLIDE_MS = 250;

/** 一次拖动滑杆会连着改几十次设置，合并到这个窗口里只推一条。 */
const PUSH_COALESCE_MS = 40;
const RETRY_DELAY_MS = 500;
const MAX_RETRIES = 20;

/** 预设名 → 原生协议里的编号（见 EqSettings.kt 的 ReverbPreset）。 */
const REVERB_PRESET_INDEX: Record<AudioConsoleReverbPreset, number> = {
    factory: 0,
    hall: 1,
    cathedral: 2,
    plate: 3,
};

let started = false;
let startAttempts = 0;
let pushAttempts = 0;
let lastSignature = '';
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 推送是串行的，且「最后一次状态」一定会送到。
 *
 * 为什么必须串行：Capacitor 的调用虽然是顺序投递的，但 `await` 返回的顺序不保证。
 * 拖滑杆时 40 ms 就会推一条，两条同时在途时，先发的可能后到 —— 原生最终停在旧值上，
 * 用户看到的是「滑杆拉到 6，声音还是 3，再动一下才跟上」。这类错位要等下一次变更
 * 才会自愈，正是「调音器短时失效」的观感来源。
 *
 * `pushing` 期间来的新状态只置一个 dirty 标记，等这一趟回来立刻再推一次，
 * 所以中间被合并掉的只是过期状态，不会丢掉最终状态。
 */
let pushing = false;
let dirty = false;

const buildSettings = (): NativeEqualizerSettings => {
    const state = useAudioSettingsStore.getState();
    const console_ = useAudioConsoleStore.getState().settings;
    // 必须用「实际听到的那一份」：mod 曲线叠在用户设置之上，直接用 audioEqualizerSettings
    // 会让 mod 曲线在原生下失效（Web 侧同样是在音频桥里解析的）。
    const heard = resolveHeardAudioEqualizerSettings(
        state.audioEqualizerSettings,
        state.audioEqualizerModCurve,
        state.audioEqualizerModCurveSuspended,
    );
    const isModCurve = state.audioEqualizerChangeOrigin.kind === 'mod'
        && !state.audioEqualizerModCurveSuspended;
    return {
        version: NATIVE_EQUALIZER_PROTOCOL_VERSION,
        enabled: heard.enabled,
        gains: [...heard.gains],
        eq: {
            mode: console_.frontEq.curve,
            q: console_.frontEq.q,
            globalGainDb: console_.frontEq.globalGainDb,
        },
        // 只发两颗滤波器。punch 与 space 是 v1 的遗留字段：压缩页与混响页已经各自接管，
        // 再发一次等于让预设在一个看不见的地方开第二台压缩器、或者让「混响关着」也响。
        effects: {
            highpass: heard.effects.highpass,
            lowpass: heard.effects.lowpass,
        },
        reverb: {
            enabled: console_.reverb.enabled,
            preset: REVERB_PRESET_INDEX[console_.reverb.preset] ?? 0,
            rt60: console_.reverb.rt60,
            roomLevelDb: console_.reverb.roomLevelDb,
            damping: console_.reverb.damping,
            preDelayMs: console_.reverb.preDelayMs,
            mix: console_.reverb.mix,
            tailOnPause: console_.reverb.tailOnPause,
        },
        compressor: {
            enabled: console_.compressor.enabled,
            bandCount: console_.compressor.bandCount,
            profile: console_.compressor.profile === 'flat' ? 1 : 0,
            // 三级分频点原样发过去：越界的值由原生侧再夹一次（手改过的存档也进不来）。
            crossovers: [...console_.compressor.crossovers],
            // 固定发四段：2 频段模式下原生只读前两段，第三、四段留着，
            // 用户来回切 2/4 段时参数不会丢。
            bands: AUDIO_CONSOLE_COMPRESSOR_BANDS.map(id => {
                const band = console_.compressor.bands[id];
                return {
                    enabled: band.enabled,
                    thresholdDb: band.thresholdDb,
                    ratio: band.ratio,
                    attackMs: band.attackMs,
                    releaseMs: band.releaseMs,
                    makeupDb: band.makeupDb,
                    kneeDb: band.kneeDb,
                    mix: band.mix,
                };
            }),
        },
        postEq: {
            enabled: console_.postEq.enabled,
            gains: [...console_.postEq.gains],
            mode: console_.postEq.curve,
            q: console_.postEq.q,
            globalGainDb: console_.postEq.globalGainDb,
        },
        stereo: {
            enabled: console_.stereo.enabled,
            width: console_.stereo.width,
            bassMonoHz: console_.stereo.bassMonoHz,
        },
        saturation: {
            enabled: console_.saturation.enabled,
            mode: console_.saturation.mode,
            driveDb: console_.saturation.driveDb,
            mix: console_.saturation.mix,
            outputDb: console_.saturation.outputDb,
        },
        limiter: {
            ceilingDb: console_.limiter.ceilingDb,
            releaseMs: console_.limiter.releaseMs,
        },
        glideMs: isModCurve ? MOD_GLIDE_MS : USER_GLIDE_MS,
    };
};

const schedulePush = (): void => {
    if (pushTimer !== null) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
        pushTimer = null;
        void pushNativeEqualizer(false);
    }, PUSH_COALESCE_MS);
};

const scheduleRetry = (): void => {
    if (retryTimer !== null) return;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        void pushNativeEqualizer(true);
    }, RETRY_DELAY_MS);
};

/**
 * 把还在合并窗口里的那条立刻发出去。
 *
 * WebView 切到后台时会把 `setTimeout` 节流到秒级、甚至整个暂停：用户拖完滑杆马上锁屏，
 * 那条 40 ms 的定时器可能要几十秒后才跑，回来听到的还是旧声音 —— 这也是「短时失效」的
 * 一种。页面要隐藏时不再等合并窗口，直接推。
 */
const flushScheduledPush = (): void => {
    if (pushTimer !== null) {
        clearTimeout(pushTimer);
        pushTimer = null;
    }
    void pushNativeEqualizer(false);
};

/**
 * 推一次。`force` 用于启动同步与重试：这两处即使签名没变也要发。
 *
 * 失败不抛：调用方是 store 订阅，抛出去只会变成一条未处理的 rejection。
 */
export const pushNativeEqualizer = async (force = false): Promise<void> => {
    if (!started || !isNativePlayerAvailable()) return;

    // 已经有推送在途：只登记「还有新状态」，由在途那一趟收尾时补发。
    if (pushing) {
        dirty = true;
        return;
    }

    pushing = true;
    try {
        let mustSend = true;
        while (mustSend) {
            dirty = false;
            const settings = buildSettings();
            const signature = JSON.stringify(settings);
            if (!force && signature === lastSignature) break;
            force = false;
            await nativePlayer.setEqualizer(settings);
            lastSignature = signature;
            pushAttempts = 0;
            // 这一趟在途时用户又拖了滑杆：立刻用最新状态再推一次，直到追上为止。
            mustSend = dirty;
        }
    } catch (error) {
        // 清掉签名，下一次（或重试）照旧会推。
        lastSignature = '';
        pushAttempts += 1;
        if (pushAttempts <= MAX_RETRIES) scheduleRetry();
        console.warn('[NativeEQ] 推送调音台设置失败，稍后重试', error);
    } finally {
        pushing = false;
        // 失败与并发之间可能夹着一个没送出去的状态：补一次，别把它留在 dirty 里。
        if (dirty) {
            dirty = false;
            schedulePush();
        }
    }
};

/**
 * 启动同步。在 useAppFoundation 里调用一次。
 *
 * 桥可能比 React 挂载晚一点就绪（冷启动），所以这里自己重试；成功之后订阅两条 store，
 * 之后每次听感变化都只推差异。
 */
export const startNativeEqualizerSync = (): void => {
    if (started) return;
    if (!isNativePlayerAvailable()) {
        if (startAttempts >= MAX_RETRIES) return;
        startAttempts += 1;
        setTimeout(startNativeEqualizerSync, RETRY_DELAY_MS);
        return;
    }
    started = true;
    // 启动时对一次表：WebView 上次退出前进原生可能没收到最后一条。
    void pushNativeEqualizer(true);
    useAudioSettingsStore.subscribe((state, previous) => {
        if (state.audioEqualizerSettings === previous.audioEqualizerSettings
            && state.audioEqualizerModCurve === previous.audioEqualizerModCurve
            && state.audioEqualizerModCurveSuspended === previous.audioEqualizerModCurveSuspended
            && state.audioEqualizerChangeOrigin === previous.audioEqualizerChangeOrigin) {
            return;
        }
        schedulePush();
    });
    useAudioConsoleStore.subscribe((state, previous) => {
        if (state.settings === previous.settings) return;
        schedulePush();
    });

    // 页面隐藏 / 卸载前不再等合并窗口：后台的定时器不可信（见 flushScheduledPush）。
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flushScheduledPush();
        });
        window.addEventListener('pagehide', flushScheduledPush);
    }
};

/** 诊断用：问一次原生此刻在跑什么（不轮询）。 */
export const readNativeEqualizerState = () => nativePlayer.getEqualizerState();
