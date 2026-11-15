// src/services/mediaCacheMigration.ts
/**
 * 把上一版的媒体缓存从 IndexedDB 清掉：能搬的搬进 App 私有目录，搬不动的直接删。
 *
 * 旧副本躺在 IndexedDB 里，取出来只能是 `blob:` 地址，而原生播放器吃不下 `blob:` ——
 * 于是缓存里的歌恰恰是原生播不了的那批。搬进私有目录之后播放拿的是回环地址，
 * 原生与 <audio> 都能读。
 *
 * **旧的那份一律删除**，不再以「写原生失败就留着」为兜底：留在 IndexedDB 里的旧
 * `blob:` 副本正是换歌来回切时两路音频重叠的祸根（旧条目让一部分歌回落 <audio>，
 * 而原生那边还握着同一首）。写失败的条目删掉就是了 —— 那首歌回头重新拉一次，
 * 拉完自然写进新的私有目录缓存；比让一份播放路径来路不明的旧数据留着强。
 *
 * 同一前缀下不是 Blob 的条目（`audioLevel_<songKey>` 这类元数据）不是这份缓存，
 * 不动，删了会丢信息。
 *
 * 只在安卓上跑（拿不到回环端口就直接返回），标记**整批跑完之后**才写：
 * 中途被杀或退出，下次启动接着清 —— 已经清走的那些不会再出现，也不会漏。
 * 标记升到 v2：v1 只保证「搬过」，搬失败的会留下；v2 那一遍把 leftovers 清干净。
 */

import { getCacheKeysByPrefix, getFromCache, removeFromCache } from './db';
import { cacheLimitBytes } from './audioCache';
import { hasNativeMediaCache, writeNativeMediaCache } from './mediaCacheStore';
import { isBlob } from '../utils/blobGuards';

/** 搬完的标记。**只有**整批跑完才写，见文件头。 */
const MIGRATION_FLAG_KEY = 'folia_media_cache_migrated_v2';
/** 缓存条目的前缀（resourceKeys 里 `audio_<songKey>`）。 */
const AUDIO_CACHE_PREFIX = 'audio_';

export interface MediaCacheMigrationProgress {
    done: number;
    total: number;
}

export interface MediaCacheMigrationResult {
    /** 成功搬进私有目录的条数。 */
    migrated: number;
    /** 没搬成、直接删掉的条数（超限或写原生失败）。 */
    dropped: number;
    total: number;
    skipped: boolean;
}

const readFlag = (): boolean => {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem(MIGRATION_FLAG_KEY) === '1';
    } catch {
        return false;
    }
};

const writeFlag = (): void => {
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(MIGRATION_FLAG_KEY, '1');
    } catch {
        // 存不下就算了：最坏是下次启动再清一遍空目录。
    }
};

/** 让一帧给界面：进度条要能动，整批清的时候不能把主线程焊死。 */
const yieldToUi = (): Promise<void> => new Promise(resolve => {
    setTimeout(resolve, 0);
});

/**
 * 清一遍。
 *
 * 逐条处理而不是 `getCacheEntriesByPrefix` 一把全读：那个接口会把每一份字节都读进内存，
 * 缓存上百 MB 时直接把 WebView 顶爆。这里一次只有一首歌在内存里。
 */
export const migrateLegacyMediaCache = async (
    onProgress?: (progress: MediaCacheMigrationProgress) => void,
): Promise<MediaCacheMigrationResult> => {
    if (!(await hasNativeMediaCache())) return { migrated: 0, dropped: 0, total: 0, skipped: true };
    if (readFlag()) return { migrated: 0, dropped: 0, total: 0, skipped: true };

    const keys = await getCacheKeysByPrefix([AUDIO_CACHE_PREFIX]);
    if (keys.length === 0) {
        writeFlag();
        return { migrated: 0, dropped: 0, total: 0, skipped: false };
    }

    const limit = cacheLimitBytes();
    let migrated = 0;
    let dropped = 0;
    let done = 0;
    for (const key of keys) {
        const value = await getFromCache<unknown>(key);
        // 同一前缀下还有别的东西（元数据，不是字节）：不是 Blob 的一律不动。
        if (isBlob(value)) {
            const wrote = await writeNativeMediaCache(key, value, limit);
            // 旧的那份无论如何都删：写失败也删，见文件头 —— 留着就是两路音频的祸根。
            await removeFromCache(key);
            if (wrote) migrated += 1;
            else dropped += 1;
        }
        done += 1;
        onProgress?.({ done, total: keys.length });
        await yieldToUi();
    }

    writeFlag();
    return { migrated, dropped, total: keys.length, skipped: false };
};
