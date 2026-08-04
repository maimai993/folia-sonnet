import type { SonnetTypographyPlacement } from './sonnetTypographyLayout';

// src/components/visualizer/sonnet/sonnetDebug.ts
// Debug-only overlays for visual verification during layout development.
// Flip DEBUG_SONNET_MEASURED_BOUNDS to true to draw every segment's measured
// packing box (the same bounds the flow layouts use) on top of the shot.
export const DEBUG_SONNET_MEASURED_BOUNDS = false;

type PixiModule = typeof import('pixi.js');

const ROLE_COLORS: Record<SonnetTypographyPlacement['role'], number> = {
    hero: 0xff4466,
    'semi-hero': 0xffaa00,
    support: 0x44ccff,
    decoration: 0x888888,
};

// Draws one stroked rect per placement, centered on its anchor and rotated like
// the rendered text, plus a small center dot to make the anchor visible.
export const buildSonnetMeasuredBoundsDebug = (
    pixi: PixiModule,
    placements: SonnetTypographyPlacement[],
) => {
    const layer = new pixi.Container();
    layer.visible = DEBUG_SONNET_MEASURED_BOUNDS;
    if (!DEBUG_SONNET_MEASURED_BOUNDS) return layer;

    placements.forEach(placement => {
        const color = ROLE_COLORS[placement.role] ?? 0xffffff;
        const box = new pixi.Graphics()
            .rect(
                -placement.measuredWidth / 2,
                -placement.measuredHeight / 2,
                placement.measuredWidth,
                placement.measuredHeight,
            )
            .stroke({ color, width: 1.5, alpha: 0.9 })
            .circle(0, 0, 2.5)
            .fill({ color, alpha: 0.9 });
        box.position.set(placement.x, placement.y);
        box.rotation = placement.rotation;
        layer.addChild(box);
    });
    return layer;
};
