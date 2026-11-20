import type { Texture } from 'pixi.js';

// src/components/visualizer/pixi/pixiFilterResourceRelease.ts
// 放掉滤镜池化的离屏渲染目标：Filter.destroy() 只拆自己的 program/attribute，池里的 RT 要等 Pixi 的
// 空闲 GC（60 秒）才收。按 Pixi 自己的做法先把资源与池的键断开，再把同键的空闲 RT 交给池销毁，
// 最后照常 destroy() 滤镜本身。认不出结构时（换了 Pixi 版本）直接 destroy()，行为与以前一样。

interface PooledFilterResource {
    texturePoolKey: string | null;
    renderTexture: Texture | null;
}

interface TexturePoolRelease {
    getPool: (key: string) => { returnTexture: (texture: Texture, resetStyle?: boolean) => void };
}

/** 在滤镜不再被任何滤镜链引用时调用：交还池里的 RT，再销毁滤镜本身。 */
export const destroyFilterResources = (
    filter: { resources?: PooledFilterResource[]; destroy?: () => void },
    pool: TexturePoolRelease,
) => {
    const resources = filter.resources;
    if (Array.isArray(resources)) {
        for (const resource of resources) {
            if (!resource?.texturePoolKey || !resource.renderTexture) continue;
            const { texturePoolKey, renderTexture } = resource;
            resource.texturePoolKey = null;
            resource.renderTexture = null;
            pool.getPool(texturePoolKey).returnTexture(renderTexture, false);
        }
    }
    filter.destroy?.();
};
