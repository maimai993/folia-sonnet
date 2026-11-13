import { useSyncExternalStore } from 'react';
import { usePlaybackStore, selectDisplaySong } from '../stores/usePlaybackStore';
import { usePlayerChromeSettingsStore } from '../stores/usePlayerChromeSettingsStore';
import { useVisualizerSettingsStore } from '../stores/useVisualizerSettingsStore';
import { visualizerWantsBeats, visualizerWantsDrumHits } from '../components/visualizer/beatClockTargets';
import { smartBeatActive, smartBeatMayAnalyse } from '../services/beatFx/beatEffects';
import { getBeatFxStatus, subscribeBeatFxStatus } from '../services/beatFx/beatFxLive';
import { drumHitsSnapshot, parseDrumHitsSnapshot, subscribeDrumHits } from '../services/analysis/drumHits';
import { getPlaybackAnalysisTarget } from '../services/playbackRecovery/representationRegistry';

// src/hooks/useSmartBeatStatus.ts
// 智能动感模式此刻到底在做什么，给设置界面显示一行。
//
// 为什么要这个：这个功能失败时，画面上的表现只有一种 —— 特效不动。但原因至少有五种，
// 而且其中两种（当前画面没有开启任何吃拍点的特效、这首歌只有吃鼓点的特效）根本不会
// 产生任何日志：整条分析链路压根没启动，`[BeatGrid]` / `[BeatFx]` 一行都不会有。
// 于是「翻日志找原因」在日志存在之前就已经失败了。用户看到的只是一句「还是没效果」。
//
// 这五种状态都在这里被命名，界面照着说人话：
//   off        — 智能动感模式关着
//   noTrack    — 没有在播的歌
//   noEffect   — 当前画面（模式 / 背景）没有开启的节拍特效，链路没启动
//   drumsOnly  — 当前画面只开了吃鼓点的特效，不跑 beat_this，所以没有拍点日志
//   loading    — 正在分析（首次要拷权重 + 推理，几秒到几十秒）
//   ready      — 拍点已就绪，特效应该在动
//   none       — 分析跑过但没结果，note 是原因
//
// 只读，不改任何东西；订阅的是 beatFxLive 的快照（一首歌变一次），不是每帧。

export type SmartBeatStatusKind = 'off' | 'noTrack' | 'noEffect' | 'drumsOnly' | 'loading' | 'ready' | 'none';

export interface SmartBeatStatusView {
    kind: SmartBeatStatusKind;
    /** Number of beats installed (only meaningful for `ready`). */
    beats: number;
    /** Why there are none (only meaningful for `none`). */
    note: string | null;
    /** 时计's drum hits: how many are in, and how far they reach (`null` once the whole track is picked). */
    drums: { count: number; until: number | null } | null;
}

export function useSmartBeatStatus(): SmartBeatStatusView {
    const smartBeat = useVisualizerSettingsStore(state => state.smartBeat);
    const pageTransparent = usePlayerChromeSettingsStore(state => state.transparentPlayerBackground || state.enablePlayerPageNativeBlur);
    const settings = useVisualizerSettingsStore(state => state);
    const song = usePlaybackStore(selectDisplaySong);
    const snapshot = useSyncExternalStore(subscribeBeatFxStatus, getBeatFxStatus, getBeatFxStatus);
    // 鼓点也要能说「读到哪了」：`drumsOnly` 只说「只吃鼓点」，用户看不出是在读、还是读完了没动。
    const drumKey = song ? getPlaybackAnalysisTarget(song).key : null;
    const drumSnapshot = useSyncExternalStore(
        subscribeDrumHits,
        () => drumHitsSnapshot(drumKey),
        () => '0|',
    );
    const drums = drumKey ? parseDrumHitsSnapshot(drumSnapshot) : null;
    const drumsIn = drums !== null && drums.count > 0;

    const wantsBeats = visualizerWantsBeats({ ...settings, pageTransparent });
    const wantsDrums = visualizerWantsDrumHits({ ...settings, pageTransparent });

    if (!smartBeatActive(smartBeat)) return { kind: 'off', beats: 0, note: null, drums };
    if (!song) return { kind: 'noTrack', beats: 0, note: null, drums: null };
    if (!wantsBeats) {
        // 只有 drum hits 也值得说一句：这时候永远不会跑 beat_this，也就永远没有拍点日志。
        return { kind: wantsDrums ? 'drumsOnly' : 'noEffect', beats: 0, note: null, drums: drumsIn ? drums : null };
    }
    if (!snapshot.key) return { kind: 'noTrack', beats: 0, note: null, drums };
    if (snapshot.source === 'loading') return { kind: 'loading', beats: 0, note: null, drums };
    if (snapshot.source === 'beat_this') return { kind: 'ready', beats: snapshot.eventCount, note: null, drums };
    return { kind: 'none', beats: 0, note: snapshot.note ?? (smartBeatMayAnalyse(smartBeat) ? null : 'only stored results'), drums };
}
