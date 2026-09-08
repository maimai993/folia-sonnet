// src/components/app/lattice/expandedTitleWidth.ts — where a poster's title will land once it grows.

/**
 * The layout width the title box will settle at when its poster reaches `posterWidth`.
 *
 * Read from the live cascade rather than duplicated from the stylesheet: the copy block's insets
 * resolve to pixels because it is absolutely positioned, and a percentage `max-width` survives in
 * the computed value. `posterWidth` is the poster's target rect in world units, so the camera scale
 * never enters the arithmetic. Returns null when the shape this relies on does not hold, which
 * callers must treat as "do not predict" rather than as a width of zero.
 */
export function expandedTitleWidth(node: HTMLElement, posterWidth: number): number | null {
    const box = node.parentElement;
    if (!box) return null;
    const style = getComputedStyle(box);
    if (style.position !== 'absolute') return null;
    const inset = parseFloat(style.left) + parseFloat(style.right)
        + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
        + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    if (!Number.isFinite(inset)) return null;
    const available = posterWidth - inset;
    if (!(available > 0)) return null;
    const limit = getComputedStyle(node).maxWidth;
    if (limit.endsWith('%')) return available * parseFloat(limit) / 100;
    const pixels = parseFloat(limit);
    return Number.isFinite(pixels) ? Math.min(available, pixels) : available;
}
