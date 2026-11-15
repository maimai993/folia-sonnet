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
 *      画面上就是「粒子背景没有封面」，还没法判断是不是平台那边挂了；
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

    // 空地址不必试：平台那边有时给回空串（临时地址拿不到时就是这样）。
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
                    // 重试成功也记一笔：能看出「平台那边确实抖了一下」，而不是从来没出过问题。
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

/** 封面贴图装好之后要写进去的那几格 uniform。只声明用得到的字段，避免把 three 的类型拖进来。 */
export interface CoverUniforms {
    uCover: { value: unknown };
    uHasCover: { value: number };
    uCoverAspect: { value: number };
}

export interface LoadCoverOptions {
    url: string;
    loader: RetryableLoader<CoverTexture>;
    uniforms: CoverUniforms;
    /** 装好之后按这张图算景深（写进几何的 aDepth）。 */
    applyDepth?: (image: CanvasImageSource | undefined) => void;
    /** 拿到图之后的回调：调用方用它记住那张图，几何重建时再算一遍景深。 */
    onImage?: (image: CanvasImageSource | undefined) => void;
    /** 这次加载是否已经被丢弃（组件卸载 / 重跑）。 */
    isDisposed: () => boolean;
    /** 成功时装好的纹理，交给调用方在卸载时释放。 */
    onTexture: (texture: CoverTexture) => void;
}

/** 和 three 的 Texture 在本文件里要用到的那一小部分。 */
export interface CoverTexture {
    colorSpace: string;
    minFilter: unknown;
    magFilter: unknown;
    generateMipmaps: boolean;
    image: unknown;
    dispose: () => void;
}

/**
 * 把封面贴图装上，并把 uniform 一次写好。
 *
 * 从 `ParticlesBackground.tsx` 搬过来的：那边贴着 800 行的门禁，而这一段（加载 + 设采样
 * 参数 + 记宽高比 + 算景深 + 失败回调）是自成一体的，和粒子本身的绘制没有关系。
 *
 * `flipY` 保持 three 的默认 true：片元里用 `(vGrid.x, 1.0 - vGrid.y)` 采样，两者一正一反
 * 正好抵消，画面上封面的上下方向才是对的。改这里要同步改着色器。
 */
export const loadCoverTexture = (options: LoadCoverOptions): (() => void) => {
    const { url, loader, uniforms, applyDepth, onImage, isDisposed, onTexture } = options;
    return loadWithRetry<CoverTexture>(loader, url, (loaded) => {
        if (isDisposed()) {
            loaded.dispose();
            return;
        }
        loaded.colorSpace = 'srgb';
        loaded.minFilter = 'linear';
        loaded.magFilter = 'linear';
        loaded.generateMipmaps = false;
        onTexture(loaded);
        uniforms.uCover.value = loaded;
        uniforms.uHasCover.value = 1;
        /*
         * 记下封面的真实宽高比：着色器要靠它把屏幕 UV 换成封面 UV，
         * 否则正方形封面会被拉成 16:9（设备上看到的就是「封面显示不全」）。
         */
        const image = loaded.image as { width?: number; height?: number } | undefined;
        const cw = image?.width ?? 0;
        const ch = image?.height ?? 0;
        uniforms.uCoverAspect.value = cw > 0 && ch > 0 ? cw / ch : 1;
        const bitmap = loaded.image as CanvasImageSource | undefined;
        onImage?.(bitmap);
        applyDepth?.(bitmap);
    }, 3, (reason) => {
        /*
         * 退避重试全部失败（#294）。
         *
         * 这里**不**再自己去找一张备用图：缺封面的兜底（按歌名去别的平台搜一张）
         * 已经在 getSongCoverUrl → onlineCoverFallback 那条路上做过了，这一层再搜一次
         * 就是重复请求。这里只用日志把「真的是那边的地址取不到」记下来，
         * 顺带把 uHasCover 明确置 0 —— 空白封面比上一首的残影好。
         */
        if (isDisposed()) return;
        uniforms.uHasCover.value = 0;
        console.warn(`[Particles] no cover for this song (${reason}); the background renders without one`);
    });
};
