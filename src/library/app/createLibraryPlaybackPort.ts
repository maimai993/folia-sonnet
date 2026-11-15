import type { SongResult, UnifiedSong } from '../../types';
import type { LibraryPlaybackPort } from '../core/shared/ports.contract';
import { resolveNavidromePlaybackCarrier } from '../../utils/appPlaybackGuards';
import { isCloudThemePendingTrack } from '../core/collection/resource/cloudThemeCollection.service';
import type { HomeSurfaceProps } from '../../components/app/home/homeSurfaceTypes';
import { collectToScratchpad } from '../../stores/useScratchpadStore';
import { canOpenPlaylistPickerFor, openAddSongsToPlaylist } from '../../stores/useAddToPlaylistStore';

// src/library/app/createLibraryPlaybackPort.ts
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
    | 'onTogglePlayback'
    | 'localSongs'
>;

export const createLibraryPlaybackPort = (surface: PlaybackSurface): LibraryPlaybackPort => ({
    /*
     * 「AI 主题」的占位行在这一层被拦掉。
     *
     * 那一屏先把云端给的歌名铺成等长的占位行（假 id `cloud-pending:N`，没有音源、没有时长、
     * 平台上也不存在），再一条一条去当前平台搜出来原地换掉。占位期间点一行，就会拿这样的 id
     * 去播放或入队。
     *
     * 播放的入口散在各处（卡片本身、曲目侧栏、方向键 + Enter、命令面板、拖拽到队列），逐个去判
     * 迟早漏一个，所以拦在端口这个所有 renderer 共同的那唯一的出口上。可播放清单里已经把占位行
     * 除排除了（useCollectionView），队列因此不会被掺进播不响的行 —— 这里堵的是「直接点这一行」。
     */
    playTrack: (track, queue) => {
        if (isCloudThemePendingTrack(track)) return;
        surface.onPlaySong(track, queue);
    },
    playAll: tracks => surface.onPlayAll?.(tracks),
    // 单曲入队按来源分流：本地歌交给本地队列，Navidrome 歌交出它的播放载体，其余走在线入队。
    enqueueTrack: (track: SongResult) => {
        if (isCloudThemePendingTrack(track)) return;
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
    // 选项与返回的条数原样转交：歌手页的「加入热门歌曲」靠它们静默队列提示、报出队列实际收下的数量。
    enqueueAll: (tracks, options) => surface.onAddAllToQueue?.(tracks, options),
    // fb3：宿主的播放开关原样转交（「留在原处」时网格卡片上正在播放的那首的播放键用它）。
    togglePlayback: surface.onTogglePlayback,
    // 速记簿：收进来不动队列（提示由速记簿自己报）。
    collectTracks: (tracks, origin) => {
        collectToScratchpad(tracks, origin);
    },
    // 卡片上的「收藏到歌单」：应用的歌单选择器（与播放页的星标同一个），按歌自己的来源列歌单，在线歌还有「我喜欢」。
    pickPlaylistFor: tracks => {
        if (tracks.length > 0) openAddSongsToPlaylist(tracks);
    },
    canPickPlaylistFor: canOpenPlaylistPickerFor,
});
