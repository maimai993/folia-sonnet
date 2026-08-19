import type { TemperaDecorSpec, TemperaShotKind } from './types';
import type { TemperaPalette } from './temperaPalette';
import {
    drawTemperaComposition,
    type TemperaBlockOptions,
    type TemperaCompositionContext,
} from './temperaCompositions';

// src/components/visualizer/tempera/temperaBlocks.ts
// Screentone MG layer per shot: owns enter/exit motion state and delegates all geometry to
// temperaCompositions. Playback writes transforms only, so a seek repaints the same frame.
type PixiModule = typeof import('pixi.js');
type Graphics = import('pixi.js').Graphics;

export interface TemperaBlocksView {
    container: import('pixi.js').Container;
    updateTime: (time: number, shotStart: number, shotEnd: number, audioPower: number) => void;
}

export interface TemperaBlocksOptions {
    kind: TemperaShotKind;
    decor: TemperaDecorSpec;
    palette: TemperaPalette;
    width: number;
    height: number;
    seed: number;
    showDecor: boolean;
}

interface BlockItem {
    node: Graphics;
    baseX: number;
    baseY: number;
    baseAlpha: number;
    enterDX: number;
    enterDY: number;
    delay: number;
    span: number;
    pulse: boolean;
    grow: boolean;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeOutCubic = (value: number) => 1 - Math.pow(1 - clamp01(value), 3);

export const buildTemperaBlocks = (
    pixi: PixiModule,
    options: TemperaBlocksOptions,
): TemperaBlocksView => {
    const container = new pixi.Container();
    const items: BlockItem[] = [];

    const add = (node: Graphics, blockOptions: TemperaBlockOptions = {}, parent?: import('pixi.js').Container) => {
        items.push({
            node,
            baseX: node.x,
            baseY: node.y,
            baseAlpha: blockOptions.alpha ?? 1,
            enterDX: blockOptions.enterDX ?? 0,
            enterDY: blockOptions.enterDY ?? 0,
            delay: blockOptions.delay ?? 0,
            span: blockOptions.span ?? 0.45,
            pulse: blockOptions.pulse ?? false,
            grow: blockOptions.grow ?? false,
        });
        (parent ?? container).addChild(node);
    };

    // Tilted sub-groups (poster compositions) keep their children in local coordinates.
    const createGroup = (rotation: number, x: number, y: number) => {
        const group = new pixi.Container();
        group.rotation = rotation;
        group.position.set(x, y);
        container.addChild(group);
        return group;
    };

    const context: TemperaCompositionContext = {
        pixi,
        kind: options.kind,
        palette: options.palette,
        decor: options.decor,
        width: options.width,
        height: options.height,
        seed: options.seed,
        showDecor: options.showDecor,
        add,
        createGroup,
    };
    drawTemperaComposition(context);

    // Drives enter/exit block motion from absolute time so seeks render the same frame.
    const updateTime = (time: number, shotStart: number, shotEnd: number, audioPower: number) => {
        const exitT = clamp01((shotEnd - time) / 0.28);
        for (const item of items) {
            const enter = easeOutCubic((time - shotStart - item.delay) / item.span);
            const visibility = Math.min(enter, exitT);
            item.node.alpha = item.baseAlpha * visibility;
            item.node.visible = visibility > 0.001;
            item.node.position.set(
                item.baseX + item.enterDX * (1 - enter),
                item.baseY + item.enterDY * (1 - enter),
            );
            if (item.pulse || item.grow) {
                const beat = item.pulse ? 1 + audioPower * 0.08 : 1;
                // Hatch fills open horizontally from their pivot instead of fading flat.
                item.node.scale.set(item.grow ? Math.max(0.0001, enter) * beat : beat, beat);
            }
        }
    };

    return { container, updateTime };
};
