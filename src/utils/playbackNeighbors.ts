import { getPlaybackSongKey } from './appPlaybackGuards';
import type { SongResult } from '../types';
// src/utils/playbackNeighbors.ts

export type PlaybackNeighbor = {
    /** 该方向是否可以跳转 */
    canGo: boolean;
    /** 目标曲目标题；可跳但目标未知时为 null */
    title: string | null;
};

export type PlaybackNeighbors = {
    prev: PlaybackNeighbor;
    next: PlaybackNeighbor;
};

const BLOCKED: PlaybackNeighbors = {
    prev: { canGo: false, title: null },
    next: { canGo: false, title: null },
};

type ResolvePlaybackNeighborsParams = {
    playQueue: SongResult[];
    currentSong: SongResult | null;
    loopMode: 'off' | 'all' | 'one';
    isFmMode: boolean;
    isStageActive: boolean;
};

/**
 * 按 usePlaybackQueueController 中 handlePrevTrack / handleNextTrack 的同一套下标规则，
 * 推导上一首/下一首能否跳转以及目标标题。
 * FM 模式停在队列最后一首时，跳转会现拉新曲目，此时 canGo 为 true 但 title 未知。
 */
export const resolvePlaybackNeighbors = ({
    playQueue,
    currentSong,
    loopMode,
    isFmMode,
    isStageActive,
}: ResolvePlaybackNeighborsParams): PlaybackNeighbors => {
    // 舞台播放时两个 handler 都会直接 return，这里必须同步禁用，否则箭头点了没反应
    if (isStageActive || !currentSong || playQueue.length === 0) {
        return BLOCKED;
    }

    const currentKey = getPlaybackSongKey(currentSong);
    const currentIndex = playQueue.findIndex(song => getPlaybackSongKey(song) === currentKey);
    const lastIndex = playQueue.length - 1;

    const titleAt = (index: number): string | null => playQueue[index]?.name ?? null;

    let prevIndex = -1;
    if (currentIndex > 0) {
        prevIndex = currentIndex - 1;
    } else if (loopMode === 'all') {
        prevIndex = lastIndex;
    }

    let nextIndex = -1;
    if (currentIndex >= 0 && currentIndex < lastIndex) {
        nextIndex = currentIndex + 1;
    } else if (currentIndex < 0) {
        nextIndex = 0;
    } else if (loopMode === 'all') {
        nextIndex = 0;
    }

    // FM 走到队列末尾时会追加新曲目再跳，标题此刻无法预知
    const fmWillFetch = isFmMode && currentIndex === lastIndex;

    return {
        prev: prevIndex >= 0
            ? { canGo: true, title: titleAt(prevIndex) }
            : { canGo: false, title: null },
        next: fmWillFetch
            ? { canGo: true, title: null }
            : nextIndex >= 0
                ? { canGo: true, title: titleAt(nextIndex) }
                : { canGo: false, title: null },
    };
};
