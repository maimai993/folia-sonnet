import type { TemperaShotKind } from './types';
import type { TemperaPalette } from './temperaPalette';
import { temperaHash01 } from './temperaRandom';

// src/components/visualizer/tempera/temperaBlocks.ts
// Large color-block / geometry MG layer per shot kind; blocks slide in on shot enter and
// fade on exit, doubling as the visual guide that leads the camera into the next shot.
type PixiModule = typeof import('pixi.js');
type Graphics = import('pixi.js').Graphics;

export interface TemperaBlocksView {
    container: import('pixi.js').Container;
    updateTime: (time: number, shotStart: number, shotEnd: number, audioPower: number) => void;
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
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeOutCubic = (value: number) => 1 - Math.pow(1 - clamp01(value), 3);

export const buildTemperaBlocks = (
    pixi: PixiModule,
    kind: TemperaShotKind,
    palette: TemperaPalette,
    width: number,
    height: number,
    seed: number,
    showDecor: boolean,
): TemperaBlocksView => {
    const { Container, Graphics } = pixi;
    const container = new Container();
    const items: BlockItem[] = [];
    const color = (value: string) => pixi.Color.shared.setValue(value).toNumber();
    const variant = temperaHash01(seed, 1, 3);
    const panSign = temperaHash01(seed, 2, 5) > 0.5 ? 1 : -1;

    const addItem = (
        node: Graphics,
        options: Partial<Omit<BlockItem, 'node' | 'baseX' | 'baseY' | 'baseAlpha'>> & { alpha?: number } = {},
    ) => {
        const item: BlockItem = {
            node,
            baseX: node.x,
            baseY: node.y,
            baseAlpha: options.alpha ?? 1,
            enterDX: options.enterDX ?? 0,
            enterDY: options.enterDY ?? 0,
            delay: options.delay ?? 0,
            span: options.span ?? 0.45,
            pulse: options.pulse ?? false,
        };
        items.push(item);
        container.addChild(node);
        return item;
    };

    const drawCross = (cx: number, cy: number, size: number, strokeColor: number, alpha: number) => new Graphics()
        .moveTo(cx - size, cy).lineTo(cx + size, cy)
        .moveTo(cx, cy - size).lineTo(cx, cy + size)
        .stroke({ color: strokeColor, width: 1.5, alpha });

    if (kind === 'duo-split') {
        const horizontal = variant > 0.5;
        if (horizontal) {
            addItem(new Graphics().rect(0, 0, width, height * 0.52).fill({ color: color(palette.blockA) }),
                { alpha: 0.92, enterDY: -height * 0.6 });
            addItem(new Graphics().rect(0, height * 0.52, width, height * 0.48).fill({ color: color(palette.blockB) }),
                { alpha: 0.92, enterDY: height * 0.6, delay: 0.06 });
            addItem(new Graphics().rect(0, height * 0.52 - 1.5, width, 3).fill({ color: color(palette.accent) }),
                { alpha: 0.9, enterDX: -width * panSign, delay: 0.12, span: 0.5 });
        } else {
            addItem(new Graphics().rect(0, 0, width * 0.5, height).fill({ color: color(palette.blockA) }),
                { alpha: 0.92, enterDX: -width * 0.55 });
            addItem(new Graphics().rect(width * 0.5, 0, width * 0.5, height).fill({ color: color(palette.blockB) }),
                { alpha: 0.92, enterDX: width * 0.55, delay: 0.06 });
            addItem(new Graphics().rect(width * 0.5 - 1.5, 0, 3, height).fill({ color: color(palette.accent) }),
                { alpha: 0.9, enterDY: -height * panSign, delay: 0.12, span: 0.5 });
        }
        if (showDecor) {
            const square = new Graphics().rect(-9, -9, 18, 18).fill({ color: color(palette.accent) });
            square.position.set(horizontal ? width * 0.12 : width * 0.5, horizontal ? height * 0.52 : height * 0.14);
            addItem(square, { alpha: 0.95, delay: 0.2, pulse: true });
            addItem(drawCross(width * 0.88, height * 0.2, 8, color(palette.ink), 0.7), { delay: 0.26 });
        }
    } else if (kind === 'band-strip') {
        const bandY = height * 0.37;
        const bandHeight = height * 0.3;
        addItem(new Graphics().rect(0, bandY, width, bandHeight).fill({ color: color(palette.blockC) }),
            { alpha: 0.94, enterDX: -width * panSign, span: 0.55 });
        addItem(new Graphics().rect(0, bandY - 5, width, 1.5).fill({ color: color(palette.line) }),
            { enterDX: width * panSign, delay: 0.1 });
        addItem(new Graphics().rect(0, bandY + bandHeight + 3.5, width, 1.5).fill({ color: color(palette.line) }),
            { enterDX: width * panSign, delay: 0.14 });
        if (showDecor) {
            const dot = new Graphics().circle(0, 0, 7).fill({ color: color(palette.accent) });
            dot.position.set(width * 0.07, bandY + bandHeight / 2);
            addItem(dot, { delay: 0.22, pulse: true });
            addItem(drawCross(width * 0.93, bandY + bandHeight / 2, 8, color(palette.ink), 0.75), { delay: 0.28 });
        }
    } else if (kind === 'frame-window') {
        const frameX = width * 0.14;
        const frameY = height * 0.18;
        const frameW = width * 0.72;
        const frameH = height * 0.64;
        addItem(new Graphics().rect(frameX, frameY, frameW, frameH).fill({ color: color(palette.blockB) }),
            { alpha: 0.24, span: 0.6 });
        addItem(new Graphics().rect(frameX, frameY, frameW, frameH).stroke({ color: color(palette.ink), width: 2 }),
            { alpha: 0.85, enterDY: height * 0.08, delay: 0.08 });
        // Corner ticks in accent give the window its print-like registration marks.
        const tick = 18;
        const corners: Array<[number, number, number, number]> = [
            [frameX, frameY, 1, 1],
            [frameX + frameW, frameY, -1, 1],
            [frameX, frameY + frameH, 1, -1],
            [frameX + frameW, frameY + frameH, -1, -1],
        ];
        corners.forEach(([cx, cy, sx, sy], index) => {
            const mark = new Graphics()
                .moveTo(cx, cy + sy * tick).lineTo(cx, cy).lineTo(cx + sx * tick, cy)
                .stroke({ color: color(palette.accent), width: 3 });
            addItem(mark, { alpha: 0.95, delay: 0.16 + index * 0.04 });
        });
        if (showDecor) {
            const diamond = new Graphics()
                .moveTo(0, -10).lineTo(10, 0).lineTo(0, 10).lineTo(-10, 0)
                .fill({ color: color(palette.accent) });
            diamond.position.set(width / 2, frameY);
            addItem(diamond, { delay: 0.3, pulse: true });
        }
    } else if (kind === 'poster-panel') {
        const poster = new Container();
        poster.rotation = -0.06;
        poster.position.set(width / 2, height / 2);
        container.addChild(poster);
        const addPosterItem = (node: Graphics, options: Parameters<typeof addItem>[1] = {}) => {
            const item = addItem(node, options);
            // Re-home the node into the tilted poster group while keeping base positions local.
            container.removeChild(node);
            poster.addChild(node);
            return item;
        };
        addPosterItem(new Graphics().rect(-width * 0.62, -height * 0.75, width * 0.78, height * 1.5).fill({ color: color(palette.blockA) }),
            { alpha: 0.95, enterDX: -width * 0.7, span: 0.55 });
        addPosterItem(new Graphics().rect(width * 0.18, -height * 0.75, width * 0.3, height * 1.5).fill({ color: color(palette.blockC) }),
            { alpha: 0.5, enterDX: -width * 0.5, delay: 0.08, span: 0.55 });
        addPosterItem(new Graphics().rect(width * 0.16, -height * 0.75, width * 0.02, height * 1.5).fill({ color: color(palette.accent) }),
            { alpha: 0.9, enterDY: -height * 0.5, delay: 0.16 });
        if (showDecor) {
            const square = new Graphics().rect(-8, -8, 16, 16).fill({ color: color(palette.ink) });
            square.position.set(width * 0.3, -height * 0.32);
            addPosterItem(square, { alpha: 0.8, delay: 0.24, pulse: true });
        }
    } else {
        // quiet-line: hairline grid and a single accent dot for breathing paragraphs.
        const gridWidth = width * 0.7;
        const gridX = (width - gridWidth) / 2;
        [0.38, 0.5, 0.62].forEach((ratio, index) => {
            addItem(new Graphics().rect(gridX, height * ratio, gridWidth, 1).fill({ color: color(palette.line) }),
                { delay: index * 0.08, span: 0.6, enterDX: (index % 2 === 0 ? -1 : 1) * width * 0.2 });
        });
        if (showDecor) {
            const dot = new Graphics().circle(0, 0, 4).fill({ color: color(palette.accent) });
            dot.position.set(gridX - 14, height * 0.5);
            addItem(dot, { delay: 0.3, pulse: true });
        }
    }

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
            if (item.pulse) {
                item.node.scale.set(1 + audioPower * 0.08);
            }
        }
    };

    return { container, updateTime };
};
