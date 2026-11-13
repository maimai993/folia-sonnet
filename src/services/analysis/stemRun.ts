import { cancelNativeSeparation, separateDrumBandsNativeFromUrl, type NativeDrumStemBlock } from '../automix/nativeModels';

// src/services/analysis/stemRun.ts
// 一首歌的一次 htdemucs 分离，给几个用处共用。
//
// 手机上一次分离是满核几分钟的活（见 FoliaAutomixModelsPlugin 关于按段喂的说明）。同一首歌
// 有两个地方要它：鼓点（drumHits.ts，仿真鼓面与墨闪）和四轨包络（musicEnvelope.ts，智能动感
// 的低频、人声、和声与整体能量）。各跑一遍就是把这段时间与电耗翻倍 —— 而模型本来就一次吐
// 四轨，多要三轨只是多拷几份内存，推理时间一模一样。
//
// 所以这里只有一个任务：第一个来的人发起，后来的人登记成听众。每个块按到达顺序广播，
// 新听众先补上已经收到的块再跟上后面的 —— 这样「曲中才打开效果」也能马上有曲线。
//
// 谁都不想要了就停：每秒问一次 `wanted()`，全为假时让原生在下一个窗口停下。
// 已经收到的块留在内存里，等下一次 `joinStemRun` 接着用。

/** 一次分离的结局：走了多远、是不是被叫停；`null` 表示整个任务没能开始。 */
export type StemOutcome = { seconds: number; cancelled: boolean } | null;

export interface StemBlockListener {
    /** 还要不要继续（切歌、退到后台、效果关掉）。 */
    wanted: () => boolean;
    onBlock: (block: NativeDrumStemBlock) => void;
    /** 分离结束（正常走到尾、被取消、或拿不到地址）；`null` 表示整个任务没能开始。 */
    onDone?: (outcome: StemOutcome) => void;
}

interface Run {
    key: string;
    startSeconds: number;
    listeners: Set<StemBlockListener>;
    /** 已经广播过的块，新听众补历史时按顺序重放。 */
    blocks: NativeDrumStemBlock[];
    cancelCheck: ReturnType<typeof setInterval> | null;
    finished: boolean;
    promise: Promise<StemOutcome>;
}

const runs = new Map<string, Run>();

/** 同时只跟这么多首歌：切歌来回切时，散落的块不至于一直占着内存。 */
const MAX_RUNS = 3;

const stopRun = (run: Run) => {
    if (run.finished) return;
    run.finished = true;
    if (run.cancelCheck) clearInterval(run.cancelCheck);
    run.cancelCheck = null;
    runs.delete(run.key);
    void cancelNativeSeparation();
};

const pruneRuns = () => {
    // 只丢已经结束的：还在跑的任务有人等着，丢掉了会为同一首歌再发起一次。
    for (const [key, run] of runs) {
        if (run.finished) runs.delete(key);
    }
    while (runs.size > MAX_RUNS) {
        const oldest = runs.keys().next().value;
        if (oldest === undefined) break;
        runs.delete(oldest);
    }
};

/**
 * 加入（或发起）`key` 这首歌的分离，从 `startSeconds` 起。
 *
 * `startSeconds` 只在发起时用：后来的人接的是同一次任务，所以拿到的块从发起者的起点开始
 * （调用方都用缓存里那份半成品的位置当起点，两边本来就一致）。
 */
export const joinStemRun = (
    key: string,
    url: string,
    listener: StemBlockListener,
    startSeconds = 0,
): Promise<StemOutcome> => {
    const existing = runs.get(key);
    if (existing && !existing.finished) {
        existing.listeners.add(listener);
        // 补上已经过去的块：曲中才打开效果时，曲线不必等到下一段分离完才有。
        for (const block of existing.blocks) listener.onBlock(block);
        return existing.promise;
    }

    const run: Run = {
        key,
        startSeconds,
        listeners: new Set([listener]),
        blocks: [],
        cancelCheck: null,
        finished: false,
        promise: Promise.resolve(null),
    };
    // 原生只在块边界看取消标记，而一块是 30 秒音频（几十秒推理）：这里提前让它停，
    // 用户切歌后不必再等风扇转一分钟。
    run.cancelCheck = setInterval(() => {
        /*
         * 退到后台就停：htdemucs 是满核几分钟的活，在后台跑等于把「听歌时发烫」找回来。
         * 已经收到的块留在内存、每 30 秒落的那份留在库里，回到前台从那里接着分离。
         * 放在这里而不是各个调用方：鼓点和四条包络共用这一次分离，谁忘了判断都不该让它烧后台。
         */
        if (typeof document !== 'undefined' && document.hidden) {
            stopRun(run);
            return;
        }
        for (const entry of [...run.listeners]) {
            if (!entry.wanted()) run.listeners.delete(entry);
        }
        if (!run.listeners.size) stopRun(run);
    }, 1000);

    const promise = (async (): Promise<StemOutcome> => {
        const outcome = await separateDrumBandsNativeFromUrl(url, (block) => {
            for (const entry of [...run.listeners]) {
                if (!entry.wanted()) run.listeners.delete(entry);
            }
            if (!run.listeners.size) {
                stopRun(run);
                return;
            }
            run.blocks.push(block);
            for (const entry of run.listeners) entry.onBlock(block);
        }, { startSeconds, envelopes: true });

        run.finished = true;
        if (run.cancelCheck) clearInterval(run.cancelCheck);
        run.cancelCheck = null;
        if (runs.get(key) === run) runs.delete(key);
        for (const entry of [...run.listeners]) entry.onDone?.(outcome);
        run.listeners.clear();
        return outcome;
    })().catch((error): StemOutcome => {
        console.warn(`[StemRun] ${key}: separation failed`, error);
        run.finished = true;
        if (run.cancelCheck) clearInterval(run.cancelCheck);
        run.cancelCheck = null;
        if (runs.get(key) === run) runs.delete(key);
        for (const entry of [...run.listeners]) entry.onDone?.(null);
        run.listeners.clear();
        return null;
    });

    run.promise = promise;
    runs.set(key, run);
    pruneRuns();
    return promise;
};

/** 这首歌的分离已经到第几秒（供续跑用）；没开始过返回 null。 */
export const stemRunReached = (key: string): number | null => {
    const run = runs.get(key);
    if (!run) return null;
    const last = run.blocks[run.blocks.length - 1];
    return last ? last.untilSec : run.startSeconds;
};
