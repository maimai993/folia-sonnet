import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMotionValue } from 'framer-motion';
import { DEFAULT_THEME } from '../../src/services/baseThemes';
import { getVisualizerRegistryEntry } from '../../src/components/visualizer/registry';
import { DEFAULT_PENDOLO_TUNING, type Line } from '../../src/types';
import type { ProbeDefinition } from './definition';

// dev/probes/visualizerMemory.probe.tsx

/**
 * 单个 visualizer 的长跑内存/性能台架。
 *
 * 存在的理由：visualizer 的内存可能来自 JS 堆之外的 canvas backing store、合成层和 GPU
 * 资源，单测和 jsdom 无法覆盖这些路径。这个探针只挂一个 visualizer，用加速时间轴喂它
 * 合成歌词，配合 `npm run manual:visualizer-memory` 采样 Chromium 各进程的工作集，可用于
 * 横向对比不同 visualizer，或者 A/B 同一个 visualizer 改动前后的稳态占用。
 *
 * 用法见文件末尾的 description，或直接 `?probe=visualizerMemory&vis=<mode>`。
 */

const WORDS = ['echo', 'lantern', 'drift', 'harbour', 'salt', 'quiet', 'ember', 'tide', 'glass', 'shore'];

/** 每行 3 秒、逐字计时的合成歌词，长度足够让窗口化的行布局反复进出。 */
const buildLines = (count: number): Line[] => {
    const lines: Line[] = [];
    for (let index = 0; index < count; index += 1) {
        const start = index * SECONDS_PER_LINE;
        const wordCount = 5 + (index % 5);
        const words = Array.from({ length: wordCount }, (_, offset) => ({
            text: WORDS[(index + offset) % WORDS.length]!,
            startTime: start + (offset * SECONDS_PER_LINE) / wordCount,
            endTime: start + ((offset + 1) * SECONDS_PER_LINE) / wordCount,
        }));
        lines.push({
            id: `line-${index}`,
            words,
            startTime: start,
            endTime: start + SECONDS_PER_LINE - 0.1,
            fullText: words.map(word => word.text).join(' '),
            translation: `译文 ${index} ${words.slice(0, 3).map(word => word.text).join('')}`,
            isChorus: index % 4 === 0,
        });
    }
    return lines;
};

const SECONDS_PER_LINE = 3;

const COVER_URL = `data:image/svg+xml;utf8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">'
    + '<rect width="600" height="600" fill="#2563eb"/>'
    + '<circle cx="300" cy="300" r="180" fill="#f97316"/>'
    + '</svg>',
)}`;

const params = new URLSearchParams(window.location.search);
const MODE = params.get('vis') ?? 'pendolo';
/** 时间轴倍速。8x 意味着每 0.375 秒过一行，几分钟就能跑完一整首歌的行切换量。 */
const SPEED = Number(params.get('speed') ?? '8');
const LINES = buildLines(Number(params.get('lines') ?? '400'));
const TOTAL_SECONDS = LINES.length * SECONDS_PER_LINE;
/** 每隔 N 秒换一次 seed，模拟切歌时输入 seed 变化；是否重挂载由宿主的 key 策略决定。0 表示不换。 */
const SWITCH_SECONDS = Number(params.get('switch') ?? '0');
/** 冻结在固定一帧，用来逐像素比对改动前后的渲染结果。 */
const FREEZE = params.get('freeze') === '1';
const HIDE_TEXT = params.get('notext') === '1';
/** 打开该 visualizer 全部可选装饰，测最坏情况。 */
const HEAVY = params.get('heavy') === '1';
/**
 * Pendolo 专用消融开关，用来把内存归因到具体图层：
 * - `canvas` 整个机芯 canvas 不挂载
 * - `gears` canvas 照常每帧重绘，但只画中心渐变，不画齿轮线条
 */
const ABLATE = params.get('ablate');

const FREEZE_TIME_SECONDS = 37.5;
const FREEZE_LINE_INDEX = 12;

const resolvePendoloTuning = () => {
    if (ABLATE === 'canvas') {
        return { ...DEFAULT_PENDOLO_TUNING, showGearDecor: 'none' as const, showCenterGradient: false, showCoverOnWatchFace: false };
    }
    if (ABLATE === 'gears') {
        return { ...DEFAULT_PENDOLO_TUNING, showGearDecor: 'none' as const, showCenterGradient: true };
    }
    if (HEAVY) {
        return { ...DEFAULT_PENDOLO_TUNING, showGearDecor: 'full' as const, enableLineGlow: true, showCoverOnWatchFace: true };
    }
    return DEFAULT_PENDOLO_TUNING;
};

const VisualizerMemoryProbe: React.FC = () => {
    const currentTime = useMotionValue(0);
    const audioPower = useMotionValue(0.4);
    const bass = useMotionValue(0.4);
    const lowMid = useMotionValue(0.4);
    const mid = useMotionValue(0.4);
    const vocal = useMotionValue(0.4);
    const treble = useMotionValue(0.4);
    const [currentLineIndex, setCurrentLineIndex] = useState(0);
    const [seedTick, setSeedTick] = useState(0);
    const lineIndexRef = useRef(0);

    const audioBands = useMemo(
        () => ({ bass, lowMid, mid, vocal, treble }),
        [bass, lowMid, mid, vocal, treble],
    );

    useEffect(() => {
        if (SWITCH_SECONDS <= 0 || FREEZE) return undefined;
        const id = window.setInterval(() => setSeedTick(value => value + 1), SWITCH_SECONDS * 1000);
        return () => window.clearInterval(id);
    }, []);

    useEffect(() => {
        if (FREEZE) {
            currentTime.set(FREEZE_TIME_SECONDS);
            setCurrentLineIndex(FREEZE_LINE_INDEX);
            return undefined;
        }

        let raf = 0;
        let lastFrameAt = performance.now();
        let elapsed = 0;
        const tick = (now: number) => {
            const dt = (now - lastFrameAt) / 1000;
            lastFrameAt = now;
            elapsed = (elapsed + dt * SPEED) % TOTAL_SECONDS;
            currentTime.set(elapsed);

            // 合成一点频谱起伏，让依赖音频的图层走到它们的活跃分支。
            const phase = now / 1000;
            bass.set(0.35 + 0.3 * Math.sin(phase * 2.1));
            lowMid.set(0.35 + 0.3 * Math.sin(phase * 1.7));
            mid.set(0.35 + 0.3 * Math.sin(phase * 1.3));
            vocal.set(0.35 + 0.3 * Math.sin(phase * 2.6));
            treble.set(0.35 + 0.3 * Math.sin(phase * 3.1));
            audioPower.set(0.4 + 0.3 * Math.sin(phase * 1.9));

            const index = Math.min(LINES.length - 1, Math.floor(elapsed / SECONDS_PER_LINE));
            if (index !== lineIndexRef.current) {
                lineIndexRef.current = index;
                setCurrentLineIndex(index);
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [audioPower, bass, currentTime, lowMid, mid, treble, vocal]);

    const entry = getVisualizerRegistryEntry(MODE);

    return (
        <div className="fixed inset-0" data-probe-mode={MODE}>
            {entry.render({
                currentTime,
                currentLineIndex,
                lines: LINES,
                theme: DEFAULT_THEME,
                audioPower,
                audioBands,
                showText: !HIDE_TEXT,
                paused: FREEZE,
                seed: `probe-${seedTick}`,
                coverUrl: HEAVY ? COVER_URL : null,
                pendoloTuning: resolvePendoloTuning(),
            } as never)}
        </div>
    );
};

const definition: ProbeDefinition = {
    id: 'visualizerMemory',
    title: 'Visualizer · 内存长跑台架',
    description: '用加速时间轴长时间驱动单个 visualizer，配合 npm run manual:visualizer-memory 采样各进程内存。'
        + ' 参数：vis=<mode> speed=<倍速> lines=<行数> switch=<切歌间隔秒> heavy=1 notext=1 freeze=1 ablate=canvas|gears',
    Component: VisualizerMemoryProbe,
};

export default definition;
