// src/utils/fitSettledTitle.ts — browser-native three-line title fitting.

export const TYPOGRAPHY = ['font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch',
    'font-variation-settings', 'line-height', 'letter-spacing', 'word-spacing', 'text-transform',
    'text-wrap', 'word-break', 'overflow-wrap', 'white-space'] as const;

/**
 * Measure an isolated copy only after settling; binary search never edits the visible card.
 *
 * `width` fits against a box the node has not reached yet — an expanding poster knows where it is
 * headed before it gets there. Only the width may differ: the three-line limit comes from the
 * line height, which here is set by the viewport rather than by the container.
 */
export function fitTitle(node: HTMLElement, text: string, options?: { width?: string; onRead?: () => void }) {
    const style = getComputedStyle(node);
    const probe = document.createElement('div');
    for (const property of TYPOGRAPHY) probe.style.setProperty(property, style.getPropertyValue(property));
    Object.assign(probe.style, {
        position: 'fixed', left: '0', top: '0', visibility: 'hidden', pointerEvents: 'none',
        width: options?.width ?? style.width, padding: '0', margin: '0', border: '0', boxSizing: 'border-box',
    });
    document.body.append(probe);
    const limit = parseFloat(style.lineHeight) * 3 + 1;
    const fits = (value: string) => {
        probe.textContent = value;
        options?.onRead?.();
        return probe.getBoundingClientRect().height <= limit;
    };
    try {
        if (fits(text)) return text;
        const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]
            .map(segment => segment.segment);
        let low = 0;
        let high = segments.length;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (fits(`${segments.slice(0, middle).join('').trimEnd()}…`)) low = middle;
            else high = middle - 1;
        }
        return `${segments.slice(0, low).join('').trimEnd()}…`;
    } finally {
        probe.remove();
    }
}

