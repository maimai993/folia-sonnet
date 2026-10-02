import type { LibraryMutationPort } from '../../../core/contracts/ports';
import type { GridViewSourceActions } from './GridView';

// src/library/suites/grid/collection/gridViewSourceActions.ts
// P2.2 之前 GridView 仍按旧的 sourceActions 形状接收来源动作：从变更端口原样转接。
// 原先在 app/createLibraryMutationPort.ts（宿主转接后传给网格）；R3 起这是网格自己的事，宿主只交出端口。
// GridView 改为调用变更控制器后删除。

export const toGridViewSourceActions = (port: LibraryMutationPort): GridViewSourceActions => ({
    local: {
        onRefresh: port.local?.refresh,
        onEditEntity: port.local?.editEntity,
        onOrganizeFolderSongInfo: port.local?.organizeFolder,
        onMatchSong: port.local?.matchSong,
        onResyncFolder: port.local?.resyncFolder,
        onResyncAllFolders: port.local?.resyncAllFolders,
        onDeleteFolder: port.local?.deleteFolder,
        onRenamePlaylist: port.local?.renamePlaylist,
        onDeletePlaylist: port.local?.deletePlaylist,
        onExportPlaylist: port.local?.exportPlaylist,
        onRemovePlaylistSongs: port.local?.removePlaylistSongs,
    },
    navidrome: {
        availablePlaylists: port.navidrome?.availablePlaylists,
        onAddToPlaylist: port.navidrome?.addToPlaylist,
        onCreatePlaylist: port.navidrome?.createPlaylist,
        onRenamePlaylist: port.navidrome?.renamePlaylist,
        onDeletePlaylist: port.navidrome?.deletePlaylist,
        onRemovePlaylistSongs: port.navidrome?.removePlaylistSongs,
    },
});
