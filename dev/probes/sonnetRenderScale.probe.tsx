import React, { useMemo } from 'react';
import { useMotionValue } from 'framer-motion';
import { DEFAULT_THEME } from '../../src/services/baseThemes';
import { DEFAULT_SONNET_TUNING, type Line } from '../../src/types';
import type { VisualizerSharedProps } from '../../src/components/visualizer/definition';
import VisualizerSonnet from '../../src/components/visualizer/sonnet/VisualizerSonnet';
import type { ProbeDefinition } from './definition';

// dev/probes/sonnetRenderScale.probe.tsx
// 商籁在不同分辨率倍数下的样子（issue H12 的验证台）。
//
// 为什么要有它：Sonnet 的自动降级（adaptiveRenderScale.ts）会把分辨率倍数往下压，
// 而「压低了画面还对不对」只有在真的 WebGL 画面上才看得出 —— 单测只能证明算出来的
// 倍数对不对，证明不了画面没坏。这个探针把倍数钉死，其它一切照常。
//
// 用法：`?probe=sonnetRenderScale&scale=2`（0.5 / 0.75 / 1 / 1.5 / 2）。
// 不给 scale 就依次排一列，方便一次截一张长图对比。

const WORDS = ['echo', 'lantern', 'drift', 'harbour', 'salt', 'quiet', 'ember', 'tide', 'glass', 'shore'];
const SECONDS_PER_LINE = 3;

/** 合成一份逐字计时的歌词：够长，能让行窗口反复进进出出。 */
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
            translation: `译文 ${index}`,
            isChorus: index % 4 === 0,
        });
    }
    return lines;
};

const SCALES = [0.5, 0.75, 1, 1.5, 2] as const;

const SonnetStage: React.FC<{ scale: number; label: string }> = ({ scale, label }) => {
    const currentTime = useMotionValue(SECONDS_PER_LINE * 1.5);
    const lines = useMemo(() => buildLines(24), []);
    const props = {
        currentTime,
        currentLineIndex: 1,
        lines,
        theme: DEFAULT_THEME,
        audioPower: 0.6,
        audioBands: [0.5, 0.6, 0.4, 0.7, 0.3],
        showText: true,
        lyricsFontScale: 1,
        staticMode: false,
        paused: true,
        seed: 'sonnet-probe',
        songTitle: 'Probe Song',
        songArtist: 'Probe Artist',
        songAlbum: 'Probe Album',
        sonnetTuning: { ...DEFAULT_SONNET_TUNING, render: { scale, antialias: 'global' as const } },
        isPreviewMode: false,
    } as unknown as VisualizerSharedProps;
    return (
        <div style={{ width: 720, height: 405, position: 'relative', background: '#09090b' }}>
            <VisualizerSonnet {...props} />
            <div style={{ position: 'absolute', left: 8, top: 8, color: '#fff', fontSize: 14, fontFamily: 'monospace' }}>
                {label}
            </div>
        </div>
    );
};

const Component: React.FC = () => {
    const requested = Number(new URLSearchParams(window.location.search).get('scale') ?? '');
    const scales = SCALES.includes(requested as never) ? [requested] : [...SCALES];
    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: 12, background: '#000' }}>
            {scales.map(scale => (
                <SonnetStage key={scale} scale={scale} label={`scale ${scale}`} />
            ))}
        </div>
    );
};

const definition: ProbeDefinition = {
    id: 'sonnetRenderScale',
    title: '商籁：分辨率倍数',
    description: '同一个画面在 0.5 / 0.75 / 1 / 1.5 / 2 倍下的样子，用来确认自动降级压低倍数后画面没坏。'
        + '加 ?scale=2 只看那一档，截图对比即可。',
    Component,
};

export default definition;
