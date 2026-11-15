import { Capacitor } from '@capacitor/core';
import { nativePlayer, type NativeAudioPipelineDiagnostics } from './playbackEngine/nativePlayerPlugin';

// src/services/audioPipelineDiagnostics.ts
//
// 原生音频链路的读数（P0 基线）。原生侧的采集在
// android/.../player/dsp/AudioPipelineTelemetry.kt，这里只负责取数与两次采样之间的增量。
//
// 为什么要有增量：快照里 `cpuMs` / `positionTicks` 都是**进程启动以来的累计值**，单看没有
// 意义。两次快照相减再除以墙钟时间，才得到「这一段时间里 CPU 占了多少」「位置轮询实际
// 跑了几赫兹」—— 后面每一项优化的收益都要跟这两个数比。
//
// 只在原生 Android 上可用：Web / Electron 没有这个插件，返回 null，调用方画 n/a。

export type AudioPipelineReading = NativeAudioPipelineDiagnostics & {
    /** 这一次读数的时间戳（ms）。 */
    sampledAt: number;
    /**
     * 两次采样之间的进程 CPU 占用，相对**单核**的百分比。
     * 多线程跑满会超过 100；第一次采样为 null。
     */
    cpuPercent: number | null;
    /** 两次采样之间位置轮询的实际频率（Hz）。设计值是 4Hz（250ms 一拍）。 */
    positionTickHz: number | null;
};

let lastRaw: NativeAudioPipelineDiagnostics | null = null;
let lastRawAt = 0;
let lastReading: AudioPipelineReading | null = null;
let lastReadingAt = 0;
let inflight: Promise<AudioPipelineReading | null> | null = null;

/** 面板每秒刷新一次，桥只有一条 —— 1.5s 内重复调用直接吃缓存。 */
const CACHE_MS = 1500;

const read = async (): Promise<AudioPipelineReading | null> => {
    const now = Date.now();
    try {
        const raw = await nativePlayer.getAudioPipelineDiagnostics();
        const cpuPercent = lastRaw && lastRawAt > 0 && now > lastRawAt
            ? ((raw.cpuMs - lastRaw.cpuMs) / (now - lastRawAt)) * 100
            : null;
        const positionTickHz = lastRaw && lastRawAt > 0 && now > lastRawAt
            ? (raw.positionTicks - lastRaw.positionTicks) / ((now - lastRawAt) / 1000)
            : null;

        lastRaw = raw;
        lastRawAt = now;
        lastReading = {
            ...raw,
            sampledAt: now,
            cpuPercent: cpuPercent !== null && Number.isFinite(cpuPercent) ? Math.max(0, cpuPercent) : null,
            positionTickHz: positionTickHz !== null && Number.isFinite(positionTickHz) ? Math.max(0, positionTickHz) : null,
        };
        lastReadingAt = now;
        return lastReading;
    } catch {
        // 桥在重建 / 插件刚销毁：给上一次读数，比让面板闪成 n/a 有用。
        return lastReading;
    }
};

/**
 * 读一次原生音频链路快照；平台不支持或还没播过时返回 null / 上一次结果。
 *
 * 并发调用会合并到同一个 Promise：面板刷新与手动点击可能同时来，没必要占两次桥。
 */
export const readAudioPipelineDiagnostics = async (): Promise<AudioPipelineReading | null> => {
    if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('FoliaNativePlayer')) return null;
    if (lastReading && Date.now() - lastReadingAt < CACHE_MS) return lastReading;
    if (inflight) return inflight;
    inflight = read().finally(() => {
        inflight = null;
    });
    return inflight;
};

/** 这次会话有没有读到过原生数据（面板据此决定要不要画这一块）。 */
export const hasAudioPipelineReading = (): boolean => lastReading !== null;
