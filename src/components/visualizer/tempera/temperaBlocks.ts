import type { TemperaDecorSpec, TemperaShotKind } from './types';
import type { TemperaPalette } from './temperaPalette';
import { clamp01, easeTemperaEnter, easeTemperaInOut, resolveShotStagger } from './temperaMotion';
import { temperaHash01 } from './temperaRandom';
import {
    drawTemperaComposition,
    type TemperaBlockOptions,
    type TemperaCompositionContext,
} from './temperaCompositions';

// src/components/visualizer/tempera/temperaBlocks.ts
// Screentone MG layer per shot: owns enter/exit motion state and delegates all geometry to
// temperaCompositions. Timings are fractions of the shot's own duration, so the graphics
// advance with the lyric rather than finishing in a fixed fraction of a second. Nothing here
// reacts to audio; a seek repaints exactly the same frame.
type PixiModule = typeof import('pixi.js');
type Graphics = import('pixi.js').Graphics;

export interface TemperaBlocksView {
    container: import('pixi.js').Container;
    updateTime: (time: number, shotStart: number, shotEnd: number) => void;
}

export interface TemperaBlocksOptions {
    kind: TemperaShotKind;
    decor: TemperaDecorSpec;
    palette: TemperaPalette;
    width: number;
    height: number;
    seed: number;
    showDecor: boolean;
    /** Direction the whole composition travels in; shared with the camera and transitions. */
    flowAngle: number;
}

interface BlockItem {
    node: Graphics;
    baseX: number;
    baseY: number;
    baseAlpha: number;
    enterDX: number;
    enterDY: number;
    /** Fractions of the shot duration, resolved to seconds at update time. */
    delayFraction: number;
    spanFraction: number;
    drift: boolean;
    driftPhase: number;
    /** Per-item multiplier on the flow creep; the spread is what keeps the frame alive. */
    creepScale: number;
    grow: boolean;
}

/**
 * How fast an item creeps along the flow relative to the rest. Structural fills stay locked
 * to 1: letting two adjacent tone panels drift apart would tear a gap open at their seam.
 * Only the hatch overlays (a little, for print misregistration) and the small decor marks
 * (freely) get a parallax spread.
 */
const resolveCreepScale = (seed: number, index: number, options: TemperaBlockOptions) => {
    if (options.drift) return 0.5 + temperaHash01(seed, index, 181) * 1.3;
    if (options.grow) return 0.9 + temperaHash01(seed, index, 191) * 0.25;
    return 1;
};

export const buildTemperaBlocks = (
    pixi: PixiModule,
    options: TemperaBlocksOptions,
): TemperaBlocksView => {
    const container = new pixi.Container();
    const items: BlockItem[] = [];
    const flowX = Math.cos(options.flowAngle);
    const flowY = Math.sin(options.flowAngle);
    // Per-item stagger distance only. The bulk of the hand-off travel belongs to the shot
    // container, which moves the type along with the graphics.
    const carry = Math.max(options.width, options.height) * 0.09;

    const add = (node: Graphics, blockOptions: TemperaBlockOptions = {}, parent?: import('pixi.js').Container) => {
        items.push({
            node,
            baseX: node.x,
            baseY: node.y,
            baseAlpha: blockOptions.alpha ?? 1,
            enterDX: blockOptions.enterDX ?? 0,
            enterDY: blockOptions.enterDY ?? 0,
            delayFraction: blockOptions.delay ?? 0,
            spanFraction: blockOptions.span ?? 0.45,
            drift: blockOptions.drift ?? false,
            driftPhase: temperaHash01(options.seed, items.length, 173) * Math.PI * 2,
            creepScale: resolveCreepScale(options.seed, items.length, blockOptions),
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
        // Covers the internal creep, the camera pan and the shot's arrival offset, so a
        // full-bleed shape reaches past the frame edge at every point of the hand-off.
        bleed: carry + Math.max(options.width, options.height) * 0.17,
        // Gradient mode only: a per-shot axis so neighbouring compositions do not all ramp
        // the cover colours the same way.
        gradient: options.palette.gradient
            ? { colors: options.palette.gradient, angle: temperaHash01(options.seed, 3, 197) * Math.PI * 2 }
            : null,
        add,
        createGroup,
    };
    drawTemperaComposition(context);

    // Drives block motion from absolute time so seeks render the same frame. There is no exit
    // ramp here: the shot container owns the hand-off slide, so the outgoing composition
    // leaves as one piece with its own type still attached to it.
    const updateTime = (time: number, shotStart: number, shotEnd: number) => {
        const duration = Math.max(shotEnd - shotStart, 0.2);
        const progress = clamp01((time - shotStart) / duration);
        // Mostly linear on purpose. A pure ease flattens at both ends, and a shot long enough
        // to flatten is exactly the one that must not sit on a still frame.
        const travelled = progress * 0.8 + easeTemperaInOut(progress) * 0.2;

        for (const item of items) {
            const { delay, span } = resolveShotStagger(duration, item.delayFraction, item.spanFraction);
            const enter = easeTemperaEnter((time - shotStart - delay) / span);
            // Items creep along the flow at different rates, so the composition keeps
            // re-arranging itself for the whole shot instead of translating as one slab.
            const creep = travelled * carry * 0.4 * item.creepScale;
            item.node.alpha = item.baseAlpha * enter;
            item.node.visible = enter > 0.001;
            const behind = (1 - enter) * carry - creep;
            item.node.position.set(
                item.baseX + item.enterDX * (1 - enter) - flowX * behind,
                item.baseY + item.enterDY * (1 - enter) - flowY * behind,
            );
            if (item.drift || item.grow) {
                // A slow float replaces the old audio pulse: deterministic, seek-safe, and it
                // keeps decor from looking frozen once the shot has settled.
                const float = item.drift ? 1 + Math.sin(time * 0.5 + item.driftPhase) * 0.02 : 1;
                item.node.scale.set(item.grow ? Math.max(0.0001, enter) * float : float, float);
                if (item.drift) item.node.rotation = Math.sin(time * 0.33 + item.driftPhase) * 0.012;
            }
        }
    };

    return { container, updateTime };
};
