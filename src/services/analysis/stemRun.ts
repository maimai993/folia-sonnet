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
/**
 * `done` 是原生说的「已经到了文件尾」。
 *
 * 不能用 `seconds > 0` 代替：一趟只跑了一块就停下（推理失败、没进展）也会带回一个
 * 正数秒数，把它当「跑完整首」会让曲长被改短、整首判成补齐，然后就再也不补了。
 */
export type StemOutcome = { seconds: number; cancelled: boolean; done: boolean } | null;

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

const stopRun = (run: Run) => {
    if (run.finished) return;
    run.finished = true;
    if (run.cancelCheck) clearInterval(run.cancelCheck);
    run.cancelCheck = null;
    /*
     * 不从表里删。
     *
     * 原先这里 `runs.delete(run.key)`，紧接着补齐泵看到「没有在跑」就又发一趟，
     * 而原生那一趟其实还在单线程池里收尾（推理不响应中断，只在块边界停）。
     * 两趟一排队，新的一趟要等旧的整整一块跑完，界面上就是「发起了，却一直不前进」。
     * 留在表里，`stemRunReached` 仍然非 null，泵就不会重复发起；promise 落定后由
     * 下面那段统一删除。
     */
    void cancelNativeSeparation();
};

const pruneRuns = () => {
    /*
     * 只清「已经收尾、也没人再听」的记录。
     *
     * 还在跑的有人等着，丢掉会为同一首歌再发起一次；刚被叫停但原生还没返回的那条
     * 更不能丢 —— 它在表里正是为了告诉补齐泵「别急着重开」，见 stopRun 的说明。
     * 每一条都会在自己的 promise 落定时删掉，所以这里不需要按数量硬删。
     */
    for (const [key, run] of runs) {
        if (run.finished && run.listeners.size === 0) runs.delete(key);
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
    if (existing) {
        if (!existing.finished) {
            existing.listeners.add(listener);
            // 补上已经过去的块：曲中才打开效果时，曲线不必等到下一段分离完才有。
            for (const block of existing.blocks) listener.onBlock(block);
            return existing.promise;
        }
        /*
         * 这一趟已经被叫停，但原生那边还在收尾（worker 是单线程，卡在推理里出不来）。
         * 现在另起一趟只会排在它后面，等于什么都没发生。等它落定、表也清空了，再重来 ——
         * 但只在听众还要的情况下：不要了就必须停在这里，否则会变成一秒一次的无限重开。
         */
        return existing.promise.then(() => (
            listener.wanted() ? joinStemRun(key, url, listener, startSeconds) : null
        ));
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
        }, {
            startSeconds,
            envelopes: true,
            /*
             * 一块 11 秒 —— 正好是 SCNet 一个窗口。
             *
             * 以前给 20 秒，模型照样按 11 秒切，第二块里 9 秒是真音频、2 秒是补零，
             * 等于白算一次。11 秒一块：第一块更快到手、单块内存减半，总窗口数不变。
             */
            chunkSeconds: 11,
            /*
             * 让原生那块循环能看到「还有没有人要」：有人在每秒的 cancelCheck 里被剔除，
             * 这里立刻在块边界停下，而不是把剩下几十块也跑完。
             */
            wanted: () => run.listeners.size > 0,
        });

        run.finished = true;
        if (run.cancelCheck) clearInterval(run.cancelCheck);
        run.cancelCheck = null;
        if (runs.get(key) === run) runs.delete(key);
        for (const entry of [...run.listeners]) entry.onDone?.(outcome);
        run.listeners.clear();
        return outcome;
    })().catch((error: unknown): StemOutcome => {
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
