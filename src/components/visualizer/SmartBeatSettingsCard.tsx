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

    const statusText = (() => {
        switch (status.kind) {
            case 'off':
                return null;
            case 'noTrack':
                return t('options.smartBeatStatusNoTrack');
            case 'noEffect':
                return t('options.smartBeatStatusNoEffect');
            case 'drumsOnly':
                // 时计只吃鼓点：把「读到哪了」一并说出来，否则「没效果」和「在分析」在界面上一样。
                if (!status.drums) return `${t('options.smartBeatStatusDrumsOnly')} · ${t('options.smartBeatStatusDrumsReading')}`;
                return `${t('options.smartBeatStatusDrumsHits')} ${status.drums.count}${status.drums.until === null ? '' : ` · ${Math.floor(status.drums.until)}s`}`;
            case 'loading':
                return t('options.smartBeatStatusLoading');
            case 'ready':
                return `${t('options.smartBeatStatusReady')} · ${status.beats}`;
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
