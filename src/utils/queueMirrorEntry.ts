import type { SongResult } from '../types';
import { getPlaybackSongKey } from './appPlaybackGuards';
import { getSongAlbumLabel, getSongArtistLabel, getSongCoverUrl } from '../services/onlineMusic/songMetadata';

// src/utils/queueMirrorEntry.ts
//
// 原生播放延续需要的歌曲身份与队列镜像条目。
//
// 两处共用（改一处两边都要改，字段名与 FoliaPlaybackService 的镜像解析一一对应）：
//  · useCapacitorPlaybackBridge —— 队列变化时推全量镜像（WebView 冻结后通知栏
//    切歌 / 红心兜底的数据源）；
//  · usePlaybackQueueController —— 点歌 / 切歌分流给原生（playFromQueue）时，
//    把调用者手里最新的队列一并交过去（镜像 effect 可能还没跑）。

/**
 * 原生播放延续需要的歌曲身份：平台 + 平台侧 id 们。
 *
 * 网易的收藏与取流只认数字曲库 id（mediaId 就是它）；QQ 的写入要数字 songId
 * （正规化时存在 providerData.songId，mediaId 多数时候是 songmid，不能拿去猜），
 * 取流（CgiGetVkey）只认 songmid；酷狗的取流与歌词都只认文件 hash。
 * 本地 / Navidrome / 舞台这些自家人没有平台身份，原生兜底对它们跳过。
 */
export const resolveLikeIdentity = (song: SongResult | null | undefined): {
    providerId: string;
    serverSongId: string;
    providerMid: string;
    providerHash: string;
    providerAlbumAudioId: string;
} => {
    const sourceRef = song?.sourceRef?.kind === 'online' ? song.sourceRef : undefined;
    if (!sourceRef) return { providerId: '', serverSongId: '', providerMid: '', providerHash: '', providerAlbumAudioId: '' };
    if (sourceRef.providerId === 'netease') {
        return { providerId: 'netease', serverSongId: String(sourceRef.mediaId ?? ''), providerMid: '', providerHash: '', providerAlbumAudioId: '' };
    }
    if (sourceRef.providerId === 'qq') {
        const data = (sourceRef.providerData ?? {}) as Record<string, unknown>;
        const id = typeof data.songId === 'string' && /^\d{1,15}$/.test(data.songId.trim())
            ? data.songId.trim()
            : (typeof sourceRef.mediaId === 'string' && /^\d{1,15}$/.test(sourceRef.mediaId.trim())
                ? sourceRef.mediaId.trim()
                : '');
        // songmid：取流认它。providerData 带了用它的；没带时 mediaId 多半就是 songmid。
        const mid = typeof data.songmid === 'string' && data.songmid.trim()
            ? data.songmid.trim()
            : String(sourceRef.mediaId ?? '');
        return { providerId: 'qq', serverSongId: id, providerMid: mid, providerHash: '', providerAlbumAudioId: '' };
    }
    if (sourceRef.providerId === 'kugou') {
        const data = (sourceRef.providerData ?? {}) as Record<string, unknown>;
        return {
            providerId: 'kugou',
            serverSongId: '',
            providerMid: '',
            providerHash: typeof data.hash === 'string' ? data.hash : String(sourceRef.mediaId ?? ''),
            providerAlbumAudioId: typeof data.albumAudioId === 'string' || typeof data.albumAudioId === 'number'
                ? String(data.albumAudioId)
                : '',
        };
    }
    // 汽水与飞牛都只用一个 id：汽水的取流 / 歌词要 track id，飞牛要曲目 guid ——
    // mediaId 就是它们，原生网关按 providerId 分流。
    if (sourceRef.providerId === 'qishui' || sourceRef.providerId === 'feiniu') {
        return {
            providerId: sourceRef.providerId,
            serverSongId: String(sourceRef.mediaId ?? ''),
            providerMid: '',
            providerHash: '',
            providerAlbumAudioId: '',
        };
    }
    return { providerId: String(sourceRef.providerId), serverSongId: '', providerMid: '', providerHash: '', providerAlbumAudioId: '' };
};

export const getMirrorDurationMs = (song: SongResult): number => {
    const candidate = (song as SongResult & { duration?: number; durationMs?: number });
    const ms = candidate.durationMs ?? candidate.duration;
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return 0;
    // 有些音源给的是秒。
    return ms > 0 && ms < 1000 ? Math.round(ms * 1000) : Math.round(ms);
};

export type QueueMirrorLikeState = { liked: boolean; canLike: boolean } | null | undefined;
export type QueueMirrorLikeStateOf = (song: SongResult) => QueueMirrorLikeState;

export type QueueMirrorEntry = {
    songKey: string;
    title: string;
    artist: string;
    album: string;
    artworkUrl: string;
    durationMs: number;
    providerId: string;
    serverSongId: string;
    providerMid: string;
    providerHash: string;
    providerAlbumAudioId: string;
    liked: boolean;
    canLike: boolean;
};

/** 把一条歌转成镜像条目（与 FoliaPlaybackService 的镜像解析字段一一对应）。 */
export const buildQueueMirrorEntry = (
    song: SongResult,
    likeStateOf?: QueueMirrorLikeStateOf,
): QueueMirrorEntry => {
    const identity = resolveLikeIdentity(song);
    const likeState = likeStateOf?.(song);
    return {
        songKey: getPlaybackSongKey(song),
        title: song.name || '',
        artist: getSongArtistLabel(song) || '',
        album: getSongAlbumLabel(song) || '',
        artworkUrl: getSongCoverUrl(song) || '',
        durationMs: getMirrorDurationMs(song),
        providerId: identity.providerId,
        serverSongId: identity.serverSongId,
        providerMid: identity.providerMid,
        providerHash: identity.providerHash,
        providerAlbumAudioId: identity.providerAlbumAudioId,
        liked: likeState?.liked ?? false,
        canLike: likeState?.canLike ?? false,
    };
};

export const buildQueueMirrorEntries = (
    list: SongResult[],
    likeStateOf?: QueueMirrorLikeStateOf,
): QueueMirrorEntry[] => list.map(song => buildQueueMirrorEntry(song, likeStateOf));

/**
 * 把原生队列状态里的一条还原回 `SongResult`。
 *
 * 反向映射（buildQueueMirrorEntry 的逆）：JS 醒来对齐队列时用 —— WebView 冻结期间
 * 原生可能自动跳过/随机挑格/通知栏切歌，playQueue 换过内容，认领 currentSong 时要
 * 把队列一起摆正。
 *
 * **只能还原镜像里带的那些字段**：来源身份（sourceRef）按 providerId + 各 id 重建，
 * 其余（音质偏好、无版权标记、歌词状态这些）不在镜像里，给安全默认值。这够队列
 * 渲染与再次下发给原生用；点开详情页时由原有那条按 id 拉详情的链路补全。
 */
export const songFromMirrorEntry = (entry: {
    songKey: string;
    providerId: string;
    songId: string;
    mid: string;
    hash: string;
    albumAudioId: string;
    title: string;
    artist: string;
    album: string;
    coverUrl: string;
    durationSec: number;
}): SongResult => {
    const onlinePrefix = `online:${entry.providerId}:`;
    const kind = entry.songKey.startsWith('local:') ? 'local'
        : entry.songKey.startsWith('navidrome:') ? 'navidrome' : 'online';
    const mediaId = entry.songKey.startsWith(onlinePrefix) ? entry.songKey.slice(onlinePrefix.length)
        : kind !== 'online' ? entry.songKey.slice(entry.songKey.indexOf(':') + 1)
            : entry.songId || entry.mid || entry.hash || entry.albumAudioId || entry.songKey;
    const artists = entry.artist
        ? entry.artist.split('/').map(name => name.trim()).filter(Boolean).map((name, index) => ({ id: `${mediaId}-a${index}`, name }))
        : [];
    return {
        id: mediaId,
        name: entry.title,
        artists,
        album: { id: `${mediaId}-al`, name: entry.album, picUrl: entry.coverUrl },
        durationMs: Math.round((entry.durationSec || 0) * 1000),
        ...(kind === 'local' ? { isLocal: true, localRef: { songId: mediaId } } : {}),
        ...(kind === 'navidrome' ? { isNavidrome: true } : {}),
        sourceRef: {
            kind,
            ...(kind === 'online' ? { providerId: entry.providerId } : {}),
            mediaId,
            providerData: {
                songId: entry.songId,
                songmid: entry.mid,
                hash: entry.hash,
                albumAudioId: entry.albumAudioId,
            },
        } as SongResult['sourceRef'],
    } as SongResult;
};
