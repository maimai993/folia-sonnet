import type { SceneView } from './sonnetSceneBuilder';
import { destroySonnetFilter } from './sonnetPixiResources';

// src/components/visualizer/sonnet/sonnetOutroBlur.ts
// 片尾模糊：片尾海报升起时给最后一段场景挂一个 BlurFilter，强度随片尾帧变化；回到 0 或换场景时摘下销毁。
type PixiModule = typeof import('pixi.js');

/** The outro blur runs at this share of the canvas resolution. */
const OUTRO_BLUR_RESOLUTION_SHARE = 0.75;

export class SonnetOutroBlur {
    private filter: import('pixi.js').BlurFilter | null = null;
    private scene: SceneView | null = null;

    constructor(private readonly pixi: PixiModule) { }

    /** Whether the blur is currently attached to `scene`. */
    isOn(scene: SceneView) {
        return this.scene === scene;
    }

    /** Whether the blur still holds a filter of its own (issue M8: only this owner destroys it). */
    isAttached() {
        return this.filter !== null;
    }

    /** 摘下并销毁自己的过滤器（谁创建谁销毁）：池里的离屏 RT 一并交还，不等 Pixi 的空闲 GC。 */
    clear() {
        if (this.filter) {
            if (this.scene) {
                this.scene.container.filters = (this.scene.container.filters ?? [])
                    .filter(filter => filter !== this.filter);
            }
            destroySonnetFilter(this.filter, this.pixi.TexturePool);
        }
        this.filter = null;
        this.scene = null;
    }

    /**
     * Hands the filter back when `scene` is being destroyed (issue M8).
     *
     * The scene frees the filters it created itself (SceneView.postProcessFilters); this one is not
     * in that list. scene.container.filters is rewired onto a copy without it before the scene tears
     * the chain down, so the runtime never holds a destroyed filter and the GPU resources go with
     * the owner that made them.
     */
    release(scene: SceneView) {
        if (this.scene !== scene) return;
        const filter = this.filter;
        const remaining = (scene.container.filters ?? []).filter(candidate => candidate !== filter);
        scene.container.filters = remaining.length > 0 ? remaining : null;
        if (filter) destroySonnetFilter(filter, this.pixi.TexturePool);
        this.filter = null;
        this.scene = null;
    }

    /** `renderResolution` is what the canvas runs at; the scenes are rebuilt (and this cleared) when it changes. */
    update(scene: SceneView, strength: number, renderResolution: number) {
        if (strength <= 0) {
            this.clear();
            return;
        }
        if (this.scene !== scene) this.clear();
        if (!this.filter) {
            this.filter = new this.pixi.BlurFilter({
                strength: 0,
                quality: 2,
                kernelSize: 5,
                // The scene is drawn at the lowest resolution among its enabled filters, so this is
                // a share of the canvas, not a fixed 0.75 that a 3x canvas would stretch fourfold.
                resolution: renderResolution * OUTRO_BLUR_RESOLUTION_SHARE,
            });
            this.filter.antialias = scene.filterAntialias;
            // Shares the scene's filter chain with the post-process vignette, so its padding would
            // grow the shared render frame and drift the vignette outward as the outro blur ramps.
            this.filter.repeatEdgePixels = true;
            scene.container.filters = [...(scene.container.filters ?? []), this.filter];
            this.scene = scene;
        }
        this.filter.strength = strength;
    }
}
