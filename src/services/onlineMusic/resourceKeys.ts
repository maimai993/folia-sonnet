import type { SongResult } from '../../types';
import { getPlaybackSongKey, getPlaybackSourceRef } from '../../utils/appPlaybackGuards';

// src/services/onlineMusic/resourceKeys.ts

export type SongResourceKind = 'audio' | 'lyric' | 'cover' | 'theme' | 'replayGain';

export const getSongResourceCacheKey = (kind: SongResourceKind, song: SongResult): string => {
    const sourceRef = getPlaybackSourceRef(song);
    /*
     * 歌词换过一次键：跨来源借词（#141）之前，原平台回空就把「空」存下来了 —— 那些条目
     * 正是这个修复要处理的情况，可只要键没变，读到的还是那份空，修复等于没上线。
     * 升到 v2 后旧键（`lyric_*`）自然读不到，也不用写迁移去扫一遍库。
     */
    const versionedKind = kind === 'cover'
        && sourceRef.kind === 'online'
        && sourceRef.providerId === 'kugou'
        ? 'cover_v2'
        : kind === 'lyric' ? 'lyric_v2' : kind;
    return `${versionedKind}_${getPlaybackSongKey(song)}`;
};

export const getLegacySongResourceCacheKeys = (kind: SongResourceKind, song: SongResult): string[] => {
    const sourceRef = getPlaybackSourceRef(song);
    if (sourceRef.kind !== 'online' || sourceRef.providerId !== 'netease') return [];
    return [
        ...(sourceRef.variant === 'cloud' ? [`${kind}_cloud_${sourceRef.mediaId}`] : []),
        `${kind}_${sourceRef.mediaId}`,
    ];
};
