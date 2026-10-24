import React, { Profiler, useMemo, useRef, useState } from 'react';
import '../../src/i18n/config';
import PlatformColumn from '../../src/components/login/window/PlatformColumn';
import type { OnlineProviderId, ProviderAccountSummary } from '../../src/types/onlineMusic';
import type { ProbeDefinition } from './definition';
// dev/probes/platformColumn.probe.tsx

/**
 * 登录窗口的平台清单（竖着那一列、横着那一排），行是这里编的：没有账号、没有请求、没有任何真实数据。
 *
 * 要看的是几何：高亮那一块跟不跟得住它所在的行，滚动、改窗口宽度、悬停、点一下之后还对不对得上，
 * 以及这些动作里它只改 DOM 样式、没有把量到的像素写回 React state（提交次数不该跟着几何走）。
 *
 * 打开：?probe=platformColumn&lie=row|column&count=12&chosen=<行 id>
 * 计数从 window.__platformColumnProbe 读：commits / chooses / lie，reset() 清零。测试也用同一套。
 */
type Lie = 'column' | 'row';
type ProbeProps = { lie?: Lie; count?: number; chosen?: string; stageHeight?: number };

const syntheticRow = (index: number): ProviderAccountSummary => ({
    providerId: `probe-platform-${index}`,
    displayName: `Synthetic ${index}`,
    shortName: `Synthetic ${index}`,
    availability: { configured: true },
    status: 'anonymous',
    user: null,
    collections: [],
});

interface ProbeApi {
    readonly commits: number;
    readonly phases: readonly string[];
    readonly chooses: readonly string[];
    readonly lie: Lie;
    reset(): void;
}

const Probe: React.FC<ProbeProps> = ({ lie: initialLie = 'column', count = 12, chosen: initialChosen, stageHeight = 420 }) => {
    const rows = useMemo(() => Array.from({ length: count }, (_, index) => syntheticRow(index + 1)), [count]);
    const [lie, setLie] = useState<Lie>(initialLie);
    const [chosen, setChosen] = useState<OnlineProviderId>(initialChosen ?? rows[rows.length - 1].providerId);
    const commits = useRef(0);
    const phases = useRef<string[]>([]);
    const chooses = useRef<string[]>([]);

    const api: ProbeApi = {
        get commits() { return commits.current; },
        get phases() { return phases.current; },
        get chooses() { return chooses.current; },
        get lie() { return lie; },
        reset() { commits.current = 0; phases.current = []; chooses.current = []; },
    };
    (window as unknown as { __platformColumnProbe?: ProbeApi }).__platformColumnProbe = api;

    return (
        <div className="flex flex-col gap-2 p-4">
            <div className="flex gap-2 text-xs text-zinc-300">
                <button type="button" data-probe-action="lie-column" className="rounded bg-white/10 px-2 py-1" onClick={() => setLie('column')}>column</button>
                <button type="button" data-probe-action="lie-row" className="rounded bg-white/10 px-2 py-1" onClick={() => setLie('row')}>row</button>
                <span data-probe-readout="commits">{commits.current}</span>
            </div>
            <div data-probe-stage className="rounded-xl border border-white/10 bg-zinc-900 p-2" style={{ height: stageHeight }}>
                <Profiler id="platformColumn" onRender={(_id, phase) => { commits.current += 1; phases.current.push(phase); }}>
                    <PlatformColumn
                        rows={rows}
                        chosenId={chosen}
                        onChoose={row => { chooses.current.push(row.providerId); setChosen(row.providerId); }}
                        lie={lie}
                    />
                </Profiler>
            </div>
        </div>
    );
};

export default {
    id: 'platformColumn',
    title: 'Platform column / row geometry',
    description: '登录窗口的平台清单：高亮跟着行走，滚动/改宽/悬停/点击后仍然对得上；几何不进 React state。',
    Component: Probe,
} satisfies ProbeDefinition;
