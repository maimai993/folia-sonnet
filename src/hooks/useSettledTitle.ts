import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { fitTitle, TYPOGRAPHY } from '../utils/fitSettledTitle';

// src/hooks/useSettledTitle.ts — defer title fitting until its layout width stops changing.

// A null fitter keeps the original CSS-only behavior; probes can compare strategies on the real wall.
export const TitleFitterContext = createContext<((node: HTMLElement, text: string) => string) | null>(fitTitle);

/** Ignore transform-only motion and height changes caused by fitting the title itself. */
export function useSettledTitle(text: string, expanded: boolean) {
    const fitter = useContext(TitleFitterContext);
    const ref = useRef<HTMLElement>(null);
    const [result, setResult] = useState<{ source: string; value: string } | null>(null);
    useEffect(() => {
        const node = ref.current;
        if (!node || !fitter) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let visible = false;
        let disposed = false;
        let width = -1;
        const cache = new Map<string, string>();
        const schedule = () => {
            clearTimeout(timer);
            setResult(null);
            if (!visible || disposed) return;
            timer = setTimeout(() => {
                const style = getComputedStyle(node);
                if (parseFloat(style.width) <= 0) return;
                const key = [style.width, ...TYPOGRAPHY.map(property => style.getPropertyValue(property))].join('|');
                let value = cache.get(key);
                if (value === undefined) {
                    value = fitter(node, text);
                    if (cache.size >= 8) cache.clear();
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
        const fontsChanged = () => { cache.clear(); schedule(); };
        resize.observe(node);
        intersection.observe(node);
        window.addEventListener('resize', schedule);
        document.fonts.addEventListener('loadingdone', fontsChanged);
        void document.fonts.ready.then(() => { if (!disposed) fontsChanged(); });
        return () => {
            disposed = true;
            clearTimeout(timer);
            resize.disconnect();
            intersection.disconnect();
            window.removeEventListener('resize', schedule);
            document.fonts.removeEventListener('loadingdone', fontsChanged);
        };
    }, [text, expanded, fitter]);
    return { ref, value: result?.source === text ? result.value : text, settled: result?.source === text };
}
