import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import { getSongCoverUrl } from '../../services/onlineMusic/songMetadata';
import { formatSongName } from '../../utils/songNameFormatter';
import type { GridItem } from './polaroidCardParts';
import type { SongResult } from '../../types';

// src/components/folia-grid/lazyGridItems.ts
// 网格项的**惰性**塑形。抽出来是为了两件事：这一段的正确性很细（id 里的重复序号、增量缓存），
// 而它又必须与原来的 eager 版本产出**逐字段相同**的对象 —— 所以要有单测钉住，不能靠读代码相信。
//
// 为什么需要它：原来 `displayTracks.map(...)` 会把整张歌单都塑形一遍。5000 首实测 120ms，
// 而网格一次只渲染视口附近的几十张卡；分页每来一页还会整表重算一次（累计 O(N²/Batch)），
// 正好落在用户刚点开、转场还在飞的窗口里。

/**
 * id 里的重复序号必须在使用前知道：同一首歌在歌单里出现两次时，第二个的 id 是 `<key>-1`。
 * 这需要一遍「key → 已出现次数」的扫描 —— 但它只做字符串比较与 Map 计数，比塑形整个对象便宜
 * 一个量级；而且前缀没变时可以复用上一次的结果（分页追加是最常见的情形）。
 */
export interface DuplicateOccurrenceCache {
    source: SongResult[];
    seen: Map<string, number>;
    occurrences: Map<number, number>;
}

export interface DuplicateOccurrences {
    seen: Map<string, number>;
    occurrences: Map<number, number>;
}

export const buildDuplicateOccurrences = (
    tracks: SongResult[],
    previous: DuplicateOccurrenceCache | null,
): DuplicateOccurrences => {
    const reusablePrefix = Boolean(previous)
        && previous!.source.length <= tracks.length
        && previous!.source.every((track, index) => track === tracks[index]);
    const seen = reusablePrefix ? previous!.seen : new Map<string, number>();
    const occurrences = reusablePrefix ? previous!.occurrences : new Map<number, number>();
    for (let index = reusablePrefix ? previous!.source.length : 0; index < tracks.length; index += 1) {
        const key = getPlaybackSongKey(tracks[index]);
        const count = seen.get(key) ?? 0;
        if (count > 0) {
            occurrences.set(index, count);
        }
        seen.set(key, count + 1);
    }
    return { seen, occurrences };
};

/** 一首曲目 → 一个网格项。与 GridView 早先的 eager 版本逐字段一致。 */
export const shapeGridItem = (
    track: SongResult,
    index: number,
    occurrence: number,
): GridItem => ({
    id: `${getPlaybackSongKey(track)}-${occurrence}`,
    name: formatSongName(track),
    searchText: [
        track.name,
        track.aliases?.join(' '),
        track.translatedNames?.join(' '),
    ].filter(Boolean).join(' '),
    coverUrl: getSongCoverUrl(track),
    subtitle: String(index + 1).padStart(2, '0'),
    description: track.artists?.map(artist => artist.name).join(', '),
    rawTrack: track,
    rawTrackIndex: index,
});

/**
 * 惰性数组：`length` 立刻可用（视口计算只要它），真对象在被按下标读到时才塑形并缓存。
 *
 * `has` 陷阱是**必须**的：底层数组是稀疏的（只设了 length），而 `map`/`filter`/`findIndex`
 * 会先用 `HasProperty` 跳过「空洞」—— 少了这个陷阱，搜索过滤会静默返回空数组、封面预加载
 * 会静默拿到 undefined。加上之后这些方法照常工作（它们本来就要读全部下标）。
 */
export const createLazyGridItems = (
    tracks: SongResult[],
    occurrences: Map<number, number>,
): GridItem[] => {
    const target: GridItem[] = new Array(tracks.length);
    const shaped = new Map<number, GridItem>();
    const shapeAt = (index: number): GridItem => {
        const cached = shaped.get(index);
        if (cached) {
            return cached;
        }
        const built = shapeGridItem(tracks[index], index, occurrences.get(index) ?? 0);
        shaped.set(index, built);
        return built;
    };
    const isIndex = (property: string | symbol): number | null => {
        if (typeof property !== 'string') return null;
        const index = Number(property);
        return Number.isInteger(index) && index >= 0 && index < tracks.length ? index : null;
    };
    return new Proxy(target, {
        get(array, property, receiver) {
            const index = isIndex(property);
            return index === null ? Reflect.get(array, property, receiver) : shapeAt(index);
        },
        has(array, property) {
            const index = isIndex(property);
            return index === null ? Reflect.has(array, property) : true;
        },
        getOwnPropertyDescriptor(array, property) {
            const index = isIndex(property);
            if (index === null) {
                return Reflect.getOwnPropertyDescriptor(array, property);
            }
            return { configurable: true, enumerable: true, writable: false, value: shapeAt(index) };
        },
    });
};
