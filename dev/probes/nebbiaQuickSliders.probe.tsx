import React, { useState } from 'react';
import NebbiaQuickSliders from '../../src/components/visualizer/nebbia/NebbiaQuickSliders';
import { DEFAULT_NEBBIA_TUNING, type NebbiaTuning } from '../../src/components/visualizer/nebbia/types';
import { panelTokens } from '../../src/components/panelTab/shell/panelTheme';
import { DAYLIGHT_THEME, DEFAULT_THEME } from '../../src/services/baseThemes';
import type { ProbeDefinition } from './definition';
// dev/probes/nebbiaQuickSliders.probe.tsx

/**
 * 播放页控制面板里雾笺的滑块组：日夜两套、三种强调色。颜色只来自面板的主题变量，
 * 所以改强调色、切日夜这里都跟着变（preview 和 layoutCheck 也在这页量）。
 * `?probe=nebbiaQuickSliders`，按钮切换日夜、强调色、窗外和玻璃；一开始就有几项被调过，能看到徽章和发光。
 */
const ACCENTS = [undefined, '#ff7a59', '#38bdf8'] as const;
const GLASSES: NebbiaTuning['glass'][] = ['rain', 'dew', 'snow'];

const NebbiaQuickSlidersProbe: React.FC = () => {
    const [isDaylight, setIsDaylight] = useState(false);
    const [accentIndex, setAccentIndex] = useState(0);
    const [tuning, setTuning] = useState<NebbiaTuning>({
        ...DEFAULT_NEBBIA_TUNING, strokeWidth: 0.05, writeSpeed: 1.8, edge: 1.4, beads: 0.05, refract: 1.6,
    });
    const base = isDaylight ? DAYLIGHT_THEME : DEFAULT_THEME;
    const accent = ACCENTS[accentIndex];
    const theme = accent ? { ...base, accentColor: accent } : base;
    const text = isDaylight ? '#18181b' : '#fafafa';

    return (
        <div
            className="flex min-h-screen flex-col items-center gap-4 p-6"
            style={{ backgroundColor: isDaylight ? '#e8e8ea' : '#0b0b0d', color: text }}
        >
            <div className="flex flex-wrap gap-3 text-xs">
                <button data-probe-toggle="daylight" onClick={() => setIsDaylight(value => !value)}>toggle daylight</button>
                <button data-probe-toggle="accent" onClick={() => setAccentIndex(index => (index + 1) % ACCENTS.length)}>next accent</button>
                <button data-probe-toggle="glass" onClick={() => setTuning(value => ({ ...value, glass: GLASSES[(GLASSES.indexOf(value.glass) + 1) % GLASSES.length] }))}>next glass</button>
                <button data-probe-toggle="aquarium" onClick={() => setTuning(value => ({ ...value, behind: value.behind === 'aquarium' ? 'night' : 'aquarium' }))}>toggle aquarium</button>
            </div>
            <div
                className="st-window w-[360px] rounded-2xl border border-white/10 p-3"
                style={panelTokens(isDaylight, theme, false)}
                data-testid="nebbia-quick-probe"
            >
                <div className="flex flex-wrap">
                    <NebbiaQuickSliders tuning={tuning} onTuningChange={patch => setTuning(value => ({ ...value, ...patch }))} t={key => key} />
                </div>
            </div>
        </div>
    );
};

const definition: ProbeDefinition = {
    id: 'nebbiaQuickSliders',
    title: '雾笺 · 控制面板滑块',
    description: '雾笺在播放页控制面板里的滑块组：折叠、调过几项的徽章、整组恢复默认、调过的发光，日夜和强调色都跟着面板变。',
    Component: NebbiaQuickSlidersProbe,
};

export default definition;
