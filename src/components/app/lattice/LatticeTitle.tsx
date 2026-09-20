import { useCallback } from 'react';
import { useSettledTitle } from '../../../hooks/useSettledTitle';
import { titleLayoutWidth } from './titleLayoutWidth';

// src/components/app/lattice/LatticeTitle.tsx — preserve the full accessible title while fitting its preview.
export function LatticeTitle({ title, expanded, targetPosterWidth }:
    { title: string; expanded: boolean; targetPosterWidth?: number }) {
    // The poster's target rect is known before the spring runs, so the fit never waits for it.
    const measureWidth = useCallback(
        (node: HTMLElement) => targetPosterWidth === undefined ? null : titleLayoutWidth(node, targetPosterWidth),
        [targetPosterWidth],
    );
    const { ref, value, settled } = useSettledTitle(title, expanded, { measureWidth });
    return <strong ref={ref} aria-label={title} title={title} data-title-settled={settled || undefined}>{value}</strong>;
}
