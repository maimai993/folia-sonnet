import { getFromCache, removeFromCache, saveToCache } from './db';
import { createSafeObjectUrl, isBlob } from '../utils/blobGuards';
import {
    clearCoverAssets,
    getCoverAssetUsage,
    readCoverAsset,
    removeCoverAsset,
    writeCoverAsset,
    type BinaryAssetWriteResult,
} from './binaryAssetStore';
import { resolveProxiedUrl } from './proxiedUrl';

interface StoredCoverDescriptor extends BinaryAssetWriteResult { }

const isStoredCoverDescriptor = (value: unknown): value is StoredCoverDescriptor => {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<StoredCoverDescriptor>;
    return (candidate.backend === 'opfs' || candidate.backend === 'electron')
        && typeof candidate.mimeType === 'string'
        && typeof candidate.size === 'number'
        && typeof candidate.updatedAt === 'number';
};

const buildCoverRequestUrl = (coverUrl: string): string => {
    // 只认 platform（只有 Electron 的 preload 会写）：安卓端的模组 shim 也装了
    // `window.electron`，按对象存在与否判断会让安卓跳过下面那段桥接逻辑。
    if (typeof window !== 'undefined' && typeof window.electron?.platform === 'string') return coverUrl;
    try {
        const hostname = new URL(coverUrl).hostname;
        if (hostname === 'y.gtimg.cn'
            || hostname === 'kugou.com' || hostname.endsWith('.kugou.com')
            || hostname === 'kgimg.com' || hostname.endsWith('.kgimg.com')) {
            // 安卓上这三个主机桥接得到（原生 OkHttp 直连，没有 CORS 这一说），
            // 走 proxy 反而会打到同源的 /api/lyric-proxy —— WebView 自己的服务器回一个
            // index.html，于是**一段 HTML 被当成封面 blob 存进缓存**（response.ok 还是 200，
            // 全程不报错，只表现为封面坏图/空白）。resolveProxiedUrl 在桥接得上时给原地址。
            return resolveProxiedUrl(coverUrl);
        }
    } catch {
        return coverUrl;
    }
    return coverUrl;
};

// 也在「从某首歌取一张集合封面」的地方用：那边只要一次远程封面的字节。
export const fetchCoverBlob = async (coverUrl: string): Promise<Blob> => {
// Also used where a remote cover's bytes are wanted once (a local collection cover taken from a song).
    const response = await fetch(buildCoverRequestUrl(coverUrl), { mode: 'cors' });
    if (response.ok === false) throw new Error(`Cover request failed: ${response.status}`);
    return await response.blob();
};

export async function getCachedCoverUrl(cacheKey: string): Promise<string | null> {
    const stored = await getFromCache<unknown>(cacheKey);
    if (isBlob(stored)) {
        const descriptor = await writeCoverAsset(cacheKey, stored).catch(() => null);
        if (!descriptor) {
            return createSafeObjectUrl(stored);
        }
        await saveToCache(cacheKey, descriptor);
        return createSafeObjectUrl(stored);
    }

    if (stored !== null && !isStoredCoverDescriptor(stored)) {
        await removeFromCache(cacheKey);
        await removeCoverAsset(cacheKey);
        return null;
    }

    const cachedCover = await readCoverAsset(cacheKey, isStoredCoverDescriptor(stored) ? stored.mimeType : undefined);
    if (!cachedCover) {
        if (stored) await removeFromCache(cacheKey);
        return null;
    }
    return createSafeObjectUrl(cachedCover);
}

/**
 * Whether a cover is already stored, without minting an object URL to find out.
 *
 * `getCachedCoverUrl` is the wrong question to ask when nothing is going to be displayed: it reads
 * the bytes and hands back a URL that a caller checking for mere existence then has to remember to
 * revoke. Reads the descriptor only, and accepts the legacy raw-Blob shape the same way the reader
 * above does, so a cover written before the asset store existed still counts as cached.
 */
export async function hasCachedCover(cacheKey: string): Promise<boolean> {
    const stored = await getFromCache<unknown>(cacheKey);
    return isBlob(stored) || isStoredCoverDescriptor(stored);
}

export async function loadCachedOrFetchCover(cacheKey: string, coverUrl?: string | null): Promise<string | null> {
    if (!coverUrl) return null;

    try {
        const cachedCoverUrl = await getCachedCoverUrl(cacheKey);
        if (cachedCoverUrl) {
            return cachedCoverUrl;
        }

        const coverBlob = await fetchCoverBlob(coverUrl);
        const descriptor = await writeCoverAsset(cacheKey, coverBlob).catch(() => null);
        if (descriptor) await saveToCache(cacheKey, descriptor);
        return createSafeObjectUrl(coverBlob) || coverUrl;
    } catch (error) {
        console.warn('Failed to cache cover:', error);
        return coverUrl;
    }
}

export async function saveCoverBlob(cacheKey: string, coverBlob: Blob): Promise<void> {
    const descriptor = await writeCoverAsset(cacheKey, coverBlob).catch(() => null);
    if (descriptor) {
        await saveToCache(cacheKey, descriptor);
        return;
    }
    await saveToCache(cacheKey, coverBlob);
}

// Replaces the cached online cover used by local-song playback without changing the audio file.
export async function cacheLocalSongOnlineCover(songId: string, coverUrl: string): Promise<boolean> {
    const cacheKey = `cover_local_${songId}`;
    await removeCachedCover(cacheKey);
    try {
        const descriptor = await writeCoverAsset(cacheKey, await fetchCoverBlob(coverUrl));
        if (!descriptor) return false;
        await saveToCache(cacheKey, descriptor);
        return true;
    } catch (error) {
        console.warn('[LocalMusic] Failed to cache matched cover:', error);
        return false;
    }
}

export async function removeCachedCover(cacheKey: string): Promise<void> {
    await Promise.all([removeFromCache(cacheKey), removeCoverAsset(cacheKey)]);
}

export { clearCoverAssets, getCoverAssetUsage };
