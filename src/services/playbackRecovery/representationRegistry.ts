import type { SongResult } from '../../types';
import type { PlaybackRepresentation } from '../../types/playbackRecovery';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';

// Keeps playback and analysis on one representation for the lifetime of the current renderer.

const representations = new Map<string, PlaybackRepresentation>();

export const registerPlaybackRepresentation = (representation: PlaybackRepresentation): void => {
    representations.set(representation.songKey, representation);
};

export const getPlaybackRepresentation = (
    song: SongResult | null | undefined,
): PlaybackRepresentation | null => (
    song ? representations.get(getPlaybackSongKey(song)) ?? null : null
);

export const getPlaybackRepresentationForRevision = (
    songKey: string,
    sourceRevision: string,
): PlaybackRepresentation | null => {
    const representation = representations.get(songKey);
    return representation?.sourceRevision === sourceRevision ? representation : null;
};

export const getPlaybackAnalysisKey = (song: SongResult): string => {
    const songKey = getPlaybackSongKey(song);
    const representation = representations.get(songKey);
    return representation ? `${songKey}@${representation.representationId}` : songKey;
};

export const clearPlaybackRepresentationsForTests = (): void => {
    representations.clear();
};
