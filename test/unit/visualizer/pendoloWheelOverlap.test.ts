import { describe, expect, it } from 'vitest';
import type { Line } from '@/types';
import { DEFAULT_PENDOLO_TUNING } from '@/types';
import { calculatePendoloWheelLayout, type PendoloBlockSize, type PendoloLineItem } from '@/components/visualizer/pendolo/pendoloGeometry';
import { pendoloTextBlockWidth } from '@/components/visualizer/pendolo/pendoloTextLayout';

// test/unit/visualizer/pendoloWheelOverlap.test.ts

const lines: Line[] = Array.from({ length: 12 }, (_, index) => ({
    id: `line-${index}`,
    startTime: index * 4,
    endTime: index * 4 + 3,
    fullText: `第 ${index} 行歌词`,
    words: [],
}));

/** 小屏上真实量出来的块：正文 28px 挤在 140px 宽度里会换到两三行。 */
const blockSizes: PendoloBlockSize[] = lines.map(() => ({ width: 140, height: 34 }));

const boxOf = (item: PendoloLineItem, size: PendoloBlockSize) => ({
    left: item.x,
    right: item.x + size.width * item.scale,
    top: item.y - (size.height * item.scale) / 2,
    bottom: item.y + (size.height * item.scale) / 2,
});

const overlappingPairs = (items: PendoloLineItem[], sizes: PendoloBlockSize[]) => {
    const pairs: string[] = [];
    for (let i = 0; i < items.length; i += 1) {
        for (let j = i + 1; j < items.length; j += 1) {
            const left = boxOf(items[i], sizes[items[i].index]);
            const right = boxOf(items[j], sizes[items[j].index]);
            if (left.left < right.right && right.left < left.right && left.top < right.bottom && right.top < left.bottom) {
                pairs.push(`${items[i].index}/${items[j].index}`);
            }
        }
    }
    return pairs;
};

describe('Pendolo wheel lyric blocks', () => {
    it('小屏上相邻歌词块的包围盒不再相交，且焦点行始终保留', () => {
        const items = calculatePendoloWheelLayout(
            lines, 6, 0, 360, 640, DEFAULT_PENDOLO_TUNING, 24, undefined, blockSizes,
        );
        expect(items.length).toBeGreaterThan(1);
        expect(items.some(item => item.isActive)).toBe(true);
        expect(overlappingPairs(items, blockSizes)).toEqual([]);
    });

    it('不给块尺寸时行为不变：传入的行一个都不剔除', () => {
        const heights = new Array(lines.length).fill(34);
        const withoutSizes = calculatePendoloWheelLayout(
            lines, 6, 0, 360, 640, DEFAULT_PENDOLO_TUNING, 24, heights,
        );
        const emptySizes = calculatePendoloWheelLayout(
            lines, 6, 0, 360, 640, DEFAULT_PENDOLO_TUNING, 24, heights, [],
        );
        expect(emptySizes.map(item => item.index)).toEqual(withoutSizes.map(item => item.index));
        expect(withoutSizes.length).toBeGreaterThan(1);
    });

    it('大屏上块与块本来就离得开，剔除不会少画', () => {
        const sized = calculatePendoloWheelLayout(
            lines, 6, 0, 1280, 800, DEFAULT_PENDOLO_TUNING, 40, undefined, blockSizes,
        );
        const unsized = calculatePendoloWheelLayout(
            lines, 6, 0, 1280, 800, DEFAULT_PENDOLO_TUNING, 40,
        );
        expect(sized.map(item => item.index)).toEqual(unsized.map(item => item.index));
    });

    it('块宽取换行后最宽的那一行', () => {
        // 单测环境没有 canvas，pretext 量不了字；这里直接喂一份换行结果，钉「取最大值」这条契约。
        const layout = {
            lines: [
                { text: '短', width: 18, graphemeStart: 0, graphemeEnd: 1 },
                { text: '长长长', width: 54, graphemeStart: 1, graphemeEnd: 4 },
            ],
            lineHeight: 20,
            height: 40,
        };
        expect(pendoloTextBlockWidth(layout)).toBe(54);
        expect(pendoloTextBlockWidth({ lines: [], lineHeight: 20, height: 0 })).toBe(0);
    });
});
