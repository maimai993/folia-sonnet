// src/utils/frameRateLimiter.ts
// Shared helpers and global RAF gate for optional visualizer frame throttling.

import type { VisualizerFrameRate } from '../types';
import { isAndroidAppShell } from '../platform/runtime';

type AnimationFrameCallback = FrameRequestCallback;
type RequestAnimationFrameFn = (callback: AnimationFrameCallback) => number;
type CancelAnimationFrameFn = (handle: number) => void;

type FrameRateLimitedRaf = {
    requestAnimationFrame: RequestAnimationFrameFn;
    cancelAnimationFrame: CancelAnimationFrameFn;
    setFrameRate: (frameRate: VisualizerFrameRate) => void;
    getFrameRate: () => VisualizerFrameRate;
};

type WindowWithVisualizerFrameRateLimiter = Window & {
    __foliaNativeRequestAnimationFrame?: RequestAnimationFrameFn;
    __foliaNativeCancelAnimationFrame?: CancelAnimationFrameFn;
};

// 30 那一档是给「画不动」的设备留的：播放页的可视化常常同时有两三个全屏 WebGL 上下文，
// 手机 WebView 上单帧就要二三十毫秒，这时候只有真的把每秒帧数压下来才看得出流畅，
// 60 档在高刷屏上还是嫌多。
export const VISUALIZER_FRAME_RATE_OPTIONS = [30, 60, 90, 120] as const satisfies VisualizerFrameRate[];
export const VISUALIZER_FRAME_RATE_STORAGE_KEY = 'visualizer_frame_rate';
const FRAME_INTERVAL_TOLERANCE_MS = 1;

export const isVisualizerFrameRate = (value: unknown): value is VisualizerFrameRate => (
    value === 'off'
    || value === 120
    || value === 90
    || value === 60
    || value === 30
);

export const parseVisualizerFrameRate = (value: string | null): VisualizerFrameRate => {
    if (value === 'off' || value === 'auto' || value === null) {
        return 'off';
    }

    const parsed = Number(value);
    return isVisualizerFrameRate(parsed) ? parsed : 'off';
};

/**
 * 手机上的默认帧率上限。
 *
 * 桌面（Electron / 浏览器）默认「不限」是对的：那台机器有余量，120Hz 屏上跑满才顺。
 * 手机是另一回事 —— 高分屏、播放页常常同时有两三个全屏 WebGL 上下文，单帧二三十毫秒，
 * 「不限」等于一直占满一个核去画肉眼分不出来的帧。真机读数里播放页 76% 的 CPU 中，
 * 音频处理器只占 2%，剩下的几乎都是这里。
 *
 * 60 而不是 30：60 在手机上是「跟手」的下限，再低歌词滚动就能看出台阶。
 */
const MOBILE_DEFAULT_FRAME_RATE: VisualizerFrameRate = 60;

/**
 * 启动时定帧率档位：**只在没存过**的时候给平台默认。
 *
 * 用户自己在「性能与动效」里选过（包括选「不限」）一律照用户 —— 这一条很重要，
 * 否则升级一次就把人手动关掉的限制又打开了。
 *
 * 启动装限帧器与读设置 store 两处都要用同一个判据，所以放在这里，
 * 不让两边各写一份「null 该怎么办」。
 */
export const resolveInitialVisualizerFrameRate = (stored: string | null): VisualizerFrameRate => {
    if (stored === null) {
        return isAndroidAppShell() ? MOBILE_DEFAULT_FRAME_RATE : 'off';
    }
    return parseVisualizerFrameRate(stored);
};

/**
 * Decides whether a RAF tick should run under the configured FPS cap.
 *
 * 判定对象是**下一帧被允许的时刻**，不是「上次放行的实际时刻」：
 *
 * 拿上次放行的实际时刻 + 一个间隔来判，在 120Hz 屏上选 90 档会塌到 60fps —— 帧间隔 8.33ms，
 * 而阈值是 1000/90-1 = 10.11ms，于是必须攒满两帧（16.67ms）才够，档位被压成屏幕刷新率的
 * 整数分之一。累积推进下一允许时刻才会得到「四帧放行三帧」这种接近 90fps 的节奏。
 *
 * `nextAllowedTimestampMs` 为 0 表示还没放行过任何帧（首帧、刚改过档位、或掉帧后重新锚定）。
 */
export const shouldProcessFrameAtRate = (
    timestampMs: number,
    nextAllowedTimestampMs: number,
    frameRate: VisualizerFrameRate,
) => {
    if (frameRate === 'off' || nextAllowedTimestampMs === 0) {
        return true;
    }

    return timestampMs + FRAME_INTERVAL_TOLERANCE_MS >= nextAllowedTimestampMs;
};

/** 一帧被放行后，下一帧最早允许的时刻。落后超过一个间隔就重新锚定，不追赶欠的帧。 */
export const nextAllowedFrameTimestamp = (
    timestampMs: number,
    previousAllowedTimestampMs: number,
    frameRate: VisualizerFrameRate,
): number => {
    if (frameRate === 'off') {
        return 0;
    }

    const intervalMs = 1000 / frameRate;
    if (previousAllowedTimestampMs === 0 || timestampMs >= previousAllowedTimestampMs + intervalMs) {
        return timestampMs + intervalMs;
    }

    return previousAllowedTimestampMs + intervalMs;
};

const reportAnimationFrameCallbackError = (error: unknown) => {
    console.error('Error in requestAnimationFrame callback:', error);
    setTimeout(() => {
        throw error;
    }, 0);
};

// Creates a shared RAF queue so every callback scheduled for an allowed frame flushes together.
export const createFrameRateLimitedRaf = (
    nativeRequestAnimationFrame: RequestAnimationFrameFn,
    nativeCancelAnimationFrame: CancelAnimationFrameFn,
    initialFrameRate: VisualizerFrameRate = 60,
): FrameRateLimitedRaf => {
    let frameRate = initialFrameRate;
    let nextHandle = 1;
    let nativeFrameHandle: number | null = null;
    /** 下一帧被允许的时刻；0 = 还没放行过（首帧 / 刚改档位 / 掉帧后重锚）。 */
    let nextAllowedTimestamp = 0;
    const callbacks = new Map<number, AnimationFrameCallback>();

    const scheduleNativeFrame = () => {
        if (nativeFrameHandle !== null || callbacks.size === 0) {
            return;
        }

        nativeFrameHandle = nativeRequestAnimationFrame(processNativeFrame);
    };

    const processNativeFrame = (timestamp: number) => {
        nativeFrameHandle = null;

        if (!shouldProcessFrameAtRate(timestamp, nextAllowedTimestamp, frameRate)) {
            scheduleNativeFrame();
            return;
        }

        nextAllowedTimestamp = nextAllowedFrameTimestamp(timestamp, nextAllowedTimestamp, frameRate);
        const frameHandles = Array.from(callbacks.keys());

        for (const handle of frameHandles) {
            // Match native RAF: an earlier callback may cancel a later one in the same frame.
            const callback = callbacks.get(handle);
            if (!callback) continue;
            callbacks.delete(handle);
            try {
                callback(timestamp);
            } catch (error) {
                reportAnimationFrameCallbackError(error);
            }
        }

        scheduleNativeFrame();
    };

    return {
        requestAnimationFrame: (callback) => {
            const handle = nextHandle;
            nextHandle += 1;
            callbacks.set(handle, callback);
            scheduleNativeFrame();
            return handle;
        },
        cancelAnimationFrame: (handle) => {
            callbacks.delete(handle);
            if (callbacks.size === 0 && nativeFrameHandle !== null) {
                nativeCancelAnimationFrame(nativeFrameHandle);
                nativeFrameHandle = null;
            }
        },
        setFrameRate: (nextFrameRate) => {
            frameRate = nextFrameRate;
            nextAllowedTimestamp = 0;

            if (nativeFrameHandle !== null) {
                nativeCancelAnimationFrame(nativeFrameHandle);
                nativeFrameHandle = null;
            }
            scheduleNativeFrame();
        },
        getFrameRate: () => frameRate,
    };
};

let installedLimiter: FrameRateLimitedRaf | null = null;

export const setGlobalVisualizerFrameRate = (frameRate: VisualizerFrameRate) => {
    if (typeof window === 'undefined') {
        return;
    }

    if (frameRate === 'off') {
        restoreGlobalVisualizerFrameRateLimiter();
        return;
    }

    if (!installedLimiter) {
        installGlobalVisualizerFrameRateLimiter(frameRate);
        return;
    }

    installedLimiter.setFrameRate(frameRate);
};

// Asks for the display's next frame, past the cap. For work that has to land in the same frame as
// something the cap does not hold back: a library that took `requestAnimationFrame` before the cap
// was switched on (framer-motion does, when its module loads) keeps running on every display frame.
export const requestUncappedAnimationFrame = (callback: AnimationFrameCallback): number => {
    const frameWindow = window as WindowWithVisualizerFrameRateLimiter;
    return (frameWindow.__foliaNativeRequestAnimationFrame ?? window.requestAnimationFrame).call(window, callback);
};

// Cancels a frame asked for with `requestUncappedAnimationFrame`.
export const cancelUncappedAnimationFrame = (handle: number) => {
    const frameWindow = window as WindowWithVisualizerFrameRateLimiter;
    (frameWindow.__foliaNativeCancelAnimationFrame ?? window.cancelAnimationFrame).call(window, handle);
};

export const restoreGlobalVisualizerFrameRateLimiter = () => {
    if (typeof window === 'undefined') {
        return;
    }

    const frameWindow = window as WindowWithVisualizerFrameRateLimiter;
    if (frameWindow.__foliaNativeRequestAnimationFrame) {
        window.requestAnimationFrame = frameWindow.__foliaNativeRequestAnimationFrame;
    }
    if (frameWindow.__foliaNativeCancelAnimationFrame) {
        window.cancelAnimationFrame = frameWindow.__foliaNativeCancelAnimationFrame;
    }
    installedLimiter = null;
};

export const installGlobalVisualizerFrameRateLimiter = (overrideFrameRate?: VisualizerFrameRate) => {
    if (typeof window === 'undefined') {
        return;
    }

    const initialFrameRate = overrideFrameRate
        ?? resolveInitialVisualizerFrameRate(window.localStorage.getItem(VISUALIZER_FRAME_RATE_STORAGE_KEY));
    if (initialFrameRate === 'off') {
        restoreGlobalVisualizerFrameRateLimiter();
        return;
    }

    if (installedLimiter) {
        installedLimiter.setFrameRate(initialFrameRate);
        return;
    }

    const frameWindow = window as WindowWithVisualizerFrameRateLimiter;
    frameWindow.__foliaNativeRequestAnimationFrame ??= window.requestAnimationFrame;
    frameWindow.__foliaNativeCancelAnimationFrame ??= window.cancelAnimationFrame;
    const nativeRequestAnimationFrame: RequestAnimationFrameFn = (callback) => (
        frameWindow.__foliaNativeRequestAnimationFrame?.call(window, callback) ?? 0
    );
    const nativeCancelAnimationFrame: CancelAnimationFrameFn = (handle) => {
        frameWindow.__foliaNativeCancelAnimationFrame?.call(window, handle);
    };
    installedLimiter = createFrameRateLimitedRaf(nativeRequestAnimationFrame, nativeCancelAnimationFrame, initialFrameRate);

    window.requestAnimationFrame = installedLimiter.requestAnimationFrame;
    window.cancelAnimationFrame = installedLimiter.cancelAnimationFrame;
};
