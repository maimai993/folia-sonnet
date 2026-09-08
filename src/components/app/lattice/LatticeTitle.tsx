import { useCallback } from 'react';
import { useSettledTitle } from '../../../hooks/useSettledTitle';
import { expandedTitleWidth } from './expandedTitleWidth';

// src/components/app/lattice/LatticeTitle.tsx — preserve the full accessible title while fitting its preview.
export function LatticeTitle({ title, expanded, layoutSettled, targetPosterWidth }:
    { title: string; expanded: boolean; layoutSettled?: boolean; targetPosterWidth?: number }) {
    // The poster's target rect is known before the spring runs, so the fit need not wait for it.
    const measureTargetWidth = useCallback(
        (node: HTMLElement) => targetPosterWidth === undefined ? null : expandedTitleWidth(node, targetPosterWidth),
        [targetPosterWidth],
    );
    const { ref, value, settled } = useSettledTitle(title, expanded, { layoutSettled, measureTargetWidth });
    return <strong ref={ref} aria-label={title} title={title} data-title-settled={settled || undefined}>{value}</strong>;
}
