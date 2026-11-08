import { describe, expect, it } from 'vitest';
import type { Line } from '@/types';
import { DEFAULT_PENDOLO_TUNING } from '@/types';
import { calculatePendoloWheelLayout } from '@/components/visualizer/pendolo/pendoloGeometry';

// test/unit/visualizer/pendoloWheelOverlap.test.ts
// Pendolo 的轮盘上，一行歌词是一块文字：锚点在圆弧上、从锚点向右铺开，宽高各自乘这一行的 scale。
// 这里钉住「块高真的被算进了角间距」这条契约 —— 角间距只按行高撑开的话，小屏上块会叠在一起。

const lines: Line[] = Array.from({ length: 12 }, (_, index) => ({
    id: `line-${index}`,
    startTime: index * 4,
    endTime: index * 4 + 3,
    fullText: `第 ${index} 行歌词`,
    words: [],
}));

/** 小屏上真实量出来的块高：正文 28px 挤在 140px 宽度里会换到两三行。 */
const BLOCK_HEIGHT = 34;
/** 相邻两块之间最少要留出的空隙，pendoloGeometry 撑开角间距时用的就是它。 */
const MIN_GAP_PX = 24;

const blockHeights = (height = BLOCK_HEIGHT): number[] => lines.map(() => height);

describe('Pendolo wheel lyric blocks', () => {
    it('小屏上块高会真的撑开轮盘，焦点行始终保留', () => {
        const heights = blockHeights();
        const sized = calculatePendoloWheelLayout(
            lines, 6, 0, 360, 640, DEFAULT_PENDOLO_TUNING, 24, heights,
        ).sort((left, right) => left.index - right.index);
        const unsized = calculatePendoloWheelLayout(
            lines, 6, 0, 360, 640, DEFAULT_PENDOLO_TUNING, 24,
        ).sort((left, right) => left.index - right.index);
        expect(sized.length).toBeGreaterThan(1);
        // 焦点行一定在：它的块是整个轮盘的锚，角 0、scale 放大。
        expect(sized.find(item => item.isActive)?.index).toBe(6);

        // 块高喂进去之后，每一行都比只按行高排的时候更往外让：这正是「块不再挤在一起」的来源。
        // 焦点行角 0，两种排法下都在原位；离焦点越远，让出来的角越多。
        const sizedByIndex = new Map(sized.map(item => [item.index, item]));
        for (const item of unsized) {
            const withSizes = sizedByIndex.get(item.index);
            if (!withSizes) continue;
            if (item.index === 6) {
                expect(withSizes.angleRad).toBeCloseTo(0, 6);
                continue;
            }
            expect(Math.abs(withSizes.angleRad)).toBeGreaterThan(Math.abs(item.angleRad));
        }
    });

    it('块高把相邻两块的角间距撑到「两块高 + 空隙」够放下为止', () => {
        // 单测环境没有 canvas，pretext 量不了字；这里直接喂一份块高，钉「块高撑开角间距」这条契约。
        const heights = blockHeights();
        const baseRadius = Math.min(360, 640) * DEFAULT_PENDOLO_TUNING.arcRadius + 24;
        const items = calculatePendoloWheelLayout(
            lines, 6, 0, 360, 640, DEFAULT_PENDOLO_TUNING, 24, heights,
        ).sort((left, right) => left.index - right.index);
        expect(items.length).toBeGreaterThan(1);
        for (let i = 1; i < items.length; i += 1) {
            const previous = items[i - 1];
            const current = items[i];
            const stepRad = current.angleRad - previous.angleRad;
            // 角间距至少是 (前块高 + 本块高 + 空隙) / (2 * 半径)，两块在弧上才各占各的地方。
            const neededRad = (heights[previous.index] + heights[current.index] + MIN_GAP_PX) / (2 * baseRadius);
            expect(stepRad).toBeGreaterThanOrEqual(neededRad - 1e-9);
        }
    });

    it('不给块高时行为不变：传入的行一个都不剔除', () => {
        const withoutSizes = calculatePendoloWheelLayout(
            lines, 6, 0, 360, 640, DEFAULT_PENDOLO_TUNING, 24,
        );
        const emptySizes = calculatePendoloWheelLayout(
            lines, 6, 0, 360, 640, DEFAULT_PENDOLO_TUNING, 24, [],
        );
        expect(emptySizes.map(item => item.index)).toEqual(withoutSizes.map(item => item.index));
        expect(withoutSizes.length).toBeGreaterThan(1);
    });

    it('大屏上块与块本来就离得开，块高不会让它少画', () => {
        const sized = calculatePendoloWheelLayout(
            lines, 6, 0, 1280, 800, DEFAULT_PENDOLO_TUNING, 40, blockHeights(),
        );
        const unsized = calculatePendoloWheelLayout(
            lines, 6, 0, 1280, 800, DEFAULT_PENDOLO_TUNING, 40,
        );
        expect(sized.map(item => item.index)).toEqual(unsized.map(item => item.index));
    });
});
