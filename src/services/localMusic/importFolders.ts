import type { LocalSong } from '../../types';
import { useLyricSettingsStore } from '../../stores/useLyricSettingsStore';
import { deleteLocalSong as dbDeleteLocalSong, getDirHandles, getLocalLibrarySnapshot, getLocalSongs, saveLocalLibrarySnapshot, saveLocalSongs } from '../db';
import { fetchOnlineCoversForImportedSongs } from '../localCoverAutoFetch';
import type { PreparedLocalCoverBlob } from '../localCoverAssetService';
import {
    clearLocalRootRemoved,
    isLocalFolderIgnored,
    isLocalRootRemoved,
    normalizeLocalFolderPath,
    runLocalFolderMutation,
    setLocalFolderIgnored,
} from '../localLibraryFolderIgnore';
import { isAndroidNativeRuntime, pickAndroidLocalMusic, scanAndroidDeviceMusic } from '../nativeLocalMusic';
import { findImportedRootForHandle, getImportDirectoryHandle } from './fileHandles';
import { getLocalSongRootFolderName } from './folderPaths';
import { collectImportDiffPlan } from './importPlan';
import { notifyLocalMusicScanProgress, notifyLocalMusicUpdated } from './libraryEvents';
import { IMPORT_CONCURRENCY, formatImportDuration, mapWithConcurrency } from './scanFiles';
import { buildImportedSong, hydrateSongMetadata } from './songImport';
import { fileHandleMap, removedRootGenerations } from './state';

// src/services/localMusic/importFolders.ts
// Imports or rescans a folder: pick it, diff it, persist what changed, then hydrate metadata and
// fetch online covers in the background.

const HYDRATION_BATCH_SIZE = 25;
const HYDRATION_REFRESH_EVERY = 100;

async function hydrateImportedSongsInBackground(rootFolderName: string, songs: LocalSong[]) {
    const rootGeneration = removedRootGenerations.get(rootFolderName);
    const hydrationStartedAt = performance.now();
    const pendingBatch: LocalSong[] = [];
    let savedCount = 0;
    let nextIndex = 0;
    let flushInFlight: Promise<void> | null = null;

    notifyLocalMusicScanProgress({
        active: true,
        folderName: rootFolderName,
        totalSongs: songs.length,
        completedSongs: 0
    });

    const flushBatch = async (forceNotify = false) => {
        while (flushInFlight) {
            await flushInFlight;
        }
        if (pendingBatch.length === 0) {
            return;
        }

        const batch = pendingBatch.splice(0, pendingBatch.length);
        const currentFlush = (async () => {
            await runLocalFolderMutation(async () => {
                if (removedRootGenerations.get(rootFolderName) !== rootGeneration) return;
                const ignoredPaths = (await getLocalLibrarySnapshot(rootFolderName))?.ignoredFolderPaths || [];
                const visibleBatch = batch.filter(song => !isLocalFolderIgnored(song.folderName || song.filePath, ignoredPaths));
                if (visibleBatch.length > 0) await saveLocalSongs(visibleBatch);
            });
            savedCount += batch.length;
            if (forceNotify || savedCount % HYDRATION_REFRESH_EVERY === 0 || savedCount === songs.length) {
                notifyLocalMusicUpdated();
            }
            notifyLocalMusicScanProgress({
                active: true,
                folderName: rootFolderName,
                totalSongs: songs.length,
                completedSongs: savedCount
            });
            console.log(`[LocalMusic][Import] Background metadata hydration saved ${savedCount}/${songs.length} songs for "${rootFolderName}".`);
        })();
        flushInFlight = currentFlush;
        try {
            await currentFlush;
        } finally {
            if (flushInFlight === currentFlush) {
                flushInFlight = null;
            }
        }
    };

    const worker = async () => {
        while (true) {
            const currentIndex = nextIndex++;
            if (currentIndex >= songs.length) {
                return;
            }

            const hydratedSong = await hydrateSongMetadata(songs[currentIndex]);

            pendingBatch.push(hydratedSong);

            if (pendingBatch.length >= HYDRATION_BATCH_SIZE) {
                await flushBatch();
            }
        }
    };

    try {
        const workerCount = Math.min(IMPORT_CONCURRENCY, songs.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        while (pendingBatch.length > 0) {
            await flushBatch(true);
        }
        if (flushInFlight) {
            await flushInFlight;
        }
        console.log(`[LocalMusic][Import] Background metadata hydration for "${rootFolderName}" finished in ${formatImportDuration(performance.now() - hydrationStartedAt)}.`);
    } finally {
        notifyLocalMusicScanProgress({
            active: false,
            folderName: rootFolderName,
            totalSongs: songs.length,
            completedSongs: savedCount
        });
    }
}

// Import folder using File System Access API (if supported)
/**
 * ⚠️ 这份 `importFolder` **目前没有任何调用方**。
 *
 * 真正被首页用的是 `src/services/localMusicService.ts` 里的同名函数
 * （`createLibraryHomePort.ts` 从那里导入）。两份实现曾经分叉过：这里加了
 * 安卓分支、那边没加，于是安卓上点「导入文件夹」只会调 Web 的
 * `showDirectoryPicker`，加载动画闪一下就没了，系统文件管理器根本不弹。
 *
 * 那边现在已经补上同样的安卓分支。改这里的逻辑时**务必同步改那边**，
 * 否则又会变成「改了没生效」。长期看应该只留一份。
 */
export async function importFolder(expectedRootName?: string): Promise<LocalSong[]> {
    /*
     * 安卓没有 File System Access API，这里不能去调 showDirectoryPicker —— 它会直接抛
     * 「Local library unavailable」。改走原生：用系统文件管理器挑整个文件夹（或逐个文件），
     * 选中的音频由原生复制进私有目录，再通过回环地址播放。
     */
    if (isAndroidNativeRuntime()) {
        return await pickAndroidLocalMusic();
    }

    // Request access in the user gesture before waiting for other library writes.
    try {
        const dirHandle = await getImportDirectoryHandle(expectedRootName);
        if (!dirHandle) return [];
        return await runLocalFolderMutation(() => importFolderContents(dirHandle, expectedRootName));
    } catch (error) {
        if ((error as Error).name === 'AbortError') return [];
        throw error;
    }
}

async function importFolderContents(dirHandle: FileSystemDirectoryHandle, expectedRootName?: string): Promise<LocalSong[]> {
    try {
        const importStartedAt = performance.now();

        let rootFolderName = expectedRootName || dirHandle.name;
        let isRescanningExistingRoot = Boolean(expectedRootName);

        // If the picked directory is already imported, rescan the existing root instead of duplicating it.
        if (!expectedRootName) {
            const existingRootName = await findImportedRootForHandle(dirHandle);
            if (existingRootName) {
                rootFolderName = existingRootName;
                isRescanningExistingRoot = true;
                console.log(`[LocalMusic][Import] Directory "${dirHandle.name}" already imported as "${rootFolderName}", rescanning existing root.`);
            }
        }

        // If it's a new import (no expectedRootName), ensure the root folder name is unique
        if (!expectedRootName && !isRescanningExistingRoot) {
            const allSongs = await getLocalSongs();

            // Collect existing root folder names (the part before the first '/')
            const existingRootFolders = new Set(
                allSongs
                    .map(s => s.folderName)
                    .filter(Boolean)
                    .map(name => name!.split('/')[0])
            );

            let originalRootName = rootFolderName;
            let counter = 1;
            while (existingRootFolders.has(rootFolderName)) {
                counter++;
                rootFolderName = `${originalRootName} (${counter})`;
            }
        }

        // 用户把这个目录重新导进来了（之前删过）：墓碑撤掉，之后的刷新才不会把它又跳过去。
        await clearLocalRootRemoved(rootFolderName);

        const traversalStartedAt = performance.now();
        const allSongs = await getLocalSongs();
        const existingRootSongs = allSongs.filter(song =>
            song.folderName === rootFolderName || (song.folderName && song.folderName.startsWith(`${rootFolderName}/`))
        );
        const previousSnapshot = await getLocalLibrarySnapshot(rootFolderName);
        const diffPlan = await collectImportDiffPlan(
            rootFolderName,
            dirHandle,
            existingRootSongs,
            previousSnapshot,
            useLyricSettingsStore.getState().localLyricFormatOrder
        );
        console.log(`[LocalMusic][Import] Traversed ${diffPlan.relevantFileCount} relevant files in ${formatImportDuration(performance.now() - traversalStartedAt)}.`);

        // Save directory handle for persistence after a successful scan plan is built
        try {
            const { getDirHandles, saveDirHandles } = await import('../db');
            const dirHandles = await getDirHandles();
            dirHandles[rootFolderName] = dirHandle;
            await saveDirHandles(dirHandles);
            console.log(`[LocalMusic] Saved directory handle for ${rootFolderName}`);
        } catch (e) {
            console.error('[LocalMusic] Failed to save directory handle:', e);
        }

        const lyricIndexStartedAt = performance.now();
        console.log(`[LocalMusic][Import] Indexed ${diffPlan.lrcMap.size} lyric files, ${diffPlan.tlrcMap.size} translated lyric files, and ${diffPlan.coverMap.size} folder cover files in ${formatImportDuration(performance.now() - lyricIndexStartedAt)}.`);
        console.log(`[LocalMusic][Import] Snapshot diff for "${rootFolderName}": ${diffPlan.changedEntries.length} changed/new audio files, ${diffPlan.reusedSongs.length} unchanged audio files, ${diffPlan.removedSongs.length} removed audio files.`);

        // Second pass: Process audio files with limited concurrency
        const metadataStartedAt = performance.now();
        const existingSongsByPath = new Map(existingRootSongs.map(song => [song.filePath, song]));
        const coverBlobCache = new Map<string, Promise<PreparedLocalCoverBlob | undefined>>();
        const processedSongs = await mapWithConcurrency(diffPlan.changedEntries, IMPORT_CONCURRENCY, async (entry) => {
            try {
                return await buildImportedSong(
                    entry,
                    diffPlan.lrcMap,
                    diffPlan.tlrcMap,
                    diffPlan.coverMap,
                    coverBlobCache,
                    false,
                    existingSongsByPath.get(entry.relativePath)
                );
            } catch (error) {
                console.error(`Failed to import file ${entry.relativePath}:`, error);
                return {
                    song: null,
                    metrics: {
                        getFileMs: 0,
                        lyricReadMs: 0,
                        coverReadMs: 0,
                        parseMetadataMs: 0,
                        durationFallbackMs: 0,
                        usedDurationFallback: false
                    }
                };
            }
        });

        const songsToPersist = processedSongs
            .map(result => result.song)
            .filter((song): song is LocalSong => song !== null);
        const aggregateMetrics = processedSongs.reduce((acc, result) => {
            acc.getFileMs += result.metrics.getFileMs;
            acc.lyricReadMs += result.metrics.lyricReadMs;
            acc.coverReadMs += result.metrics.coverReadMs;
            acc.parseMetadataMs += result.metrics.parseMetadataMs;
            acc.durationFallbackMs += result.metrics.durationFallbackMs;
            acc.durationFallbackCount += result.metrics.usedDurationFallback ? 1 : 0;
            return acc;
        }, {
            getFileMs: 0,
            lyricReadMs: 0,
            coverReadMs: 0,
            parseMetadataMs: 0,
            durationFallbackMs: 0,
            durationFallbackCount: 0
        });
        console.log(`[LocalMusic][Import] Prepared ${songsToPersist.length} changed audio files with concurrency=${IMPORT_CONCURRENCY} in ${formatImportDuration(performance.now() - metadataStartedAt)}.`);
        console.log(
            `[LocalMusic][Import] Preparation breakdown: getFile=${formatImportDuration(aggregateMetrics.getFileMs)}, ` +
            `lyrics=${formatImportDuration(aggregateMetrics.lyricReadMs)}, ` +
            `folderCover=${formatImportDuration(aggregateMetrics.coverReadMs)}, ` +
            `parseBlob=${formatImportDuration(aggregateMetrics.parseMetadataMs)}, ` +
            `durationFallback=${formatImportDuration(aggregateMetrics.durationFallbackMs)} ` +
            `(${aggregateMetrics.durationFallbackCount} files).`
        );

        if (diffPlan.removedSongs.length > 0) {
            for (const song of diffPlan.removedSongs) {
                fileHandleMap.delete(song.id);
                await dbDeleteLocalSong(song.id);
            }
        }

        const importedSongs = [...diffPlan.reusedSongs];
        try {
            const persistStartedAt = performance.now();
            await saveLocalSongs(songsToPersist);
            await saveLocalLibrarySnapshot(diffPlan.snapshot);
            console.log(`[LocalMusic][Import] Persisted ${songsToPersist.length} changed songs in ${formatImportDuration(performance.now() - persistStartedAt)}.`);
            importedSongs.push(...songsToPersist);
        } catch (saveError) {
            console.error('Failed to save imported songs:', saveError);
            songsToPersist.forEach(song => fileHandleMap.delete(song.id));
            throw saveError;
        }

        console.log(`[LocalMusic][Import] Finished importing "${rootFolderName}" with ${importedSongs.length}/${diffPlan.totalAudioFiles} available songs in ${formatImportDuration(performance.now() - importStartedAt)}.`);
        notifyLocalMusicUpdated();
        void hydrateImportedSongsInBackground(rootFolderName, songsToPersist).catch(error => {
            console.error(`[LocalMusic][Import] Background metadata hydration failed for "${rootFolderName}":`, error);
        });
        /*
         * 联网补封面与后台抽内嵌封面并行跑，不等后者。
         *
         * 文件里没有内嵌封面的歌，原先要等「播到它」才在歌词匹配里顺手带回在线封面 ——
         * 于是刚导入完的这一屏全是占位色。这里立刻补；两边撞车（hydration 随后抽出了内嵌
         * 封面）由 localCoverAutoFetch 落库前重读一次解决，内嵌的那张优先。
         */
        fetchOnlineCoversForImportedSongs(importedSongs);

        return importedSongs;
    } catch (error) {
        if ((error as Error).name === 'AbortError') {
            // User cancelled the picker
            return [];
        }
        throw error;
    }
}

// Resync folder: refresh an imported folder in place using the persisted root handle
export async function resyncFolder(folderName: string): Promise<LocalSong[] | null> {
    // 安卓没有持久化的目录句柄可重扫：那边的歌来自设备音乐库，整库重扫走 resyncAllFolders，
    // 这里不能转去 importFolder —— 那会弹一次系统文件选择器，而用户点的是「刷新」。
    if (isAndroidNativeRuntime()) return null;

    // Only root imports have persisted directory handles. Derived child folders
    // should resync through their imported root folder handle.
    const rootFolderName = folderName.split('/')[0] || folderName;
    const importedSongs = await importFolder(rootFolderName);

    // If user cancelled (empty array), return null to indicate cancellation
    if (importedSongs.length === 0) {
        return null;
    }

    return importedSongs;
}

// Resyncs all imported local roots once, even when the song list contains nested folders.
export async function resyncAllFolders(): Promise<LocalSong[] | null> {
    // 安卓：设备音乐库重扫一次就够了。挑文件夹导入的那些文件已经在 App 私有目录里，
    // 不存在「按根重扫」这回事 —— 逐个根去调 importFolder 会连着弹好几次系统选择器。
    if (isAndroidNativeRuntime()) return await scanAndroidDeviceMusic();

    const allSongs = await getLocalSongs();
    const handles = await getDirHandles();
    const rootFolderNames = Array.from(new Set(
        [...Object.keys(handles), ...allSongs
            .map(getLocalSongRootFolderName)
            .filter((rootFolderName): rootFolderName is string => Boolean(rootFolderName))]
    ));

    if (rootFolderNames.length === 0) {
        return null;
    }

    const importedSongs: LocalSong[] = [];
    for (const rootFolderName of rootFolderNames) {
        // 删掉的根目录不该被刷新收回来（墓碑由「删除文件夹」写下，重新导入时撤掉）。
        if (await isLocalRootRemoved(rootFolderName)) continue;
        const rootSongs = await importFolder(rootFolderName);
        importedSongs.push(...rootSongs);
    }

    return importedSongs;
}

// Clear the app's ignore flag and rescan immediately; disk ignore rules still apply.
export async function clearFolderIgnore(folderName: string): Promise<void> {
    const rootFolderName = normalizeLocalFolderPath(folderName).split('/')[0];
    const dirHandle = await getImportDirectoryHandle(rootFolderName);
    if (!dirHandle) return;
    return runLocalFolderMutation(async () => {
        await setLocalFolderIgnored(folderName, false);
        await importFolderContents(dirHandle, rootFolderName);
    });
}
