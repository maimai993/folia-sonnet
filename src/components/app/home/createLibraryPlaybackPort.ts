import type { SongResult, UnifiedSong } from '../../../types';
import type { LibraryPlaybackPort } from '../../../types/libraryUi';
import { resolveNavidromePlaybackCarrier } from '../../../utils/appPlaybackGuards';
import type { HomeSurfaceProps } from './homeSurfaceTypes';

// src/components/app/home/createLibraryPlaybackPort.ts
// 把首页 surface 上的播放回调装配成 Library Core 的播放端口。核心层只说「播这首、以这些为队列」，
// 队列怎么建、本地与 Navidrome 走哪条入队路径，仍由应用现有的播放控制器决定。

type PlaybackSurface = Pick<
    HomeSurfaceProps,
    | 'onPlaySong'
    | 'onPlayAll'
    | 'onAddAllToQueue'
    | 'onAddSongToQueue'
    | 'onAddLocalSongToQueue'
    | 'onAddNavidromeSongsToQueue'
    | 'localSongs'
>;

export const createLibraryPlaybackPort = (surface: PlaybackSurface): LibraryPlaybackPort => ({
    playTrack: (track, queue) => surface.onPlaySong(track, queue),
    playAll: tracks => surface.onPlayAll?.(tracks),
    // 单曲入队按来源分流：本地歌交给本地队列，Navidrome 歌交出它的播放载体，其余走在线入队。
    enqueueTrack: (track: SongResult) => {
        const unifiedTrack = track as UnifiedSong;
        const localSongId = unifiedTrack.localRef?.songId;
        const localSong = localSongId ? surface.localSongs.find(song => song.id === localSongId) : undefined;
        if (unifiedTrack.isLocal && localSong) {
            surface.onAddLocalSongToQueue?.(localSong);
            return;
        }
        if (unifiedTrack.isNavidrome) {
            const naviSong = resolveNavidromePlaybackCarrier(unifiedTrack);
            if (naviSong) {
                surface.onAddNavidromeSongsToQueue?.([naviSong]);
                return;
            }
        }
        surface.onAddSongToQueue?.(track);
    },
    enqueueAll: tracks => {
        surface.onAddAllToQueue?.(tracks);
    },
});
