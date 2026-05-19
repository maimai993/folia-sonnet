import type { QueueAddBehavior } from '../types';

// src/utils/queueAddBehavior.ts

type QueueEntry = {
    id: number;
};

type ApplyQueueAddBehaviorParams<T extends QueueEntry> = {
    queue: T[];
    songs: T[];
    currentSong: T | null;
    behavior: QueueAddBehavior;
};

// Applies the user's preferred insertion strategy and reorders songs that are already in the queue.
export const applyQueueAddBehavior = <T extends QueueEntry>({
    queue,
    songs,
    currentSong,
    behavior,
}: ApplyQueueAddBehaviorParams<T>) => {
    const currentSongId = currentSong?.id ?? null;
    const seenTargetIds = new Set<number>();
    const targetSongs: T[] = [];

    for (const song of songs) {
        if (song.id === currentSongId || seenTargetIds.has(song.id)) {
            continue;
        }

        seenTargetIds.add(song.id);
        targetSongs.push(song);
    }

    if (targetSongs.length === 0) {
        return {
            nextQueue: queue,
            affectedSongs: targetSongs,
            changed: false,
        };
    }

    const queueWithoutTargets = queue.filter(song => !seenTargetIds.has(song.id));

    if (behavior === 'append') {
        const nextQueue = [...queueWithoutTargets, ...targetSongs];
        return {
            nextQueue,
            affectedSongs: targetSongs,
            changed: nextQueue.length !== queue.length || nextQueue.some((song, index) => song.id !== queue[index]?.id),
        };
    }

    const anchorIndex = currentSong
        ? queueWithoutTargets.findIndex(song => song.id === currentSong.id)
        : -1;

    if (anchorIndex === -1) {
        const nextQueue = [...targetSongs, ...queueWithoutTargets];
        return {
            nextQueue,
            affectedSongs: targetSongs,
            changed: nextQueue.length !== queue.length || nextQueue.some((song, index) => song.id !== queue[index]?.id),
        };
    }

    const nextQueue = [
        ...queueWithoutTargets.slice(0, anchorIndex + 1),
        ...targetSongs,
        ...queueWithoutTargets.slice(anchorIndex + 1),
    ];

    return {
        nextQueue,
        affectedSongs: targetSongs,
        changed: nextQueue.length !== queue.length || nextQueue.some((song, index) => song.id !== queue[index]?.id),
    };
};
