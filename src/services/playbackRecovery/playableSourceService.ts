import type { LocalSong, SongResult } from '../../types';
import type { TranscodeFallbackRequest, TranscodeFallbackResult, TranscodeFallbackSource } from '../../types/playbackRecovery';
import { getFileFromLocalSong } from '../localMusicService';
import { getPlaybackSongKey, isLocalPlaybackSong, isNavidromePlaybackSong, resolveNavidromePlaybackCarrier } from '../../utils/appPlaybackGuards';
import { buildLocalSourceRevision, buildNavidromeSourceRevision } from './sourceRevision';

// Resolves renderer-owned sources into the narrow, validated Electron transcode IPC contract.

const buildRequestId = () => (
    globalThis.crypto?.randomUUID?.()
    ?? `transcode-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

export const buildTranscodeFallbackSource = async (
    song: SongResult,
    failedSource: string,
    localSongs: LocalSong[],
): Promise<TranscodeFallbackSource | null> => {
    const songKey = getPlaybackSongKey(song);
    if (isLocalPlaybackSong(song)) {
        const localSong = localSongs.find(candidate => candidate.id === song.localRef.songId);
        if (!localSong) return null;
        const file = await getFileFromLocalSong(localSong);
        if (!file || file.size <= 0) return null;
        return {
            kind: 'local',
            songKey,
            sourceRevision: buildLocalSourceRevision(localSong, file),
            fileName: file.name || localSong.fileName,
            data: await file.arrayBuffer(),
        };
    }

    if (isNavidromePlaybackSong(song)) {
        const carrier = resolveNavidromePlaybackCarrier(song);
        if (!carrier) return null;
        const data = carrier.navidromeData;
        const common = {
            kind: 'navidrome',
            songKey,
            fileName: `${data.id}.${data.suffix || 'audio'}`,
        } as const;
        const revisionBase = [data.id, data.path, data.suffix, song.durationMs];
        if (failedSource.startsWith('blob:')) {
            const bytes = await (await fetch(failedSource)).arrayBuffer();
            return {
                ...common,
                sourceRevision: [...revisionBase, `blob:${bytes.byteLength}`].join(':'),
                data: bytes,
            };
        }
        const url = /^https?:/i.test(failedSource) ? failedSource : data.streamUrl;
        return {
            ...common,
            sourceRevision: buildNavidromeSourceRevision(song, url),
            url,
        };
    }

    return null;
};

export const startPlayableTranscode = (
    song: SongResult,
    failedSource: string,
    localSongs: LocalSong[],
    priority: TranscodeFallbackRequest['priority'],
): { requestId: string; result: Promise<TranscodeFallbackResult> } => {
    const bridge = window.electron?.requestTranscodeFallback;
    const requestId = buildRequestId();
    if (!bridge) return { requestId, result: Promise.resolve({ ok: false, errorCode: 'NOT_ELECTRON' }) };
    const result = (async () => {
        const source = await buildTranscodeFallbackSource(song, failedSource, localSongs);
        if (!source) return { ok: false, errorCode: 'SOURCE_UNAVAILABLE' };
        const request: TranscodeFallbackRequest = { requestId, priority, source };
        return bridge(request);
    })();
    return { requestId, result };
};

export const cancelPlayableTranscode = (requestId: string): void => {
    if (requestId) void window.electron?.cancelTranscodeFallback?.(requestId);
};
