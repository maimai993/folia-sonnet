import { isLocalLibraryAutoScanSupported } from '../../../../../services/localLibraryAutoScan';
import { option, type SettingsGroupDef } from '../../kit';

// src/components/modal/settings/pages/storage/options.ts
// The groups and options of the 存储与备份 page, declared apart from the page so the files that
// draw its rows name the same ones. The four group ids are the ids other code opens the settings on.

export const MEDIA: SettingsGroupDef = { id: 'mediaCache', titleKey: 'options.mediaCache' };
export const CACHES: SettingsGroupDef = { id: 'cacheDetails', titleKey: 'options.cacheDetails' };
// Drawn only where the browser can watch a folder (FolderWatchGroup).
export const WATCH: SettingsGroupDef = { id: 'localLibraryWatch', titleKey: 'options.localLibraryWatch', available: isLocalLibraryAutoScanSupported };
export const BACKUP: SettingsGroupDef = { id: 'importExportTitle', titleKey: 'options.importExportTitle' };

/** What the app keeps on disk, one row each, in the order they are drawn. */
export const CACHE_ROWS = [
    { category: 'playlist', option: option(CACHES, 'cachePlaylist', 'options.playlistData') },
    { category: 'lyrics', option: option(CACHES, 'cacheLyrics', 'options.lyrics') },
    { category: 'cover', option: option(CACHES, 'cacheCover', 'options.covers') },
    { category: 'media', option: option(CACHES, 'cacheMedia', 'options.mediaFiles') },
    { category: 'analysis', option: option(CACHES, 'cacheAnalysis', 'options.analysisData') },
    { category: 'volumeBalance', option: option(CACHES, 'cacheVolumeBalance', 'options.volumeBalanceData') },
    // B 站 MV：匹配到了哪条投稿，以及用户手动钉的那一条。只存结果不存直链（见 useBilibiliMvStore）。
    { category: 'mvMatch', option: option(CACHES, 'cacheMvMatch', 'options.mvMatchData') },
    // MV 的**音视频字节**（画面 + 音轨，见 mvMediaCache.ts）：与上面那行是两件事，
    // 一个是几十字节的记录、一个是几十兆的媒体文件，所以分开量、分开清。
    { category: 'mvMedia', option: option(CACHES, 'cacheMvMedia', 'options.mvMediaData') },
] as const;

export const O = {
    mediaCache: option(MEDIA, 'enableMediaCache', 'options.enableMediaCache'),
    cacheDirectory: option(MEDIA, 'cacheDirectory', 'options.cacheDirectory', { electronOnly: true }),
    cacheLimit: option(MEDIA, 'mediaCacheLimit', 'options.mediaCacheLimit', { electronOnly: true }),
    autoScan: option(WATCH, 'localLibraryAutoScan', 'options.localLibraryAutoScan'),
    exportConfig: option(BACKUP, 'exportConfig', 'options.exportThemeLabel'),
    importConfig: option(BACKUP, 'importConfig', 'options.importBtn'),
};
