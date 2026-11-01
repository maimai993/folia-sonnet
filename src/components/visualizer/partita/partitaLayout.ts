import React from 'react';
import { DEFAULT_PARTITA_TUNING, Line, Theme, Word as WordType, type PartitaTuning } from '../../../types';
import { buildDisplayWordsFromLayoutUnits, buildPostLyricLayoutUnits, type LyricLayoutUnit } from '../../../utils/lyrics/cjkSemanticLayout';
import { getWordSegmentationKey } from '../../../utils/lyrics/wordSegmentation';
import { type VisualizerPreheatWindow } from '../runtime';
import { resolveWordColor } from '../wordColoring';
import { rememberBounded } from '../../../utils/visualizer/textMeasureCache';
import { measurePartitaTextWidth, type PartitaFontMetrics } from './partitaTextWidth';

// src/components/visualizer/partita/partitaLayout.ts
// 云阶的分栏布局：把当前行切成 chunk 排进若干列，算出每个词的偏移 / 旋转 / 缩放，并按 key 缓存。
// 宽度方向用真实测宽兜底：历史切法放不下时按宽度再分行、字号按档位微缩、stagger/scale 按剩余空间收；
// 放得下的行（桌面常态）保持原有切法与变换不变。

export interface WordLayoutConfig {
    id: string;
    x: number;
    y: number;
    rotate: number;
    scale: number;
    marginBottom: string;
    alignSelf: string;
    passedRotate: number;
}

interface LineLayoutConfig {
    perspective: number;
    justifyContent: string;
    alignItems: string;
    columnGap: string;
}

interface PartitaColumn {
    id: string;
    words: Array<{
        chunkUnits: LyricLayoutUnit[];
        chunkWords: WordType[];
        displayWords: WordType[];
        config: WordLayoutConfig;
        order: number;
        rowIndex: number;
    }>;
}

export interface PartitaSequentialLayout {
    columns: PartitaColumn[];
    totalGraphemes: number;
    /** 主行字号的密度系数：1 = 原始字号；宽度放不下时按档位下调，组件用它缩 clamp 字号。 */
    fontDensityScale: number;
    lineConfig: LineLayoutConfig;
}

/** 布局需要的视口与字体输入：fontPx 是 density=1 时主行的实际渲染字号（含 lyricsFontScale）。 */
export interface PartitaViewport {
    height: number;
    width: number;
    fontPx: number;
    fontMetrics: PartitaFontMetrics;
}

export type PartitaWidthMeasure = (text: string, fontPx: number) => number;

export const EMPTY_PARTITA_LAYOUT: PartitaSequentialLayout = {
    columns: [],
    totalGraphemes: 0,
    fontDensityScale: 1,
    lineConfig: {
        perspective: 1000,
        justifyContent: 'justify-center',
        alignItems: 'items-center',
        columnGap: '1.6rem',
    },
};

const PARTITA_LAYOUT_CACHE_LIMIT = 48;
export const PARTITA_WORD_LAYOUT_STYLE: React.CSSProperties = { marginRight: '0.8rem' };
export const PARTITA_PREHEAT_WINDOW: VisualizerPreheatWindow = {
    minLead: 0.18,
    maxLead: 1.2,
};

// 从渲染样式镜像来的几何常量（GlowWord / PartitaChunk / 歌词容器），让实测宽度能对齐真实裁剪边界（视口边缘）。
const WORD_GAP_PX = 12.8;        // PARTITA_WORD_LAYOUT_STYLE marginRight 0.8rem
const CHUNK_PADDING_PX = 16;     // PartitaChunk padding 0.5rem × 2
const COLUMN_PADDING_PX = 12;    // 列容器 px-3 单侧
const GUIDE_EDGE_PX = 20;        // 引导线伸出 chunk 边缘（左 -16px / 右 +20px）
const WORD_JITTER_PX = 8;        // 词级随机偏移的半幅（chaotic 15/2）
const CONTAINER_PADDING_PX = 64; // 歌词容器 p-8
const VIEWPORT_SAFETY_PX = 4;
const GLOW_LINE_HEIGHT = 1.22;   // GlowWord lineHeight
const ROW_EXTRA_PX = 16;         // chunk 纵向 padding 0.2rem × 2 + marginBottom 0.6rem
const MIN_STAGGER_PX = 8;        // stagger 小于这个值就没了错落感；行至少要留这么多
const ACTIVE_PEAK_EXTRA = 0.4;   // active 词瞬时在 chunk scale 上再 ×1.4
const SCALE_FLOOR = 0.5;         // 兜底档位里允许的最小 chunk scale
// 窄屏兜底的字号档位：从 legacy 密度（>40 字素的 0.8）起，只降不升。
const DENSITY_LADDER = [0.9, 0.8, 0.72, 0.65, 0.58];

const isCJK = (text: string) => /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(text);
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
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const clampPartitaStagger = (value: number, fallback: number) => Number.isFinite(value)
    ? clamp(value, 0, 180)
    : fallback;

export const resolvePartitaTuning = (tuning?: PartitaTuning): PartitaTuning => {
    const rawMin = clampPartitaStagger(tuning?.staggerMin ?? DEFAULT_PARTITA_TUNING.staggerMin, DEFAULT_PARTITA_TUNING.staggerMin);
    const rawMax = clampPartitaStagger(tuning?.staggerMax ?? DEFAULT_PARTITA_TUNING.staggerMax, DEFAULT_PARTITA_TUNING.staggerMax);

    return {
        showGuideLines: tuning?.showGuideLines ?? DEFAULT_PARTITA_TUNING.showGuideLines,
        useSemanticLayout: tuning?.useSemanticLayout ?? DEFAULT_PARTITA_TUNING.useSemanticLayout,
        staggerMin: Math.min(rawMin, rawMax),
        staggerMax: Math.max(rawMin, rawMax),
    };
};

export const getActiveColor = (wordText: string, theme: Theme) => {
    return resolveWordColor(wordText, theme.wordColors, theme.accentColor);
};

// 主行字号的 clamp（clamp(2.5rem, 5.5vw, 4.5rem) × lyricsFontScale）在布局侧也要用同一份，rem 按 16px。
export const resolvePartitaBaseFontPx = (viewportWidth: number, lyricsFontScale: number) => {
    return Math.max(40, Math.min(viewportWidth * 0.055, 72)) * lyricsFontScale;
};

const makeRandom = (seed: number) => {
    let state = seed;
    return () => {
        const x = Math.sin(state++) * 10000;
        return x - Math.floor(x);
    };
};

interface PartitaRowGeometry {
    textWidth: number;
    gaps: number;
    maxWordWidth: number;
}

export const measurePartitaRowGeometry = (displayWords: WordType[], fontPx: number, measure: PartitaWidthMeasure): PartitaRowGeometry => {
    let textWidth = 0;
    let maxWordWidth = 0;
    displayWords.forEach(w => {
        const width = measure(w.text, fontPx);
        textWidth += width;
        maxWordWidth = Math.max(maxWordWidth, width);
    });
    return { textWidth, gaps: displayWords.length * WORD_GAP_PX, maxWordWidth };
};

// 行中心（含 stagger）到行最远边缘的距离：正文 + 词距 + chunk padding 按 scale，再叠 active 峰值、引导线、词抖动。
export const getPartitaRowHalfSpan = (
    geometry: PartitaRowGeometry,
    scale: number,
    staggerX: number,
    showGuideLines: boolean,
) => (
    Math.abs(staggerX)
    + scale * ((geometry.textWidth + geometry.gaps + CHUNK_PADDING_PX) / 2 + ACTIVE_PEAK_EXTRA * geometry.maxWordWidth)
    + COLUMN_PADDING_PX
    + (showGuideLines ? GUIDE_EDGE_PX : 0)
    + WORD_JITTER_PX
);

// 一个 layout unit 最终会拆成几个 display word（词距按它算）。
const displayWordCount = (unit: LyricLayoutUnit) => (
    unit.isSticky && !unit.isSemantic ? 1 : Math.max(unit.words.length, 1)
);

// 按实测宽度贪心切行：unit 不可拆，放不下就断行；首 unit 无条件进当前行。
const splitByWidth = (
    layoutUnits: LyricLayoutUnit[],
    fontPx: number,
    textBudget: number,
    measure: PartitaWidthMeasure,
): LyricLayoutUnit[][] => {
    const chunks: LyricLayoutUnit[][] = [];
    let current: LyricLayoutUnit[] = [];
    let currentWidth = 0;

    layoutUnits.forEach(unit => {
        const width = measure(unit.text, fontPx) + displayWordCount(unit) * WORD_GAP_PX;
        if (current.length > 0 && currentWidth + width > textBudget) {
            chunks.push(current);
            current = [];
            currentWidth = 0;
        }
        current.push(unit);
        currentWidth += width;
    });
    if (current.length > 0) chunks.push(current);
    return chunks;
};

// 历史的“不均匀随机”切行：完全均分太机械，破坏手写乐谱感。逐字节保持原实现。
const splitIntoChunks = (
    layoutUnits: LyricLayoutUnit[],
    rowCount: number,
    random: () => number,
): LyricLayoutUnit[][] => {
    const chunks: LyricLayoutUnit[][] = [];
    let remainingUnits = layoutUnits.length;
    let remainingChunks = rowCount;
    let unitIndex = 0;

    for (let c = 0; c < rowCount; c++) {
        const isLastChunk = c === rowCount - 1;
        const avg = remainingUnits / remainingChunks;

        let chunkLength = 1;
        if (isLastChunk) {
            chunkLength = remainingUnits;
        } else {
            const max = Math.ceil(avg * 1.5);
            const min = 1;
            const randVal = random();
            chunkLength = Math.max(min, Math.min(max, Math.round(avg + (randVal - 0.5) * avg)));
        }

        chunkLength = Math.max(1, Math.min(chunkLength, remainingUnits - (remainingChunks - 1)));

        chunks.push(layoutUnits.slice(unitIndex, unitIndex + chunkLength));
        unitIndex += chunkLength;
        remainingUnits -= chunkLength;
        remainingChunks--;
    }
    return chunks;
};

interface BuiltRow {
    chunkUnits: LyricLayoutUnit[];
    chunkWords: WordType[];
    displayWords: WordType[];
    config: WordLayoutConfig;
    order: number;
    rowIndex: number;
    fits: boolean;
}

// 由 chunks 生成行配置。clamp=false 时保持历史数值（错落随机原样）；clamp=true 时 scale/stagger
// 被该行剩余宽度封顶。两档的随机消耗顺序一致，同一份种子结果确定。
const buildRows = (
    chunks: LyricLayoutUnit[][],
    fontPx: number,
    rowCount: number,
    theme: Theme,
    viewport: PartitaViewport,
    tuning: PartitaTuning,
    measure: PartitaWidthMeasure,
    random: () => number,
    clampTransforms: boolean,
): BuiltRow[] => {
    const intensity = theme.animationIntensity;
    const isChaotic = intensity === 'chaotic';
    const isCalm = intensity === 'calm';
    const halfViewport = viewport.width / 2 - VIEWPORT_SAFETY_PX;
    const fixedSpan = COLUMN_PADDING_PX + (tuning.showGuideLines ? GUIDE_EDGE_PX : 0) + WORD_JITTER_PX;

    const rows: BuiltRow[] = [];
    chunks.forEach((chunkUnits, rowIndex) => {
        const chunkWords = chunkUnits.flatMap(unit => unit.words);
        const displayWords = buildDisplayWordsFromLayoutUnits(chunkUnits);
        if (chunkWords.length === 0) return;

        const mergedTextForConfig = chunkWords.map(w => w.text.trim()).join('');
        const graphemeCount = splitGraphemes(mergedTextForConfig.replace(/\s+/g, '')).length;
        const rowBias = rowIndex - (rowCount - 1) / 2;
        const isStaggeredLeft = rowIndex % 2 === 0;

        const staggerMagnitude = tuning.staggerMin + random() * Math.max(tuning.staggerMax - tuning.staggerMin, 0);
        const staggerScale = isCalm ? 1 : 0.8 + random() * 0.9;
        const desiredScale = (isChaotic ? 1 + Math.min(graphemeCount * 0.01, 0.05) : 1) * staggerScale;

        const geometry = measurePartitaRowGeometry(displayWords, fontPx, measure);
        const scaledHalfWidth = (geometry.textWidth + geometry.gaps + CHUNK_PADDING_PX) / 2 + ACTIVE_PEAK_EXTRA * geometry.maxWordWidth;

        let scale = desiredScale;
        if (clampTransforms && scaledHalfWidth > 0) {
            scale = Math.max(SCALE_FLOOR, Math.min(desiredScale, (halfViewport - fixedSpan - MIN_STAGGER_PX) / scaledHalfWidth));
        }

        const staggerCap = Math.max(0, halfViewport - fixedSpan - scale * scaledHalfWidth);
        const staggerX = (clampTransforms ? Math.min(staggerMagnitude, staggerCap) : staggerMagnitude) * (isStaggeredLeft ? -1 : 1);
        const fits = getPartitaRowHalfSpan(geometry, scale, staggerX, tuning.showGuideLines) <= halfViewport;

        rows.push({
            chunkUnits,
            chunkWords,
            displayWords,
            order: rowIndex,
            rowIndex,
            fits,
            config: {
                id: `${rowIndex}-${chunkWords[0].startTime}`,
                x: staggerX,
                y: isCalm ? 0 : rowBias * 2.5,
                rotate: isChaotic ? (isStaggeredLeft ? -3 : 3) : 0,
                scale,
                marginBottom: isChaotic ? '0.4rem' : '0.6rem',
                alignSelf: 'center',
                passedRotate: (rowIndex % 2 === 0 ? 1 : -1) * (isChaotic ? 6 : 3),
            },
        });
    });
    return rows;
};

const assembleLayout = (
    rows: BuiltRow[],
    line: Line,
    totalGraphemes: number,
    density: number,
    perspective: number,
): PartitaSequentialLayout => {
    const columns: PartitaColumn[] = [];
    if (rows.length > 0) {
        columns.push({
            id: `column-${line.startTime}-0`,
            words: rows.map(({ chunkUnits, chunkWords, displayWords, config, order, rowIndex }) => ({
                chunkUnits,
                chunkWords,
                displayWords,
                config,
                order,
                rowIndex,
            })),
        });
    }

    return {
        columns,
        totalGraphemes,
        fontDensityScale: density,
        lineConfig: {
            perspective,
            alignItems: 'items-center',
            justifyContent: 'justify-center',
            columnGap: '2rem',
        },
    };
};

const buildSequentialColumns = (
    line: Line,
    theme: Theme,
    viewport: PartitaViewport,
    tuning: PartitaTuning,
    measure: PartitaWidthMeasure,
): PartitaSequentialLayout => {
    // Partita wants the line to feel "composed", not scattered.
    // So instead of throwing each word around independently, first decide how many chunks/rows the line should have.
    const totalGraphemes = Math.max(splitGraphemes(line.fullText.replace(/\s+/g, '')).length, line.words.length, 1);
    const layoutUnits = buildPostLyricLayoutUnits(line, {
        semantic: tuning.useSemanticLayout,
        sticky: true,
    });
    if (layoutUnits.length === 0) {
        return { ...EMPTY_PARTITA_LAYOUT, totalGraphemes };
    }

    // Legacy density: 行数历史上只看高度，>40 字素整体缩到 0.8。放得下时一切照旧。
    const legacyDensity = totalGraphemes > 40 ? 0.8 : 1;
    const baseRowHeight = 100;
    const availableHeight = viewport.height * 0.65;
    const heightRowCount = Math.max(1, Math.floor(availableHeight / baseRowHeight));

    const passARandom = makeRandom(line.startTime);
    const passARows = Math.min(layoutUnits.length, heightRowCount);
    const passAChunks = splitIntoChunks(layoutUnits, passARows, passARandom);
    const passARowConfigs = buildRows(
        passAChunks,
        viewport.fontPx * legacyDensity,
        passARows,
        theme,
        viewport,
        tuning,
        measure,
        passARandom,
        false,
    );

    const perspective = theme.animationIntensity === 'chaotic' ? 720 : 1000;

    if (passARowConfigs.length > 0 && passARowConfigs.every(row => row.fits)) {
        return assembleLayout(passARowConfigs, line, totalGraphemes, legacyDensity, perspective);
    }

    // 窄屏兜底：先试历史行只收 stagger/scale（保住桌面的分组），再按宽度贪心重分 + 字号降档。
    const widthBudget = viewport.width - CONTAINER_PADDING_PX - CHUNK_PADDING_PX - COLUMN_PADDING_PX * 2
        - (tuning.showGuideLines ? GUIDE_EDGE_PX * 2 : 0) - WORD_JITTER_PX * 2 - MIN_STAGGER_PX * 2;
    const candidates = [legacyDensity, ...DENSITY_LADDER.filter(d => d < legacyDensity)];
    let lastAttempt: { rows: BuiltRow[]; density: number } | null = null;

    for (const density of candidates) {
        const fontPx = viewport.fontPx * density;
        const attemptRandom = makeRandom(line.startTime);

        if (density === legacyDensity) {
            const clampedRows = buildRows(passAChunks, fontPx, passARows, theme, viewport, tuning, measure, attemptRandom, true);
            if (clampedRows.length > 0 && clampedRows.every(row => row.fits)) {
                return assembleLayout(clampedRows, line, totalGraphemes, density, perspective);
            }
        }

        const pitch = fontPx * GLOW_LINE_HEIGHT + ROW_EXTRA_PX;
        const capacity = Math.max(1, Math.max(heightRowCount, Math.floor(availableHeight / pitch)));
        const widthChunks = splitByWidth(layoutUnits, fontPx, widthBudget, measure);
        if (widthChunks.length > capacity) continue;

        const rows = buildRows(widthChunks, fontPx, widthChunks.length, theme, viewport, tuning, measure, attemptRandom, true);
        lastAttempt = { rows, density };
        if (rows.length > 0 && rows.every(row => row.fits)) {
            return assembleLayout(rows, line, totalGraphemes, density, perspective);
        }
    }

    if (lastAttempt) {
        if (!lastAttempt.rows.every(row => row.fits)) {
            console.warn('[partita] 窄屏兜底到最小字号仍放不下，接受残余溢出', {
                startTime: line.startTime,
                width: viewport.width,
                fullText: line.fullText,
            });
        }
        return assembleLayout(lastAttempt.rows, line, totalGraphemes, lastAttempt.density, perspective);
    }

    return { ...EMPTY_PARTITA_LAYOUT, totalGraphemes };
};

export const buildPartitaLayoutCacheKey = (
    line: Line,
    theme: Theme,
    viewport: PartitaViewport,
    tuning: PartitaTuning
) => {
    const windowHeightBucket = Math.round(viewport.height / 24);
    const windowWidthBucket = Math.round(viewport.width / 24);
    return [
        'semantic-layout-v2',
        line.startTime,
        line.endTime,
        line.words.length,
        line.fullText,
        // The saved split feeds buildPostLyricLayoutUnits below, so it changes the columns. The
        // cache outlives a re-segmentation of the song playing (it is only bounded by its LRU),
        // so without this a line already on screen kept the layout built from the old split.
        getWordSegmentationKey(line),
        theme.animationIntensity,
        theme.fontWeight ?? 'auto',
        windowHeightBucket,
        windowWidthBucket,
        Math.round(viewport.fontPx),
        viewport.fontMetrics.fontWeight,
        viewport.fontMetrics.fontFamily,
        tuning.staggerMin,
        tuning.staggerMax,
        tuning.showGuideLines ? 1 : 0,
        tuning.useSemanticLayout ? 1 : 0,
    ].join('|');
};

export const getOrBuildPartitaLayout = (
    cache: Map<string, PartitaSequentialLayout>,
    line: Line,
    theme: Theme,
    viewport: PartitaViewport,
    tuning: PartitaTuning,
    measure?: PartitaWidthMeasure
): PartitaSequentialLayout => {
    const cacheKey = buildPartitaLayoutCacheKey(line, theme, viewport, tuning);
    const cached = cache.get(cacheKey);
    if (cached) {
        // Layout cache matters here because rebuilding columns on every frame would be pointless and expensive.
        return cached;
    }

    const widthMeasure: PartitaWidthMeasure = measure
        ?? ((text, fontPx) => measurePartitaTextWidth(text, fontPx, viewport.fontMetrics));
    const layout = buildSequentialColumns(line, theme, viewport, tuning, widthMeasure);
    return rememberBounded(cache, cacheKey, layout, PARTITA_LAYOUT_CACHE_LIMIT);
};
