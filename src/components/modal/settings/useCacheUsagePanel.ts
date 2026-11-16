import { startTransition, useEffect, useState } from 'react';
import { clearCacheByCategory, getCacheUsageByCategory } from '../../../services/db';
import { forgetSettledDrumHits } from '../../../services/analysis/drumHits';
import { readMvMatchCacheBytes, useBilibiliMvStore } from '../../../stores/useBilibiliMvStore';
import type { CacheCategory } from './pages/settingsPageContext';

// src/components/modal/settings/useCacheUsagePanel.ts
// 设置 → 存储里那一块缓存用量：各分类占多少、正在清哪一类、清理后重新量一遍。
// 从 SettingsModal 拆出来；缓存目录本身在主进程那一组里（useElectronSettingsPanel）。

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
 */
export const cacheSizeLabels = (
    usage: Awaited<ReturnType<typeof getCacheUsageByCategory>>,
): Record<CacheCategory, string> => ({
    playlist: formatCacheBytes(usage.playlist),
    lyrics: formatCacheBytes(usage.lyrics),
    cover: formatCacheBytes(usage.cover),
    media: formatCacheBytes(usage.media),
    analysis: formatCacheBytes(usage.analysis),
    volumeBalance: formatCacheBytes(usage.volumeBalance),
    mvMatch: formatCacheBytes(readMvMatchCacheBytes()),
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
        mvMatch: '0 B'
    });
    const [mediaCount, setMediaCount] = useState(0);
    const [isCleaning, setIsCleaning] = useState<CacheCategory | null>(null);



    const applyCacheUsage = (usage: Awaited<ReturnType<typeof getCacheUsageByCategory>>) => {
        setCacheSizes(cacheSizeLabels(usage));
        setMediaCount(usage.mediaCount);
    };

    const fetchCacheUsage = async () => {
        applyCacheUsage(await getCacheUsageByCategory());
    };

    useEffect(() => {
        if (activeTab === 'options') {
            // Like the answers above, it lands while the window is opening.
            void getCacheUsageByCategory().then(usage => startTransition(() => applyCacheUsage(usage)));
        }
    }, [activeTab]);

    const handleClear = async (category: CacheCategory) => {
        setIsCleaning(category);
        if (category === 'mvMatch') {
            // 这一份不进 IndexedDB：清内存 + localStorage，两处都要动，否则重启又回来了。
            useBilibiliMvStore.getState().clear();
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
