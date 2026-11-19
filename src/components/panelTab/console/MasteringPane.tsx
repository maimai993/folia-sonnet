import React from 'react';
import { useTranslation } from 'react-i18next';
import {
    AUDIO_CONSOLE_COMP_AMOUNT_MAX,
    AUDIO_CONSOLE_COMP_AMOUNT_MIN,
    AUDIO_CONSOLE_COMP_MAX_GAIN_MAX,
    AUDIO_CONSOLE_COMP_MAX_GAIN_MIN,
    AUDIO_CONSOLE_COMP_RESPONSE_MAX,
    AUDIO_CONSOLE_COMP_RESPONSE_MIN,
    AUDIO_CONSOLE_BASS_GAIN_MIN,
    AUDIO_CONSOLE_BASS_GAIN_MAX,
    AUDIO_CONSOLE_BASS_FREQ_MIN,
    AUDIO_CONSOLE_BASS_FREQ_MAX,
    AUDIO_CONSOLE_EXCITER_AMOUNT_MIN,
    AUDIO_CONSOLE_EXCITER_AMOUNT_MAX,
    AUDIO_CONSOLE_TRANSIENT_MIN,
    AUDIO_CONSOLE_TRANSIENT_MAX,
    AUDIO_CONSOLE_TONE_MIN,
    AUDIO_CONSOLE_TONE_MAX,
    AUDIO_CONSOLE_LOUDNESS_MIN,
    AUDIO_CONSOLE_LOUDNESS_MAX,
    AUDIO_CONSOLE_BALANCE_MIN,
    AUDIO_CONSOLE_BALANCE_MAX,
} from '../../../utils/audioConsole';
import { useAudioConsoleStore } from '../../../stores/useAudioConsoleStore';
import { Toggle } from '../../ui';
import EqualizerSection from '../equalizer/EqualizerSection';
import { ConsoleSlider, formatDb, formatHz, formatMs, formatPercent } from './controls';

// src/components/panelTab/console/MasteringPane.tsx
// 调音台的母带页。
//
// 只放真正的母带处理：损失补偿、音色塑造、增强、声像平衡。全部是「一个滑杆一个效果」——
// 名字借自母带行业，但每一项都不用懂中心频率、Q 或包络，推滑杆就能听出变化。
// 最顶上的「损失补偿」是本方案的核心：开调音后声音变小变闷，它把响度补回来。
// 原本混在这里的「修复」类（噪声门/去齿音/去喷麦）已移到独立的「修复」页，让分类更清楚。
//
// 和其余四页一样，这里直接读写 useAudioConsoleStore（不经过均衡器那层的草稿），
// 拖动即试听、松手即落盘由 store 的 commit 负责。

const MasteringPane: React.FC = () => {
    const { t } = useTranslation();
    const mastering = useAudioConsoleStore(state => state.settings.mastering);
    const setCompensation = useAudioConsoleStore(state => state.setCompensation);
    const setBassBoost = useAudioConsoleStore(state => state.setBassBoost);
    const setExciter = useAudioConsoleStore(state => state.setExciter);
    const setTransient = useAudioConsoleStore(state => state.setTransient);
    const setTone = useAudioConsoleStore(state => state.setTone);
    const setLoudness = useAudioConsoleStore(state => state.setLoudness);
    const setBalance = useAudioConsoleStore(state => state.setBalance);

    const percentage = (value: number): string => `${Math.round(value * 100)}%`;

    return (
        <div className="flex min-h-full flex-col">
            {/* —— 核心：损失补偿，放最上面 —— */}
            <EqualizerSection title={t('ui.consoleMasteringComp')} hint={t('ui.consoleMasteringCompHint')}>
                <div className="space-y-3.5 px-4 pb-4 pt-3">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleMasteringCompEnabled')}</span>
                        <Toggle
                            checked={mastering.compensation.enabled}
                            onChange={enabled => setCompensation({ enabled })}
                            label={t('ui.consoleMasteringCompEnabled')}
                        />
                    </div>
                    <div inert={!mastering.compensation.enabled} className={`space-y-3.5 ${mastering.compensation.enabled ? '' : 'opacity-40'}`}>
                        <ConsoleSlider
                            label={t('ui.consoleMasteringCompAmount')}
                            valueText={percentage(mastering.compensation.amount)}
                            value={mastering.compensation.amount}
                            min={AUDIO_CONSOLE_COMP_AMOUNT_MIN}
                            max={AUDIO_CONSOLE_COMP_AMOUNT_MAX}
                            onChange={amount => setCompensation({ amount })}
                            onCommit={() => undefined}
                        />
                        <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleMasteringCompAmountHint')}</p>
                        <ConsoleSlider
                            label={t('ui.consoleMasteringCompMaxGain')}
                            valueText={formatDb(mastering.compensation.maxGainDb, 1)}
                            value={mastering.compensation.maxGainDb}
                            min={AUDIO_CONSOLE_COMP_MAX_GAIN_MIN}
                            max={AUDIO_CONSOLE_COMP_MAX_GAIN_MAX}
                            decimals={1}
                            onChange={maxGainDb => setCompensation({ maxGainDb })}
                            onCommit={() => undefined}
                        />
                        <ConsoleSlider
                            label={t('ui.consoleMasteringCompResponse')}
                            valueText={formatMs(mastering.compensation.responseMs)}
                            value={mastering.compensation.responseMs}
                            min={AUDIO_CONSOLE_COMP_RESPONSE_MIN}
                            max={AUDIO_CONSOLE_COMP_RESPONSE_MAX}
                            log
                            decimals={0}
                            onChange={responseMs => setCompensation({ responseMs })}
                            onCommit={() => undefined}
                        />
                        <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleMasteringCompResponseHint')}</p>
                    </div>
                </div>
            </EqualizerSection>

            {/* —— 音色塑造：空气 / 临场 / 温暖 / 清晰 —— */}
            <EqualizerSection title={t('ui.consoleMasteringTone')} hint={t('ui.consoleMasteringToneHint')}>
                <div className="space-y-3.5 px-4 py-3.5">
                    <ConsoleSlider label={t('ui.consoleMasteringAir')} valueText={formatDb(mastering.tone.air, 1)} value={mastering.tone.air} min={AUDIO_CONSOLE_TONE_MIN} max={AUDIO_CONSOLE_TONE_MAX} decimals={1} onChange={air => setTone({ air })} onCommit={() => undefined} />
                    <ConsoleSlider label={t('ui.consoleMasteringPresence')} valueText={formatDb(mastering.tone.presence, 1)} value={mastering.tone.presence} min={AUDIO_CONSOLE_TONE_MIN} max={AUDIO_CONSOLE_TONE_MAX} decimals={1} onChange={presence => setTone({ presence })} onCommit={() => undefined} />
                    <ConsoleSlider label={t('ui.consoleMasteringWarmth')} valueText={formatDb(mastering.tone.warmth, 1)} value={mastering.tone.warmth} min={AUDIO_CONSOLE_TONE_MIN} max={AUDIO_CONSOLE_TONE_MAX} decimals={1} onChange={warmth => setTone({ warmth })} onCommit={() => undefined} />
                    <ConsoleSlider label={t('ui.consoleMasteringClarity')} valueText={formatDb(mastering.tone.clarity, 1)} value={mastering.tone.clarity} min={AUDIO_CONSOLE_TONE_MIN} max={AUDIO_CONSOLE_TONE_MAX} decimals={1} onChange={clarity => setTone({ clarity })} onCommit={() => undefined} />
                </div>
            </EqualizerSection>

            {/* —— 增强：低频 / 激励 / 瞬态 / 等响度 —— */}
            <EqualizerSection title={t('ui.consoleMasteringEnhance')} hint={t('ui.consoleMasteringEnhanceHint')}>
                <div className="divide-y divide-[var(--st-line)]">
                    {/* 低频增强 */}
                    <div className="space-y-3.5 px-4 py-3.5">
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-[13px] leading-5">{t('ui.consoleMasteringBass')}</span>
                            <Toggle checked={mastering.bassBoost.enabled} onChange={enabled => setBassBoost({ enabled })} label={t('ui.consoleMasteringBass')} />
                        </div>
                        <div inert={!mastering.bassBoost.enabled} className={`space-y-3.5 ${mastering.bassBoost.enabled ? '' : 'opacity-40'}`}>
                            <ConsoleSlider label={t('ui.consoleMasteringGain')} valueText={formatDb(mastering.bassBoost.gainDb, 1)} value={mastering.bassBoost.gainDb} min={AUDIO_CONSOLE_BASS_GAIN_MIN} max={AUDIO_CONSOLE_BASS_GAIN_MAX} decimals={1} onChange={gainDb => setBassBoost({ gainDb })} onCommit={() => undefined} />
                            <ConsoleSlider label={t('ui.consoleMasteringFreq')} valueText={formatHz(mastering.bassBoost.frequencyHz)} value={mastering.bassBoost.frequencyHz} min={AUDIO_CONSOLE_BASS_FREQ_MIN} max={AUDIO_CONSOLE_BASS_FREQ_MAX} log decimals={0} onChange={frequencyHz => setBassBoost({ frequencyHz })} onCommit={() => undefined} />
                        </div>
                    </div>
                    {/* 谐波激励 */}
                    <div className="space-y-3.5 px-4 py-3.5">
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-[13px] leading-5">{t('ui.consoleMasteringExciter')}</span>
                            <Toggle checked={mastering.exciter.enabled} onChange={enabled => setExciter({ enabled })} label={t('ui.consoleMasteringExciter')} />
                        </div>
                        <div inert={!mastering.exciter.enabled} className={`space-y-3.5 ${mastering.exciter.enabled ? '' : 'opacity-40'}`}>
                            <ConsoleSlider label={t('ui.consoleMasteringAmount')} valueText={percentage(mastering.exciter.amount)} value={mastering.exciter.amount} min={AUDIO_CONSOLE_EXCITER_AMOUNT_MIN} max={AUDIO_CONSOLE_EXCITER_AMOUNT_MAX} onChange={amount => setExciter({ amount })} onCommit={() => undefined} />
                            <ConsoleSlider label={t('ui.consoleSaturationMix')} valueText={formatPercent(mastering.exciter.mix)} value={mastering.exciter.mix} min={0} max={1} onChange={mix => setExciter({ mix })} onCommit={() => undefined} />
                        </div>
                    </div>
                    {/* 瞬态塑形 */}
                    <div className="space-y-3.5 px-4 py-3.5">
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-[13px] leading-5">{t('ui.consoleMasteringTransient')}</span>
                            <Toggle checked={mastering.transient.enabled} onChange={enabled => setTransient({ enabled })} label={t('ui.consoleMasteringTransient')} />
                        </div>
                        <div inert={!mastering.transient.enabled} className={`space-y-3.5 ${mastering.transient.enabled ? '' : 'opacity-40'}`}>
                            <ConsoleSlider label={t('ui.consoleMasteringTransientAmount')} valueText={mastering.transient.amount === 0 ? '0' : `${mastering.transient.amount > 0 ? '+' : ''}${percentage(mastering.transient.amount)}`} value={mastering.transient.amount} min={AUDIO_CONSOLE_TRANSIENT_MIN} max={AUDIO_CONSOLE_TRANSIENT_MAX} onChange={amount => setTransient({ amount })} onCommit={() => undefined} />
                            <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleMasteringTransientHint')}</p>
                        </div>
                    </div>
                    {/* 等响度 */}
                    <div className="space-y-3.5 px-4 py-3.5">
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-[13px] leading-5">{t('ui.consoleMasteringLoudness')}</span>
                            <Toggle checked={mastering.loudness.enabled} onChange={enabled => setLoudness({ enabled })} label={t('ui.consoleMasteringLoudness')} />
                        </div>
                        <div inert={!mastering.loudness.enabled} className={`space-y-3.5 ${mastering.loudness.enabled ? '' : 'opacity-40'}`}>
                            <ConsoleSlider label={t('ui.consoleMasteringAmount')} valueText={percentage(mastering.loudness.amount)} value={mastering.loudness.amount} min={AUDIO_CONSOLE_LOUDNESS_MIN} max={AUDIO_CONSOLE_LOUDNESS_MAX} onChange={amount => setLoudness({ amount })} onCommit={() => undefined} />
                            <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleMasteringLoudnessHint')}</p>
                        </div>
                    </div>
                </div>
            </EqualizerSection>

            {/* —— 声像：声道平衡 —— */}
            <EqualizerSection title={t('ui.consoleMasteringField')} hint={t('ui.consoleMasteringFieldHint')}>
                <div className="space-y-3.5 px-4 py-3.5">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleMasteringBalance')}</span>
                        <Toggle checked={mastering.balance.enabled} onChange={enabled => setBalance({ enabled })} label={t('ui.consoleMasteringBalance')} />
                    </div>
                    <div inert={!mastering.balance.enabled} className={`space-y-3.5 ${mastering.balance.enabled ? '' : 'opacity-40'}`}>
                        <ConsoleSlider
                            label={t('ui.consoleMasteringBalance')}
                            valueText={mastering.balance.value === 0 ? t('ui.consoleMasteringCenter') : `${mastering.balance.value < 0 ? t('ui.consoleMasteringLeft') : t('ui.consoleMasteringRight')} ${percentage(Math.abs(mastering.balance.value))}`}
                            value={mastering.balance.value}
                            min={AUDIO_CONSOLE_BALANCE_MIN}
                            max={AUDIO_CONSOLE_BALANCE_MAX}
                            defaultValue={0}
                            onChange={value => setBalance({ value })}
                            onCommit={() => undefined}
                        />
                    </div>
                </div>
            </EqualizerSection>
        </div>
    );
};

export default MasteringPane;
