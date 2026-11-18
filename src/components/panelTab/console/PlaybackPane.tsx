import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAudioSettingsStore } from '../../../stores/useAudioSettingsStore';
import { Button } from '../../ui';
import EqualizerSection from '../equalizer/EqualizerSection';
import { ConsoleSlider } from './controls';

// src/components/panelTab/console/PlaybackPane.tsx
// 调音台的「变速变调」页：播放速度与升降调，两个都不碰音色。
//
// 与母带页那些 DSP 效果不同，这一页的两项都由 ExoPlayer 的 PlaybackParameters 执行：
//   · speed 管时长（快进慢放），引擎侧的位置外推速率同步跟着变；
//   · pitch 只移频不改时长（AudioTrack.setPlaybackParams / Sonic 都支持），KTV 升 key、
//     跟着乐器对调、慢速学歌靠它，与倍速组合时也互不干扰。
//
// store（useAudioSettingsStore）直接落 localStorage，并在启动时把落盘值推给原生 ——
// prepare 的 PlaybackParameters 用的是原生自己记的值，赶在第一次装源之前对好表。

/** 倍速快捷档：覆盖常见的慢放学歌与快进场景，点一下不用拖滑杆。 */
const SPEED_PRESETS: ReadonlyArray<{ value: number; label: string }> = [
    { value: 0.75, label: '0.75×' },
    { value: 1, label: '1.0×' },
    { value: 1.25, label: '1.25×' },
    { value: 1.5, label: '1.5×' },
    { value: 2, label: '2.0×' },
];

/** 小号筛选 chip：选中项强调色，未选中灰字。 */
const ChoiceChip: React.FC<{
    selected: boolean;
    label: string;
    onClick: () => void;
}> = ({ selected, label, onClick }) => (
    <Button
        onClick={onClick}
        className={`st-t-fast h-7 shrink-0 whitespace-nowrap rounded-lg px-2.5 text-[12px] transition-colors ${selected
            ? 'bg-[var(--st-accent)] font-semibold text-[color:var(--st-on-accent)]'
            : 'bg-[var(--st-fill)] text-[color:var(--st-t2)] hover:bg-[var(--st-fill2)] hover:text-[color:var(--st-t1)]'}`}
    >
        {label}
    </Button>
);

const PlaybackPane: React.FC = () => {
    const { t } = useTranslation();
    const playbackSpeed = useAudioSettingsStore(state => state.playbackSpeed);
    const playbackPitch = useAudioSettingsStore(state => state.playbackPitch);
    const setSpeed = useAudioSettingsStore(state => state.handleSetPlaybackSpeed);
    const setPitch = useAudioSettingsStore(state => state.handleSetPlaybackPitch);

    const formatSpeed = (value: number): string => `${value.toFixed(2).replace(/\.?0+$/, '')}×`;
    const formatPitch = (value: number): string => (
        value === 0 ? t('ui.consolePlaybackPitchOriginal') : `${value > 0 ? '+' : ''}${value} ${t('ui.consolePlaybackPitchUnit')}`
    );

    return (
        <div className="flex min-h-full flex-col">
            {/* —— 倍速：0.5x 慢放学歌 ~ 2x 快进，引擎与原生两侧的位置外推一起改 —— */}
            <EqualizerSection title={t('ui.consolePlaybackSpeed')} hint={t('ui.consolePlaybackSpeedHint')}>
                <div className="space-y-3 px-4 py-3.5">
                    <div className="hide-scrollbar flex items-center gap-1.5 overflow-x-auto pb-0.5">
                        {SPEED_PRESETS.map(preset => (
                            <ChoiceChip
                                key={preset.value}
                                selected={Math.abs(playbackSpeed - preset.value) < 0.005}
                                label={preset.label}
                                onClick={() => setSpeed(preset.value)}
                            />
                        ))}
                    </div>
                    <ConsoleSlider
                        label={t('ui.consolePlaybackSpeed')}
                        valueText={formatSpeed(playbackSpeed)}
                        value={playbackSpeed}
                        min={0.5}
                        max={2}
                        defaultValue={1}
                        decimals={2}
                        onChange={speed => setSpeed(speed)}
                        onCommit={() => undefined}
                    />
                </div>
            </EqualizerSection>

            {/* —— 升降调：±6 半音，只移频不改时长 —— */}
            <EqualizerSection title={t('ui.consolePlaybackPitch')} hint={t('ui.consolePlaybackPitchHint')}>
                <div className="space-y-3 px-4 py-3.5">
                    <ConsoleSlider
                        label={t('ui.consolePlaybackPitch')}
                        valueText={formatPitch(playbackPitch)}
                        value={playbackPitch}
                        min={-6}
                        max={6}
                        defaultValue={0}
                        decimals={0}
                        onChange={pitch => setPitch(pitch)}
                        onCommit={() => undefined}
                    />
                    <p className="text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consolePlaybackPitchNote')}</p>
                </div>
            </EqualizerSection>

            {/* —— 恢复默认：本页两项一起回原速原调 —— */}
            <div className="px-4 pb-6 pt-1">
                <Button
                    onClick={() => {
                        setSpeed(1);
                        setPitch(0);
                    }}
                    className="st-t-fast h-9 w-full rounded-xl bg-[var(--st-fill)] text-[13px] text-[color:var(--st-t2)] transition-colors hover:bg-[var(--st-fill2)] hover:text-[color:var(--st-t1)]"
                >
                    {t('ui.consolePlaybackRestoreDefaults')}
                </Button>
            </div>
        </div>
    );
};

export default PlaybackPane;
