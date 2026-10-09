// src/utils/mediaDiagnostics.ts
//
// 播放侧的停顿现场。「歌卡一下」有两种完全不同的成因：取不到数据（网络/上游）与解码跟不上，
// 再加上我们自己改过播放位置或速率的情况 —— 三种在日志里长得一模一样，没有计数就分不开。
//
// 只记录可公开的形态：次数、时长、缓冲量、readyState / networkState。不记录音频地址、账号或凭据。

export type AudioEventKind =
    | 'waiting'
    | 'canplay'
    | 'playing'
    | 'stalled'
    | 'error'
    | 'seeking'
    | 'seeked'
    | 'ratechange'
    | 'pause'
    | 'ended';

export type MediaDiagnosticsSnapshot = {
    waitingCount: number;
    waitingTotalMs: number;
    waitingMaxMs: number;
    lastWaitingMs: number | null;
    stalledCount: number;
    errorCount: number;
    seekingCount: number;
    seekedCount: number;
    rateChangeCount: number;
    playbackRate: number | null;
    bufferedAheadSec: number | null;
    bufferedRanges: number;
    readyState: number | null;
    networkState: number | null;
    lastEvent: AudioEventKind | null;
    lastEventAt: string | null;
    /** 正在等待（waiting 已开始、还没等到 canplay/playing）时为 true。 */
    waitingNow: boolean;
};

import { usePerfDiagnosticsStore } from '../stores/usePerfDiagnosticsStore';

let waitingCount = 0;
let waitingTotalMs = 0;
let waitingMaxMs = 0;
let lastWaitingMs: number | null = null;
let waitingSinceMs: number | null = null;
let stalledCount = 0;
let errorCount = 0;
let seekingCount = 0;
let seekedCount = 0;
let rateChangeCount = 0;
let lastEvent: AudioEventKind | null = null;
let lastEventAt: string | null = null;

const nowMs = (): number => (
    typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now()
);

/** 最近一次读到过状态的那个音频元素，缓冲量与网络状态从它身上读。 */
let trackedElement: HTMLAudioElement | null = null;

const settleWaiting = (): void => {
    if (waitingSinceMs === null) return;
    const durationMs = nowMs() - waitingSinceMs;
    waitingSinceMs = null;
    waitingCount += 1;
    waitingTotalMs += durationMs;
    lastWaitingMs = durationMs;
    if (durationMs > waitingMaxMs) waitingMaxMs = durationMs;
};

export const noteAudioEvent = (
    kind: AudioEventKind,
    element?: HTMLAudioElement | null,
): void => {
    // 跟「性能采样」同一个开关（开发者选项）。默认关：这些计数只服务于排查，
    // 不应该在每个用户的每次播放事件上跑。
    if (!usePerfDiagnosticsStore.getState().perfDiagnosticsEnabled) return;
    if (element) trackedElement = element;
    lastEvent = kind;
    lastEventAt = new Date().toISOString();

    if (kind === 'waiting') {
        // 已经在等的时候再来一次 waiting 只更新起点，不重复计数。
        if (waitingSinceMs === null) waitingSinceMs = nowMs();
        return;
    }
    // 等到数据了就结算这一次 waiting；seeked 同样收尾（跳转引起的等待不算网络问题，
    // 但仍要把计时收掉，否则下一次 waiting 会把它一起算进去）。
    if (kind === 'seeked') {
        seekedCount += 1;
        settleWaiting();
        return;
    }
    if (kind === 'canplay' || kind === 'playing') {
        settleWaiting();
        return;
    }
    if (kind === 'stalled') stalledCount += 1;
    else if (kind === 'error') errorCount += 1;
    else if (kind === 'seeking') seekingCount += 1;
    else if (kind === 'ratechange') rateChangeCount += 1;
};

export const readMediaDiagnostics = (): MediaDiagnosticsSnapshot => {
    const element = trackedElement;
    let bufferedAheadSec: number | null = null;
    let bufferedRanges = 0;
    if (element) {
        try {
            const buffered = element.buffered;
            bufferedRanges = buffered ? buffered.length : 0;
            const currentTime = Number(element.currentTime);
            if (buffered && bufferedRanges > 0 && Number.isFinite(currentTime)) {
                let ahead = 0;
                for (let index = 0; index < bufferedRanges; index += 1) {
                    const end = buffered.end(index);
                    const start = buffered.start(index);
                    if (currentTime >= start && currentTime <= end) {
                        ahead = Math.max(ahead, end - currentTime);
                    }
                }
                bufferedAheadSec = ahead;
            }
        } catch {
            // 元素已经换歌或释放，读不到就算了。
        }
    }
    return {
        waitingCount,
        waitingTotalMs,
        waitingMaxMs,
        lastWaitingMs,
        stalledCount,
        errorCount,
        seekingCount,
        seekedCount,
        rateChangeCount,
        playbackRate: element && Number.isFinite(element.playbackRate) ? element.playbackRate : null,
        bufferedAheadSec,
        bufferedRanges,
        readyState: element ? element.readyState : null,
        networkState: element ? element.networkState : null,
        lastEvent,
        lastEventAt,
        waitingNow: waitingSinceMs !== null,
    };
};

/** 换歌时复位：上一首的停顿不该算到这一首头上。 */
export const resetMediaDiagnostics = (): void => {
    waitingCount = 0;
    waitingTotalMs = 0;
    waitingMaxMs = 0;
    lastWaitingMs = null;
    waitingSinceMs = null;
    stalledCount = 0;
    errorCount = 0;
    seekingCount = 0;
    seekedCount = 0;
    rateChangeCount = 0;
    lastEvent = null;
    lastEventAt = null;
};
