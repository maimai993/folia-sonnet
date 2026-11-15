import type { LocalSong } from '../types';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { getLocalSongs, saveLocalSongs } from './db';
import { stageLocalCoverAsset } from './localCoverAssetService';
import { fetchOnlineCoversForImportedSongs } from './localCoverAutoFetch';
import { clearLocalRootRemoved, isLocalRootRemoved } from './localLibraryFolderIgnore';
import { buildImportedMetadataSnapshot } from '../utils/localSongMetadata';
import { parseEmbeddedMetadataAsync } from '../utils/localMetadataWorkerClient';
import { noteLibraryStep } from '../nativeBridge/api/libraryTrace.js';

// src/services/nativeLocalMusic.ts
/**
 * 安卓本地音乐。
 *
 * 网页那套「导入文件夹」用的是 File System Access API（`showDirectoryPicker` +
 * `navigator.storage.getDirectory`），**安卓 WebView 一个都不给** —— 于是本地曲库在 App 里
 * 直接被判成不可用，表现为「本地打不开」。这里改走原生：
 *
 * · 扫描设备音乐库（MediaStore）：读系统已经收录的音频，不用用户自己去翻文件管理器。
 * · 挑选文件 / 整个文件夹（Storage Access Framework）：挑中的由原生复制进 App 私有目录。
 *
 * 两种来源的音频都不能直接给 WebView：`content://` 播不了，私有目录它也不认。
 * 所以原生另起了一个只监听 127.0.0.1 的小服务（LocalAudioServer）把音频以 http 喂回来，
 * 而**端口每次启动都可能变** —— 因此歌里只存一个 ref，播放时按当前端口重新拼地址，
 * 绝不能把 URL 存死（否则重启后整库都播不了）。
 */

type NativeAudioTrack = {
    id: string;
    fileName: string;
    title?: string;
    artist?: string;
    album?: string;
    duration?: number;
    fileSize?: number;
    mimeType?: string;
    url: string;
};

type NativePickResponse = {
    tracks?: NativeAudioTrack[];
    port?: number;
    cancelled?: boolean;
    picked?: number;
    copied?: number;
    resultCode?: number;
    error?: string;
    failures?: Array<{ uri?: string; message?: string }>;
};

type NativeScanResponse = {
    tracks?: NativeAudioTrack[];
    /** 媒体库一首都没有、又没开"所有文件访问"时置位：先去开权限，再扫一遍。 */
    needsAllFilesAccess?: boolean;
};

type NativePlugin = {
    scanLocalAudio?: () => Promise<NativeScanResponse>;
    pickAudioFiles?: () => Promise<NativePickResponse>;
    pickAudioFolder?: () => Promise<NativePickResponse>;
    deleteImportedAudio?: (options: { refs: string[] }) => Promise<{
        deleted?: string[];
        failed?: string[];
    }>;
    localAudioServerPort?: () => Promise<{ port?: number }>;
    /** 取走外部应用送进来、页面还没领过音频（冷启动那一路）。 */
    takeExternalAudioUris?: () => Promise<NativePickResponse>;
    requestAllFilesAccess?: () => Promise<{ granted?: boolean }>;
    /**
     * 把一个 ref 指向的音频复制一份进 App 私有目录，返回新的 `imported-` ref。
     * 只在该首歌真的播不出来时才调，不是扫描时整库复制。
     */
    copyLocalAudio?: (options: {
        ref: string;
        /** 原文件名。私有副本丢了的时候，原生靠它回媒体库把原文件找回来重拷。 */
        fileName?: string;
        fileSize?: number;
    }) => Promise<{
        copied?: boolean;
        ref?: string;
        error?: string;
    }>;
};

export const ANDROID_MEDIA_FOLDER_NAME = 'Android 本地音乐';
export const ANDROID_IMPORTED_FOLDER_NAME = 'Android 文件导入';

export const isAndroidNativeRuntime = (): boolean => (
    typeof window !== 'undefined'
    && Capacitor.getPlatform() === 'android'
);

/**
 * `FoliaNative` 的那只手。
 *
 * ⚠️ 不能读 `window.Capacitor?.Plugins?.FoliaNative`：那是**没注册过的插件**所在的口袋，
 * Capacitor 只会往里面放 Web 端实现了的插件（@capacitor/*），我们自己那些原生插件一个都不在，
 * 于是这里恒为 null —— `pickAudioFolder` 判不可用、直接抛「Android audio picker is unavailable」，
 * 表现就是「点本地音乐选择文件夹，什么都不弹」。必须走 `registerPlugin`，它给的是代理，
 * 方法名问过去就是一次 native 调用。
 *
 * 代理对象不能拿 `typeof plugin.x === 'function'` 判存在（任何名字都是 function），
 * 所以「有没有这个方法」只能问 isPluginAvailable，或者干脆调一次让它自己报错。
 */
const FoliaNative = registerPlugin<NativePlugin>('FoliaNative');

const getPlugin = (): NativePlugin | null => (
    Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('FoliaNative') ? FoliaNative : null
);

const titleFromFileName = (fileName: string): string => (
    String(fileName || 'Unknown Song').replace(/\.[^.]+$/, '')
);

let resolvedAudioServerPort = 0;

/** 取（并缓存）本机音频服务的端口。拿不到返回 0，调用方据此判定「原生不可用」。 */
export const resolveNativeAudioServerPort = async (): Promise<number> => {
    if (resolvedAudioServerPort > 0) return resolvedAudioServerPort;
    const plugin = getPlugin();
    if (!plugin?.localAudioServerPort) return 0;
    try {
        const response = await plugin.localAudioServerPort();
        const port = Number(response?.port) || 0;
        if (port > 0) resolvedAudioServerPort = port;
        return port;
    } catch {
        return 0;
    }
};

/** 挑选接口回包里带着端口，顺手记下来，省掉一次往返。 */
const noteAudioServerPort = (port: unknown): void => {
    const value = Number(port) || 0;
    if (value > 0) resolvedAudioServerPort = value;
};

/**
 * 把 ref 指向的音频**自己复制一份**进 App 私有目录，返回新 ref（失败返回 null）。
 *
 * 用它的理由很直接：MediaStore 那一路是按 id 现读用户原文件的，
 * 文件被搬走、媒体库没刷新、或者某个 ROM 不给读，播放就只剩一句
 * 「无法访问文件，请重新导入」—— 而用户的原文件根本没动过，
 * 让人重新导入整个文件夹毫无道理。复制一份之后，播放只认 App 自己的副本，
 * 和「挑选导入」那条路一样，与 MediaStore 和权限彻底脱钩。
 *
 * 只在真播不出来时调一次，之后那首歌就用新 ref，不会再回到原文件。
 */
export const copyAndroidLocalAudio = async (
    ref: string,
    fileName?: string,
    fileSize?: number,
): Promise<string | null> => {
    const plugin = getPlugin();
    if (!ref || !plugin?.copyLocalAudio) return null;
    try {
        const response = await plugin.copyLocalAudio({
            ref,
            fileName: fileName || undefined,
            fileSize: Number(fileSize) > 0 ? Number(fileSize) : 0,
        });
        if (!response?.copied) {
            noteLibraryStep('local', 'copy:failed', { ref, error: response?.error });
            return null;
        }
        const next = response.ref;
        if (!next) return null;
        noteLibraryStep('local', 'copy:ok', { from: ref, to: next });
        return next;
    } catch (error) {
        noteLibraryStep('local', 'copy:error', {
            ref,
            message: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
};

export const nativeAudioUrlForRef = async (ref: string): Promise<string | null> => {
    if (!ref) return null;
    const port = await resolveNativeAudioServerPort();
    if (port <= 0) return null;
    return `http://127.0.0.1:${port}/audio/${encodeURIComponent(ref)}`;
};

/**
 * 带用户去系统设置开「所有文件访问」。
 *
 * 这是受限权限，App 弹窗要不来，只能跳设置页让用户手动开；回来的结果由原生回包告知。
 * 没有对应的插件方法（旧包 / 非安卓）时返回 false，调用方按"没授权"继续走。
 */
export const requestAndroidAllFilesAccess = async (): Promise<boolean> => {
    const plugin = getPlugin();
    if (!plugin?.requestAllFilesAccess) return false;
    try {
        const response = await plugin.requestAllFilesAccess();
        return response?.granted === true;
    } catch {
        return false;
    }
};

/**
 * 扫描设备音乐库（MediaStore）导入。
 *
 * 这是文件选择器之外的备用入口：选择器需要用户在系统文件管理器里自己找到文件，
 * 而音乐库扫描直接把系统已经收录的音频全部读进来，不需要逐首挑选。
 * 因此它依赖 READ_MEDIA_AUDIO 权限，插件会自行申请。
 *
 * 媒体库一首都没有时（有的 ROM 收录不全），原生会在没开"所有文件访问"的
 * 情况下置 needsAllFilesAccess —— 这里带用户去开一次，然后重扫（这次原生
 * 会按目录走文件系统兜底）；用户拒绝就按空结果收场，不再反复打扰。
 */
/**
 * @param includeRemovedRoots 把删掉的根目录也要回来。
 *
 * 「刷新」在安卓上走的就是这一条路（resyncAllFolders → 这里），所以默认**尊重**删除：
 * 用户删掉的目录不因为刷新就原样回来 —— 那正是「删不掉、一刷新又回来了」的来源。
 * 只有用户**显式**点「扫描设备音乐」才传 true，并且顺手把墓碑撤掉，之后刷新也留着。
 */
export const scanAndroidDeviceMusic = async (
    options: { includeRemovedRoots?: boolean } = {},
): Promise<LocalSong[]> => {
    const plugin = getPlugin();
    if (!plugin?.scanLocalAudio) {
        noteLibraryStep('local', 'scan:no-plugin');
        throw new Error('Android media scan is unavailable');
    }

    if (options.includeRemovedRoots) {
        await clearLocalRootRemoved(ANDROID_MEDIA_FOLDER_NAME);
    } else if (await isLocalRootRemoved(ANDROID_MEDIA_FOLDER_NAME)) {
        // 整个设备音乐库都被删掉了：刷新不该把它捞回来。
        noteLibraryStep('local', 'scan:root-removed');
        return [];
    }

    noteLibraryStep('local', 'scan:start');
    try {
        let response = await plugin.scanLocalAudio();
        if (response.needsAllFilesAccess) {
            noteLibraryStep('local', 'scan:needs-all-files');
            if (await requestAndroidAllFilesAccess()) {
                noteLibraryStep('local', 'scan:all-files-granted');
                response = await plugin.scanLocalAudio();
            } else {
                noteLibraryStep('local', 'scan:all-files-denied');
            }
        }
        const now = Date.now();
        const songs = (response.tracks || []).map((track): LocalSong => {
            const fileName = track.fileName || `track-${track.id}`;
            const title = track.title || titleFromFileName(fileName);
            return {
                id: `android-media-${track.id}`,
                fileName,
                filePath: `Android/MediaStore/${track.id}`,
                // 只记 ref：端口每次启动都变，存 URL 重启后就播不了。
                nativeAudioRef: track.id,
                duration: Number(track.duration) || 0,
                fileSize: Number(track.fileSize) || 0,
                fileLastModified: now,
                mimeType: track.mimeType || 'audio/*',
                addedAt: now,
                title,
                titleOrigin: 'import',
                importedMetadata: buildImportedMetadataSnapshot({
                    fileName,
                    fallbackTitle: title,
                    fallbackArtist: track.artist || '',
                    fallbackAlbum: track.album || '',
                }),
                folderName: ANDROID_MEDIA_FOLDER_NAME,
                hasManualLyricSelection: false,
                noAutoMatch: false,
            };
        });

        // 与挑文件那条路同一道兜底：同一份音频库里已经有了就不再加一条。
        // 先导入过、再扫设备音乐库（或反过来）拿到的是同一个文件，两条记录的 ref 不同，
        // 不去重就是「一首歌在库里有两份」。
        const existingSongs = songs.length > 0 ? await getLocalSongs() : [];
        const existingRefs = new Set(existingSongs.map(song => song.nativeAudioRef).filter(Boolean));
        const existingContent = new Set(
            existingSongs
                .map(song => pickedContentKey(song.fileName, song.fileSize))
                .filter((key): key is string => key !== null),
        );
        const freshSongs = songs.filter(song => {
            if (song.nativeAudioRef && existingRefs.has(song.nativeAudioRef)) return false;
            const contentKey = pickedContentKey(song.fileName, song.fileSize);
            return !(contentKey && existingContent.has(contentKey));
        });

        if (freshSongs.length > 0) {
            await saveLocalSongs(freshSongs);
            // MediaStore 这条路连文件字节都没读（没有内嵌封面可抽），整批歌的封面只能靠联网。
            // 不在这里补的话，扫完设备音乐看到的就是一屏占位色。
            fetchOnlineCoversForImportedSongs(freshSongs);
        }
        noteLibraryStep('local', 'scan:done', {
            songs: freshSongs.length,
            alreadyInLibrary: songs.length - freshSongs.length,
        });
        return freshSongs;
    } catch (error) {
        noteLibraryStep('local', 'scan:error', {
            message: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
};

/**
 * 「同一份音频」的判别键：文件名 + 字节数。
 *
 * 大小读不出来（部分 provider 不给 `OpenableColumns.SIZE`）时返回 null —— 那时候不敢按内容判，
 * 两个同名的不同文件会被并成一首。
 */
const pickedContentKey = (fileName: string | undefined, fileSize: number | undefined): string | null => {
    const size = Number(fileSize) || 0;
    if (size <= 0) return null;
    return `${(fileName || '').toLowerCase()}|${size}`;
};

/**
 * 挑中的音频去重（同一批里只留一份）。
 *
 * 「挑单个音频文件」这条路在部分系统上会把同一个文件给两遍（ClipData 里一份、`getData()` 里一份，
 * 或者 provider 同时给了文档 uri 与媒体 uri 两种形式）；原生那边 ref 是按「文件名 + 大小」算的，
 * 只要那一趟大小没读出来，同一个文件就会算出两个 ref —— 落库就是**两份一模一样的歌**。
 * 这里两层收口：ref 完全相同、或者文件名与大小都相同。
 */
export const dedupePickedTracks = (tracks: NativeAudioTrack[]): NativeAudioTrack[] => {
    const seenRefs = new Set<string>();
    const seenContent = new Set<string>();
    return tracks.filter(track => {
        const ref = track.id;
        if (ref) {
            if (seenRefs.has(ref)) return false;
            seenRefs.add(ref);
        }
        const contentKey = pickedContentKey(track.fileName, track.fileSize);
        if (contentKey) {
            if (seenContent.has(contentKey)) return false;
            seenContent.add(contentKey);
        }
        return true;
    });
};

/**
 * 用系统文件管理器（Storage Access Framework）挑选音频文件。
 *
 * 优先挑整个文件夹（用户一次选一张专辑 / 一个目录），原生侧递归扫出里面的音频；
 * 旧设备上没有这个方法时退回逐个挑文件。
 *
 * 选中的文件由原生侧复制进 App 私有目录，之后通过本机回环地址流式播放，
 * 所以不依赖 MediaStore 是否收录过这些文件，也不需要整盘存储权限。
 */
export type ImportedTracksResult = {
    /** 这次真的新写进本机曲库的（库里原本没有）。 */
    fresh: LocalSong[];
    /**
     * 这批曲目在曲库里的最终记录：新增的就是新记录，库里已有的用**已有那条**。
     *
     * 外部打开那条路要拿它去加歌单 —— 用户再打开一次同一个文件时，曲库里已经有了，
     * 可「加到歌单」这件事还得照做，否则表现就是「提示已经在曲库里了，但歌单里没有」。
     */
    resolved: LocalSong[];
};

/**
 * 一批原生已经拷好的音频 → 本机曲库里的记录，并落库。
 *
 * 「挑文件导入」和外部打开（"用 Folia 打开" / 分享，见 takeExternalAudioTracks）共用：
 * 两条路从原生拿到的都是同一套 { id, fileName, fileSize, mimeType, url }，
 * 所以读内嵌元数据、与库里已有音频去重、写库这些后处理只写一份。
 */
const buildAndStoreImportedTracks = async (tracks: NativeAudioTrack[]): Promise<ImportedTracksResult> => {
    const now = Date.now();
    const songs: LocalSong[] = [];

    for (const track of tracks) {
        const fileName = track.fileName || `track-${track.id}`;
        const fallbackTitle = titleFromFileName(fileName);
        let metadata: Awaited<ReturnType<typeof parseEmbeddedMetadataAsync>> = null;
        let metadataError: string | undefined;
        try {
            // 回环地址是跨源的，LocalAudioServer 那边带 `Access-Control-Allow-Origin: *`。
            const blob = await (await fetch(track.url)).blob();
            metadata = await parseEmbeddedMetadataAsync(new File([blob], fileName, {
                type: track.mimeType || 'audio/*',
            }), true);
        } catch (error) {
            metadataError = error instanceof Error ? error.message : String(error);
            console.warn('[NativeLocalMusic] Failed to parse embedded metadata', fileName, error);
        }
        noteLibraryStep('local', 'pick:track', {
            fileName,
            fileSize: track.fileSize,
            metadata: metadata ? 'ok' : 'none',
            cover: metadata?.coverAssetId ? 'ok' : 'none',
            metadataError,
        });

        /*
         * 内嵌封面在这一刻就落盘。
         *
         * 字节已经取回来了（上面解析元数据就是拿它解的），顺手抽出封面就行；不写的话
         * 这首歌要等到「播到它」或「首页本地页签回填」那两趟才有封面 —— 磁贴墙铺的是
         * 队列快照，那一刻没封面就一直空白。stage 之后的真正落盘在 saveLocalSongs →
         * assignImportedSongs → prepareLocalSongsCoverAssets。
         */
        if (metadata?.cover && metadata.coverAssetId) {
            stageLocalCoverAsset(metadata.coverAssetId, metadata.cover);
        }

        const title = metadata?.title || fallbackTitle;
        songs.push({
            id: `android-imported-${track.id}`,
            fileName,
            filePath: `Android/Imported/${track.id}`,
            nativeAudioRef: track.id,
            duration: Number(metadata?.duration) || Number(track.duration) || 0,
            fileSize: Number(track.fileSize) || 0,
            fileLastModified: now,
            mimeType: track.mimeType || 'audio/*',
            addedAt: now,
            title,
            titleOrigin: 'import',
            importedMetadata: buildImportedMetadataSnapshot({
                fileName,
                embeddedTitle: metadata?.title,
                fallbackTitle,
                embeddedArtist: metadata?.artist,
                embeddedArtists: metadata?.artists,
                fallbackArtist: track.artist || '',
                embeddedAlbum: metadata?.album,
                fallbackAlbum: track.album || '',
            }),
            folderName: ANDROID_IMPORTED_FOLDER_NAME,
            localCoverAssetId: metadata?.coverAssetId,
            localCoverSource: metadata?.cover ? 'embedded' : undefined,
            hasManualLyricSelection: false,
            noAutoMatch: false,
        });
    }

    // 第二道兜底：库里已经有了的同一份音频不再加一条（见 pickedContentKey）。
    // 查重的同时把「库里已有的那条」也记下来：不重复加，但该加的歌单还得加。
    const existingSongs = songs.length > 0 ? await getLocalSongs() : [];
    const existingByRef = new Map<string, LocalSong>();
    const existingByContent = new Map<string, LocalSong>();
    existingSongs.forEach(song => {
        if (song.nativeAudioRef && !existingByRef.has(song.nativeAudioRef)) {
            existingByRef.set(song.nativeAudioRef, song);
        }
        const contentKey = pickedContentKey(song.fileName, song.fileSize);
        if (contentKey && !existingByContent.has(contentKey)) {
            existingByContent.set(contentKey, song);
        }
    });

    const freshSongs: LocalSong[] = [];
    const resolvedSongs: LocalSong[] = [];
    songs.forEach(song => {
        const contentKey = pickedContentKey(song.fileName, song.fileSize);
        const already = (song.nativeAudioRef ? existingByRef.get(song.nativeAudioRef) : undefined)
            ?? (contentKey ? existingByContent.get(contentKey) : undefined);
        if (already) {
            resolvedSongs.push(already);
            return;
        }
        freshSongs.push(song);
        resolvedSongs.push(song);
    });

    if (freshSongs.length !== songs.length) {
        noteLibraryStep('local', 'pick:already-in-library', {
            picked: songs.length,
            fresh: freshSongs.length,
        });
    }

    if (freshSongs.length > 0) {
        await saveLocalSongs(freshSongs);
        noteLibraryStep('local', 'pick:saved', { songs: freshSongs.length });
        // 文件里没内嵌封面的歌（原生解析拿不到 cover 的那种）立刻去在线平台要一张，
        // 不用等播到它。扫描设备音乐与外部音频导入都走这里，所以挂在这一处就够。
        fetchOnlineCoversForImportedSongs(freshSongs);
    }
    return { fresh: freshSongs, resolved: resolvedSongs };
};

export const pickAndroidLocalMusic = async (): Promise<LocalSong[]> => {
    const plugin = getPlugin();
    if (!plugin) {
        const platform = Capacitor.getPlatform();
        const available = Capacitor.isPluginAvailable('FoliaNative');
        noteLibraryStep('local', 'pick:no-plugin', {
            hasPlugin: false,
            platform,
            pluginAvailable: available,
        });
        /*
         * 把判据一起说出来。
         *
         * 以前这里只抛一句「Android audio picker is unavailable」，
         * 真机上用户看到的就是「点了没反应」—— 分不清是
         * 「跑在浏览器里」、「原生插件没注册」还是「插件注册了但方法不在」。
         * 这三种的修法完全不同，所以把 platform / available 一起带上。
         */
        throw new Error(
            `Android audio picker is unavailable（platform=${platform}, pluginAvailable=${available}）`,
        );
    }
    // 代理上任何名字都是 function，所以「选文件夹」这条入口默认就在；挑不到时原生侧会 reject，
    // 那一次再回落成「选单个文件」。这份回落只为「插件比页面旧」这一种情况留着。
    const source = 'folder';

    noteLibraryStep('local', 'pick:start', { source });
    let response: NativePickResponse;
    try {
        response = await plugin.pickAudioFolder!();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        noteLibraryStep('local', 'pick:error', { message });
        /*
         * 插件比页面旧（原生侧还没有 pickAudioFolder）时，代理把调用送过去会以
         * 「not implemented on Android」回来。那不是用户的错，也不该让整条导入链断掉 ——
         * 回落到「选单个文件」那条老路，用户照样能把歌导进来。
         */
        if (/not implemented|unavailable|not found/i.test(message) && !/already open/i.test(message)) {
            noteLibraryStep('local', 'pick:fallback-files', { message });
            response = await plugin.pickAudioFiles!();
        } else {
            throw error;
        }
    }

    const failures = Array.isArray(response.failures) ? response.failures : [];
    noteLibraryStep('local', 'pick:result', {
        cancelled: response.cancelled === true,
        picked: response.picked ?? (response.tracks || []).length,
        copied: response.copied ?? (response.tracks || []).length,
        tracks: (response.tracks || []).length,
        resultCode: response.resultCode,
        error: response.error,
        failures: failures.length,
        firstFailure: failures[0]?.message,
        port: response.port,
    });

    if (response.cancelled) return [];
    noteAudioServerPort(response.port);

    // 同一个文件在系统上被给了两遍时只留一份（见 dedupePickedTracks）。
    const rawTracks = response.tracks || [];
    const tracks = dedupePickedTracks(rawTracks);
    if (tracks.length !== rawTracks.length) {
        noteLibraryStep('local', 'pick:deduped', {
            returned: rawTracks.length,
            kept: tracks.length,
        });
    }

    const { fresh: songs } = await buildAndStoreImportedTracks(tracks);
    if (tracks.length > 0 && songs.length === 0) {
        // 挑到了、但库里全都有：这不是失败，别去抛下面那个「一个都没进来」。
        return [];
    }
    if (tracks.length === 0) {
        if (failures.length > 0) {
            // 选了文件却一个都没进来：把原生侧的原因抛出去，界面至少会报错，
            // 而不是像以前那样静默什么都不做。
            throw new Error(`Imported 0 of ${failures.length} picked file(s): ${failures[0]?.message || 'unknown error'}`);
        } else if (response.error) {
            // RESULT_OK 却没给出任何可读的 uri：这是原生侧明确的异常，同样要报出来。
            throw new Error(response.error);
        }
    }
    return songs;
};

// ---- 外部打开 / 分享（文件管理器里「用 Folia 打开」）----

export type ExternalAudioPayload = {
    tracks: NativeAudioTrack[];
    port?: number;
};

type EventListenerPlugin = NativePlugin & {
    addListener?: (
        eventName: string,
        listener: (payload: { tracks?: NativeAudioTrack[]; port?: number }) => void,
    ) => Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> };
};

/**
 * 取走「外部送进来、原生已经拷好但页面还没领过」的那批音频。
 *
 * 从别的应用打开文件时 App 通常是冷启动的：那时页面还没加载完，一个监听者都没有，
 * 原生只能先把拷好的曲目攒着；页面起来后调一次这个方法把它们领走。
 */
export const takeExternalAudioTracks = async (): Promise<ExternalAudioPayload> => {
    const plugin = getPlugin() as EventListenerPlugin | null;
    if (!plugin?.takeExternalAudioUris) return { tracks: [] };
    try {
        const response = await plugin.takeExternalAudioUris();
        const tracks = Array.isArray(response?.tracks) ? response.tracks : [];
        noteAudioServerPort(response?.port);
        noteLibraryStep('local', 'external:take', { tracks: tracks.length });
        return { tracks, port: Number(response?.port) || undefined };
    } catch (error) {
        noteLibraryStep('local', 'external:take-error', {
            message: error instanceof Error ? error.message : String(error),
        });
        return { tracks: [] };
    }
};

/**
 * 应用已经在前台时又从别的应用打开了音频：原生直接发事件过来，不必轮询。
 * 返回值是取消订阅的函数。
 */
export const subscribeExternalAudio = (
    listener: (payload: ExternalAudioPayload) => void,
): (() => void) => {
    const plugin = getPlugin() as EventListenerPlugin | null;
    if (!plugin?.addListener) return () => undefined;
    let handle: { remove: () => Promise<void> } | { remove: () => void } | null = null;
    let disposed = false;
    const registered = plugin.addListener('externalAudio', payload => {
        if (disposed) return;
        const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
        if (tracks.length === 0) return;
        noteAudioServerPort(payload?.port);
        noteLibraryStep('local', 'external:event', { tracks: tracks.length });
        listener({ tracks, port: Number(payload?.port) || undefined });
    });
    Promise.resolve(registered)
        .then(resolved => {
            if (disposed) {
                void resolved.remove();
                return;
            }
            handle = resolved;
        })
        .catch(() => undefined);
    return () => {
        disposed = true;
        if (handle) void handle.remove();
    };
};

/**
 * 用户点头之后：这批拷好的音频正式进本机曲库。
 *
 * 返回 fresh（这次新写进去的）与 resolved（这批曲目在曲库里的记录，含原本就有的）。
 * 加歌单要用 resolved：用户第二次打开同一个文件时 fresh 是空的，但「加进歌单」照样得做。
 */
export const importExternalAudioTracks = async (tracks: NativeAudioTrack[]): Promise<ImportedTracksResult> => {
    const unique = dedupePickedTracks(tracks);
    noteLibraryStep('local', 'external:import', { tracks: unique.length });
    if (unique.length === 0) return { fresh: [], resolved: [] };
    return await buildAndStoreImportedTracks(unique);
};

/**
 * 用户摇头之后：把已经拷进私有目录的副本删掉。
 *
 * 文件是 intent 一进来就拷的（content:// 的读授权只在 intent 存活期间有效，等用户看完
 * 「是否导入」再读很可能已经作废），所以拒绝这一步必须连副本一起收回，不能只在数据上不管它。
 */
export const discardExternalAudioTracks = async (tracks: NativeAudioTrack[]): Promise<void> => {
    const refs = tracks.map(track => track.id).filter(Boolean);
    if (refs.length === 0) return;
    noteLibraryStep('local', 'external:discard', { refs: refs.length });
    await deleteAndroidImportedAudio(refs);
};

/**
 * 删除安卓导入时复制进 App 私有目录的音频副本。
 *
 * 「从库中删除」以前只删数据库记录，私有目录里的副本会一直留着占空间；这里把副本也清掉。
 * 只处理 `imported-*` 这种 App 自己写出的文件名，扫描设备音乐库得到的歌是引用用户原文件，
 * 永远不走这个入口。
 */
export const deleteAndroidImportedAudio = async (
    refs: string[],
): Promise<{ deleted: string[]; failed: string[] }> => {
    const candidates = Array.from(new Set(
        refs.filter((ref): ref is string => typeof ref === 'string' && ref.startsWith('imported-')),
    ));
    if (candidates.length === 0) return { deleted: [], failed: [] };

    const plugin = getPlugin();
    if (!plugin?.deleteImportedAudio) {
        noteLibraryStep('local', 'delete:no-plugin', { refs: candidates.length });
        return { deleted: [], failed: candidates };
    }

    try {
        const response = await plugin.deleteImportedAudio({ refs: candidates });
        const deleted = Array.isArray(response?.deleted) ? response.deleted : [];
        const failed = Array.isArray(response?.failed) ? response.failed : [];
        noteLibraryStep('local', 'delete:done', {
            requested: candidates.length,
            deleted: deleted.length,
            failed: failed.length,
        });
        return { deleted, failed };
    } catch (error) {
        noteLibraryStep('local', 'delete:error', {
            requested: candidates.length,
            message: error instanceof Error ? error.message : String(error),
        });
        return { deleted: [], failed: candidates };
    }
};
