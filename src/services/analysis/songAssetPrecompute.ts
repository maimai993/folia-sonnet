import type { SongResult } from '../../types';
import { isCapacitorAndroid } from '../../platform/runtime';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import { getPlaybackAnalysisTarget } from '../playbackRecovery/representationRegistry';
import { isNativePlayerAvailable, nativePlayer } from '../playbackEngine/nativePlayerPlugin';
import { resolveNativeAudioUrl } from '../beatFx/beatFxSource';
import { prewarmMusicEnvelope } from './musicEnvelope';

// src/services/analysis/songAssetPrecompute.ts
// 歌曲的「提前分析」：在用户还没听这首歌之前，把两样东西备好、落盘。
//
//   1. 智能动感的整曲曲线（prewarmMusicEnvelope，秒出的基线，落 IndexedDB）—— 始终做；
//   2. 分离好的两轨音频（原生 prepareSongTracks，伴奏 + 清唱，落 cacheDir）——
//      只有「设置 → 存储」里的「预先拆分音轨」总开关打开才做。
//
// 总开关关着时，① 保证智能动感照常有数据，② 不占播放的核去跑几十秒推理；
// 开着时两样都提前备好，拨「人声 / 伴奏」秒切，下一首也一起备。
//
// 为什么不塞进播放时的分析链：那条链有模块级单例 target、靠 RAF 泵推进，
// 预取下一首会把正在播的这首歌挤掉。这里独立排队、串行跑，谁都不抢谁。

interface Pending {
    song: SongResult;
    durationSec: number;
}

/** 等待处理的歌。key 去重：切歌、队列编辑、会话恢复会重复报同一首。 */
const pending = new Map<string, Pending>();
/** 本会话已经处理过的（成功、或失败到上限），避免反复白试。 */
const settled = new Set<string>();
/** 一首歌连续拿不到可解码地址的次数：给几次重试机会，别一次就判死。 */
const failures = new Map<string, number>();
const MAX_FAILURES = 3;
/** 串行闸门：一次只让一首歌去解析地址 / 跑基线。 */
let running = false;
/** 上限，防止长期运行后这个 Set 无限涨。 */
const SETTLED_LIMIT = 256;

export const queueSongAssetPrecompute = (song: SongResult): void => {
    if (!isCapacitorAndroid() || !isNativePlayerAvailable()) return;
    let key: string;
    try {
        key = getPlaybackAnalysisTarget(song).key;
    } catch {
        return;
    }
    if (!key || settled.has(key) || pending.has(key)) return;
    // 失败计数与 settled 一起设上限，长时间挂着 App 也不会无限涨。
    if (failures.size > SETTLED_LIMIT) failures.clear();
    pending.set(key, { song, durationSec: song.durationMs / 1000 });
    void drain();
};

/**
 * 进应用时把播放队列**头部窗口**排进预拆分（P2 修复：不再整队拆）。
 *
 * 原实现把整条 playQueue 逐首排进预拆 —— 百首歌的队列就是一百次地址解析、
 * 一百次完整下载加几十秒推理，流量、电量、发热都不可控，而且预拆完成的
 * 还不一定是接下来会听的歌（用户随时跳过）。改成只拆「当前这首 + 下一首」：
 * 拨「人声 / 伴奏」秒切的体验不变（当前歌永远优先），浪费封顶两首。
 *
 * 每一首仍走 [queueSongAssetPrecompute] 的去重（本会话 settled/pending），
 * 原生侧 [InstrumentalCoordinator.prebuild] 还会再查一次四轨缓存 —— 已拆过的
 * 直接跳过，不会重复拆分。总开关关着时这里不排 SCNet，只排整曲曲线。
 */
const QUEUE_PREBUILD_WINDOW = 2;

export const queuePlaybackQueuePrecompute = (queue: SongResult[]): void => {
    if (!isCapacitorAndroid() || !isNativePlayerAvailable()) return;
    if (!useAudioSettingsStore.getState().prebuildTracksEnabled) return;
    for (const song of queue.slice(0, QUEUE_PREBUILD_WINDOW)) {
        queueSongAssetPrecompute(song);
    }
};

/**
 * 预拆的流量约束（P2 修复）：用户开了省流量 / 还在 2G-3G 网络时，跳过
 * 每首几十 MB 的完整下载与推理。整曲曲线（几 KB）不受影响，智能动感照常。
 */
const prebuildAllowedOnThisNetwork = (): boolean => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (!connection) return true;
    if (connection.saveData) return false;
    const type = connection.effectiveType ?? '4g';
    return type === '4g' || type === 'unknown';
};

/**
 * 回前台时重排队列头部窗口。
 *
 * 后台会把没拆完的生成作废（原生 pauseForBackground），但本会话的 settled 记录还在，
 * 那些被作废的歌不会被重新排上。这里清掉窗口内歌曲的 settled 再重排：已拆完的由原生
 * allStemsReady 兜底跳过，不会重复拆；没拆完的整首重来。窗口之外的 settled 不动 ——
 * 原实现清空整个 settled 再整队重排，回一次前台就把整条队列的地址重新解析一遍。
 */
export const rearmPlaybackQueuePrecompute = (queue: SongResult[]): void => {
    if (!isCapacitorAndroid() || !isNativePlayerAvailable()) return;
    if (!useAudioSettingsStore.getState().prebuildTracksEnabled) return;
    for (const song of queue.slice(0, QUEUE_PREBUILD_WINDOW)) {
        let key: string;
        try {
            key = getPlaybackAnalysisTarget(song).key;
        } catch {
            continue;
        }
        settled.delete(key);
        failures.delete(key);
    }
    for (const song of queue.slice(0, QUEUE_PREBUILD_WINDOW)) {
        queueSongAssetPrecompute(song);
    }
};

const drain = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
        while (pending.size > 0) {
            const entry = pending.entries().next().value;
            if (!entry) break;
            const [key, item] = entry;
            pending.delete(key);
            let done = false;
            try {
                const url = await resolveNativeAudioUrl(item.song);
                if (url) {
                    await prewarmMusicEnvelope(key, url, item.durationSec);
                    /*
                     * 只有「设置 → 存储」里的总开关打开，才预先拆两轨（伴奏 / 清唱）。
                     *
                     * 关着（默认）时上面那条整曲曲线照常落盘 —— 智能动感的数据正常供给，
                     * 只是不跑几十秒的 SCNet。真拨「人声 / 伴奏」时原生 reconcile 会现拆。
                     * 只负责「排上」，不在这等推理 —— 原生那条队列自己管进度；
                     * 装源时原生也会按开关自己调一次 prebuild，重复调用按 key 去重，安全。
                     */
                    if (useAudioSettingsStore.getState().prebuildTracksEnabled
                        && isNativePlayerAvailable()
                        && prebuildAllowedOnThisNetwork()) {
                        await nativePlayer.prepareSongTracks(url, getPlaybackSongKey(item.song));
                    }
                    done = true;
                }
            } catch (error) {
                console.warn(`[SongAssets] ${key}: precompute failed`, error);
            } finally {
                if (done) {
                    settled.add(key);
                    failures.delete(key);
                } else {
                    /*
                     * 拿不到可解码地址是常事（在线直链还没解析出来 / 桌面端），不能
                     * 一锤子判成「这首歌永远没数据」—— 那正是「智能动感拿不到数据」
                     * 最难查的一种。留着 key，下一次预取 / 切歌会再排一次；连着失败
                     * 到上限才彻底放弃，免得无限白试。
                     */
                    const count = (failures.get(key) ?? 0) + 1;
                    if (count >= MAX_FAILURES) {
                        settled.add(key);
                        failures.delete(key);
                    } else {
                        failures.set(key, count);
                    }
                }
                if (settled.size > SETTLED_LIMIT) settled.clear();
            }
        }
    } finally {
        running = false;
        // 循环期间可能又有新歌入队（drain 当时被 running 挡住了）。
        if (pending.size > 0) void drain();
    }
};
