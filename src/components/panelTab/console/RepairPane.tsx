import React from 'react';
import { useTranslation } from 'react-i18next';
import {
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
    AUDIO_CONSOLE_RESTORE_AMOUNT_MIN,
    AUDIO_CONSOLE_RESTORE_AMOUNT_MAX,
} from '../../../utils/audioConsole';
import { useAudioConsoleStore } from '../../../stores/useAudioConsoleStore';
import { Toggle } from '../../ui';
import EqualizerSection from '../equalizer/EqualizerSection';
import { ConsoleSlider, formatDb, formatHz, formatMs, formatRatio } from './controls';

// src/components/panelTab/console/RepairPane.tsx
// 调音台的「修复」页：把所有「修补瑕疵」的处理集中在一处 ——
//   人声类：噪声门、去齿音、去喷麦（原先散在母带页）
//   录音类：去咔嗒、去嗡声、降噪（原先散在工作室页）
// 它们读写的仍是原有的 store 字段与 DSP 处理级，只是界面归位，动的是「分类」不是「算法」。
// 拖动即试听、松手即落盘仍由 store 的 commit 负责。

const RepairPane: React.FC = () => {
    const { t } = useTranslation();
    const mastering = useAudioConsoleStore(state => state.settings.mastering);
    const studio = useAudioConsoleStore(state => state.settings.mastering.studio);
    const setNoiseGate = useAudioConsoleStore(state => state.setNoiseGate);
    const setDeEsser = useAudioConsoleStore(state => state.setDeEsser);
    const setDePlosive = useAudioConsoleStore(state => state.setDePlosive);
    const setRestore = useAudioConsoleStore(state => state.setRestore);

    const percentage = (value: number): string => `${Math.round(value * 100)}%`;

    return (
        <div className="flex min-h-full flex-col">
            {/* —— 人声修复：噪声门 / 去齿音 / 去喷麦 —— */}
            <EqualizerSection title={t('ui.consoleMasteringRepair')} hint={t('ui.consoleMasteringRepairHint')}>
                <div className="divide-y divide-[var(--st-line)]">
                    {/* 噪声门 */}
                    <div className="space-y-3.5 px-4 py-3.5">
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-[13px] leading-5">{t('ui.consoleMasteringGate')}</span>
                            <Toggle checked={mastering.noiseGate.enabled} onChange={enabled => setNoiseGate({ enabled })} label={t('ui.consoleMasteringGate')} />
                        </div>
                        <div inert={!mastering.noiseGate.enabled} className={mastering.noiseGate.enabled ? '' : 'opacity-40'}>
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
                        <div inert={!mastering.deEsser.enabled} className={mastering.deEsser.enabled ? '' : 'opacity-40'}>
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
                        <div inert={!mastering.dePlosive.enabled} className={mastering.dePlosive.enabled ? '' : 'opacity-40'}>
                            <ConsoleSlider label={t('ui.consoleMasteringReduction')} valueText={formatDb(mastering.dePlosive.reductionDb, 1)} value={mastering.dePlosive.reductionDb} min={AUDIO_CONSOLE_DEPLOSIVE_REDUCTION_MIN} max={AUDIO_CONSOLE_DEPLOSIVE_REDUCTION_MAX} decimals={1} onChange={reductionDb => setDePlosive({ reductionDb })} onCommit={() => undefined} />
                            <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleMasteringDePlosiveHint')}</p>
                        </div>
                    </div>
                </div>
            </EqualizerSection>

            {/* —— 录音修复：去咔嗒 / 去嗡声 / 降噪 —— */}
            <EqualizerSection title={t('ui.consoleStudioRestore')} hint={t('ui.consoleStudioRestoreHint')}>
                <div className="divide-y divide-[var(--st-line)]">
                    <div className="flex items-center justify-between gap-3 px-4 py-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleStudioDeclick')}</span>
                        <Toggle checked={studio.restore.declick} onChange={declick => setRestore({ declick })} label={t('ui.consoleStudioDeclick')} />
                    </div>
                    <div className="flex items-center justify-between gap-3 px-4 py-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleStudioHum')}</span>
                        <Toggle checked={studio.restore.hum} onChange={hum => setRestore({ hum })} label={t('ui.consoleStudioHum')} />
                    </div>
                    <div className="flex items-center justify-between gap-3 px-4 py-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleStudioDenoise')}</span>
                        <Toggle checked={studio.restore.denoise} onChange={denoise => setRestore({ denoise })} label={t('ui.consoleStudioDenoise')} />
                    </div>
                    <div className="px-4 py-3.5">
                        <ConsoleSlider
                            label={t('ui.consoleStudioRestoreAmount')}
                            valueText={percentage(studio.restore.amount)}
                            value={studio.restore.amount}
                            min={AUDIO_CONSOLE_RESTORE_AMOUNT_MIN}
                            max={AUDIO_CONSOLE_RESTORE_AMOUNT_MAX}
                            onChange={amount => setRestore({ amount })}
                            onCommit={() => undefined}
                        />
                    </div>
                </div>
            </EqualizerSection>
        </div>
    );
};

export default RepairPane;
