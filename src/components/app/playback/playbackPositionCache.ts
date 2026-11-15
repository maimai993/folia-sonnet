import { getFromCache, removeFromCache, saveToCache } from '../../../services/db';
import type { SongResult } from '../../../types';
import { getPlaybackSongKey } from '../../../utils/appPlaybackGuards';

// src/components/app/playback/playbackPositionCache.ts
//
// 上次听到哪儿了。
//
// 队列与当前曲早就有快照（`last_song` / `last_queue`），唯独位置从来没存过：恢复出来的
// 会话永远从 0:00 开始，用户听到一半退出，回来得自己拖回去。这里补上那一个数。
//
// 为什么单独存一条而不是塞进 last_song：位置每几秒就变，塞进歌曲对象会让整份队列
// （几百首）跟着重写一遍 IndexedDB。位置只有几十字节，各写各的。

const PLAYBACK_POSITION_KEY = 'last_position';

export type PersistedPlaybackPosition = {
    /** 这条位置属于哪一首。恢复时歌曲对不上就整条作废。 */
    songKey: string;
    /** 歌名与歌手：key 变了（换过音源版本、重新归一化过来源）时用它认回同一首。 */
    name?: string;
    artist?: string;
    positionSec: number;
    /** 保存时的时长。恢复时用来判断「是不是已经听完了」。 */
    durationSec: number;
    savedAt: number;
};

/**
 * 最近一次写入的留痕。
 *
 * 「位置没恢复」有两种完全不同的原因：根本没写进去，或者写进去了没认出来。两者的修法
 * 不一样（前者要在保存端找，后者在匹配上找），而现场只有用户手里的界面 —— 把这个记下来，
 * 自检提示里就能一句话分清。
 */
export type PositionWriteProbe = {
    songKey: string;
    name: string;
    positionSec: number;
    at: number;
};

let lastWriteProbe: PositionWriteProbe | null = null;

export const getPositionWriteProbe = (): PositionWriteProbe | null => lastWriteProbe;

/** 歌手折成一行文本：这里只用来认「同一首」，展示格式无关紧要。 */
const artistText = (song: SongResult): string => (
    (song.artists || []).map(item => item?.name).filter(Boolean).join(' / ')
);

export const savePlaybackPosition = async (
    song: SongResult | null,
    positionSec: number,
    durationSec: number,
): Promise<void> => {
    if (!song) return;
    const position = Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0;
    const duration = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
    const record: PersistedPlaybackPosition = {
        songKey: getPlaybackSongKey(song),
        name: song.name,
        artist: artistText(song),
        positionSec: position,
        durationSec: duration,
        savedAt: Date.now(),
    };
    lastWriteProbe = {
        songKey: record.songKey,
        name: record.name ?? '',
        positionSec: record.positionSec,
        at: record.savedAt,
    };
    await saveToCache(PLAYBACK_POSITION_KEY, record);
};

/** 读出上次位置。哪一首由调用方自己比（见 `readPlaybackPositionForSong`）。 */
export const readPlaybackPosition = async (): Promise<PersistedPlaybackPosition | null> => {
    const record = await getFromCache<PersistedPlaybackPosition>(PLAYBACK_POSITION_KEY);
    if (!record || typeof record.positionSec !== 'number' || !Number.isFinite(record.positionSec)) {
        return null;
    }
    return record.positionSec > 0 ? record : null;
};

/** 歌名与歌手都对上就算同一首（大小写、首尾空白不算差异）。 */
const sameTitle = (first?: string, second?: string): boolean => {
    const a = (first || '').trim().toLowerCase();
    const b = (second || '').trim().toLowerCase();
    return a.length > 0 && a === b;
};

/**
 * 恢复时要的那条位置：先按 key 精确认，认不上再按「歌名 + 歌手」认。
 *
 * 只按 key 认是不够的：同一首歌在库里换过音源版本、或者旧快照里的 sourceRef 与现在的
 * 归一化结果不同，key 就换了 —— 位置明明还在，却被当成「没存过」，用户回来又是 0:00。
 * 反过来说，名字与歌手必须同时命中，同名翻唱才不会被误认。
 */
export const readPlaybackPositionForSong = async (song: SongResult): Promise<PersistedPlaybackPosition | null> => {
    const record = await readPlaybackPosition();
    if (!record) return null;
    if (record.songKey === getPlaybackSongKey(song)) return record;
    const sameSong = sameTitle(record.name, song.name) && sameTitle(record.artist, artistText(song));
    if (!sameSong) return null;
    console.info('[Session] 位置的 key 变了，按歌名认回:', record.songKey, '→', getPlaybackSongKey(song));
    return record;
};

export const forgetPlaybackPosition = async (): Promise<void> => {
    lastWriteProbe = null;
    await removeFromCache(PLAYBACK_POSITION_KEY);
};
