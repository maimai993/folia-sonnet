import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SonnetOutroBlur } from '@/components/visualizer/sonnet/sonnetOutroBlur';
import { SonnetPixiRuntime } from '@/components/visualizer/sonnet/createSonnetPixiRuntime';
import type { SceneView } from '@/components/visualizer/sonnet/sonnetSceneBuilder';

// test/unit/visualizer/sonnetOutroBlur.test.ts
// 商籁片尾模糊的归属（issue M8）：滤镜是 SonnetOutroBlur 自己 new 的，就由它自己 destroy。
// 以前场景的 destroyScene 只销毁场景自建的那批 postProcessFilters，片尾模糊混在同一个
// container.filters 数组里，没人负责 —— GPU 资源要等 Pixi 的空闲 GC。这里钉住：
// 场景销毁前片尾模糊被交还给创建者、从链上摘下并销毁，而场景自己的那批不受影响。

/** 本次用例里被销毁的滤镜，按对象身份比对（不用 toEqual 的序列化）。 */
let destroyed: object[] = [];

/** 交还进纹理池的时刻（当时已销毁了几个），用来钉住「先交还 RT 再 destroy」。 */
let returnedToPool: string[] = [];

beforeEach(() => {
    destroyed = [];
    returnedToPool = [];
});

/** 滤镜的 destroy() 记一笔，再交给用例自己决定要不要做别的。 */
const trackDestroy = (filter: { destroy: () => void }) => {
    filter.destroy = () => { destroyed.push(filter); };
};

/** 滤镜只暴露 strength 与 destroy()：模糊和场景能碰的也只有这两样。 */
const fakeFilter = () => {
    const filter = { strength: 0 } as { strength: number; destroy: () => void };
    trackDestroy(filter);
    return filter;
};

/** pixi 模块只留模糊要 new 的 BlurFilter 与交还 RT 用的 TexturePool。 */
const pixiModule = () => ({
    BlurFilter: class {
        strength: number;
        quality = 2;
        kernelSize = 5;
        resolution = 1;
        antialias: unknown = 'inherit';
        repeatEdgePixels = false;
        /** 真 BlurFilter 持有一份池化资源，destroy() 前由 pixiFilterResourceRelease 交还。 */
        resources: { texturePoolKey: string | null; renderTexture: object | null }[] = [];

        constructor(options: { strength: number }) {
            this.strength = options.strength;
        }

        destroy() {
            if (this.resources.length > 0) destroyed.push(this);
        }
    },
    TexturePool: {
        getPool: () => ({
            returnTexture: () => { returnedToPool.push(String(destroyed.length)); },
        }),
    },
}) as unknown as typeof import('pixi.js');

/** 给模糊刚建出来的滤镜安上一份池化 RT，模拟 Pixi 渲染过之后的状态。 */
const withPooledTexture = (blur: SonnetOutroBlur) => {
    const filter = internalFilter(blur) as unknown as {
        resources: { texturePoolKey: string | null; renderTexture: object | null }[];
    };
    filter.resources.push({ texturePoolKey: 'blur-1', renderTexture: { id: 'rt' } });
};
/** 场景只留模糊与 destroyScene 用到的部分。 */
const fakeScene = (ownFilters: object[]) => ({
    container: { filters: [...ownFilters] },
    postProcessFilters: ownFilters,
    filterAntialias: 'on',
    shots: [],
}) as unknown as SceneView & { container: { filters: object[] | null } };

/** 模糊的私有滤镜：用例要拿到链上真正那一个对象。 */
const internalFilter = (blur: SonnetOutroBlur): object | null => (
    (blur as unknown as { filter: object | null }).filter
);

const isAttachedTo = (scene: { container: { filters: object[] | null } }, filter: object | null) => (
    filter !== null && (scene.container.filters as object[]).includes(filter)
);

describe('商籁片尾模糊的创建者与销毁者是同一方（M8）', () => {
    it('clear() 之后链上不再剩片尾模糊，内部也不再持有滤镜', () => {
        const own = fakeFilter();
        const scene = fakeScene([own]);
        const blur = new SonnetOutroBlur(pixiModule());
        blur.update(scene, 0.6, 2);
        const outroFilter = internalFilter(blur);
        expect(outroFilter).not.toBeNull();
        expect(isAttachedTo(scene, outroFilter)).toBe(true);
        withPooledTexture(blur);
        let ownDestroyed = false;
        own.destroy = () => {
            ownDestroyed = true;
        };

        blur.clear();

        expect(isAttachedTo(scene, outroFilter)).toBe(false);
        expect(isAttachedTo(scene, own)).toBe(true);
        expect(internalFilter(blur)).toBeNull();
        expect(blur.isOn(scene)).toBe(false);
        // 场景自己那个没被碰，片尾模糊由创建者销毁。
        expect(ownDestroyed).toBe(false);
        expect(destroyed).toHaveLength(1);
        expect(destroyed[0]).toBe(outroFilter);
        // 先交还池里的离屏 RT，再 destroy：Pixi 的 Filter.destroy() 自己不会把 RT 还回池。
        expect(returnedToPool).toEqual(['0']);
    });

    it('场景销毁时由创建者交还并销毁，链上只剩场景自建的那批', () => {
        const own = fakeFilter();
        const scene = fakeScene([own]);
        const blur = new SonnetOutroBlur(pixiModule());
        blur.update(scene, 0.6, 2);
        const outroFilter = internalFilter(blur);
        withPooledTexture(blur);

        blur.release(scene);
        expect(isAttachedTo(scene, outroFilter)).toBe(false);
        expect(isAttachedTo(scene, own)).toBe(true);
        expect(internalFilter(blur)).toBeNull();
        expect(destroyed).toHaveLength(1);
        expect(destroyed[0]).toBe(outroFilter);
        expect(returnedToPool).toEqual(['0']);
    });

    it('场景自己的账本里没有片尾模糊，所以只有创建者能销毁它', () => {
        const own = fakeFilter();
        const scene = fakeScene([own]);
        const blur = new SonnetOutroBlur(pixiModule());
        blur.update(scene, 0.6, 2);
        const outroFilter = internalFilter(blur);
        withPooledTexture(blur);

        // 场景按自己的账本销毁（destroyScene 里 postProcessFilters.forEach(destroy)）：
        // 片尾模糊不在账本里，它只可能在 release 时被创建者销毁。
        expect(scene.postProcessFilters).not.toContain(outroFilter);
        blur.release(scene);
        scene.postProcessFilters.forEach(filter => filter.destroy());

        // 销毁顺序：先片尾模糊（创建者），再场景自建的那批。
        expect(destroyed.slice(0, 2)).toEqual([outroFilter, own]);
    });
});

describe('SonnetPixiRuntime.destroyScene 释放片尾模糊', () => {
    it('片尾模糊开着的时候销毁场景：摘离场景层之前它已经交还给创建者并被销毁', () => {
        const own = fakeFilter();
        const scene = fakeScene([own]);
        const outro = new SonnetOutroBlur(pixiModule());
        const runtime = Object.create(SonnetPixiRuntime.prototype) as unknown as {
            outroBlur: SonnetOutroBlur;
            sceneContainer: { removeChild: (child: unknown) => void };
            destroyScene: (scene: SceneView) => void;
        };
        /** 摘离场景层那一刻模糊还认不认这个场景（clear 会断开，release 也会断开）。 */
        let stillOwnsSceneAtRemoval = true;
        Object.assign(runtime, {
            outroBlur: outro,
            sceneContainer: {
                removeChild: () => {
                    stillOwnsSceneAtRemoval = outro.isOn(scene);
                },
            },
        });
        outro.update(scene, 0.4, 2);
        const outroFilter = internalFilter(outro);
        expect(isAttachedTo(scene, outroFilter)).toBe(true);
        withPooledTexture(outro);

        runtime.destroyScene(scene);

        // 片尾模糊是 SonnetOutroBlur 自己建的（issue M8），场景不再替它持有：交还时由它自己销毁。
        expect(stillOwnsSceneAtRemoval).toBe(false);
        expect(outro.isAttached()).toBe(false);
        // 销毁顺序：片尾模糊在前，场景自建的那批在后。
        expect(destroyed[0]).toBe(outroFilter);
        expect(destroyed.slice(0, 2)).toEqual([outroFilter, own]);
    });
});
