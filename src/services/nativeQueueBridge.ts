// src/services/nativeQueueBridge.ts
// 原生播放队列的读写口。**播放链路的真相在原生**（NativePlayQueue + FoliaPlaybackService），
// 前台只下发意图、订阅状态。
//
// 分工：
//   · 前台 → 原生：播这个队列、切到第几首、设循环模式。发完就不管了。
//   · 原生 → 前台：整份状态（队列、下标、循环模式、位置、是否在播）。变了就推。
//
// 前台**不判断**「放完了该播哪首」「这次该不该换歌词」「要不要重试」—— 那些现在都在
// 原生。前台被系统冻结时这些照样发生，它回来时拉一次快照就能把界面摆正。
//
// 唯一的例外是渲染：歌词与主题要按当前曲目重新拉，因为那是界面的事（原生给的是
// songKey，怎么画由前台决定）。

import { registerPlugin } from '@capacitor/core';
import { isCapacitorAndroid } from '../platform/runtime';
import type { NativePlaybackSnapshot } from './playbackEngine/nativePlayerPlugin';

export type NativeLoopMode = 'off' | 'all' | 'one';

export type NativeQueueEntry = {
    songKey: string;
    providerId: string;
    songId: string;
    mid: string;
    hash: string;
    albumAudioId: string;
    url: string;
    title: string;
    artist: string;
    album: string;
    coverUrl: string;
    durationSec: number;
};

/** 原生推上来的整份状态。`revision` 变了代表队列内容或下标动过。 */
export type NativeQueueState = {
    entries: NativeQueueEntry[];
    index: number;
    size: number;
    loopMode: NativeLoopMode;
    shuffle: boolean;
    revision: number;
    hasSong: boolean;
    songKey: string;
    title: string;
    artist: string;
    album: string;
    durationMs: number;
    positionMs: number;
    playing: boolean;
    liked: boolean;
    canLike: boolean;
    providerId: string;
    serverSongId: string;
    artworkUrl: string;
    nativeMedia?: NativePlaybackSnapshot & { url: string; speed?: number };
    lyrics?: { songKey: string; lrc: string; translated: string };
};

type NativeQueuePlugin = {
    getQueueState: () => Promise<NativeQueueState>;
    setLoopMode: (options: { mode?: string; shuffle?: boolean }) => Promise<Record<string, unknown>>;
    setQueueMirror: (options: { queueJson?: string; index?: number }) => Promise<void>;
};

const nativeQueuePlugin = registerPlugin<NativeQueuePlugin>('FoliaPlayback');
const plugin = (): NativeQueuePlugin | null => isCapacitorAndroid() ? nativeQueuePlugin : null;

/** 拉一次完整状态。非安卓返回 null，调用方按既有（Web 全流程）路径走。 */
export const readNativeQueueState = async (): Promise<NativeQueueState | null> => {
    const api = plugin();
    if (!api) return null;
    try {
        return await api.getQueueState();
    } catch (error) {
        console.warn('[nativeQueue] 读取队列状态失败', error);
        return null;
    }
};

/**
 * 下发循环模式。**原生会落盘并在之后自己按它行事** —— 不需要每次切歌都重发，
 * 也不需要前台在切歌时再确认一次。
 */
export const writeNativeLoopMode = async (
    mode: NativeLoopMode,
    shuffle?: boolean,
): Promise<boolean> => {
    const api = plugin();
    if (!api) return false;
    try {
        await api.setLoopMode(shuffle === undefined ? { mode } : { mode, shuffle });
        return true;
    } catch (error) {
        console.warn('[nativeQueue] 下发循环模式失败', error);
        return false;
    }
};
