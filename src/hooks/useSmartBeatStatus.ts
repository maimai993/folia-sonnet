import { useSyncExternalStore } from 'react';
import { usePlaybackStore, selectDisplaySong } from '../stores/usePlaybackStore';
import { usePlayerChromeSettingsStore } from '../stores/usePlayerChromeSettingsStore';
import { useVisualizerSettingsStore } from '../stores/useVisualizerSettingsStore';
import { visualizerWantsBeats, visualizerWantsDrumHits, visualizerWantsEnvelopes, visualizerWantsStems } from '../components/visualizer/beatClockTargets';
import { smartBeatActive, smartBeatMayAnalyse } from '../services/beatFx/beatEffects';
import { getBeatFxStatus, subscribeBeatFxStatus } from '../services/beatFx/beatFxLive';
import { getBeatAnalysisProgress, subscribeBeatAnalysisProgress, type BeatAnalysisProgress } from '../services/beatFx/beatProgress';
import { drumHitsSnapshot, parseDrumHitsSnapshot, subscribeDrumHits, type DrumStage } from '../services/analysis/drumHits';
import { getMusicEnvelope, getMusicEnvelopeRefineBlocked, getMusicEnvelopeRevision, nextUnrefinedFrom, refinedSeconds, subscribeMusicEnvelope } from '../services/analysis/musicEnvelope';
import { getPlaybackAnalysisKey, getPlaybackAnalysisTarget } from '../services/playbackRecovery/representationRegistry';

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

export type SmartBeatStatusKind = 'off' | 'noTrack' | 'noEffect' | 'drumsOnly' | 'stemsOnly' | 'loading' | 'ready' | 'none';

export interface SmartBeatStatusView {
    kind: SmartBeatStatusKind;
    /** Number of beats installed (only meaningful for `ready`). */
    beats: number;
    /** Why there are none (only meaningful for `none`). */
    note: string | null;
    /** 时计's drum hits: how many are in, how far they reach (`null` once the whole track is picked),
     *  and which step a read is at while there are none yet. */
    drums: { count: number; until: number | null; stage: DrumStage | null } | null;
    /** 拍点分析走到哪一段了（只在 `loading` 时有值）：取音频 / 解码 / 频谱 / 推理。 */
    progress: BeatAnalysisProgress | null;
    /**
     * 只吃分轨曲线时（`stemsOnly`）：曲线铺到第几秒、整曲多长、
     * 已被真分轨精修了多少秒、是否整首都精修完了。
     */
    stems: {
        until: number;
        seconds: number;
        refined: number;
        complete: boolean;
        /** 分轨精修在这台机器上跑不起来（已停止重试，曲线仍是整曲的频段版）。 */
        refineFailed: boolean;
    } | null;
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
    const rawProgress = useSyncExternalStore(
        subscribeBeatAnalysisProgress,
        getBeatAnalysisProgress,
        () => null,
    );
    /*
     * 进度在整个分析期间都递出去，不只是 `loading`：
     * 分段交付后状态会先变成 `ready`（第一块到了），但整曲还在算 ——
     * 界面要能说「已就绪 20 拍 · 正在补齐整曲 62%」，否则用户以为已经算完了。
     * 分析结束时 endBeatAnalysisProgress 会把它清空，`ready` 之后自然不再显示。
     */
    const progress = rawProgress;

    const wantsBeats = visualizerWantsBeats({ ...settings, pageTransparent });
    const wantsDrums = visualizerWantsDrumHits({ ...settings, pageTransparent });
    const wantsStems = visualizerWantsStems({ ...settings, pageTransparent });
    const wantsEnvelopes = visualizerWantsEnvelopes({ ...settings, pageTransparent });
    /*
     * 只吃分轨曲线的画面（绝大多数歌词样式新加的那批效果）从来不会跑 beat_this，
     * 所以 `wantsBeats` 为假并不等于「什么都没分析」—— 以前这里直接落到 `noEffect`，
     * 明明曲线在补、画面在动，设置里却说「当前画面没有开启的节拍特效」。这里把分轨单独说清楚。
     */
    /*
     * 订阅曲线的版本号。
     *
     * 下面读的 `envelope.until` 每来一块才变一次，而本 hook 的其它订阅（beatFxStatus）
     * 是「一首歌变一次」。不订阅这个版本号的话，补齐在后台从 30 秒一路推到 120 秒，
     * 卡片上却永远写着 30s —— 那不是卡死，但看起来完全一样。
     */
    useSyncExternalStore(subscribeMusicEnvelope, getMusicEnvelopeRevision, () => 0);
    const envelope = song ? getMusicEnvelope(getPlaybackAnalysisKey(song)) : null;
    /*
     * 曲线现在有两级状态，界面得分开说：
     *   · 整曲有没有曲线（基线铺满了没有）—— 决定「画面能不能整曲跟着动」；
     *   · 有多少秒已经被真分轨盖过（`refined`）—— 决定「还要不要在后台跑」。
     * 以前只有 `until` 一个数，两种情况混在一起，所以「补齐中」和「补完了」看起来一样。
     */
    const trackSeconds = Math.max(0, (song?.durationMs ?? 0) / 1000);
    const refinedSec = refinedSeconds(envelope);
    const stems = envelope
        ? {
            until: envelope.until ?? trackSeconds,
            seconds: trackSeconds || envelope.bass.length / envelope.fps,
            refined: refinedSec,
            complete: envelope.until === undefined && trackSeconds > 0
                && nextUnrefinedFrom(envelope, trackSeconds) >= trackSeconds - 2,
            refineFailed: getMusicEnvelopeRefineBlocked(),
        }
        : null;

    if (!smartBeatActive(smartBeat)) return { kind: 'off', beats: 0, note: null, drums, progress, stems };
    if (!song) return { kind: 'noTrack', beats: 0, note: null, drums: null, progress, stems: null };
    if (!wantsBeats) {
        // 分轨类效果（ envelopes / stems 两种源）开着：说它跑到哪了，而不是说「什么都没分析」。
        if (wantsEnvelopes || wantsStems) {
            return { kind: 'stemsOnly', beats: 0, note: null, drums, progress, stems };
        }
        // 只有 drum hits 也值得说一句：这时候永远不会跑 beat_this，也就永远没有拍点日志。
        // 一个 hit 都还没有时也要把 `drums` 递出去：卡片靠它的 `stage` 说「在取音频 / 在解码」。
        return { kind: wantsDrums ? 'drumsOnly' : 'noEffect', beats: 0, note: null, drums, progress, stems };
    }
    if (!snapshot.key) return { kind: 'noTrack', beats: 0, note: null, drums, progress, stems };
    if (snapshot.source === 'loading') return { kind: 'loading', beats: 0, note: null, drums, progress, stems };
    if (snapshot.source === 'beat_this') return { kind: 'ready', beats: snapshot.eventCount, note: null, drums, progress, stems };
    return { kind: 'none', beats: 0, note: snapshot.note ?? (smartBeatMayAnalyse(smartBeat) ? null : 'only stored results'), drums, progress, stems };
}
