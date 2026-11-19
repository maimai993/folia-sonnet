// src/components/swarmSplash/swarmDraw.ts
// 群体光标的绘制层：把光标、正在画的框、正在打的字画到 canvas 上。
//
// 纯绘制函数，不持有任何状态 —— 每帧由运行时把「此刻该画什么」算好后交给它。
// 箭头形状按「鼠标指针」画：一个三角箭头加一道竖线尾巴，和真实光标同形。

import type { Point, SwarmCursor } from './swarmPhysics';

/** 光标配色：取一组高饱和色，让一群光标看得出是不同的人。 */
export const CURSOR_COLORS = [
    '#f24e1e', '#a259ff', '#1abcfe', '#0acf83', '#ff7262', '#ffc700',
    '#9747ff', '#e8467c', '#14ae5c', '#0d99ff', '#ff8a00', '#00b5ce',
];

/** 一只光标的标牌（光标旁的小名字牌）：颜色从 id 推出，避免另存一份映射。 */
export const cursorColor = (cursor: SwarmCursor): string => CURSOR_COLORS[cursor.id % CURSOR_COLORS.length];

export type StageSize = { width: number; height: number };

/**
 * 画一只光标。
 *
 * 箭头用路径直接画，不用图片：一来不必带资源，二来缩放时永远清晰。
 */
export const drawCursor = (
    context: CanvasRenderingContext2D,
    cursor: SwarmCursor,
    color: string,
    /** 头部缩放：收尾时整体缩一下会更有「撤离」的感觉。 */
    scale = 1,
): void => {
    const size = 15 * scale;
    context.save();
    context.translate(cursor.x, cursor.y);
    // 箭头本体：从原点(尖端)往右下画。
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(0, size * 1.35);
    context.lineTo(size * 0.34, size * 1.02);
    context.lineTo(size * 0.62, size * 1.55);
    context.lineTo(size * 0.85, size * 1.42);
    context.lineTo(size * 0.58, size * 0.9);
    context.lineTo(size, size * 0.86);
    context.closePath();
    context.fillStyle = color;
    context.fill();
    context.lineWidth = 1.2;
    context.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    context.stroke();
    context.restore();
};

/**
 * 画正在成型的矩形：只画已经描过的那一段。
 *
 * 两个光标从对角拉：这里按 progress（0..1）画到对应比例，看起来就是「一边拉一边长」。
 */
export const drawGrowingRect = (
    context: CanvasRenderingContext2D,
    rect: { x: number; y: number; width: number; height: number },
    progress: number,
    color: string,
): void => {
    const width = rect.width * Math.min(1, progress);
    const height = rect.height * Math.min(1, progress);
    context.save();
    context.strokeStyle = color;
    context.lineWidth = 1.5;
    context.setLineDash([5, 4]);
    context.strokeRect(rect.x, rect.y, width, height);
    context.setLineDash([]);
    // 尺寸标尺：右上角一个小标签，和设计工具一样。
    if (width > 40 && height > 24) {
        context.fillStyle = 'rgba(13, 153, 255, 0.9)';
        context.fillRect(rect.x + width / 2 - 18, rect.y + height + 4, 36, 14);
    }
    context.restore();
};

/** 画一行已经打出来的字。 */
export const drawTypedText = (
    context: CanvasRenderingContext2D,
    text: string,
    at: Point,
    size: number,
    color: string,
): void => {
    if (!text) return;
    context.save();
    context.fillStyle = color;
    context.font = `600 ${size}px 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif`;
    context.textBaseline = 'top';
    context.fillText(text, at.x, at.y);
    context.restore();
};
