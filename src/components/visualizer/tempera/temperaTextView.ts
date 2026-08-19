import type { TemperaGlyphPlacement } from './temperaLayout';
import type { TemperaPalette } from './temperaPalette';
import type { TemperaDecorFragment } from './types';
import type { TemperaGlyphMotionInput } from './temperaMotion';

// src/components/visualizer/tempera/temperaTextView.ts
// Builds one Pixi Text node per grapheme plus a hard offset copy for print registration.
// The shadow copies sit *below* the inverted text layer on purpose: the difference filter
// reads them as backdrop, which is what makes the glyph flip color. Nothing is ever painted
// behind a glyph to emphasise it - the inversion against the artwork is the emphasis.
type PixiModule = typeof import('pixi.js');

export interface TemperaGlyphView {
    display: import('pixi.js').Text;
    shadow: import('pixi.js').Text | null;
    /** Everything the per-frame motion solver needs; the runtime never reads layout again. */
    motion: TemperaGlyphMotionInput;
    baseX: number;
    baseY: number;
    shadowDX: number;
    shadowDY: number;
}

interface TemperaTextViewOptions {
    placements: TemperaGlyphPlacement[];
    palette: TemperaPalette;
    fontFamily: string;
    fontWeight: number;
    shadowEnabled: boolean;
    textLayer: import('pixi.js').Container;
    /** Rendered under the inverted text layer, so the filter reads it as backdrop. */
    underLayer: import('pixi.js').Container;
    /**
     * Rendered above the inverted layer and never filtered. Keyword glyphs live here so the
     * theme's `wordColors` hue survives; inverting them would throw the colour away.
     */
    keywordLayer: import('pixi.js').Container;
}

const SHADOW_OFFSET_X = 0.06;
const SHADOW_OFFSET_Y = 0.08;

export const buildTemperaTextViews = (
    pixi: PixiModule,
    options: TemperaTextViewOptions,
): TemperaGlyphView[] => {
    const { Text, TextStyle } = pixi;
    const { palette, fontFamily, fontWeight } = options;
    const views: TemperaGlyphView[] = [];
    const weightToken = String(fontWeight) as import('pixi.js').TextStyleFontWeight;

    options.placements.forEach(placement => {
        if (placement.char.trim().length === 0) return;
        const baseStyle = {
            fontFamily,
            fontWeight: weightToken,
            fontSize: placement.fontSize,
        };
        const display = new Text({
            text: placement.char,
            style: new TextStyle({ ...baseStyle, fill: placement.color ?? palette.ink }),
        });
        display.anchor.set(0.5);
        display.position.set(placement.x, placement.y);
        display.rotation = placement.rotation;

        // Hard (unblurred) offset copy; reads as an off-register second printing plate.
        let shadow: import('pixi.js').Text | null = null;
        if (options.shadowEnabled) {
            shadow = new Text({
                text: placement.char,
                style: new TextStyle({ ...baseStyle, fill: palette.shadow }),
            });
            shadow.anchor.set(0.5);
            shadow.rotation = placement.rotation;
            options.underLayer.addChildAt(shadow, 0);
        }

        (placement.color ? options.keywordLayer : options.textLayer).addChild(display);
        views.push({
            display,
            shadow,
            motion: {
                startTime: placement.startTime,
                settleTime: placement.settleTime,
                endTime: placement.endTime,
                enterX: placement.enterX,
                enterY: placement.enterY,
                enterRotation: placement.enterRotation,
                enterScale: placement.enterScale,
                driftPhase: placement.driftPhase,
                rotation: placement.rotation,
            },
            baseX: placement.x,
            baseY: placement.y,
            shadowDX: placement.fontSize * SHADOW_OFFSET_X,
            shadowDY: placement.fontSize * SHADOW_OFFSET_Y,
        });
    });

    return views;
};

interface TemperaFragmentViewOptions {
    fragments: TemperaDecorFragment[];
    palette: TemperaPalette;
    fontFamily: string;
    fontWeight: number;
    baseFontSize: number;
    width: number;
    height: number;
    layer: import('pixi.js').Container;
}

// Stray glyphs parked in the margins of sparse compositions. They carry no timeline: the
// shot's own enter/exit alpha covers them, so playback never touches these nodes.
export const buildTemperaFragmentViews = (
    pixi: PixiModule,
    options: TemperaFragmentViewOptions,
) => {
    const { Text, TextStyle } = pixi;
    options.fragments.forEach(fragment => {
        const node = new Text({
            text: fragment.char,
            style: new TextStyle({
                fontFamily: options.fontFamily,
                fontWeight: String(options.fontWeight) as import('pixi.js').TextStyleFontWeight,
                fontSize: Math.max(12, options.baseFontSize * fragment.scale),
                fill: options.palette.ink,
            }),
        });
        node.anchor.set(0.5);
        node.position.set(fragment.x * options.width, fragment.y * options.height);
        node.rotation = fragment.rotation;
        node.alpha = 0.42;
        options.layer.addChild(node);
    });
};
