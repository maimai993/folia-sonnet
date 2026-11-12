// src/components/visualizer/backgrounds/particles/coverLoader.ts
//
// 封面贴图的「失败重试」包装。
//
// 为什么单独一个文件：部分平台的封面地址是临时签名 URL，偶尔会 403 / 超时 / 返回空，
// 一次失败就放弃的话用户看到的是「粒子背景没有封面」。重试逻辑要占十几行，
// 而 ParticlesBackground.tsx 已经贴着 800 行的上限，所以把它拆出来。

interface RetryableLoader<T> {
    /*
     * onProgress 各加载器自己不同（three 的 TextureLoader 要 ProgressEvent），
     * 这里不管它，只把这一格空着传下去。签名写成「可选的第四个回调」就够用。
     */
    load: (
        url: string,
        onLoad: (resource: T) => void,
        onProgress: undefined,
        onError: (error: unknown) => void,
    ) => unknown;
}

/**
 * 用退避策略加载一个资源，失败重试 `retries` 次（400ms → 800ms → 1.6s …）。
 *
 * 这个函数在 #294 之前的两个缺口，都是「静默」造成的：
 *   1. 全部失败之后没有任何回调 —— 调用方既不知道最终失败了，也没法退回备用地址，
 *      画面上就是「粒子背景没有封面」，还没法判断是不是 QQ 那边挂了；
 *   2. 一条日志都没有 —— 重试了几次、最后失败在哪个地址，事后都查不到。
 * 现在补了 `onFail`（可选）和两行日志；`onFail` 会在**重试用尽**或**地址为空**时
 * 各调一次，调用方可以拿它去换一张备用封面。
 *
 * @returns 取消函数：卸载时调用，之后既不会再发起重试，也不会回调 `onDone` / `onFail`。
 */
export const loadWithRetry = <T,>(
    loader: RetryableLoader<T>,
    url: string,
    onDone: (resource: T) => void,
    retries = 3,
    onFail?: (reason: 'exhausted' | 'empty-url') => void,
): (() => void) => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // 空地址不必试：platform 那边有时给回空串（QQ 的临时地址拿不到时就是这样）。
    if (!url) {
        console.warn('[Particles] cover url is empty, nothing to load');
        onFail?.('empty-url');
        return () => {};
    }

    const attempt = (remaining: number, attempted: number) => {
        if (cancelled) return;
        loader.load(
            url,
            (resource) => {
                // 取消之后就没人接手释放它了，这里自己收尾：调用方约定 dispose 可选。
                if (cancelled) {
                    (resource as { dispose?: () => void })?.dispose?.();
                    return;
                }
                if (attempted > 1) {
                    // 重试成功也记一笔：能看出「QQ 那边确实抖了一下」，而不是从来没出过问题。
                    console.info(`[Particles] cover loaded after ${attempted} attempts`);
                }
                onDone(resource);
            },
            undefined,
            (error) => {
                if (cancelled) return;
                if (remaining <= 0) {
                    console.warn(`[Particles] cover failed after ${attempted} attempts, giving up: ${url}`, error);
                    onFail?.('exhausted');
                    return;
                }
                const delay = 400 * 2 ** (retries - remaining);
                timer = setTimeout(() => attempt(remaining - 1, attempted + 1), delay);
            },
        );
    };

    attempt(retries, 1);

    return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
    };
};
