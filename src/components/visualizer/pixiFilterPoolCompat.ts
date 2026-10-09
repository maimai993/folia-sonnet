import type { BindGroup, Texture } from 'pixi.js';

// src/components/visualizer/pixiFilterPoolCompat.ts
// Pixi 8.21.0 prunes screen-sized textures while FilterSystem still binds the last pass.
// Remove this version-gated shim once the dependency includes the upstream fix:
// https://github.com/pixijs/pixijs/pull/12259
type PixiModule = typeof import('pixi.js');
const PATCHED = Symbol.for('folia.pixi821FilterPoolCompat');

interface FilterSystemCompat {
    _globalFilterBindGroup: BindGroup;
    _findFilterResolution?: (rootResolution: number) => number;
    init?: () => void;
    destroy: () => void;
    [PATCHED]?: boolean;
}

interface TexturePoolCompat {
    _poolKey: Record<number, number | undefined>;
    _buckets: Map<number, Texture[]>;
    _dropTextures: (textures: Texture[], destroy: boolean) => void;
    returnTexture: (texture: Texture, resetStyle?: boolean) => void;
}

/** Unbind all live renderers before the shared pool destroys textures; keep normal draws unchanged. */
export const installPixiFilterPoolCompat = (pixi: PixiModule) => {
    if ((pixi.VERSION as string) !== '8.21.0') return;
    const prototype = pixi.FilterSystem.prototype as unknown as FilterSystemCompat;
    if (prototype[PATCHED]) return;
    prototype[PATCHED] = true;

    const groups = new Set<BindGroup>();
    const pool = pixi.TexturePool as unknown as TexturePoolCompat;
    const unbindPassTextures = () => {
        const source = pixi.Texture.EMPTY.source;
        groups.forEach(group => {
            group.setResource(source, 1);
            group.setResource(source.style, 2);
            group.setResource(source, 3);
        });
    };

    // init is picked up by Pixi's renderer runner before any filter is rendered.
    const init = prototype.init;
    prototype.init = function () {
        init?.call(this);
        groups.add(this._globalFilterBindGroup);
    };
    const destroy = prototype.destroy;
    prototype.destroy = function () {
        groups.delete(this._globalFilterBindGroup);
        this._globalFilterBindGroup.destroy();
        destroy.call(this);
    };

    // Resize, renderer destruction and clear() all discard idle textures through this method.
    const dropTextures = pool._dropTextures;
    pool._dropTextures = function (textures, shouldDestroy) {
        if (shouldDestroy && textures.length > 0) unbindPassTextures();
        dropTextures.call(this, textures, shouldDestroy);
    };
    // 池里的纹理可能在 FilterSystem 的栈里还留着引用时就被回收，下一次分辨率查询于是拿到
    // `inputTexture.source === null`，Pixi 会每帧抛异常直到场景重建 —— 表现出来就是画面反复
    // 卡一下。这里兜住异常、退回根分辨率：当前帧能画完，也不必把已销毁的纹理继续留在手里。
    const findFilterResolution = prototype._findFilterResolution;
    if (findFilterResolution) {
        prototype._findFilterResolution = function (rootResolution: number) {
            try {
                return findFilterResolution.call(this, rootResolution);
            } catch {
                return rootResolution;
            }
        };
    }
    // A checked-out texture can outlive its bucket and be destroyed directly on return.
    const returnTexture = pool.returnTexture;
    pool.returnTexture = function (texture, resetStyle) {
        const key = this._poolKey[texture.uid];
        if (key !== undefined && !this._buckets.has(key)) unbindPassTextures();
        returnTexture.call(this, texture, resetStyle);
    };
};
