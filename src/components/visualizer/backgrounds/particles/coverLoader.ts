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
 * @returns 取消函数：卸载时调用，之后既不会再发起重试，也不会回调 `onDone`。
 */
export const loadWithRetry = <T,>(
    loader: RetryableLoader<T>,
    url: string,
    onDone: (resource: T) => void,
    retries = 3,
): (() => void) => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const attempt = (remaining: number) => {
        if (cancelled) return;
        loader.load(
            url,
            (resource) => {
                // 取消之后就没人接手释放它了，这里自己收尾：调用方约定 dispose 可选。
                if (cancelled) {
                    (resource as { dispose?: () => void })?.dispose?.();
                    return;
                }
                onDone(resource);
            },
            undefined,
            () => {
                if (cancelled || remaining <= 0) return;
                const delay = 400 * 2 ** (retries - remaining);
                timer = setTimeout(() => attempt(remaining - 1), delay);
            },
        );
    };

    attempt(retries);

    return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
    };
};
