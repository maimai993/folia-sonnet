import React from 'react';
import { useTranslation } from 'react-i18next';
import {
    AUDIO_CONSOLE_TARGET_LUFS_MIN,
    AUDIO_CONSOLE_TARGET_LUFS_MAX,
    AUDIO_CONSOLE_DYNEQ_FREQ_MIN,
    AUDIO_CONSOLE_DYNEQ_FREQ_MAX,
    AUDIO_CONSOLE_DYNEQ_AMOUNT_MIN,
    AUDIO_CONSOLE_DYNEQ_AMOUNT_MAX,
    AUDIO_CONSOLE_VOCAL_MIN,
    AUDIO_CONSOLE_VOCAL_MAX,
} from '../../../utils/audioConsole';
import { useAudioConsoleStore } from '../../../stores/useAudioConsoleStore';
import { Toggle } from '../../ui';
import EqualizerSection from '../equalizer/EqualizerSection';
import { ConsoleSlider, formatDb, formatHz } from './controls';

// src/components/panelTab/console/StudioPane.tsx
// 调音台的「智能」页：工作室台 —— 把调音从「修补」升级到「美化 + 智能」。
//
// 分组：A/B 对比 → 响度标准化 → 进阶效果 → 智能场景。
// 每一项仍是「一个开关 + 一根滑杆 / 一个选择」，名字专业但用法直觉。
// A/B 对比放最顶上，随时一键听「原声 vs 调音后」。
// 原本混在这里的「音频修复」（去咔嗒/去嗡/降噪）已移到独立的「修复」页，让分类更清楚。

const StudioPane: React.FC = () => {
    const { t } = useTranslation();
    const studio = useAudioConsoleStore(state => state.settings.mastering.studio);
    const setNormalize = useAudioConsoleStore(state => state.setNormalize);
    const setAdvanced = useAudioConsoleStore(state => state.setAdvanced);
    const setScene = useAudioConsoleStore(state => state.setScene);

    const percentage = (value: number): string => `${Math.round(value * 100)}%`;
    const rmsDb = (value: number): string => `${value.toFixed(0)} dBFS RMS`;


    return (
        <div className="flex min-h-full flex-col">
            {/* —— 智能场景 · A/B 对比，放最顶上：随时一键对比原声 —— */}
            <EqualizerSection title={t('ui.consoleStudioAB')} hint={t('ui.consoleStudioABHint')}>
                <div className="space-y-3 px-4 py-3.5">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleStudioABEnabled')}</span>
                        <Toggle
                            checked={studio.scene.compare}
                            onChange={compare => setScene({ compare })}
                            label={t('ui.consoleStudioABEnabled')}
                        />
                    </div>
                    <p className={`text-[11px] leading-4 text-[color:var(--st-t3)] ${studio.scene.compare ? 'text-[color:var(--st-accent)]' : ''}`}>
                        {studio.scene.compare ? t('ui.consoleStudioABOn') : t('ui.consoleStudioABOff')}
                    </p>
                </div>
            </EqualizerSection>

            {/* —— 响度标准化 —— */}
            <EqualizerSection title={t('ui.consoleStudioNormalize')} hint={t('ui.consoleStudioNormalizeHint')}>
                <div className="space-y-3.5 px-4 pb-4 pt-3">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleStudioNormalizeEnabled')}</span>
                        <Toggle checked={studio.normalize.enabled} onChange={enabled => setNormalize({ enabled })} label={t('ui.consoleStudioNormalizeEnabled')} />
                    </div>
                    <div inert={!studio.normalize.enabled} className={studio.normalize.enabled ? '' : 'opacity-40'}>
                        <ConsoleSlider
                            label={t('ui.consoleStudioTarget')}
                            valueText={rmsDb(studio.normalize.targetLufs)}
                            value={studio.normalize.targetLufs}
                            min={AUDIO_CONSOLE_TARGET_LUFS_MIN}
                            max={AUDIO_CONSOLE_TARGET_LUFS_MAX}
                            decimals={0}
                            onChange={targetLufs => setNormalize({ targetLufs })}
                            onCommit={() => undefined}
                        />
                        <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleStudioTargetHint')}</p>
                        <div className="flex items-center justify-between gap-3 pt-1">
                            <span className="text-[13px] leading-5">{t('ui.consoleStudioTruePeak')}</span>
                            <Toggle checked={studio.normalize.truePeak} onChange={truePeak => setNormalize({ truePeak })} label={t('ui.consoleStudioTruePeak')} />
                        </div>
                    </div>
                </div>
            </EqualizerSection>

            {/* —— 进阶效果 —— */}
            <EqualizerSection title={t('ui.consoleStudioAdvanced')} hint={t('ui.consoleStudioAdvancedHint')}>
                <div className="divide-y divide-[var(--st-line)]">
                    {/* 动态 EQ */}
                    <div className="space-y-3 px-4 py-3.5">
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-[13px] leading-5">{t('ui.consoleStudioDynEq')}</span>
                            <Toggle checked={studio.advanced.dynamicEq} onChange={dynamicEq => setAdvanced({ dynamicEq })} label={t('ui.consoleStudioDynEq')} />
                        </div>
                        <div inert={!studio.advanced.dynamicEq} className={studio.advanced.dynamicEq ? '' : 'opacity-40'}>
                            <ConsoleSlider
                                label={t('ui.consoleStudioDynEqFreq')}
                                valueText={formatHz(studio.advanced.dynamicEqFreq)}
                                value={studio.advanced.dynamicEqFreq}
                                min={AUDIO_CONSOLE_DYNEQ_FREQ_MIN}
                                max={AUDIO_CONSOLE_DYNEQ_FREQ_MAX}
                                decimals={0}
                                onChange={dynamicEqFreq => setAdvanced({ dynamicEqFreq })}
                                onCommit={() => undefined}
                            />
                            <ConsoleSlider
                                label={t('ui.consoleStudioDynEqAmount')}
                                valueText={formatDb(studio.advanced.dynamicEqAmount, 0)}
                                value={studio.advanced.dynamicEqAmount}
                                min={AUDIO_CONSOLE_DYNEQ_AMOUNT_MIN}
                                max={AUDIO_CONSOLE_DYNEQ_AMOUNT_MAX}
                                decimals={0}
                                onChange={dynamicEqAmount => setAdvanced({ dynamicEqAmount })}
                                onCommit={() => undefined}
                            />
                        </div>
                    </div>
                    {/* 人声增强 */}
                    <div className="px-4 py-3.5">
                        <ConsoleSlider
                            label={t('ui.consoleStudioVocal')}
                            valueText={percentage(studio.advanced.vocalBoost)}
                            value={studio.advanced.vocalBoost}
                            min={AUDIO_CONSOLE_VOCAL_MIN}
                            max={AUDIO_CONSOLE_VOCAL_MAX}
                            onChange={vocalBoost => setAdvanced({ vocalBoost })}
                            onCommit={() => undefined}
                        />
                    </div>
                </div>
            </EqualizerSection>

        </div>
    );
};

export default StudioPane;
