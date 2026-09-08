import { fitTitle } from '../../../src/utils/fitSettledTitle';

// dev/probes/lattice-performance/strategies.ts — identical scheduling, different cache-miss fitters.
export type Strategy = 'original' | 'current';
export type Counters = { calls: number; reads: number; ms: number };
export const emptyCounters = (): Counters => ({ calls: 0, reads: 0, ms: 0 });

/** A null fitter leaves the CSS-only baseline in place; the DOM fitter reports its own read count. */
export function makeFitter(strategy: Strategy, counters: Counters) {
    if (strategy === 'original') return null;
    return (node: HTMLElement, text: string, width?: string) => {
        const start = performance.now();
        const value = fitTitle(node, text, { width, onRead: () => counters.reads++ });
        counters.calls++;
        counters.ms += performance.now() - start;
        return value;
    };
}
