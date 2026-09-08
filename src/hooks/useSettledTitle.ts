import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { fitTitle } from '../utils/fitSettledTitle';
import { sharedTitleFitCache, titleFitCacheKey, type TitleFitCache } from '../utils/settledTitleCache';

// src/hooks/useSettledTitle.ts — defer title fitting until its layout width stops changing.

export type TitleFitter = (node: HTMLElement, text: string, width?: string) => string;

// A null fitter keeps the original CSS-only behavior; probes can compare strategies on the real wall.
const defaultFitter: TitleFitter = (node, text, width) => fitTitle(node, text, { width });
export const TitleFitterContext = createContext<TitleFitter | null>(defaultFitter);

// Shared so a poster that pans back into view reuses its earlier measurement. A probe measuring
// cache misses provides its own instance so results cannot leak between trials.
export const TitleFitCacheContext = createContext<TitleFitCache>(sharedTitleFitCache);

// How far below the predicted width the head start is measured. A string that fits a narrower box
// fits a wider one, so erring low keeps a prediction from ever producing an overflowing line, at a
// cost of at most one grapheme.
const PREDICTION_MARGIN = 0.5;

type Options = {
    /** The box is known to have stopped growing, so a pending fit no longer has to wait. */
    layoutSettled?: boolean;
    /** Width the box is heading for, in layout pixels; null when it cannot be predicted. */
    measureTargetWidth?: (node: HTMLElement) => number | null;
};

/**
 * Ignore transform-only motion and height changes caused by fitting the title itself.
 *
 * Until the fit lands the element shows the untruncated title under a CSS line clamp, which breaks
 * at a word boundary and can leave the last visible line half empty — so the wait is visible, not
 * merely late. Both options exist to shorten it without measuring any more often.
 */
export function useSettledTitle(text: string, expanded: boolean, options?: Options) {
    const { layoutSettled = false, measureTargetWidth } = options ?? {};
    const fitter = useContext(TitleFitterContext);
    const cache = useContext(TitleFitCacheContext);
    const ref = useRef<HTMLElement>(null);
    const [result, setResult] = useState<{ source: string; value: string } | null>(null);
    // Set while an effect holds a pending fit; `layoutSettled` uses it to bring that fit forward.
    const flush = useRef<(() => void) | null>(null);
    // A fit measured against a width the box has not reached yet, waiting for it to arrive.
    const headStart = useRef<{ source: string; width: number; value: string } | null>(null);
    useEffect(() => {
        const node = ref.current;
        if (!node || !fitter) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let visible = false;
        let disposed = false;
        let width = -1;
        const measure = () => {
            timer = undefined;
            const style = getComputedStyle(node);
            if (parseFloat(style.width) <= 0) return;
            const key = titleFitCacheKey(text, style);
            let value = cache.get(key);
            if (value === undefined) {
                value = fitter(node, text);
                cache.set(key, value);
            }
            setResult({ source: text, value });
        };
        const schedule = () => {
            clearTimeout(timer);
            timer = undefined;
            if (!visible || disposed) {
                setResult(null);
                return;
            }
            const style = getComputedStyle(node);
            const live = parseFloat(style.width);
            if (live > 0) {
                // The debounce is there to avoid re-measuring through a reflow, and neither of these
                // measures anything. Applying one spares the poster a spell of clamped, untruncated
                // text; the head start is accepted only for the width it was actually measured at,
                // and only from below, so it can be narrower than the box but never wider.
                const key = titleFitCacheKey(text, style);
                let hit = cache.get(key);
                const ready = headStart.current;
                if (hit === undefined && ready?.source === text
                    && ready.width <= live && live - ready.width <= 1 + PREDICTION_MARGIN) {
                    hit = ready.value;
                    cache.set(key, hit);
                }
                if (hit !== undefined) {
                    setResult({ source: text, value: hit });
                    return;
                }
            }
            setResult(null);
            timer = setTimeout(measure, 200);
        };
        // Only ever brings a pending fit forward. Once one has landed there is nothing to accelerate,
        // so a `layoutSettled` arriving after the debounce already fired cannot re-measure or flicker.
        flush.current = () => { if (timer !== undefined) { clearTimeout(timer); measure(); } };
        const resize = new ResizeObserver(entries => {
            const next = entries[0].contentRect.width;
            if (next === width) return;
            width = next;
            schedule();
        });
        const intersection = new IntersectionObserver(entries => {
            visible = entries[0].isIntersecting;
            schedule();
        });
        resize.observe(node);
        intersection.observe(node);
        window.addEventListener('resize', schedule);
        // The epoch inside the cache key already retires measurements taken against the old faces,
        // so a font load only has to re-run the fit, never clear a cache other posters are using.
        document.fonts.addEventListener('loadingdone', schedule);
        void document.fonts.ready.then(() => { if (!disposed) schedule(); });
        return () => {
            disposed = true;
            clearTimeout(timer);
            flush.current = null;
            resize.disconnect();
            intersection.disconnect();
            window.removeEventListener('resize', schedule);
            document.fonts.removeEventListener('loadingdone', schedule);
        };
    }, [text, expanded, fitter, cache]);
    useEffect(() => { if (layoutSettled) flush.current?.(); }, [layoutSettled]);
    // Measure against where an expanding box is going while it is still on its way. Nothing is shown
    // early: `schedule` picks this up only once the box has actually arrived, so a wrong prediction
    // costs one unused measurement and is invisible. Only the growing card does this, so a reflow
    // that moves every poster does not turn into a fit per poster.
    useEffect(() => {
        const node = ref.current;
        if (!expanded || !node || !fitter || !measureTargetWidth) return;
        const predicted = measureTargetWidth(node);
        if (predicted === null || !(predicted > 0)) return;
        const target = predicted - PREDICTION_MARGIN;
        if (parseFloat(getComputedStyle(node).width) >= target) return;
        headStart.current = { source: text, width: target, value: fitter(node, text, `${target}px`) };
    }, [expanded, text, fitter, measureTargetWidth]);
    return { ref, value: result?.source === text ? result.value : text, settled: result?.source === text };
}
