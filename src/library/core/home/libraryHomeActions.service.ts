import type { PersonalFmLaunch, PersonalFmSelection } from '../../../types/personalFm';
import type { LocalLibraryGroup } from '../../../types';
import type { NavidromeGridViewCollectionType } from '../collection/collection.contract';
import type {
    LibraryHomeActionResult,
    LibraryHomeActionsController,
    LibraryHomeActionsSnapshot,
    LibraryHomeCard,
    LibraryHomeOpenCollection,
    LibraryHomePort,
    LibraryHomeScanProgress,
} from './homeModel.contract';
import { isPersonalFmCard, onlineCardCollection } from './homeCards';
import { isHomeImportBusy, resolveLocalUnavailableReason } from './homeSources';

// src/library/core/home/libraryHomeActions.service.ts
// 首页动作层（原样搬自 Grid3D）：本地的导入文件夹、刷新全部、导入歌单文件，私人 FM 直接播放，打开卡片。
// - 三个导入共用一个「忙」：任何一个在进行或扫描在进行时，导入文件夹 / 刷新再提交返回 busy；歌单文件导入只看自己；
// - 导入文件夹前先看本地曲库能不能用（不能用时弹提示）；导入 / 刷新有新歌才刷新曲库；导入失败弹「不支持」提示，
//   刷新失败只记日志；歌单文件导入一首都没匹配上时报错、不刷新，否则刷新曲库后按有没有跳过的路径给出提示；
// - 扫描进度：第一个订阅者到来时开始听端口，最后一个离开时停（宿主创建一次，不需要 dispose）。
// 副作用都经宿主装配的 LibraryHomePort。

const OK: LibraryHomeActionResult = { ok: true };
const BUSY: LibraryHomeActionResult = { ok: false, reason: 'busy' };
const UNSUPPORTED: LibraryHomeActionResult = { ok: false, reason: 'unsupported' };
const FAILED: LibraryHomeActionResult = { ok: false, reason: 'failed' };

const IDLE: LibraryHomeActionsSnapshot = {
    importingFolder: false,
    refreshingFolders: false,
    importingPlaylist: false,
    scan: null,
};

/** 创建首页动作控制器。端口在调用时现读（宿主每次渲染都可能换新的曲库与回调）。 */
export const createLibraryHomeActions = (port: LibraryHomePort): LibraryHomeActionsController => {
    let snapshot = IDLE;
    const listeners = new Set<() => void>();
    let stopScanProgress: (() => void) | null = null;

    const patch = (next: Partial<LibraryHomeActionsSnapshot>) => {
        snapshot = { ...snapshot, ...next };
        listeners.forEach(listener => listener());
    };

    const handleScanProgress = (progress: LibraryHomeScanProgress | null) => {
        patch({ scan: progress?.active ? progress : null });
    };

    const playPersonalFm = async (selection?: PersonalFmLaunch, providerId?: string): Promise<LibraryHomeActionResult> => {
        try {
            const songs = await port.getPersonalFm(selection, providerId);
            if (songs.length > 0) port.playPersonalFm(songs[0], songs);
            return OK;
        } catch (error) {
            console.error('[LibraryHome] Failed to fetch and play Personal FM:', error);
            return FAILED;
        }
    };

    return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
            listeners.add(listener);
            if (!stopScanProgress) stopScanProgress = port.subscribeScanProgress(handleScanProgress);
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0 && stopScanProgress) {
                    stopScanProgress();
                    stopScanProgress = null;
                }
            };
        },

        importFolder: async () => {
            if (isHomeImportBusy(snapshot)) return BUSY;
            const unavailable = resolveLocalUnavailableReason(port.localAvailability());
            if (unavailable) {
                port.notify({ kind: 'alert', message: unavailable });
                return UNSUPPORTED;
            }
            patch({ importingFolder: true });
            try {
                const imported = await port.importFolder();
                if (imported > 0) void port.refreshLocalSongs();
                return OK;
            } catch (error) {
                console.error('[LibraryHome] Failed to import local folder:', error);
                port.notify({ kind: 'alert', message: { key: 'localMusic.importNotSupported' } });
                return FAILED;
            } finally {
                patch({ importingFolder: false });
            }
        },

        scanDeviceMusic: async () => {
            if (isHomeImportBusy(snapshot)) return BUSY;
            // ⚠ 宿主没接这条能力时要**说出来**。以前这里是静默 return：按钮点了没反应、
            // 不申请权限、也不提示，看着就像界面坏了（安卓上「扫描设备音乐」就是这样
            // 静了很久 —— 能力没接进 port，而失败又不吭声）。
            if (typeof port.scanDeviceMusic !== 'function') {
                port.notify({ kind: 'alert', message: { key: 'localMusic.scanDeviceUnavailable' } });
                return UNSUPPORTED;
            }
            patch({ scanningDevice: true });
            try {
                const imported = await port.scanDeviceMusic();
                if (imported > 0) void port.refreshLocalSongs();
                return OK;
            } catch (error) {
                console.error('[LibraryHome] Failed to scan device music:', error);
                port.notify({ kind: 'alert', message: { key: 'localMusic.scanDeviceFailed' } });
                return FAILED;
            } finally {
                patch({ scanningDevice: false });
            }
        },

        refreshFolders: async () => {
            if (isHomeImportBusy(snapshot)) return BUSY;
            patch({ refreshingFolders: true });
            try {
                const imported = await port.resyncAllFolders();
                if (imported > 0) void port.refreshLocalSongs();
                return OK;
            } catch (error) {
                console.error('[LibraryHome] Failed to resync local folders:', error);
                return FAILED;
            } finally {
                patch({ refreshingFolders: false });
            }
        },

        importPlaylistFile: async (file) => {
            if (snapshot.importingPlaylist) return BUSY;
            patch({ importingPlaylist: true });
            try {
                const result = await port.importPlaylistFile(file);
                if (!result.playlistName) {
                    port.notify({ kind: 'status', type: 'error', message: { key: 'localMusic.playlistImportNoMatches' } });
                    return FAILED;
                }
                await port.refreshLocalSongs();
                const values = { name: result.playlistName, count: result.matchedCount };
                port.notify(result.skippedCount > 0
                    ? { kind: 'status', type: 'info', message: { key: 'localMusic.playlistImportPartial', values: { ...values, skipped: result.skippedCount } } }
                    : { kind: 'status', type: 'success', message: { key: 'localMusic.playlistImportSuccess', values } });
                return OK;
            } catch (error) {
                console.error('[LibraryHome] Failed to import local playlist:', error);
                port.notify({ kind: 'status', type: 'error', message: { key: 'localMusic.playlistImportFailed' } });
                return FAILED;
            } finally {
                patch({ importingPlaylist: false });
            }
        },

        /**
         * 从本地曲库删歌。与导入共用「忙」：正在导入时删会让两边看到的曲库不一致
         * （删掉的歌可能正被重扫带回来），所以直接回 busy。
         */
        deleteLocalSongs: async (songIds) => {
            const ids = Array.from(new Set(songIds));
            if (ids.length === 0) return OK;
            if (isHomeImportBusy(snapshot)) return BUSY;
            await port.deleteLocalSongs(ids);
            await port.refreshLocalSongs();
            port.notify({
                kind: 'status',
                type: 'success',
                message: { key: 'localMusic.songsRemoved', values: { count: ids.length } },
            });
            return OK;
        },

        /**
         * 给本地歌曲改名。不跟导入共用「忙」：改名只动一首、也不重扫目录，导入进行中改也不会
         * 让两边看到的曲库打架（导入按路径认歌，改名后路径是同步改过的）。
         */
        renameLocalSong: async (songId, name) => {
            try {
                const result = await port.renameLocalSong(songId, name);
                if (!result.ok) {
                    port.notify({
                        kind: 'status',
                        type: 'error',
                        message: {
                            key: result.reason === 'conflict'
                                ? 'localMusic.renameNameTaken'
                                : result.reason === 'invalid'
                                    ? 'localMusic.renameInvalidName'
                                    : 'localMusic.renameFailed',
                        },
                    });
                    return FAILED;
                }
                await port.refreshLocalSongs();
                // 磁盘文件没改成也算成功：安卓改不了文件名、桌面可能是文件夹授权失效，
                // 这两种情况只改了显示名，得跟用户说清楚。
                port.notify({
                    kind: 'status',
                    type: result.renamedFile ? 'success' : 'info',
                    message: {
                        key: result.renamedFile ? 'localMusic.renameSuccessFile' : 'localMusic.renameSuccessTitle',
                        values: { name: result.title },
                    },
                });
                return OK;
            } catch (error) {
                console.error('[LibraryHome] Failed to rename local song:', error);
                port.notify({ kind: 'status', type: 'error', message: { key: 'localMusic.renameFailed' } });
                return FAILED;
            }
        },

        playPersonalFm,

        /**
         * 打开在线卡片。`providerId` 是**当前平台**，只有单平台视图里才是卡片的归属平台。
         *
         * 「全部」视图把各家的歌单合在一屏，每张卡自己来自哪家记在 `sourceProviderId` 上（见
         * homeModel.contract 的注释）：这时必须按**卡片自己的**平台去取曲目，拿当前平台去问别家的
         * 歌单只会取空、取错，或者拿别家的歌单 id 撞上当前平台的接口（404；「我喜欢的」各家都有，
         * 于是点 QQ 的那张打开的是当前平台那一份）。
         */
        openOnlineCard: async (card: LibraryHomeCard, providerId: string, open: LibraryHomeOpenCollection) => {
            if (isPersonalFmCard(card)) return playPersonalFm((card.raw as { personalFm?: PersonalFmSelection } | undefined)?.personalFm, providerId);
            open(port.describeOnlineCollection(onlineCardCollection(card), card.sourceProviderId ?? providerId));
            if (isPersonalFmCard(card)) return playPersonalFm((card.raw as { personalFm?: PersonalFmLaunch } | undefined)?.personalFm, providerId);
            open(port.describeOnlineCollection(onlineCardCollection(card), providerId));
            return OK;
        },

        openLocalGroup: (group: LocalLibraryGroup, open: LibraryHomeOpenCollection) => {
            open(port.describeLocalGroup(group));
        },

        openNavidromeCard: (card: LibraryHomeCard, type: NavidromeGridViewCollectionType, open: LibraryHomeOpenCollection) => {
            open(port.describeNavidromeCard(card, type));
        },
    };
};
