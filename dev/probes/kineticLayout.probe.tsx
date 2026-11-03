import React, { useEffect, useMemo } from 'react';
import { useMotionValue } from 'framer-motion';
import { DEFAULT_THEME } from '../../src/services/baseThemes';
import { getVisualizerRegistryEntry } from '../../src/components/visualizer/registry';
import { DEFAULT_KINETIC_TUNING } from '../../src/components/visualizer/kinetic/types';
import type { Line } from '../../src/types';
import type { ProbeDefinition } from './definition';

// dev/probes/kineticLayout.probe.tsx
// 文字PV 的布局探针：静止在指定行上，量字与字、行与行的占位与横向出界。
// 配合 node test/render/layoutCheck.mjs --page '...probe=kineticLayout...' 与 preview.mjs 用。

const SECONDS_PER_LINE = 3;

/** 24 与 31 字的中文行（README 布局自检的同一组长度），混一句带标点的短句。 */
const CJK_LINES = [
    '迷惘在无边际这座幽深的森林里风吹过星光落下',
    '我们慢慢走回去星河与风一起落在很远很远的地方把回忆折成纸船放进河流',
    '把回忆折成纸船放进河流，',
];

const buildLines = (count: number): Line[] => Array.from({ length: count }, (_, index) => {
    const start = index * SECONDS_PER_LINE;
    const fullText = CJK_LINES[index % CJK_LINES.length];
    const chars = Array.from(fullText);
    const step = (SECONDS_PER_LINE - 0.2) / chars.length;
    return {
        id: `line-${index}`,
        words: chars.map((text, offset) => ({ text, startTime: start + offset * step, endTime: start + (offset + 1) * step })),
        startTime: start,
        endTime: start + SECONDS_PER_LINE - 0.1,
        fullText,
        translation: `translation ${index}`,
        isChorus: index % 4 === 0,
    };
});

const params = new URLSearchParams(window.location.search);
const LINES = buildLines(Number(params.get('lines') ?? '12'));
/** 停在哪一行：第 i 行 = i*3 秒起，取 +1.5 秒停在行中间。 */
const START_SECONDS = Number(params.get('start') ?? '1.5');

const KineticLayoutProbe: React.FC = () => {
    const currentTime = useMotionValue(0);
    const audioPower = useMotionValue(0.4);
    const bass = useMotionValue(0.4);
    const lowMid = useMotionValue(0.4);
    const mid = useMotionValue(0.4);
    const vocal = useMotionValue(0.4);
    const treble = useMotionValue(0.4);
    const audioBands = useMemo(() => ({ bass, lowMid, mid, vocal, treble }), [bass, lowMid, mid, vocal, treble]);

    const lineIndex = Math.min(LINES.length - 1, Math.floor(START_SECONDS / SECONDS_PER_LINE));
    const entry = getVisualizerRegistryEntry('kinetic');

    // useMotionValueEvent 只在变化时触发：先放 0 再放目标值，保证冻结帧上每个字都收到一次 change。
    useEffect(() => {
        currentTime.set(0);
        const id = window.setTimeout(() => currentTime.set(START_SECONDS), 50);
        return () => window.clearTimeout(id);
    }, [currentTime]);

    return (
        <div className="fixed inset-0" data-probe-mode="kinetic">
            {entry.render({
                currentTime,
                currentLineIndex: lineIndex,
                lines: LINES,
                theme: DEFAULT_THEME,
                audioPower,
                audioBands,
                showText: true,
                paused: true,
                seed: 'kinetic-probe',
                visualizerTunings: { kinetic: DEFAULT_KINETIC_TUNING },
            } as never)}
        </div>
    );
};

const definition: ProbeDefinition = {
    id: 'kineticLayout',
    title: '文字PV 路 布局自检',
    description: '静止在指定行的文字PV 场景，配 layoutCheck.mjs 量字与字、行与行重叠与横向出界。'
        + ' 参数：start=<秒> lines=<行数>',
    Component: KineticLayoutProbe,
};

export default definition;
