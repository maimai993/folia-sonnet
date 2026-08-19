import type { TemperaGlyphPlacement } from './temperaLayout';
import type { TemperaPalette } from './temperaPalette';

// src/components/visualizer/tempera/temperaTextView.ts
// Builds one Pixi Text node per grapheme with drop shadow, halo copy and an accent
// backing block used for the current-glyph inversion highlight.
type PixiModule = typeof import('pixi.js');

export interface TemperaGlyphView {
    display: import('pixi.js').Text;
    halo: import('pixi.js').Text | null;
    highlight: import('pixi.js').Graphics | null;
    startTime: number;
    endTime: number;
    settleTime: number;
    baseX: number;
    baseY: number;
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
    haloLayer: import('pixi.js').Container;
    textLayer: import('pixi.js').Container;
}

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
        const style = new TextStyle({
            fontFamily,
            fontWeight: weightToken,
            fontSize: placement.fontSize,
            fill: palette.ink,
            dropShadow: {
                color: palette.shadow,
                alpha: 0.5,
                blur: 6,
                angle: Math.PI / 2,
                distance: 2,
            },
        });
        const display = new Text({ text: placement.char, style });
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
            options.textLayer.addChild(highlight);
        }

        let halo: import('pixi.js').Text | null = null;
        if (options.glowEnabled) {
            halo = new Text({
                text: placement.char,
                style: new TextStyle({
                    fontFamily,
                    fontWeight: weightToken,
                    fontSize: placement.fontSize,
                    fill: palette.accent,
                }),
            });
            halo.anchor.set(0.5);
            halo.position.set(placement.x, placement.y);
            halo.rotation = placement.rotation;
            options.haloLayer.addChild(halo);
        }

        options.textLayer.addChild(display);
        views.push({
            display,
            halo,
            highlight,
            startTime: placement.startTime,
            endTime: placement.endTime,
            settleTime: placement.settleTime,
            baseX: placement.x,
            baseY: placement.y,
            rotation: placement.rotation,
            enterX: placement.enterX,
            enterY: placement.enterY,
            isCurrent: false,
        });
    });

    return views;
};
