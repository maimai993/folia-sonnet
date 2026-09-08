import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { fitTitle } from '../utils/fitSettledTitle';
import { sharedTitleFitCache, titleFitCacheKey, type TitleFitCache } from '../utils/settledTitleCache';

// src/hooks/useSettledTitle.ts — defer title fitting until its layout width stops changing.

// A null fitter keeps the original CSS-only behavior; probes can compare strategies on the real wall.
export const TitleFitterContext = createContext<((node: HTMLElement, text: string) => string) | null>(fitTitle);

// Shared so a poster that pans back into view reuses its earlier measurement. A probe measuring
// cache misses provides its own instance so results cannot leak between trials.
export const TitleFitCacheContext = createContext<TitleFitCache>(sharedTitleFitCache);

/** Ignore transform-only motion and height changes caused by fitting the title itself. */
export function useSettledTitle(text: string, expanded: boolean) {
    const fitter = useContext(TitleFitterContext);
    const cache = useContext(TitleFitCacheContext);
    const ref = useRef<HTMLElement>(null);
    const [result, setResult] = useState<{ source: string; value: string } | null>(null);
    useEffect(() => {
        const node = ref.current;
        if (!node || !fitter) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let visible = false;
        let disposed = false;
        let width = -1;
        const schedule = () => {
            clearTimeout(timer);
            setResult(null);
            if (!visible || disposed) return;
            timer = setTimeout(() => {
                const style = getComputedStyle(node);
                if (parseFloat(style.width) <= 0) return;
                const key = titleFitCacheKey(text, style);
                let value = cache.get(key);
                if (value === undefined) {
                    value = fitter(node, text);
                    cache.set(key, value);
                }
                setResult({ source: text, value });
            }, 200);
        };
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
            resize.disconnect();
            intersection.disconnect();
            window.removeEventListener('resize', schedule);
            document.fonts.removeEventListener('loadingdone', schedule);
        };
    }, [text, expanded, fitter, cache]);
    return { ref, value: result?.source === text ? result.value : text, settled: result?.source === text };
}
