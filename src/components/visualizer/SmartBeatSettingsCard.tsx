import React from 'react';
import { useVisualizerSettingsStore } from '../../stores/useVisualizerSettingsStore';
import { useSmartBeatAvailability } from '../../hooks/useSmartBeatAvailability';
import { useSmartBeatStatus } from '../../hooks/useSmartBeatStatus';
import { Group, Row, Segmented, type SettingsGroupDef } from '../modal/settings/kit';
import type { SmartBeatMode } from '../../types';

// src/components/visualizer/SmartBeatSettingsCard.tsx
// 智能动感模式's one setting, alone on the lyric style window's 全局 tab: it is a setting of the whole picture,
// over every mode's beat effects, so it sits with no one mode's panel. Each effect's own switch and
// strength sit in the mode's settings on the 歌词动画 tab (BeatEffectsGroup.tsx), with what its model needs.
// Reads and writes the settings store itself; nothing about it is a per-mode draft.
// Three ways (SmartBeatMode): 关闭 / 只用已分析 / 开启, in that order - how much each does - and the
// note below says what the chosen one does, so "half on" never has to be guessed at.
//
// 最后一行是这条链路此刻的实况（hooks/useSmartBeatStatus.ts）。开着这个模式却看不到效果时，
// 画面和「没开」完全一样；而两种最常见的原因 —— 当前画面没开吃拍点的特效、这首歌只有吃鼓点
// 的特效 —— 连一行日志都不会产生。所以状态必须说在设置里，不能只留在日志里等人去翻。

const SMART_BEAT_GROUP: SettingsGroupDef = { id: 'vis-smart-beat', titleKey: 'options.smartBeat' };

type SmartBeatSettingsCardProps = {
    t: (key: string) => string;
};

const SmartBeatSettingsCard: React.FC<SmartBeatSettingsCardProps> = ({ t }) => {
    const smartBeat = useVisualizerSettingsStore(state => state.smartBeat);
    const setSmartBeat = useVisualizerSettingsStore(state => state.handleSetSmartBeat);
    const availability = useSmartBeatAvailability(smartBeat.mode);
    const status = useSmartBeatStatus();
    const unavailableReason = availability === 'ready' ? null : t(`options.beatFxUnavailable_${availability}`);
    /*
     * 分析要几十秒，而进度事件只在阶段边界到一次（解码完、每 20 秒频谱）。
     * 秒数得自己走 —— 否则一行字停在那里，和卡死还是分不出来。
     */
    const [, tick] = React.useState(0);
    React.useEffect(() => {
        if (status.kind !== 'loading') return undefined;
        const timer = setInterval(() => tick(value => value + 1), 1000);
        return () => clearInterval(timer);
    }, [status.kind]);

    const statusText = (() => {
        switch (status.kind) {
            case 'off':
                return null;
            case 'noTrack':
                return t('options.smartBeatStatusNoTrack');
            case 'noEffect':
                return t('options.smartBeatStatusNoEffect');
            case 'drumsOnly': {
                /*
                 * 时计只吃鼓点：把「读到哪了」一并说出来，否则「没效果」和「在分析」在界面上一样。
                 * 还要说出**哪一段**：取音频（在线曲目整曲下载）、解码、挑鼓点，新手机会走半分钟，
                 * 这半分钟里字不变的话，和卡死没有区别。
                 */
                const drums = status.drums;
                if (drums && drums.count > 0) {
                    return `${t('options.smartBeatStatusDrumsOnly')} · ${t('options.smartBeatStatusDrumsHits')}${drums.count}${drums.until === null ? '' : ` · ${Math.floor(drums.until)}s`}`;
                }
                const step = drums?.stage === 'bytes' ? t('options.smartBeatStageBytes')
                    : drums?.stage === 'decode' ? t('options.smartBeatStageDecode')
                        : drums?.stage === 'pick' ? t('options.smartBeatStagePick')
                            : drums?.stage === 'no-bytes' ? t('options.smartBeatStageNoBytes')
                                : t('options.smartBeatStatusDrumsReading');
                return `${t('options.smartBeatStatusDrumsOnly')} · ${step}`;
            }
            case 'loading': {
                /*
                 * 说出**哪一段**、到多少、等了多久。
                 *
                 * 原来只有一句「正在分析这首歌的节拍…」：整首歌几分钟里一个字不变，
                 * 用户没法判断是后台在慢慢算，还是这条路已经死了（真机反馈 2026-11-13）。
                 * 现在卡在取音频还是推理一眼可见；超时后这一行会换成具体原因。
                 */
                const progress = status.progress;
                if (!progress) return t('options.smartBeatStatusLoading');
                const stage = progress.stage === 'decode' ? t('options.smartBeatStageDecode')
                    : progress.stage === 'mel' ? t('options.smartBeatStageMel')
                        : progress.stage === 'infer' ? t('options.smartBeatStageInfer')
                            : t('options.smartBeatStagePrepare');
                const percent = progress.stage === 'prepare' ? '' : ` · ${Math.round(progress.percent * 100)}%`;
                const seconds = Math.max(0, Math.round((Date.now() - progress.startedAt) / 1000));
                return `${stage}${percent} · ${seconds}s`;
            }
            case 'ready': {
                const base = `${t('options.smartBeatStatusReady')} · ${status.beats}`;
                // 第一块到了就算就绪，但整曲还在算：说清楚，别让人以为已经完事。
                const progress = status.progress;
                if (!progress) return base;
                const percent = progress.stage === 'prepare' ? '' : ` ${Math.round(progress.percent * 100)}%`;
                return `${base} · ${t('options.smartBeatStatusFilling')}${percent}`;
            }
            case 'none':
                return status.note ? `${t('options.smartBeatStatusNone')} · ${status.note}` : t('options.smartBeatStatusNone');
        }
    })();

    return (
        <Group def={SMART_BEAT_GROUP}>
            <Row label={t('options.smartBeatMode')} note={t(`options.smartBeatDesc_${smartBeat.mode}`)}>
                <Segmented<SmartBeatMode>
                    value={smartBeat.mode}
                    options={[
                        { value: 'off', label: t('options.smartBeatOff') },
                        { value: 'cached', label: t('options.smartBeatCached') },
                        { value: 'on', label: t('options.smartBeatOn') },
                    ]}
                    onChange={mode => setSmartBeat({ mode })}
                />
            </Row>
            {unavailableReason && <Row notice={unavailableReason} />}
            {statusText && <Row notice={statusText} />}
        </Group>
    );
};

export default SmartBeatSettingsCard;
