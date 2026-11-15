import React, { useEffect, useState } from 'react';
import { DebugRow } from './devDebugPanels';
import { CopyButton } from './modal/settings/kit/CopyButton';
import { readAudioPipelineDiagnostics, type AudioPipelineReading } from '../services/audioPipelineDiagnostics';
import { audioPipelineRows } from '../utils/audioPipelineFormat';

// src/components/AudioPipelinePanel.tsx
//
// 原生音频链路的读数面板，放在 设置 → 开发者选项。
//
// 为什么还要这一份：编辑器浮层（Perf 页）只能靠 Alt+Shift+D 打开 —— 手机没有键盘，
// 安卓上那个浮层根本叫不出来。而「音质在哪一段被削」恰恰要在真机上量。所以同一批数字
// 摆到设置里，Android 用户点两下就能看见（与 Perf 页读的是同一个快照，格式化也只写一份）。

const POLL_MS = 2000;

const AudioPipelinePanel: React.FC = () => {
    const [reading, setReading] = useState<AudioPipelineReading | null>(null);

    useEffect(() => {
        let cancelled = false;
        const pull = () => {
            void readAudioPipelineDiagnostics().then(next => {
                if (!cancelled && next) setReading(next);
            });
        };
        pull();
        const handle = window.setInterval(pull, POLL_MS);
        return () => {
            cancelled = true;
            window.clearInterval(handle);
        };
    }, []);

    if (!reading) {
        return (
            <div className="rounded-lg bg-[var(--st-pv)] px-3 py-2 text-[11px] leading-relaxed opacity-70">
                Android 原生播放才有读数。先播一首歌，再回到这里。
            </div>
        );
    }

    return (
        <div className="rounded-lg bg-[var(--st-pv)] px-3 py-2">
            <div className="break-words text-[10px] leading-relaxed opacity-80">{reading.verdict}</div>
            <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[10px]">
                {audioPipelineRows(reading).map(row => (
                    <DebugRow key={row.label} label={row.label} value={row.value} />
                ))}
            </dl>
            <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[10px] opacity-50">
                    {new Date(reading.sampledAt).toLocaleTimeString()}
                </span>
                {/* 数字多，截图容易漏行；复制一份完整的 JSON 发出来最省事。 */}
                <CopyButton text={() => JSON.stringify(reading, null, 2)}>复制读数</CopyButton>
            </div>
        </div>
    );
};

export default AudioPipelinePanel;
