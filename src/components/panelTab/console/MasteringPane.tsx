import React from 'react';
import { useTranslation } from 'react-i18next';
import {
    AUDIO_CONSOLE_COMP_AMOUNT_MAX,
    AUDIO_CONSOLE_COMP_AMOUNT_MIN,
    AUDIO_CONSOLE_COMP_MAX_GAIN_MAX,
    AUDIO_CONSOLE_COMP_MAX_GAIN_MIN,
    AUDIO_CONSOLE_COMP_RESPONSE_MAX,
    AUDIO_CONSOLE_COMP_RESPONSE_MIN,
    AUDIO_CONSOLE_GATE_THRESHOLD_MIN,
    AUDIO_CONSOLE_GATE_THRESHOLD_MAX,
    AUDIO_CONSOLE_GATE_ATTACK_MIN,
    AUDIO_CONSOLE_GATE_ATTACK_MAX,
    AUDIO_CONSOLE_GATE_RELEASE_MIN,
    AUDIO_CONSOLE_GATE_RELEASE_MAX,
    AUDIO_CONSOLE_GATE_REDUCTION_MIN,
    AUDIO_CONSOLE_GATE_REDUCTION_MAX,
    AUDIO_CONSOLE_DEESS_FREQ_MIN,
    AUDIO_CONSOLE_DEESS_FREQ_MAX,
    AUDIO_CONSOLE_DEESS_THRESHOLD_MIN,
    AUDIO_CONSOLE_DEESS_THRESHOLD_MAX,
    AUDIO_CONSOLE_DEESS_RATIO_MIN,
    AUDIO_CONSOLE_DEESS_RATIO_MAX,
    AUDIO_CONSOLE_DEPLOSIVE_REDUCTION_MIN,
    AUDIO_CONSOLE_DEPLOSIVE_REDUCTION_MAX,
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
import { Toggle } from '../../modal/settings/kit';
import EqualizerSection from '../equalizer/EqualizerSection';
import { ConsoleSlider, formatDb, formatHz, formatMs, formatPercent, formatRatio } from './controls';

// src/components/panelTab/console/MasteringPane.tsx
// 调音台的第六页：母带台。
//
// 十项处理按「先补偿、再修复、再塑造、最后平衡」分组，全部是「一个滑杆一个效果」——
// 名字借自母带行业，但每一项都不用懂中心频率、Q 或包络，推滑杆就能听出变化。
// 最顶上的「损失补偿」是本方案的核心：开调音后声音变小变闷，它把响度补回来。
//
// 和其余四页一样，这里直接读写 useAudioConsoleStore（不经过均衡器那层的草稿），
// 拖动即试听、松手即落盘由 store 的 commit 负责。

const MasteringPane: React.FC = () => {
    const { t } = useTranslation();
    const mastering = useAudioConsoleStore(state => state.settings.mastering);
    const setCompensation = useAudioConsoleStore(state => state.setCompensation);
    const setNoiseGate = useAudioConsoleStore(state => state.setNoiseGate);
    const setDeEsser = useAudioConsoleStore(state => state.setDeEsser);
    const setDePlosive = useAudioConsoleStore(state => state.setDePlosive);
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
                    <div className={mastering.compensation.enabled ? '' : 'opacity-40'}>
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

            {/* —— 修复：噪声门 / 去齿音 / 去喷麦 —— */}
            <EqualizerSection title={t('ui.consoleMasteringRepair')} hint={t('ui.consoleMasteringRepairHint')}>
                <div className="divide-y divide-[var(--st-line)]">
                    {/* 噪声门 */}
                    <div className="space-y-3.5 px-4 py-3.5">
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-[13px] leading-5">{t('ui.consoleMasteringGate')}</span>
                            <Toggle checked={mastering.noiseGate.enabled} onChange={enabled => setNoiseGate({ enabled })} label={t('ui.consoleMasteringGate')} />
                        </div>
                        <div className={mastering.noiseGate.enabled ? '' : 'opacity-40'}>
                            <ConsoleSlider label={t('ui.consoleThreshold')} valueText={formatDb(mastering.noiseGate.thresholdDb, 1)} value={mastering.noiseGate.thresholdDb} min={AUDIO_CONSOLE_GATE_THRESHOLD_MIN} max={AUDIO_CONSOLE_GATE_THRESHOLD_MAX} decimals={1} onChange={thresholdDb => setNoiseGate({ thresholdDb })} onCommit={() => undefined} />
                            <ConsoleSlider label={t('ui.consoleAttack')} valueText={formatMs(mastering.noiseGate.attackMs)} value={mastering.noiseGate.attackMs} min={AUDIO_CONSOLE_GATE_ATTACK_MIN} max={AUDIO_CONSOLE_GATE_ATTACK_MAX} log decimals={1} onChange={attackMs => setNoiseGate({ attackMs })} onCommit={() => undefined} />
                            <ConsoleSlider label={t('ui.consoleRelease')} valueText={formatMs(mastering.noiseGate.releaseMs)} value={mastering.noiseGate.releaseMs} min={AUDIO_CONSOLE_GATE_RELEASE_MIN} max={AUDIO_CONSOLE_GATE_RELEASE_MAX} log decimals={0} onChange={releaseMs => setNoiseGate({ releaseMs })} onCommit={() => undefined} />
                            <ConsoleSlider label={t('ui.consoleMasteringReduction')} valueText={formatDb(mastering.noiseGate.reductionDb, 1)} value={mastering.noiseGate.reductionDb} min={AUDIO_CONSOLE_GATE_REDUCTION_MIN} max={AUDIO_CONSOLE_GATE_REDUCTION_MAX} decimals={1} onChange={reductionDb => setNoiseGate({ reductionDb })} onCommit={() => undefined} />
                        </div>
                    </div>
                    {/* 去齿音 */}
                    <div className="space-y-3.5 px-4 py-3.5">
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-[13px] leading-5">{t('ui.consoleMasteringDeEsser')}</span>
                            <Toggle checked={mastering.deEsser.enabled} onChange={enabled => setDeEsser({ enabled })} label={t('ui.consoleMasteringDeEsser')} />
                        </div>
                        <div className={mastering.deEsser.enabled ? '' : 'opacity-40'}>
                            <ConsoleSlider label={t('ui.consoleMasteringFreq')} valueText={formatHz(mastering.deEsser.frequencyHz)} value={mastering.deEsser.frequencyHz} min={AUDIO_CONSOLE_DEESS_FREQ_MIN} max={AUDIO_CONSOLE_DEESS_FREQ_MAX} log decimals={0} onChange={frequencyHz => setDeEsser({ frequencyHz })} onCommit={() => undefined} />
                            <ConsoleSlider label={t('ui.consoleThreshold')} valueText={formatDb(mastering.deEsser.thresholdDb, 1)} value={mastering.deEsser.thresholdDb} min={AUDIO_CONSOLE_DEESS_THRESHOLD_MIN} max={AUDIO_CONSOLE_DEESS_THRESHOLD_MAX} decimals={1} onChange={thresholdDb => setDeEsser({ thresholdDb })} onCommit={() => undefined} />
                            <ConsoleSlider label={t('ui.consoleRatio')} valueText={formatRatio(mastering.deEsser.ratio)} value={mastering.deEsser.ratio} min={AUDIO_CONSOLE_DEESS_RATIO_MIN} max={AUDIO_CONSOLE_DEESS_RATIO_MAX} decimals={1} onChange={ratio => setDeEsser({ ratio })} onCommit={() => undefined} />
                        </div>
                    </div>
                    {/* 去喷麦 */}
                    <div className="space-y-3.5 px-4 py-3.5">
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-[13px] leading-5">{t('ui.consoleMasteringDePlosive')}</span>
                            <Toggle checked={mastering.dePlosive.enabled} onChange={enabled => setDePlosive({ enabled })} label={t('ui.consoleMasteringDePlosive')} />
                        </div>
                        <div className={mastering.dePlosive.enabled ? '' : 'opacity-40'}>
                            <ConsoleSlider label={t('ui.consoleMasteringReduction')} valueText={formatDb(mastering.dePlosive.reductionDb, 1)} value={mastering.dePlosive.reductionDb} min={AUDIO_CONSOLE_DEPLOSIVE_REDUCTION_MIN} max={AUDIO_CONSOLE_DEPLOSIVE_REDUCTION_MAX} decimals={1} onChange={reductionDb => setDePlosive({ reductionDb })} onCommit={() => undefined} />
                            <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleMasteringDePlosiveHint')}</p>
                        </div>
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
                        <div className={mastering.bassBoost.enabled ? '' : 'opacity-40'}>
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
                        <div className={mastering.exciter.enabled ? '' : 'opacity-40'}>
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
                        <div className={mastering.transient.enabled ? '' : 'opacity-40'}>
                            <ConsoleSlider label={t('ui.consoleMasteringTransientAmount')} valueText={mastering.transient.amount === 0 ? '0' : (mastering.transient.amount > 0 ? '+' : '') + Math.round(mastering.transient.amount * 100) + '%'} value={mastering.transient.amount} min={AUDIO_CONSOLE_TRANSIENT_MIN} max={AUDIO_CONSOLE_TRANSIENT_MAX} onChange={amount => setTransient({ amount })} onCommit={() => undefined} />
                            <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleMasteringTransientHint')}</p>
                        </div>
                    </div>
                    {/* 等响度 */}
                    <div className="space-y-3.5 px-4 py-3.5">
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-[13px] leading-5">{t('ui.consoleMasteringLoudness')}</span>
                            <Toggle checked={mastering.loudness.enabled} onChange={enabled => setLoudness({ enabled })} label={t('ui.consoleMasteringLoudness')} />
                        </div>
                        <div className={mastering.loudness.enabled ? '' : 'opacity-40'}>
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
                    <div className={mastering.balance.enabled ? '' : 'opacity-40'}>
                        <ConsoleSlider
                            label={t('ui.consoleMasteringBalance')}
                            valueText={mastering.balance.value === 0 ? t('ui.consoleMasteringCenter') : (mastering.balance.value < 0 ? t('ui.consoleMasteringLeft') : t('ui.consoleMasteringRight')) + ' ' + Math.round(Math.abs(mastering.balance.value) * 100) + '%'}
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
