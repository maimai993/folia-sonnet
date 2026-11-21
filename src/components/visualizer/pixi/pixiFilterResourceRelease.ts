import type { Texture } from 'pixi.js';

// src/components/visualizer/pixi/pixiFilterResourceRelease.ts
// 放掉滤镜池化的离屏渲染目标：Filter.destroy() 只拆自己的 program/attribute，池里的 RT 要等 Pixi 的
// 空闲 GC（60 秒）才收。按 Pixi 自己的做法先把资源与池的键断开，再把同键的空闲 RT 交给池销毁，
// 最后照常 destroy() 滤镜本身。认不出结构时（换了 Pixi 版本）直接 destroy()，行为与以前一样。

interface PooledFilterResource {
    texturePoolKey: string | null;
    renderTexture: Texture | null;
}

/**
 * 池只需要一个能力：把纹理收回。
 *
 * 上一版这里写的是 `getPool(key)`，那是凭印象编的 —— Pixi 8 的 `TexturePoolClass` 上
 * 根本没有这个方法（只有 `returnTexture`、`createTexture`、`setScreenSize` 等）。
 * 生成这个文件时没有类型检查过，所以一直没被发现。
 */
interface TexturePoolRelease {
    returnTexture: (texture: Texture, resetStyle?: boolean) => void;
}

/**
 * 从 `resources` 里挑出「确实是池化资源」的那些。
 *
 * 认不出来的（Pixi 换了版本、或滤镜根本没有池化资源）一律跳过，最后照常 `destroy()` ——
 * 与改动前的行为一致，不会因为认错结构就崩。
 */
const asPooledResources = (resources: unknown): PooledFilterResource[] => {
    if (!resources || typeof resources !== 'object') return [];
    return Object.values(resources as Record<string, unknown>)
        .filter((resource): resource is PooledFilterResource => {
            if (!resource || typeof resource !== 'object') return false;
            const candidate = resource as Record<string, unknown>;
            return 'texturePoolKey' in candidate && 'renderTexture' in candidate;
        });
};

/**
 * 在滤镜不再被任何滤镜链引用时调用：交还池里的 RT，再销毁滤镜本身。
 *
 * `resources` 的形状按运行时来认：Pixi 的 Filter 上它是 `Record<string, any>`，池化滤镜
 * 会在里面塞 `{ texturePoolKey, renderTexture }` 对象。这里不把它钉成数组类型 ——
 * 钉了就出现「BlurFilter 不能赋给 PooledFilterResource[]」这种编译错误，而运行时本来就是
 * 逐个试的（旧写法 `Array.isArray` 对 `Record` 恒为 false，等于从来没真的交还过 RT）。
 */
export const destroyFilterResources = (
    filter: { resources?: unknown; destroy?: () => void },
    pool: TexturePoolRelease,
) => {
    for (const resource of asPooledResources(filter.resources)) {
        const { texturePoolKey, renderTexture } = resource;
        if (!texturePoolKey || !renderTexture) continue;
        resource.texturePoolKey = null;
        resource.renderTexture = null;
        pool.returnTexture(renderTexture, false);
    }
    filter.destroy?.();
};
