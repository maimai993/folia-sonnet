import { describe, expect, it } from 'vitest';
import { DEFAULT_PARTITA_TUNING, type Line, type Theme } from '@/types';
import { buildPostLyricLayoutUnits } from '@/utils/lyrics/cjkSemanticLayout';
import {
    getOrBuildPartitaLayout,
    getPartitaRowHalfSpan,
    measurePartitaRowGeometry,
    resolvePartitaBaseFontPx,
    type PartitaViewport,
    type PartitaWidthMeasure,
} from '@/components/visualizer/partita/partitaLayout';

// test/unit/visualizer/partitaNarrowFit.test.ts
// 云阶窄屏适配的纯判定：布局输出的每一行（含 stagger、chunk scale、active 峰值、引导线伸出量）
// 都必须落在视口半径内；宽屏放得下时保持历史行为（density=1、行数只由高度决定）。
// 测宽注入的是「每个字素一个 em」的单宽字体，与真实 CJK 字面行为一致且结果确定。

const makeLine = (fullText: string, startTime = 36.6): Line => ({
    id: 'line-1',
    startTime,
    endTime: startTime + fullText.length * 0.4,
    fullText,
    words: Array.from(fullText, (text, index) => ({
        text,
        startTime: startTime + index * 0.4,
        endTime: startTime + (index + 1) * 0.4,
    })),
    isChorus: false,
});

const theme = { animationIntensity: 'normal' } as unknown as Theme;

const fakeMeasure: PartitaWidthMeasure = (text, fontPx) => Array.from(text).length * fontPx;

const makeViewport = (width: number, height: number, fontPx: number): PartitaViewport => ({
    width,
    height,
    fontPx,
    fontMetrics: { fontWeight: 700, fontFamily: 'Test' },
});

const rowsOf = (layout: ReturnType<typeof getOrBuildPartitaLayout>) =>
    layout.columns.flatMap(column => column.words.map(row => ({
        displayWords: row.displayWords,
        config: row.config,
    })));

describe('partita narrow fit', () => {
    it('keeps every row inside the viewport on a 390×844 portrait phone', () => {
        const viewport = makeViewport(390, 844, resolvePartitaBaseFontPx(390, 1));
        const layout = getOrBuildPartitaLayout(new Map(), makeLine('我们慢慢走回去，星河与风一起落在很远很远的地方'), theme, viewport, DEFAULT_PARTITA_TUNING, fakeMeasure);
        const rows = rowsOf(layout);

        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            const geometry = measurePartitaRowGeometry(row.displayWords, viewport.fontPx * layout.fontDensityScale, fakeMeasure);
            const halfSpan = getPartitaRowHalfSpan(geometry, row.config.scale, row.config.x, true);
            expect(halfSpan).toBeLessThanOrEqual(viewport.width / 2);
        }
    });

    it('keeps every row inside the viewport on a 360×780 portrait phone with a 31-char line', () => {
        const viewport = makeViewport(360, 780, resolvePartitaBaseFontPx(360, 1));
        const layout = getOrBuildPartitaLayout(new Map(), makeLine('我听见远方的海潮一遍一遍拍打着沉默的礁石和那座早已熄灭多年的灯塔'), theme, viewport, DEFAULT_PARTITA_TUNING, fakeMeasure);
        const rows = rowsOf(layout);

        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            const geometry = measurePartitaRowGeometry(row.displayWords, viewport.fontPx * layout.fontDensityScale, fakeMeasure);
            const halfSpan = getPartitaRowHalfSpan(geometry, row.config.scale, row.config.x, true);
            expect(halfSpan).toBeLessThanOrEqual(viewport.width / 2);
        }
    });

    it('shrinks the font only when row count would exceed the height budget', () => {
        // 360 宽 + 引导线时每行只装得下 3 个字素，31 字行按 density 1 要 11 行，
        // 超出高度预算 → 必须降档字号，行数回到预算内。
        const viewport = makeViewport(360, 780, resolvePartitaBaseFontPx(360, 1));
        const layout = getOrBuildPartitaLayout(new Map(), makeLine('我听见远方的海潮一遍一遍拍打着沉默的礁石和那座早已熄灭多年的灯塔'), theme, viewport, DEFAULT_PARTITA_TUNING, fakeMeasure);

        expect(layout.fontDensityScale).toBeLessThan(1);
        const pitch = viewport.fontPx * layout.fontDensityScale * 1.22 + 16;
        expect(layout.columns[0].words.length).toBeLessThanOrEqual(Math.floor(780 * 0.65 / pitch));
    });

    it('keeps the legacy layout on a wide desktop viewport', () => {
        const viewport = makeViewport(1440, 1100, resolvePartitaBaseFontPx(1440, 1));
        const line = makeLine('我们慢慢走回去，星河与风一起落在很远很远的地方');
        const layout = getOrBuildPartitaLayout(new Map(), line, theme, viewport, DEFAULT_PARTITA_TUNING, fakeMeasure);

        expect(layout.fontDensityScale).toBe(1);
        const expectedRowCount = Math.min(
            buildPostLyricLayoutUnits(line, { semantic: true, sticky: true }).length,
            Math.max(1, Math.floor(1100 * 0.65 / 100)),
        );
        expect(layout.columns[0].words.length).toBe(expectedRowCount);
        for (const row of rowsOf(layout)) {
            const geometry = measurePartitaRowGeometry(row.displayWords, viewport.fontPx, fakeMeasure);
            expect(getPartitaRowHalfSpan(geometry, row.config.scale, row.config.x, true))
                .toBeLessThanOrEqual(viewport.width / 2);
        }
    });

    it('falls back to estimated widths and still returns rows when measuring is unavailable', () => {
        const viewport = makeViewport(390, 844, resolvePartitaBaseFontPx(390, 1));
        const layout = getOrBuildPartitaLayout(new Map(), makeLine('我们慢慢走回去，星河与风一起落在很远很远的地方'), theme, viewport, DEFAULT_PARTITA_TUNING);

        expect(layout.columns.length).toBeGreaterThan(0);
        expect(layout.fontDensityScale).toBeGreaterThan(0);
    });

    it('survives a single unbreakable unit that cannot fit any density', () => {
        const viewport = makeViewport(320, 700, resolvePartitaBaseFontPx(320, 1));
        const layout = getOrBuildPartitaLayout(new Map(), makeLine('超长英文单词perpendicularity不允许拆分'), theme, viewport, DEFAULT_PARTITA_TUNING, fakeMeasure);

        expect(layout.columns.length).toBeGreaterThan(0);
        expect(layout.fontDensityScale).toBeGreaterThan(0);
    });
});
