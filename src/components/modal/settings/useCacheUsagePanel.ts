import { startTransition, useEffect, useState } from 'react';
import { clearCacheByCategory, getCacheUsageByCategory } from '../../../services/db';
import { forgetSettledDrumHits } from '../../../services/analysis/drumHits';
import { clearMvMatchCache, clearMvMediaCacheBytes, readMvMediaCacheBytes, readMvMatchCacheBytes } from '../../../stores/useBilibiliMvStore';
import type { CacheCategory } from './pages/settingsPageContext';

// src/components/modal/settings/useCacheUsagePanel.ts
// 设置 → 存储里那一块缓存用量：各分类占多少、正在清哪一类、清理后重新量一遍。
// 从 SettingsModal 拆出来；缓存目录本身在主进程那一组里（useElectronSettingsPanel）。
//
// MV 那两类的读数与清理都在这里转出去：老的那个设置面板（SettingsModal）也用它，
// 但那一层不该认识平台名字 —— 两处共用这一份，顺便不会各自演化。

export {
    readMvMediaCacheBytes,
    readMvMatchCacheBytes,
    clearMvMatchCache,
    clearMvMediaCacheBytes,
} from '../../../stores/useBilibiliMvStore';

/**
 * 各分类用量 → 显示用的字符串。两个设置面板（老的那个和现在这一页）都要用，
 * 所以放在这里，别再各写一份 —— 以前两份就是「新加一类只在其中一处出现」的来源。
 */
export const formatCacheBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

/**
 * 一次用量读数 → 存储页每一行的文字。MV 匹配结果不在 IndexedDB 里，单独量。
 *
 * `mvMediaBytes` 由调用方异步量好传进来（那份要问原生，见 readMvMediaCacheBytes）。
 */
export const cacheSizeLabels = (
    usage: Awaited<ReturnType<typeof getCacheUsageByCategory>>,
    mvMediaBytes = 0,
): Record<CacheCategory, string> => ({
    playlist: formatCacheBytes(usage.playlist),
    lyrics: formatCacheBytes(usage.lyrics),
    cover: formatCacheBytes(usage.cover),
    media: formatCacheBytes(usage.media),
    analysis: formatCacheBytes(usage.analysis),
    volumeBalance: formatCacheBytes(usage.volumeBalance),
    mvMatch: formatCacheBytes(readMvMatchCacheBytes()),
    mvMedia: formatCacheBytes(mvMediaBytes),
});

export const useCacheUsagePanel = (activeTab: 'help' | 'options') => {
    // Cache State
    const [cacheSizes, setCacheSizes] = useState({
        playlist: '0 B',
        lyrics: '0 B',
        cover: '0 B',
        media: '0 B',
        analysis: '0 B',
        volumeBalance: '0 B',
        mvMatch: '0 B',
        mvMedia: '0 B'
    });
    const [mediaCount, setMediaCount] = useState(0);
    const [isCleaning, setIsCleaning] = useState<CacheCategory | null>(null);



    const applyCacheUsage = (
        usage: Awaited<ReturnType<typeof getCacheUsageByCategory>>,
        mvMediaBytes: number,
    ) => {
        setCacheSizes(cacheSizeLabels(usage, mvMediaBytes));
        setMediaCount(usage.mediaCount);
    };

    /**
     * 量一遍。
     *
     * MV 那份字节缓存要问原生（异步），而用量本身是同步读完的：两件事一起等，
     * 一起交给界面，免得那一行先显示 0 再跳成「38 MB」。
     */
    const fetchCacheUsage = async () => {
        const [usage, mvMediaBytes] = await Promise.all([
            getCacheUsageByCategory(),
            readMvMediaCacheBytes().catch(() => 0),
        ]);
        applyCacheUsage(usage, mvMediaBytes);
    };

    useEffect(() => {
        if (activeTab === 'options') {
            // Like the answers above, it lands while the window is opening.
            void Promise.all([
                getCacheUsageByCategory(),
                readMvMediaCacheBytes().catch(() => 0),
            ]).then(([usage, mvMediaBytes]) => startTransition(() => applyCacheUsage(usage, mvMediaBytes)));
        }
    }, [activeTab]);

    const handleClear = async (category: CacheCategory) => {
        setIsCleaning(category);
        if (category === 'mvMatch') {
            // 这一份不进 IndexedDB：清内存 + localStorage，两处都要动，否则重启又回来了。
            clearMvMatchCache();
        } else if (category === 'mvMedia') {
            // 只清盘上的字节，不动「配了哪条投稿」那条记录 —— 清完还能重新下载同一支 MV。
            await clearMvMediaCacheBytes();
        } else {
            await clearCacheByCategory(category);
        }
        // The drum hits' memory of which tracks are stored goes with the stored analyses.
        if (category === 'analysis') forgetSettledDrumHits();
        await fetchCacheUsage();
        setIsCleaning(null);
    };

    return { cacheSizes, mediaCount, isCleaning, clearCategory: handleClear };
};

export type CacheUsagePanel = ReturnType<typeof useCacheUsagePanel>;
