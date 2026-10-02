import type { LocalSong, SongResult } from '../../../src/types';
import type { NavidromeSong } from '../../../src/types/navidrome';
import type { HomeSurfaceProps } from '../../../src/components/app/home/homeSurfaceTypes';
import { getPlaybackSongKey } from '../../../src/utils/appPlaybackGuards';
import { recordProbeCall } from './probeLog';

// dev/probes/libraryBehavior/probeSurfaceCallbacks.ts
// 两个行为探针（集合详情 libraryBehavior、首页 homeBehavior）共用的「假 App」回调：播放、入队、状态消息
// 全部只记账不执行。宿主与首页拿到的是同一组回调，所以两边的断言读的是同一本账。

export const probeSongKeys = (songs: SongResult[] | undefined): string[] => (songs ?? []).map(getPlaybackSongKey);

export type ProbeSurfaceCallbacks = Pick<
    HomeSurfaceProps,
    | 'onPlaySong'
    | 'onPlayAll'
    | 'onAddAllToQueue'
    | 'onAddSongToQueue'
    | 'onAddLocalSongToQueue'
    | 'onAddNavidromeSongsToQueue'
    | 'onStatusMessage'
    | 'onBackToPlayer'
>;

/** 一组只记账的播放 / 入队 / 状态消息回调（模块级常量即可，身份稳定）。 */
export const PROBE_SURFACE_CALLBACKS: ProbeSurfaceCallbacks = {
    onPlaySong: (song, queue, isFmCall) => recordProbeCall({
        kind: 'playSong',
        ids: probeSongKeys([song]),
        queueIds: probeSongKeys(queue),
        ...(isFmCall ? { isFm: true } : {}),
    }),
    onPlayAll: songs => recordProbeCall({ kind: 'playAll', ids: probeSongKeys(songs) }),
    onAddAllToQueue: songs => {
        recordProbeCall({ kind: 'addAllToQueue', ids: probeSongKeys(songs) });
        return songs.length;
    },
    onAddSongToQueue: song => recordProbeCall({ kind: 'addSongToQueue', ids: probeSongKeys([song]) }),
    onAddLocalSongToQueue: (song: LocalSong) => recordProbeCall({ kind: 'addLocalSongToQueue', ids: [song.id] }),
    onAddNavidromeSongsToQueue: (songs: NavidromeSong[]) => recordProbeCall({
        kind: 'addNavidromeSongsToQueue',
        ids: songs.map(song => song.navidromeData?.id ?? String(song.id)),
    }),
    onStatusMessage: message => recordProbeCall({ kind: 'statusMessage', ids: [], text: message.text, status: message.type }),
    onBackToPlayer: () => {},
};
