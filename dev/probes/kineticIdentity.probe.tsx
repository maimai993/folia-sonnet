import React, { useEffect, useState } from 'react';
import { motionValue } from 'framer-motion';
import VisualizerKinetic from '../../src/components/visualizer/kinetic/VisualizerKinetic';
import KineticSettingsPanel from '../../src/components/visualizer/kinetic/KineticSettingsPanel';
import { usePlaybackStore } from '../../src/stores/usePlaybackStore';
import { PlayerState, type Line } from '../../src/types';
import type { ProbeDefinition } from './definition';

// 受控 A/B 身份与晚到歌词：走真实设置面板、iframe 和 JIZURA boot，不调用 AI 或音乐服务。
const makeLines = (track: string): Line[] => [
    { startTime: 1, endTime: 12, fullText: `${track} distinct first line`, words: [] },
    { startTime: 12, endTime: 30, fullText: `${track} final line`, words: [] },
];

const clock = motionValue(5);
const power = motionValue(0);
const bands = { bass: power, lowMid: power, mid: power, vocal: power, treble: power };

function KineticIdentityProbe() {
    const lyrics = usePlaybackStore(state => state.lyrics);
    const [track, setTrack] = useState('Alpha');
    const [seek, setSeek] = useState<number | null>(null);
    useEffect(() => {
        const listener = (event: Event) => {
            const time = (event as CustomEvent).detail.time;
            setSeek(time);
            clock.set(time); // 暂停时用户 seek 也反馈到真实 renderer MotionValue，覆盖完整时钟回路。
        };
        window.addEventListener('kinetic:seek', listener);
        return () => window.removeEventListener('kinetic:seek', listener);
    }, []);
    useEffect(() => {
        const select = (name: string, pending = false) => {
            setTrack(name);
            usePlaybackStore.setState({
                currentSong: { id: name, name, artists: [], album: { id: 'probe', name: 'probe' } } as never,
                lyrics: pending ? null : { lines: makeLines(name) } as never,
                playerState: PlayerState.PAUSED,
            });
        };
        const listener = (event: Event) => {
            const { name, pending } = (event as CustomEvent).detail;
            select(name, pending);
        };
        window.addEventListener('probe:kinetic-track', listener);
        select('Alpha');
        return () => window.removeEventListener('probe:kinetic-track', listener);
    }, []);
    return <div className="relative h-screen" data-probe-track={track} data-probe-seek={seek ?? ''}>
        {new URLSearchParams(location.search).has('render') && <VisualizerKinetic
            currentTime={clock} currentLineIndex={0} lines={lyrics?.lines ?? []} theme={{} as never}
            audioPower={power} audioBands={bands} paused />}
        <KineticSettingsPanel t={(key: string) => key} tuning={{}} onTuningChange={() => {}}
            isDaylight={false} theme={{} as never} controlCardBg="" rangeInputClass="" settings={{} as never} />
    </div>;
}

export default {
    id: 'kineticIdentity',
    title: '文字PV · 歌曲身份与编辑台注入',
    description: '真实 iframe boot、textarea、plan 和按歌保存的受控 A/B 回归。',
    Component: KineticIdentityProbe,
} satisfies ProbeDefinition;
