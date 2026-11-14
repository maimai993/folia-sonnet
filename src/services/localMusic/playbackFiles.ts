import type { LocalSong } from '../../types';
import { createSafeObjectUrl } from '../../utils/blobGuards';
import { repairFlacMetadata } from '../../utils/flacMetadataRepair';
import { saveLocalSong } from '../db';
import { copyAndroidLocalAudio, nativeAudioUrlForRef } from '../nativeLocalMusic';
import { getAccessibleFileHandle, recoverFileHandleFromPersistedDirectory } from './fileHandles';
import { fileHandleMap } from './state';

// src/services/localMusic/playbackFiles.ts
// Turns a local song's bytes into something <audio> can play, from the desktop file handles and
// from the Android native loopback service.

type NativeAudioProbe = 'ok' | 'missing' | 'blocked';

/**
 * 播放前先问一次本机回环服务：这个 ref 到底还能不能取到字节。
 *
 * 之前是把 http://127.0.0.1:<port>/audio/<ref> 直接丢给 <audio> —— 副本丢了、空了、
 * 或者请求被网络栈（明文 / CORS / Range）挡掉，浏览器报出来**一模一样**：
 * networkState=3、mediaErrorCode=4，就一句 "MEDIA_ELEMENT_ERROR: Format error"。
 * 拿 1 个字节的 Range 请求先探一次，三种情况就能分开处理。
 */
async function probeNativeAudioUrl(url: string): Promise<NativeAudioProbe> {
    try {
        const response = await fetch(url, { headers: { Range: 'bytes=0-0' } });
        if (response.ok) return 'ok';
        // 服务侧对「文件不存在」和「文件是空的」都回 404（并把原因写进 logcat）。
        return response.status === 404 ? 'missing' : 'blocked';
    } catch {
        // fetch 直接抛：连字节都没拿到，属于网络层被挡，不是文件本身的问题。
        return 'blocked';
    }
}

/**
 * 把整首取成本地 Blob 再换 object URL。
 *
 * 这是非安卓本地播放一直在走的路（getAudioFromFile 也是 object URL）。换成它之后，
 * 回环地址在 <audio> 上可能遇到的 CORS / Range / 明文 / 混合内容这些环节全部不存在 ——
 * object URL 是同源资源。只在「流式那条路走不通」时才用，正常情况不花这个内存。
 */
async function blobUrlFromNativeAudioUrl(url: string): Promise<string | null> {
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        return createSafeObjectUrl(await response.blob());
    } catch {
        return null;
    }
}

/**
 * 按 ref 取一个能播的地址：拿得到就流式播，取不到字节就整首取成 Blob。
 * 返回 null 表示这个 ref 彻底不行（调用方据此决定要不要自己复制一份）。
 */
/**
 * 上一次播放失败的原因。
 *
 * 没有 logcat 的机器上，「无法访问文件，请重新导入文件夹」这一句等于什么都没说：
 * 副本丢了、请求被网络栈挡了、端口没拿到 —— 三种的处理方式完全不同。
 * 记下来交给界面显示，用户一眼就能把范围报出来。
 */
export type LocalAudioFailureReason = 'missing' | 'blocked' | 'no-ref' | 'no-server' | null;
let lastLocalAudioFailure: LocalAudioFailureReason = null;
export const getLastLocalAudioFailureReason = (): LocalAudioFailureReason => lastLocalAudioFailure;

async function playableUrlForNativeRef(ref: string): Promise<string | null> {
    const nativeUrl = await nativeAudioUrlForRef(ref);
    if (!nativeUrl) {
        lastLocalAudioFailure = 'no-server';
        return null;
    }
    const probe = await probeNativeAudioUrl(nativeUrl);
    if (probe === 'ok') {
        lastLocalAudioFailure = null;
        return nativeUrl;
    }
    if (probe === 'missing') {
        lastLocalAudioFailure = 'missing';
        return null;
    }
    const blobUrl = await blobUrlFromNativeAudioUrl(nativeUrl);
    lastLocalAudioFailure = blobUrl ? null : 'blocked';
    return blobUrl;
}

// Get audio blob from local song using fileHandle
// Returns blob URL if fileHandle exists, null otherwise
export async function getAudioFromLocalSong(song: LocalSong): Promise<string | null> {
    // 安卓原生曲库：文件在 MediaStore 或 App 私有目录里，WebView 拿不到句柄，
    // 走原生那个回环的小服务（地址按当前端口现拼，见 nativeAudioUrlForRef）。
    /*
     * 播放失败时最需要知道的就是「这首歌到底有没有 ref」。
     * 没有 ref 说明它压根不是原生入库的（或是旧版本导入、字段没写进去），
     * 再往下查回环服务是白费功夫 —— 这条路只会落到「重新导入」那句提示上。
     */
    if (!song.nativeAudioRef) {
        console.warn(
            `[LocalMusic] Song ${song.id} has no nativeAudioRef (filePath=${song.filePath ?? '(none)'});`
            + ' it was not imported through the Android native path.',
        );
    }
    if (song.nativeAudioRef) {
        /*
         * 探活结果必须打出来。
         *
         * 之前这里全程静默：直连失败 → 复制 → 复制也失败，最后才在函数末尾
         * 统一打一句「No accessible handle」。可那句提示指向「重新导入」，
         * 而真正的原因（回环服务 404 / 端口没起来 / 复制被拒）全被吞掉了，
         * 在真机上完全看不出该往哪查。
         */
        const ref = song.nativeAudioRef;
        const nativeUrl = await nativeAudioUrlForRef(ref);
        console.info(`[LocalMusic] Playback ref=${ref} url=${nativeUrl ?? '(no-port)'}`);
        const direct = await playableUrlForNativeRef(ref);
        if (direct) {
            lastLocalAudioFailure = null;
            return direct;
        }
        console.warn(`[LocalMusic] Direct playback failed for ref=${ref}, reason=${lastLocalAudioFailure ?? 'unknown'}; trying a private copy.`);

        /*
         * 自己复制一份。
         *
         * MediaStore 那一路（扫描设备音乐库）是按 id **现读用户原文件**的：
         * 文件被搬走、媒体库还没刷新、某个 ROM 不给读，播放就只剩一句
         * 「无法访问文件，请重新导入」—— 而用户的原文件根本没动过，
         * 让人重新导入整个文件夹毫无道理。这里把源文件的字节拷进 App 私有目录，
         * 之后这首歌只认那份副本，和「挑选导入」那条路一样，与 MediaStore 和权限脱钩。
         *
         * 只在真播不出来时拷这一首，不是扫描时整库复制 —— 那会平白占几个 G。
         */
        const copiedRef = await copyAndroidLocalAudio(song.nativeAudioRef, song.fileName, song.fileSize);
        if (copiedRef && copiedRef !== song.nativeAudioRef) {
            const copiedUrl = await playableUrlForNativeRef(copiedRef);
            if (copiedUrl) {
                // 记住新 ref：下次直接播副本，不用再拷贝一次。
                song.nativeAudioRef = copiedRef;
                void saveLocalSong(song).catch((error) => {
                    console.warn('[LocalMusic] Failed to persist the copied audio ref:', error);
                });
                return copiedUrl;
            }
        }

        // 原因必须写进日志：副本丢了 / 被网络栈挡了 / 服务没起来，三种的处理完全不同，
        // 而真机上那句「无法访问文件」本身看不出任何区别。
        console.warn(
            `[LocalMusic] Native audio unreachable for ${song.id}: ${song.nativeAudioRef}`
            + ` (reason: ${lastLocalAudioFailure ?? 'unknown'})`,
        );
        return null;
    }
    lastLocalAudioFailure = 'no-ref';

    const fileHandle = await getAccessibleFileHandle(song);

    if (fileHandle) {
        try {
            const file = await fileHandle.getFile();
            return await getAudioFromFile(file);
        } catch (error) {
            console.error('[LocalMusic] Failed to get file from handle:', error);
            // File may have been moved or the stored handle may have become stale.
            fileHandleMap.delete(song.id);
        }
    }

    const recoveredHandle = await recoverFileHandleFromPersistedDirectory(song);
    if (recoveredHandle) {
        try {
            const file = await recoveredHandle.getFile();
            return await getAudioFromFile(file);
        } catch (error) {
            console.error('[LocalMusic] Failed to get file from recovered directory handle:', error);
            fileHandleMap.delete(song.id);
        }
    }

    // No accessible handle available - permission may need to be restored or the file moved.
    console.warn(
        `[LocalMusic] No accessible handle for song ${song.id}.`
        + ` nativeAudioRef=${song.nativeAudioRef ?? '(none)'}`
        + ` filePath=${song.filePath ?? '(none)'}`
        + ` fileName=${song.fileName ?? '(none)'}`
        + ' Permission restore or re-import is required.',
    );
    return null;
}

/** Resolves the current File for playback recovery without changing the song or minting a URL. */
export async function getFileFromLocalSong(song: LocalSong): Promise<File | null> {
    const fileHandle = await getAccessibleFileHandle(song);
    if (fileHandle) {
        try {
            return await fileHandle.getFile();
        } catch (error) {
            console.warn(`[LocalMusic] Failed to read local recovery input for ${song.id}:`, error);
            fileHandleMap.delete(song.id);
        }
    }

    const recoveredHandle = await recoverFileHandleFromPersistedDirectory(song);
    if (!recoveredHandle) return null;
    try {
        return await recoveredHandle.getFile();
    } catch (error) {
        console.warn(`[LocalMusic] Failed to read recovered local input for ${song.id}:`, error);
        fileHandleMap.delete(song.id);
        return null;
    }
}

/**
 * The local file's raw bytes, for callers that need the audio itself rather than a URL to it.
 *
 * Automix separation is the caller: it must not mint a blob URL only to read it once and then have to
 * revoke it, and a local file never enters the online media cache, so its bytes are reachable only
 * from its own handle. Mirrors getAudioFromLocalSong's resolution (accessible handle, else a recover)
 * but returns the ArrayBuffer. Null when no handle can be reached - permission not restored, or moved.
 */
export async function getLocalSongArrayBuffer(song: LocalSong): Promise<ArrayBuffer | null> {
    const fileHandle = await getAccessibleFileHandle(song);
    if (!fileHandle) {
        console.warn(`[LocalMusic] No accessible handle for song ${song.id} (automix bytes)`);
        return null;
    }
    try {
        return await (await fileHandle.getFile()).arrayBuffer();
    } catch (error) {
        console.error('[LocalMusic] Failed to read local bytes:', error);
        fileHandleMap.delete(song.id);
        return null;
    }
}

// Get audio blob from File object (for file input imports)
export async function getAudioFromFile(file: File): Promise<string> {
    const url = createSafeObjectUrl(await repairFlacMetadata(file, true));
    if (!url) throw new TypeError('Local audio source must be a File or Blob');
    return url;
}
