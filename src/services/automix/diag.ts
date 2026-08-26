// src/services/automix/diag.ts
// TEMPORARY companion to electron/analysis/diag.cjs. Forwards renderer stage marks and a JS-heap
// curve into the SAME main-side log, so the renderer's own memory trend lines up against the
// per-process working-set curve. No-ops entirely off Electron (web build, tests).

const bridge = (): ((text: string) => void) | undefined =>
    (typeof window !== 'undefined' ? (window as unknown as { electron?: { diagMark?: (t: string) => void } }).electron?.diagMark : undefined);

/** Drop a one-line stage marker into the diag log. Never throws into playback. */
export const diagMark = (text: string): void => {
    try { bridge()?.(text); } catch { /* logging must never break a transition */ }
};

let heapTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Idempotent. Samples the renderer JS heap every 2s. The discriminator the process-level curve
 * can't give on its own: growth HERE means leaked JS objects; a flat heap while the renderer's
 * working set climbs means native memory (decoded audio buffers, WebAudio nodes, WebGL).
 */
export const startDiagHeapSampler = (): void => {
    if (heapTimer || typeof window === 'undefined') return;
    if (!bridge()) return; // not Electron - nothing to send to
    const perf = performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } };
    if (!perf.memory) return; // non-Chromium - usedJSHeapSize unavailable
    const sample = () => {
        const used = Math.round(perf.memory!.usedJSHeapSize / 1048576);
        const total = Math.round(perf.memory!.totalJSHeapSize / 1048576);
        diagMark(`heap used=${used}MB total=${total}MB`);
    };
    heapTimer = setInterval(sample, 2000);
    sample();
};
