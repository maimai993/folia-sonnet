import type { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { compressLight, lightAt, type ResolvedBeam } from '../light/rig';

// src/components/visualizer/lumiere/lineart/lineArt.ts
// 光学线稿：一组折线（高度单位坐标），按进度描出来，节点上有闪点。每条线一个 Graphics：
// 描线进度变化时才重建几何，受光强弱只改 alpha（光柱扫过时，照到的线更亮）。
type PixiModule = typeof import('pixi.js');

export type Point = [number, number];

export interface LinePath {
    points: Point[];
    /** 线宽（高度单位）。 */
    width: number;
    /** 基础亮度 0..1。 */
    alpha: number;
    /** 描线开始的相对时刻 0..1（在整组的描线时长里错开）。 */
    delay: number;
    /** 描完这一条占整组时长的比例。 */
    span: number;
    /** 虚线：实段与空段长度（高度单位）。 */
    dash?: [number, number];
}

export interface LineNode {
    at: Point;
    /** 闪点直径（高度单位）。 */
    size: number;
    /** 出现的相对时刻 0..1。 */
    delay: number;
    twinklePhase: number;
}

export interface LineArtSpec {
    paths: LinePath[];
    nodes: LineNode[];
}

interface BuiltPath {
    spec: LinePath;
    graphics: Graphics;
    lengths: number[];
    total: number;
    drawn: number;
    midpoint: Point;
}

export interface LineArtLayer {
    view: Container;
    /** draw：整组描线进度 0..1；fade：整体亮度（进退场）。 */
    update: (time: number, draw: number, fade: number, beams: readonly ResolvedBeam[], color: number) => void;
    destroy: () => void;
}

const cumulative = (points: Point[]) => {
    const lengths = [0];
    for (let i = 1; i < points.length; i += 1) {
        const [ax, ay] = points[i - 1]!;
        const [bx, by] = points[i]!;
        lengths.push(lengths[i - 1]! + Math.hypot(bx - ax, by - ay));
    }
    return lengths;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export const createLineArt = (
    pixi: PixiModule,
    options: { height: number; spec: LineArtSpec; starTexture: Texture },
): LineArtLayer => {
    const { height, spec } = options;
    const view = new pixi.Container();
    const pathsHolder = new pixi.Container();
    const nodesHolder = new pixi.Container();
    view.addChild(pathsHolder, nodesHolder);

    const paths: BuiltPath[] = spec.paths.filter(path => path.points.length > 1).map(path => {
        const graphics = new pixi.Graphics();
        pathsHolder.addChild(graphics);
        const lengths = cumulative(path.points);
        const mid = path.points[Math.floor(path.points.length / 2)]!;
        return { spec: path, graphics, lengths, total: lengths[lengths.length - 1]!, drawn: -1, midpoint: mid };
    });

    const nodes: Array<{ spec: LineNode; sprite: Sprite }> = spec.nodes.map(node => {
        const sprite = new pixi.Sprite(options.starTexture);
        sprite.anchor.set(0.5);
        sprite.position.set(node.at[0] * height, node.at[1] * height);
        nodesHolder.addChild(sprite);
        return { spec: node, sprite };
    });

    /** 画出一条线的前 amount 长度（考虑虚线）。 */
    const redraw = (path: BuiltPath, amount: number) => {
        const g = path.graphics;
        g.clear();
        if (amount <= 0) return;
        const { points, dash } = path.spec;
        const limit = Math.min(amount, path.total);
        const period = dash ? dash[0] + dash[1] : 0;
        const at = (index: number, distance: number): Point => {
            const [ax, ay] = points[index - 1]!;
            const [bx, by] = points[index]!;
            const segment = path.lengths[index]! - path.lengths[index - 1]!;
            const f = segment > 0 ? (distance - path.lengths[index - 1]!) / segment : 0;
            return [(ax + (bx - ax) * f) * height, (ay + (by - ay) * f) * height];
        };
        g.moveTo(points[0]![0] * height, points[0]![1] * height);
        for (let i = 1; i < points.length; i += 1) {
            const start = path.lengths[i - 1]!;
            const end = Math.min(path.lengths[i]!, limit);
            if (start >= limit) break;
            if (!dash) {
                const [x, y] = at(i, end);
                g.lineTo(x, y);
                continue;
            }
            // 虚线：按周期的整数下标取出落在本段里的每一截实线（不用浮点游标，避免卡在边界上）。
            for (let k = Math.floor(start / period); k * period < end; k += 1) {
                const from = Math.max(start, k * period);
                const to = Math.min(end, k * period + dash[0]);
                if (to <= from) continue;
                const [ax, ay] = at(i, from);
                const [bx, by] = at(i, to);
                g.moveTo(ax, ay);
                g.lineTo(bx, by);
            }
        }
        const px = path.spec.width * height;
        g.stroke({ width: px * 3.2, color: 0xffffff, alpha: 0.12, cap: 'round', join: 'round' });
        g.stroke({ width: px, color: 0xffffff, alpha: 1, cap: 'round', join: 'round' });
    };

    const update = (time: number, draw: number, fade: number, beams: readonly ResolvedBeam[], color: number) => {
        for (const path of paths) {
            const { delay, span } = path.spec;
            const local = clamp01((draw - delay) / Math.max(span, 1e-3));
            const eased = 1 - (1 - local) ** 3;
            const amount = eased * path.total;
            if (Math.abs(amount - path.drawn) > 1e-5) {
                redraw(path, amount);
                path.drawn = amount;
            }
            const lit = compressLight(lightAt(beams, path.midpoint[0], path.midpoint[1]));
            // 光束外的线也要看得见（参考图里取景框、叶片都在暗处），受光的部分再亮一截。
            path.graphics.alpha = Math.min(1, path.spec.alpha * fade * (0.55 + 0.9 * lit));
            path.graphics.tint = color;
        }
        for (const { spec: node, sprite } of nodes) {
            const appear = clamp01((draw - node.delay) / 0.08);
            const lit = compressLight(lightAt(beams, node.at[0], node.at[1]));
            const twinkle = 0.55 + 0.45 * Math.sin(time * 2.3 + node.twinklePhase);
            const alpha = appear * fade * (0.25 + 0.75 * lit) * twinkle;
            sprite.visible = alpha > 0.004;
            if (!sprite.visible) continue;
            const pop = 1 + (1 - appear) * 1.5;
            const px = node.size * height * pop * (0.8 + 0.2 * twinkle);
            sprite.width = px;
            sprite.height = px;
            sprite.alpha = alpha;
            sprite.tint = color;
        }
    };

    return {
        view,
        update,
        destroy: () => view.destroy({ children: true }),
    };
};
