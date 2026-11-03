import React, { useEffect, useMemo, useState } from 'react';
import { Button } from './ui';
import { DebugRow, formatMs } from './devDebugPanels';
import { readFrameTimingSnapshot, runCpuProbe } from '../utils/frameTimingDiagnostics';
import { readAiThemeAttempts } from '../utils/aiThemeDiagnostics';
import { readMediaDiagnostics } from '../utils/mediaDiagnostics';
import { readAudioPipelineDiagnostics, type AudioPipelineReading } from '../services/audioPipelineDiagnostics';
import { audioPipelineRows } from '../utils/audioPipelineFormat';
import { usePerfDiagnosticsStore } from '../stores/usePerfDiagnosticsStore';

// src/components/PerfDebugPanel.tsx
// The Perf tab: frame timing, the device, audio continuity and the last AI theme attempts.

/**
 * 卡顿与 AI 诊断页。
 *
 * 「卡」有两种完全不同的成因：我们的渲染开销（帧间隔、longtask）与设备本身不够（核数、
 * 内存、处理器探针）。三条放在一起才不会把用户设备性能不足当成我们的 bug，也不会反过来。
 * AI 那一段是 AI 主题生成的最近几次尝试，用来解释「偶尔生成不出来」。
 *
 * 数值每秒刷新一次即可 —— 采样本身在 utils/frameTimingDiagnostics 里持续进行，
 * 这里只是读数。处理器探针要占住主线程 250ms，所以只在按下按钮时跑。
 */
export const PerfPanel: React.FC<{ isDaylight: boolean; panelClass: string; }> = ({ isDaylight, panelClass }) => {
    const [tick, setTick] = useState(0);
    const [cpu, setCpu] = useState<ReturnType<typeof runCpuProbe> | null>(null);
    const [probing, setProbing] = useState(false);

    useEffect(() => {
        const handle = window.setInterval(() => setTick(value => value + 1), 1000);
        return () => window.clearInterval(handle);
    }, []);

    /*
     * 原生音频链路：单独一条 2s 的拉取。
     *
     * 它跟上面那条 1s 的 tick 分开，是因为读数要走 Capacitor 的桥 —— 而桥只有一条，
     * 跟着每个 tick 拉会跟播放控制抢通道。服务内部还有 1.5s 缓存兜底。
     */
    const [native, setNative] = useState<AudioPipelineReading | null>(null);
    useEffect(() => {
        let cancelled = false;
        const pull = () => {
            void readAudioPipelineDiagnostics().then(next => {
                if (!cancelled && next) setNative(next);
            });
        };
        pull();
        const handle = window.setInterval(pull, 2000);
        return () => {
            cancelled = true;
            window.clearInterval(handle);
        };
    }, []);

    const perfEnabled = usePerfDiagnosticsStore(state => state.perfDiagnosticsEnabled);
    const frames = useMemo(() => readFrameTimingSnapshot(), [tick]);
    const media = useMemo(() => readMediaDiagnostics(), [tick]);
    const aiAttempts = useMemo(() => readAiThemeAttempts().slice(-4).reverse(), [tick]);
    const stats = frames.stats;
    const ms = (value: number | null) => (value === null ? 'n/a' : `${value.toFixed(1)}ms`);
    const fps = (value: number | null) => (value === null ? 'n/a' : `${value.toFixed(0)}fps`);
    const buttonClass = isDaylight
        ? 'rounded-full border border-black/10 px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] hover:bg-black/[0.05] disabled:opacity-50'
        : 'rounded-full border border-white/10 px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] hover:bg-white/[0.07] disabled:opacity-50';

    return (
        <>
            <section className={panelClass}>
                {/* 采样默认关：这里全是 0 不是"很流畅"，而是根本没在采。说明必须写在最上面。 */}
                <div className="px-3 pt-3 text-[10px] leading-relaxed opacity-60">
                    {perfEnabled
                        ? 'Sampling on.'
                        : 'Sampling off — open 开发者选项 → 性能采样 to start collecting. Numbers below stay at zero until then.'}
                </div>
                <div className="px-3 pt-3 text-[10px] uppercase tracking-[0.16em] opacity-60">Frame Timing</div>
                <div className="px-3 pb-3">
                    <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[10px]">
                        <DebugRow label="health" value={frames.renderHealth} />
                        <DebugRow label="refresh" value={frames.refreshHz === null ? 'n/a' : `${frames.refreshHz}Hz`} />
                        <DebugRow label="frames" value={String(frames.frameCount)} />
                        <DebugRow label="p50" value={ms(stats.p50Ms)} />
                        <DebugRow label="p95" value={ms(stats.p95Ms)} />
                        <DebugRow label="p99" value={ms(stats.p99Ms)} />
                        <DebugRow label="max" value={ms(stats.maxMs)} />
                        <DebugRow label="slow>32ms" value={String(frames.sessionSlowCount)} />
                        <DebugRow label="jank>50ms" value={String(frames.sessionJankCount)} />
                        <DebugRow label="freeze>100ms" value={`${frames.sessionFreezeCount} (max ${Math.round(frames.longestFreezeMs)}ms)`} />
                        <DebugRow label="worst 1s" value={fps(frames.worstSecondFps)} />
                        <DebugRow label="recent 1s" value={fps(frames.recentSecondFps)} />
                        <DebugRow label="longtasks" value={`${frames.longTasks.count} (self ${frames.longTasks.selfCount}, other ${frames.longTasks.otherCount})`} />
                        <DebugRow label="longtask max" value={frames.longTasks.count ? ms(frames.longTasks.maxMs) : 'n/a'} />
                    </dl>
                </div>
            </section>

            <section className={panelClass}>
                <div className="px-3 pt-3 text-[10px] uppercase tracking-[0.16em] opacity-60">Device</div>
                <div className="px-3 pb-3">
                    <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[10px]">
                        <DebugRow label="class" value={frames.deviceClass} />
                        <DebugRow label="cores" value={frames.cores === null ? 'n/a' : String(frames.cores)} />
                        <DebugRow label="memory" value={frames.memoryGb === null ? 'n/a' : `${frames.memoryGb}GB`} />
                        <DebugRow label="visible/hidden" value={`${(frames.visibleMs / 1000).toFixed(0)}s / ${(frames.hiddenMs / 1000).toFixed(0)}s`} />
                    </dl>
                    <div className="mt-3 flex items-center gap-3">
                        <Button
                            className={buttonClass}
                            disabled={probing}
                            onClick={() => {
                                setProbing(true);
                                // 让按钮先画出来：探针会占住主线程 250ms，同步跑会把点击卡住。
                                window.setTimeout(() => {
                                    try {
                                        setCpu(runCpuProbe());
                                    } finally {
                                        setProbing(false);
                                    }
                                }, 60);
                            }}
                        >
                            {probing ? 'running…' : 'run cpu probe'}
                        </Button>
                        {cpu && (
                            <span className="text-[10px] opacity-70">
                                {`${(cpu.opsPerSecond / 1e6).toFixed(0)}M ops/s · ${cpu.index} · ${cpu.durationMs.toFixed(0)}ms`}
                            </span>
                        )}
                    </div>
                </div>
            </section>

            <section className={panelClass}>
                <div className="px-3 pt-3 text-[10px] uppercase tracking-[0.16em] opacity-60">Audio Continuity</div>
                <div className="px-3 pb-3">
                    <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[10px]">
                        <DebugRow
                            label="waiting"
                            value={`${media.waitingCount} (total ${Math.round(media.waitingTotalMs)}ms, max ${Math.round(media.waitingMaxMs)}ms)${media.waitingNow ? ' · now' : ''}`}
                        />
                        <DebugRow label="stalled / errors" value={`${media.stalledCount} / ${media.errorCount}`} />
                        <DebugRow label="seeking / seeked" value={`${media.seekingCount} / ${media.seekedCount}`} />
                        <DebugRow label="rate changes" value={`${media.rateChangeCount} (rate ${media.playbackRate ?? 'n/a'})`} />
                        <DebugRow
                            label="buffer ahead"
                            value={media.bufferedAheadSec === null ? 'n/a' : `${media.bufferedAheadSec.toFixed(2)}s (${media.bufferedRanges} ranges)`}
                        />
                        <DebugRow label="ready/network" value={`${media.readyState ?? 'n/a'} / ${media.networkState ?? 'n/a'}`} />
                        <DebugRow label="last event" value={media.lastEvent ? `${media.lastEvent}${media.lastEventAt ? ` @${media.lastEventAt.slice(11, 19)}` : ''}` : 'n/a'} />
                        {/*
                         * 频谱走哪条路：worklet = 音频线程算完 post 出来，主线程一次都不等；
                         * analyser = 每帧在主线程上现算一遍 FFT（`getByteFrequencyData`），
                         * 正是整页掉帧且所有可视化模式一起慢的成因。卡的时候先看这一行。
                         */}
                        <DebugRow
                            label="spectrum via"
                            value={media.spectrumSource === 'analyser'
                                ? `analyser (兜底)${media.spectrumSourceReason ? ` · ${media.spectrumSourceReason}` : ''}`
                                : media.spectrumSource}
                        />
                        {/*
                         * hint 只是「请求」，落地成多少看 base / out —— 判「调缓冲有没有用」
                         * 要看这两个数动没动，两个数不动就说明这一档调了等于没调。
                         */}
                        <DebugRow
                            label="ctx latency"
                            value={`hint ${media.audioContextLatencyHint} · base ${formatMs(media.audioContextBaseLatencySec)} · out ${formatMs(media.audioContextOutputLatencySec)} · ${media.audioContextState ?? 'n/a'}`}
                        />
                    </dl>
                </div>
            </section>

            <section className={panelClass}>
                <div className="px-3 pt-3 text-[10px] uppercase tracking-[0.16em] opacity-60">Native Audio Pipeline</div>
                <div className="px-3 pb-3">
                    {/*
                     * 这一块是 P0 的标尺：解码格式 / 处理器链 / 声卡格式 / 欠载 / CPU 分四段摆开。
                     * 「音质变差」发生在这条链的哪一段，靠这四行对比就能定，不用再靠听。
                     */}
                    {!native ? (
                        <div className="pt-2 text-[11px] opacity-70">
                            非 Android 原生播放，或这次会话还没播过（播一首再看）。
                        </div>
                    ) : (
                        <>
                            <div className="pt-2 break-words text-[10px] leading-relaxed opacity-80">{native.verdict}</div>
                            <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[10px]">
                                {audioPipelineRows(native).map(row => (
                                    <DebugRow key={row.label} label={row.label} value={row.value} />
                                ))}
                            </dl>
                        </>
                    )}
                </div>
            </section>

            <section className={panelClass}>
                <div className="px-3 pt-3 text-[10px] uppercase tracking-[0.16em] opacity-60">AI Theme (recent)</div>
                <div className="px-3 pb-3">
                    {aiAttempts.length === 0 ? (
                        <div className="pt-2 text-[11px] opacity-70">还没有 AI 主题生成的记录。</div>
                    ) : (
                        <div className="mt-2 grid gap-1.5">
                            {aiAttempts.map(entry => (
                                <div key={`${entry.at}-${entry.provider}`} className="text-[10px] leading-relaxed">
                                    <span className="opacity-60">{new Date(entry.at).toLocaleTimeString()}</span>
                                    {' '}
                                    <span className={entry.ok ? 'font-semibold' : 'font-semibold text-red-400'}>
                                        {entry.ok ? 'ok' : 'fail'}
                                    </span>
                                    {' '}
                                    {entry.provider}/{entry.model}
                                    {` · ${entry.stage} · ${entry.durationMs}ms`}
                                    {entry.status ? ` · HTTP ${entry.status}` : ''}
                                    {entry.error ? (
                                        <div className="break-words opacity-70">{entry.error}</div>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </section>
        </>
    );
};

export default PerfPanel;
