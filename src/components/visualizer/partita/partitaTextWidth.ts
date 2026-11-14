import { rememberBounded } from '../../../utils/visualizer/textMeasureCache';

// src/components/visualizer/partita/partitaTextWidth.ts
// 云阶的实测行宽：按 GlowWord 实际渲染的字体串用 canvas measureText 量文本宽度，结果按字体+文本缓存。
// 没有 2d context 的环境（node 单测、极端沙箱）退回按字素的粗估，布局仍可构建。

interface PartitaFontMetrics {
    fontFamily: string;
    fontWeight: number;
}

const WIDTH_CACHE_LIMIT = 512;
const widthCache = new Map<string, number>();

let cachedContext: CanvasRenderingContext2D | null | undefined;

const getContext = (): CanvasRenderingContext2D | null => {
    if (cachedContext !== undefined) return cachedContext;
    cachedContext = typeof document === 'undefined'
        ? null
        : document.createElement('canvas').getContext('2d');
    return cachedContext;
};

// CJK 全角字素按一个 em、空白按 0.3 em、其余按 0.55 em 粗估；只在测不了的时候兜底。
const WIDE_GLYPH = /[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/;

const estimateTextWidth = (text: string, fontPx: number) => {
    let emTotal = 0;
    for (const char of text) {
        emTotal += WIDE_GLYPH.test(char) ? 1 : /\s/.test(char) ? 0.3 : 0.55;
    }
    return emTotal * fontPx;
};

export const measurePartitaTextWidth = (text: string, fontPx: number, metrics: PartitaFontMetrics): number => {
    if (!text) return 0;
    const context = getContext();
    if (!context || fontPx <= 0) {
        return estimateTextWidth(text, Math.max(fontPx, 0));
    }
    const key = `${metrics.fontWeight}|${fontPx}|${metrics.fontFamily}|${text}`;
    const cached = widthCache.get(key);
    if (cached !== undefined) return cached;
    context.font = `${metrics.fontWeight} ${fontPx}px ${metrics.fontFamily}`;
    const width = context.measureText(text).width;
    return rememberBounded(widthCache, key, width, WIDTH_CACHE_LIMIT);
};

// Web 字体加载完成后调：字体串在加载前后不变，缓存里的旧度量必须整体作废。
export const clearPartitaTextWidthCache = () => {
    widthCache.clear();
};

export type { PartitaFontMetrics };
