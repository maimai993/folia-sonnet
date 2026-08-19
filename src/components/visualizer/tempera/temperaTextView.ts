import type { TemperaGlyphPlacement } from './temperaLayout';
import type { TemperaPalette } from './temperaPalette';
import type { TemperaDecorFragment } from './types';

// src/components/visualizer/tempera/temperaTextView.ts
// Builds one Pixi Text node per grapheme plus a hard offset copy for print registration.
// The shadow copies and the highlight block sit *below* the inverted text layer on purpose:
// the difference filter reads them as backdrop, which is what makes the glyph flip color.
type PixiModule = typeof import('pixi.js');

export interface TemperaGlyphView {
    display: import('pixi.js').Text;
    shadow: import('pixi.js').Text | null;
    halo: import('pixi.js').Text | null;
    highlight: import('pixi.js').Graphics | null;
    startTime: number;
    endTime: number;
    settleTime: number;
    baseX: number;
    baseY: number;
    shadowDX: number;
    shadowDY: number;
    rotation: number;
    enterX: number;
    enterY: number;
    isCurrent: boolean;
}

interface TemperaTextViewOptions {
    placements: TemperaGlyphPlacement[];
    palette: TemperaPalette;
    fontFamily: string;
    fontWeight: number;
    glowEnabled: boolean;
    highlightEnabled: boolean;
    shadowEnabled: boolean;
    haloLayer: import('pixi.js').Container;
    textLayer: import('pixi.js').Container;
    /** Rendered under the inverted text layer: shadow copies and current-glyph backing. */
    underLayer: import('pixi.js').Container;
}

const SHADOW_OFFSET_X = 0.06;
const SHADOW_OFFSET_Y = 0.08;

export const buildTemperaTextViews = (
    pixi: PixiModule,
    options: TemperaTextViewOptions,
): TemperaGlyphView[] => {
    const { Graphics, Text, TextStyle } = pixi;
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
            style: new TextStyle({ ...baseStyle, fill: palette.ink }),
        });
        display.anchor.set(0.5);
        display.position.set(placement.x, placement.y);
        display.rotation = placement.rotation;

        let highlight: import('pixi.js').Graphics | null = null;
        if (options.highlightEnabled) {
            const blockWidth = placement.fontSize * 1.04;
            const blockHeight = placement.fontSize * 1.22;
            highlight = new Graphics()
                .rect(-blockWidth / 2, -blockHeight / 2, blockWidth, blockHeight)
                .fill({ color: pixi.Color.shared.setValue(palette.accent).toNumber() });
            highlight.position.set(placement.x, placement.y);
            highlight.rotation = placement.rotation;
            highlight.visible = false;
            options.underLayer.addChild(highlight);
        }

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

        let halo: import('pixi.js').Text | null = null;
        if (options.glowEnabled) {
            halo = new Text({
                text: placement.char,
                style: new TextStyle({ ...baseStyle, fill: palette.accent }),
            });
            halo.anchor.set(0.5);
            halo.position.set(placement.x, placement.y);
            halo.rotation = placement.rotation;
            options.haloLayer.addChild(halo);
        }

        options.textLayer.addChild(display);
        views.push({
            display,
            shadow,
            halo,
            highlight,
            startTime: placement.startTime,
            endTime: placement.endTime,
            settleTime: placement.settleTime,
            baseX: placement.x,
            baseY: placement.y,
            shadowDX: placement.fontSize * SHADOW_OFFSET_X,
            shadowDY: placement.fontSize * SHADOW_OFFSET_Y,
            rotation: placement.rotation,
            enterX: placement.enterX,
            enterY: placement.enterY,
            isCurrent: false,
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
