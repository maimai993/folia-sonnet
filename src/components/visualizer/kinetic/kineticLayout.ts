import { Line, Theme, Word as WordType } from '../../../types';
import { buildPostLyricLayoutUnits, type LyricLayoutUnit } from '../../../utils/lyrics/cjkSemanticLayout';
import { getWordSegmentationKey } from '../../../utils/lyrics/wordSegmentation';
import { resolveThemeFontStack, resolveThemeFontWeight } from '../../../utils/fontStacks';
import { rememberBounded } from '../../../utils/visualizer/textMeasureCache';
import { measurePartitaTextWidth, type PartitaFontMetrics } from '../partita/partitaTextWidth';
import { type KineticLayoutMode, type KineticTuning } from './types';

// src/components/visualizer/kinetic/kineticLayout.ts
// 文字PV 的布局：把当前行按实测宽度贪心折行，每行作为一个「场景块」排进竖向阶梯；
// 行高按缩放后的实际占位（字高 × 峰值缩放 + 行距）累加，字与字按实测宽 + 峰值缩放留位，
// 任何 tuning 档位下保证 0 重叠、横向不出界、整块不出屏。

export interface KineticCharMeta {
    word: WordType;
    /** 该字在所属 display word 内的序号（同一 display word 内按 grapheme 时序逐字入场）。 */
    indexInWord: number;
    graphemesInWord: number;
    /** 场景块内的全局序号，决定入场先后。 */
    order: number;
    /** 该字峰值占位宽（含强调缩放），布局用它留位。 */
    width: number;
}

export interface KineticRow {
    id: string;
    chars: KineticCharMeta[];
    /** 实测行宽（含峰值缩放与字间隙）。 */
    width: number;
    /** 行高（含峰值缩放）。 */
    height: number;
    /** 行级 x 偏移（阶梯错落），布局已保证行在屏内。 */
    offsetX: number;
    /** 行级 y 偏移（相对居中块顶）。 */
    offsetY: number;
}

export interface KineticLayout {
    rows: KineticRow[];
    /** 主行实际渲染字号（px，含 lyricsFontScale 与降档系数）。 */
    fontPx: number;
    /** 整块总高，容器用它决定是否再降档。 */
    totalHeight: number;
    /** 0..1：为了放下而降档的比例（1 = 原字号）。 */
    density: number;
    lineWidth: number;
}

export interface KineticViewport {
    width: number;
    height: number;
    fontPx: number;
    fontMetrics: PartitaFontMetrics;
}

export type KineticWidthMeasure = (text: string, fontPx: number) => number;

export const EMPTY_KINETIC_LAYOUT: KineticLayout = {
    rows: [],
    fontPx: 0,
    totalHeight: 0,
    density: 1,
    lineWidth: 1.3,
};

const KINETIC_LAYOUT_CACHE_LIMIT = 48;

/** 字重与 GlowWord 一致走 resolveThemeFontWeight，测量与渲染同源。 */
export const resolveKineticBaseFontPx = (viewportWidth: number, lyricsFontScale: number) => {
    return Math.max(34, Math.min(viewportWidth * 0.062, 64)) * lyricsFontScale;
};

/** 布局几何常量：与渲染侧的样式值一一对应（改渲染要同步改这里）。 */
export const KINETIC_LINE_HEIGHT = 1.25;          // 字行高（em）
export const KINETIC_CHAR_GAP_PX_RATIO = 0.08;    // 字间隙（em）
export const KINETIC_ROW_GAP_EM = 0.5;                   // 行间距（em；行盒给到 1.6em，间距要盖过字形伸出的部分）
export const KINETIC_CONTAINER_PADDING_PX = 48;   // 歌词容器两侧留白
export const KINETIC_MAX_BLOCK_HEIGHT_RATIO = 0.72; // 整块最多占视口高度
/** active 字瞬时再乘的峰值系数：布局按它留位，防逐字弹跳时互相压。 */
export const KINETIC_ACTIVE_PEAK = 0.22;

/** 字号降档候选：放不下时依次尝试，只降不升。 */
const DENSITY_LADDER = [0.88, 0.78, 0.7, 0.62, 0.55, 0.48];

const graphemeSegmenter = typeof Intl !== 'undefined'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

const splitGraphemes = (text: string) => {
    if (!text) return [] as string[];
    if (graphemeSegmenter) {
        return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
    }
    return Array.from(text);
};

/** 行级阶梯偏移：cascade 逐行交替左右错落，grid 小幅交替，block 居中不动。 */
const resolveRowOffset = (rowIndex: number, rowCount: number, mode: KineticLayoutMode, amplitude: number, maxWidth: number) => {
    if (mode === 'block' || amplitude <= 0) return 0;
    if (mode === 'grid') {
        // 错落网格：小幅交替，行宽有限时按剩余空间收。
        const direction = rowIndex % 2 === 0 ? -1 : 1;
        return direction * Math.min(amplitude * 0.6, maxWidth * 0.06);
    }
    // 居中阶梯：从中间往两边展开的正弦错落，方向交替，幅度不超出半屏余量的收口在调用侧做。
    const center = (rowCount - 1) / 2;
    const wave = Math.sin((rowIndex - center) * Math.PI * 0.7);
    return wave * amplitude;
};

interface BuiltRow {
    chars: KineticCharMeta[];
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
}

/**
 * 布局一行内所有字：按 grapheme 拆字、实测宽度、按峰值缩放留位。
 * displayWords 保留原始 timing（semantic/sticky 已由 cjkSemanticLayout 处理）。
 */
const buildRowsForFont = (
    layoutUnits: LyricLayoutUnit[],
    fontPx: number,
    viewport: KineticViewport,
    tuning: KineticTuning,
    measure: KineticWidthMeasure,
): BuiltRow[] => {
    const charGap = fontPx * KINETIC_CHAR_GAP_PX_RATIO;
    const rowGap = fontPx * KINETIC_ROW_GAP_EM;
    const lineHeight = fontPx * KINETIC_LINE_HEIGHT;
    // 每行可用宽度：按测量视口留 8% 余量。canvas measureText 与 DOM 排版有字距/亚像素差，
    // 这条余量同时吸收行级偏移的阶梯错落（收口时还会再按剩余空间收紧一次）。
    const widthBudget = viewport.width * 0.84;
    if (widthBudget <= fontPx) {
        return [];
    }

    // 先把 display words 拆成带时序的字元（顺序 = 歌词顺序）。
    const orderedChars: KineticCharMeta[] = [];
    layoutUnits.forEach((unit) => {
        const displayWords = unit.isSticky && !unit.isSemantic
            ? [{ text: unit.text, words: unit.words }]
            : unit.words.map(word => ({ text: word.text, words: [word] }));
        let order = orderedChars.length;
        displayWords.forEach(({ text, words }) => {
            const graphemes = splitGraphemes(text.replace(/\s+/g, ' '));
            if (graphemes.length === 0) return;
            const word = words[0];
            graphemes.forEach((char, index) => {
                const width = measure(char, fontPx) * (1 + KINETIC_ACTIVE_PEAK * Math.max(tuning.activeScale - 1, 0) / 0.6);
                orderedChars.push({ word, indexInWord: index, graphemesInWord: graphemes.length, order, width });
                order += 1;
            });
        });
    });
    if (orderedChars.length === 0) return [];

    // 贪心折行：unit 不拆散的做法在 partita 已有，这里按字贪心（文字PV 的字级入场本来就是字粒度）。
    const rows: BuiltRow[] = [];
    let current: KineticCharMeta[] = [];
    let currentWidth = 0;
    orderedChars.forEach((char) => {
        const extra = current.length === 0 ? char.width : char.width + charGap;
        if (current.length > 0 && currentWidth + extra > widthBudget) {
            rows.push({ chars: current, width: currentWidth, height: lineHeight * (1 + KINETIC_ACTIVE_PEAK * Math.max(tuning.activeScale - 1, 0) / 0.6), offsetX: 0, offsetY: 0 });
            current = [];
            currentWidth = 0;
        }
        current.push(char);
        currentWidth += current.length === 1 ? char.width : charGap + char.width;
    });
    if (current.length > 0) {
        rows.push({ chars: current, width: currentWidth, height: lineHeight * (1 + KINETIC_ACTIVE_PEAK * Math.max(tuning.activeScale - 1, 0) / 0.6), offsetX: 0, offsetY: 0 });
    }
    return rows;
};

/** 布局入口：按行构建场景块。放不下时按档位降字号重试，仍放不下取最小档结果（组件高度由 totalHeight 兜底）。 */
export const buildKineticLayout = (
    line: Line,
    theme: Theme,
    viewport: KineticViewport,
    tuning: KineticTuning,
    measure?: KineticWidthMeasure,
): KineticLayout => {
    const layoutUnits = buildPostLyricLayoutUnits(line, { semantic: true, sticky: true });
    if (layoutUnits.length === 0) {
        return { ...EMPTY_KINETIC_LAYOUT };
    }
    const widthMeasure: KineticWidthMeasure = measure
        ?? ((text, fontPx) => measurePartitaTextWidth(text, fontPx, viewport.fontMetrics));

    const lineWidth = 1.3;
    const maxBlockHeight = viewport.height * KINETIC_MAX_BLOCK_HEIGHT_RATIO;

    const candidates = [1, ...DENSITY_LADDER];
    let lastResult: KineticLayout | null = null;

    for (const density of candidates) {
        const fontPx = viewport.fontPx * density;
        const rows = buildRowsForFont(layoutUnits, fontPx, viewport, tuning, widthMeasure);
        if (rows.length === 0) continue;

        const rowGap = fontPx * KINETIC_ROW_GAP_EM;
        const lineHeight = rows[0].height;
        // 行级偏移收口：任何一行（含偏移后）都要在测量预算内。
        const maxRowWidth = Math.max(...rows.map(row => row.width));
        const maxOffset = tuning.layout === 'block'
            ? 0
            : Math.min(tuning.offsetAmplitude, Math.max(0, (viewport.width * 0.84 - maxRowWidth) / 2));

        // 行偏移与纵向位置：总块高按实际行高累加，居中放置。
        const totalHeight = rows.length * lineHeight + (rows.length - 1) * rowGap;
        const topStart = -totalHeight / 2;
        rows.forEach((row, rowIndex) => {
            row.offsetX = resolveRowOffset(rowIndex, rows.length, tuning.layout, maxOffset, maxRowWidth);
            row.offsetY = topStart + rowIndex * (lineHeight + rowGap) + lineHeight / 2;
        });

        const result: KineticLayout = {
            rows: rows.map((row, rowIndex) => ({
                id: `${line.startTime}-r${rowIndex}`,
                chars: row.chars,
                width: row.width,
                height: lineHeight,
                offsetX: row.offsetX,
                offsetY: row.offsetY,
            })),
            fontPx,
            totalHeight,
            density,
            lineWidth,
        };

        if (totalHeight <= maxBlockHeight) {
            return result;
        }
        lastResult = result;
    }

    // 最小档位仍放不下（超长句 + 极小窗口）：接受降档后的结果，块可能略超出预算，但字与字、行与行仍不重叠。
    return lastResult ?? { ...EMPTY_KINETIC_LAYOUT };
};

export const buildKineticViewport = (
    width: number,
    height: number,
    lyricsFontScale: number,
    theme: Theme,
): KineticViewport => ({
    width,
    height,
    fontPx: resolveKineticBaseFontPx(width, lyricsFontScale),
    fontMetrics: {
        fontWeight: resolveThemeFontWeight(theme, 700),
        fontFamily: resolveThemeFontStack(theme),
    },
});

export const buildKineticLayoutCacheKey = (
    line: Line,
    viewport: KineticViewport,
    tuning: KineticTuning,
) => [
    'kinetic-layout-v1',
    line.startTime,
    line.endTime,
    line.words.length,
    line.fullText,
    getWordSegmentationKey(line),
    Math.round(viewport.width),
    Math.round(viewport.height),
    Math.round(viewport.fontPx),
    viewport.fontMetrics.fontWeight,
    viewport.fontMetrics.fontFamily,
    tuning.entrance,
    tuning.layout,
    tuning.staggerScale,
    tuning.activeScale,
    tuning.offsetAmplitude,
].join('|');

export const getOrBuildKineticLayout = (
    cache: Map<string, KineticLayout>,
    line: Line,
    theme: Theme,
    viewport: KineticViewport,
    tuning: KineticTuning,
): KineticLayout => {
    const cacheKey = buildKineticLayoutCacheKey(line, viewport, tuning);
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const layout = buildKineticLayout(line, theme, viewport, tuning);
    return rememberBounded(cache, cacheKey, layout, KINETIC_LAYOUT_CACHE_LIMIT);
};
