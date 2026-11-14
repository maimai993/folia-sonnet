/**
 * 等原生的「到达信号」：`playFromQueue` 的 `ok` 只代表原生**受理**了这一单，
 * 不代表地址已经装进引擎 —— 它在起解析线程之前就回 true，真正换源要等平台的
 * 地址回来（`FoliaPlaybackService.nativePlayMirrorEntry`）。把 `ok` 当作已起播
 * 直接提交界面，解析失败时就会「名字换了、声音和歌词留在上一首」。
 *
 * 判据是**引擎自己的媒体身份**：`FoliaNativePlayer.getSnapshot().songKey`（装源时写进
 * MediaItem 的 mediaId），而且要**已经装载**（时长或位置有值）。
 *
 * 为什么不用 `FoliaPlayback.getPlaybackSnapshot().songKey`：那是服务里的 `cachedSongKey`，
 * Web 层推一次 metadata 就会把它改掉。用它当判据，界面一认领新歌就等于「到达」——
 * 引擎还在放上一首也算数，于是又变成「界面是刚点的歌、声音是上一首」。这条被用户
 * 实测抓到过（冷启动自动播放后再从歌单点歌）。
 */

export type NativeEngineSnapshot = {
    /** 引擎当前装的那首歌（MediaItem 的 mediaId）。没装东西时为空串。 */
    songKey?: string;
    durationMs?: number;
    positionMs?: number;
};

export type NativeArrivalOptions = {
    /** 读一次引擎快照（真机上就是 FoliaNativePlayer.getSnapshot）。 */
    readEngine: () => Promise<NativeEngineSnapshot | null | undefined>;
    /** 期望到达的 songKey。 */
    expectsKey: string;
    /**
     * 这一单还要不要。用户中途点了别的歌就该立刻放下，不再空等 ——
     * 否则等满超时后回退 Web，会把用户后来点的那首抢掉。
     */
    stillWanted?: () => boolean;
    /** 最长等多久，默认 6000ms（原生解析重试退避是 0/400/1200ms）。 */
    timeoutMs?: number;
    /** 两次读取之间的间隔，默认 250ms。 */
    intervalMs?: number;
    /** 现在几点，默认 Date.now；测试可以换掉。 */
    now?: () => number;
    /** 等待，默认 setTimeout；测试可以换掉。 */
    sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_INTERVAL_MS = 250;

/**
 * 引擎是不是**真的**装着这首歌并且在动。
 *
 * 光有 mediaId 不够：`prepare` 先在调用线程写身份、再去播放器线程装源，这中间有一段
 * 「身份已经换了、媒体还没装载」的窗口，时长与位置都是 0。要求时长或位置有值，
 * 才是「源真的加载了」。
 */
export const nativeEngineHasArrived = (
    snapshot: NativeEngineSnapshot | null | undefined,
    expectsKey: string,
): boolean => {
    if (!snapshot || snapshot.songKey !== expectsKey) return false;
    return Number(snapshot.durationMs ?? 0) > 0 || Number(snapshot.positionMs ?? 0) > 0;
};

/**
 * 等到返回 true，等不到（超时 / 被顶掉 / 读快照出错）返回 false。
 * 读快照出错当作「没到」：桥不可用时应当回退 Web，而不是卡在这里。
 */
export const waitForNativeArrival = async ({
    readEngine,
    expectsKey,
    stillWanted,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: NativeArrivalOptions): Promise<boolean> => {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
        if (stillWanted && !stillWanted()) return false;
        try {
            const snapshot = await readEngine();
            if (nativeEngineHasArrived(snapshot, expectsKey)) return true;
        } catch {
            return false;
        }
        if (now() >= deadline) return false;
        await sleep(intervalMs);
    }
    return false;
};
