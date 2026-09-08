import { useSettledTitle } from '../../../hooks/useSettledTitle';

// src/components/app/lattice/LatticeTitle.tsx — preserve the full accessible title while fitting its preview.
export function LatticeTitle({ title, expanded }: { title: string; expanded: boolean }) {
    const { ref, value, settled } = useSettledTitle(title, expanded);
    return <strong ref={ref} aria-label={title} title={title} data-title-settled={settled || undefined}>{value}</strong>;
}
