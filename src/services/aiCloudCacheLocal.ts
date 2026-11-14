import { getFromCache, removeFromCache, saveToCache } from './db';
import type { AiCloudCacheKind } from './aiCloudCache';

// src/services/aiCloudCacheLocal.ts
// 云缓存的本地一层：同一个键问过一次，本机就记着答案（或者记着「云端没有」），下次先问本地。
//
// 为什么要有：云缓存每次命中都要发 HTTP —— 主题生成一路是「候选 GET + 最多几条按键直取」，
// 切歌、重播、重启、同一个人反复听同一首都是重来一遍。服务器扛不住，而这些东西本机明明刚拿到过。
// 所以本地存一份：命中就零请求，也顺手绕开安卓那条原生 OkHttp（后台被冻住时的老问题）。
//
// 存在哪儿：services/db 的缓存表，跟「AI 主题本机改过的那一份」（aiThemeCloud.ts）同一个抽屉，
// 设置里的「清空缓存」和按分类清都能一起清掉。答案本身是 JSON（主题 / 动画参数），不大。
//
// 两种键：
// - `ai_cloud_entry_v1_<kind>_<key>`：云端给过的答案，连它**是怎么认下来的**一起存（`how`）。
// - `ai_cloud_miss_v1_<kind>_<key>`：问过、云端当时没有。带 TTL —— 别人后来生成出来的答案
//   还得有机会拿到，所以定在半天，不是永久。
//
// 这里全部是「尽力而为」：读失败就当没有，写失败就当没写。缓存不能挡功能。

/** 答案的键前缀；`v1` 是为了以后改形状时不跟旧数据纠缠。 */
const ENTRY_PREFIX = 'ai_cloud_entry_v1_';
/** 「问过、没有」的键前缀。 */
const MISS_PREFIX = 'ai_cloud_miss_v1_';
/**
 * 本地 miss 留多久。
 *
 * 比内存里那 5 分钟长得多（那是防同一首歌在切歌之间连问），但也不能永久：这条 miss 说的是
 * 「问的那一刻云端没有」，而云缓存每天都在长 —— 别人生成完就推上去了。半天之后再问一次，
 * 既省掉绝大多数重复请求，也不至于让一首歌永远拿不到别人做好的答案。
 */
const MISS_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * 这份答案是**怎么被认下来**的，读的时候要看它。
 *
 * - `exact`：按精确键从云端取到的。只有「没歌词可判」的那条路（主题按歌名存、纯音乐、按键直取）
 *   会这么写，因为键在、内容未必是这首的（早年「强制匹配 + 回填」的历史包袱）。
 * - `words`：靠高亮词 100% 在场认下来的，内容一定跟着这份歌词走。
 * - `own`：本机自己生成、并且已经推上去的那一份。
 *
 * 有歌词可判的时候（舞台决策那条链）就不认 `exact` —— 跟 `pullAiCloudCache` 里
 * 「不读精确键」同一条纪律，本地这一层不能把它绕过去。
 */
export type LocalCloudEntryHow = 'exact' | 'words' | 'own';

export interface LocalCloudEntry {
    payload: unknown;
    how: LocalCloudEntryHow;
    at: number;
}

const entryKey = (kind: AiCloudCacheKind, key: string): string => `${ENTRY_PREFIX}${kind}_${key}`;
const missKey = (kind: AiCloudCacheKind, key: string): string => `${MISS_PREFIX}${kind}_${key}`;

const isEntryHow = (value: unknown): value is LocalCloudEntryHow => (
    value === 'exact' || value === 'words' || value === 'own'
);

/** 本地存着的答案，没有（或形状不认识）就是 null。 */
export const readLocalCloudEntry = async (kind: AiCloudCacheKind, key: string): Promise<LocalCloudEntry | null> => {
    try {
        const stored = await getFromCache<unknown>(entryKey(kind, key));
        if (!stored || typeof stored !== 'object') return null;
        const entry = stored as Partial<LocalCloudEntry>;
        if (!('payload' in entry) || entry.payload === undefined) return null;
        if (!isEntryHow(entry.how)) return null;
        return { payload: entry.payload, how: entry.how, at: Number(entry.at) || 0 };
    } catch (error) {
        console.warn('[AiCloudCacheLocal] read failed', error);
        return null;
    }
};

/** 把云端给的答案（或自己刚生成、刚推上去的那一份）落到本地。 */
export const writeLocalCloudEntry = async (
    kind: AiCloudCacheKind,
    key: string,
    payload: unknown,
    how: LocalCloudEntryHow,
): Promise<void> => {
    if (payload === null || payload === undefined) return;
    try {
        await saveToCache(entryKey(kind, key), { payload, how, at: Date.now() } satisfies LocalCloudEntry);
    } catch (error) {
        console.warn('[AiCloudCacheLocal] write failed', error);
    }
};

/** 本地那份不认识、或者不该再用了：扔掉，下次回云端问。 */
export const dropLocalCloudEntry = async (kind: AiCloudCacheKind, key: string): Promise<void> => {
    try {
        await removeFromCache(entryKey(kind, key));
    } catch (error) {
        console.warn('[AiCloudCacheLocal] drop failed', error);
    }
};

/** 本地记过「问过、云端没有」，且还没过期。 */
export const readLocalCloudMiss = async (kind: AiCloudCacheKind, key: string): Promise<boolean> => {
    try {
        const stored = await getFromCache<{ at?: unknown }>(missKey(kind, key));
        const at = Number(stored?.at);
        if (!Number.isFinite(at) || at <= 0) return false;
        if (Date.now() - at <= MISS_TTL_MS) return true;
        // 过期了就顺手清掉，别留着占地方。
        await removeFromCache(missKey(kind, key));
        return false;
    } catch (error) {
        console.warn('[AiCloudCacheLocal] miss read failed', error);
        return false;
    }
};

/** 记下「这个键问过、云端当时没有」。 */
export const rememberLocalCloudMiss = async (kind: AiCloudCacheKind, key: string): Promise<void> => {
    try {
        await saveToCache(missKey(kind, key), { at: Date.now() });
    } catch (error) {
        console.warn('[AiCloudCacheLocal] miss write failed', error);
    }
};

/** 不再算「没有」：推上去成功了，或者本地已经有答案了。 */
export const forgetLocalCloudMiss = async (kind: AiCloudCacheKind, key: string): Promise<void> => {
    try {
        await removeFromCache(missKey(kind, key));
    } catch (error) {
        console.warn('[AiCloudCacheLocal] miss drop failed', error);
    }
};
