import { describe, expect, it } from 'vitest';
import { destroyFilterResources } from '@/components/visualizer/pixi/pixiFilterResourceRelease';

// test/unit/visualizer/pixiFilterResourceRelease.test.ts
// 滤镜销毁时把池化的离屏 RT 立刻交还（issue M8）：Pixi 的 Filter.destroy() 只拆 program / attribute，
// 池里的 RT 要等它的空闲 GC（60 秒）才收。这里钉住交还的顺序与幂等，以及认不出结构时退回原样 destroy。

/** 池交还到的每一条 texture。 */
const returned: string[] = [];

/*
 * 池的桩照着 Pixi 8 真实的 `TexturePoolClass` 写：它上面**没有** `getPool(key)`，
 * 只有 `returnTexture(texture, resetStyle?)`。上一版这里按 `getPool` 写，实现里也照着
 * 写了一个不存在的 API —— 两边一起骗过了类型检查，运行时直接 TypeError。
 */
const pixiPool = () => ({
    returnTexture: (texture: object, resetStyle?: boolean) => {
        returned.push(`${(texture as { id?: string }).id ?? '?'}:${String(resetStyle)}`);
    },
});

describe('destroyFilterResources', () => {
    it('交还每个资源池里的 RT，再做滤镜自己的 destroy', () => {
        returned.length = 0;
        const order: string[] = [];
        const filter = {
            resources: {
                color: { texturePoolKey: 'key-a', renderTexture: { id: 'rt-a' } },
                depth: { texturePoolKey: 'key-b', renderTexture: { id: 'rt-b' } },
            },
            destroy: () => { order.push('destroy'); },
        };

        destroyFilterResources(filter, {
            returnTexture: (texture, resetStyle) => {
                returned.push(`${(texture as { id?: string }).id ?? '?'}:${String(resetStyle)}`);
                order.push('return');
            },
        });

        expect(returned).toEqual(['rt-a:false', 'rt-b:false']);
        // 顺序：先把池里的 RT 交还，再销毁滤镜自己 —— 反了的话 destroy 会先把
        // program/attribute 拆掉，回头再碰 RT 就是在用一个已经拆了一半的滤镜。
        expect(order).toEqual(['return', 'return', 'destroy']);
        // 交还过就把引用摘掉，免得池和滤镜各持一份。
        const resources = Object.values(filter.resources);
        expect(resources.every(resource => (
            resource.texturePoolKey === null && resource.renderTexture === null
        ))).toBe(true);
    });

    it('没有池化资源时只 destroy，不碰池', () => {
        returned.length = 0;
        let destroyed = false;
        destroyFilterResources({ destroy: () => { destroyed = true; } }, pixiPool());
        expect(destroyed).toBe(true);
        expect(returned).toEqual([]);
    });

    it('资源上还没有池 / RT（初建的滤镜）时跳过，不会把 null 交给池', () => {
        returned.length = 0;
        let destroyed = false;
        destroyFilterResources(
            { resources: [{ texturePoolKey: null, renderTexture: null }], destroy: () => { destroyed = true; } },
            pixiPool(),
        );
        expect(returned).toEqual([]);
        expect(destroyed).toBe(true);
    });
});
