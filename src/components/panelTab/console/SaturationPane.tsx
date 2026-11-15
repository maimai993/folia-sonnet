import React from 'react';
import { useTranslation } from 'react-i18next';
import {
    AUDIO_CONSOLE_LIMITER_CEILING_MAX,
    AUDIO_CONSOLE_LIMITER_CEILING_MIN,
    AUDIO_CONSOLE_LIMITER_RELEASE_MAX,
    AUDIO_CONSOLE_LIMITER_RELEASE_MIN,
    AUDIO_CONSOLE_SATURATION_DRIVE_MAX,
    AUDIO_CONSOLE_SATURATION_DRIVE_MIN,
    AUDIO_CONSOLE_SATURATION_OUTPUT_MAX,
    AUDIO_CONSOLE_SATURATION_OUTPUT_MIN,
    type AudioConsoleSaturationMode,
} from '../../../utils/audioConsole';
import { useAudioConsoleStore } from '../../../stores/useAudioConsoleStore';
import { Segmented, Toggle } from '../../modal/settings/kit';
import EqualizerSection from '../equalizer/EqualizerSection';
import { ConsoleSlider, formatDb, formatMs, formatPercent } from './controls';

// src/components/panelTab/console/SaturationPane.tsx
// 调音台的第五页：饱和 / 染色，外加链末的限幅器。
//
// 为什么这两块在同一页：它们是信号链的**最后两站**。饱和是「最后一道加东西」，
// 限幅是「最后一道减东西」—— 调完染色顺手看一眼天花板够不够，是同一个动作。
//
// 三种曲线（磁带 / 电子管 / 二极管）不是「三个强度」而是三种不同的谐波结构：
//   TAPE   奇次为主 + 12 kHz 滚降，听起来「厚而略暗」，适合流行与摇滚；
//   TUBE   非对称，偶次谐波多，人耳把它当成「暖」，适合人声与爵士；
//   DIODE  硬膝、三次为主，颗粒感强，适合鼓、贝斯与合成器。
//
// 饱和会把响度顶上去（这是它的物理本质），所以 output 是手动的 —— 不做自动补偿，
// 是因为「变响一点」本身也是染色的一部分，替用户决定反而听不出区别。
//
// 限幅器没有开关：它一直在链末保护声卡，这一页只决定它多早开始工作、多快松开。

const MODES: ReadonlyArray<{ id: AudioConsoleSaturationMode; key: string }> = [
    { id: 'tape', key: 'ui.consoleSaturationTape' },
    { id: 'tube', key: 'ui.consoleSaturationTube' },
    { id: 'diode', key: 'ui.consoleSaturationDiode' },
];

const SaturationPane: React.FC = () => {
    const { t } = useTranslation();
    const saturation = useAudioConsoleStore(state => state.settings.saturation);
    const limiter = useAudioConsoleStore(state => state.settings.limiter);
    const setSaturation = useAudioConsoleStore(state => state.setSaturation);
    const setLimiter = useAudioConsoleStore(state => state.setLimiter);

    return (
        <div className="flex min-h-full flex-col">
            <EqualizerSection title={t('ui.consoleSaturation')} hint={t('ui.consoleSaturationHint')}>
                <div className="space-y-3.5 px-4 pb-4 pt-3">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleSaturationEnabled')}</span>
                        <Toggle
                            checked={saturation.enabled}
                            onChange={enabled => setSaturation({ enabled })}
                            label={t('ui.consoleSaturationEnabled')}
                        />
                    </div>

                    <div className={saturation.enabled ? '' : 'opacity-40'}>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[12px] text-[color:var(--st-t2)]">{t('ui.consoleSaturationMode')}</span>
                            <Segmented
                                value={saturation.mode}
                                options={MODES.map(item => ({ value: item.id, label: t(item.key) }))}
                                onChange={mode => setSaturation({ mode })}
                            />
                        </div>

                        <div className="mt-3.5 space-y-3.5">
                            <ConsoleSlider
                                label={t('ui.consoleSaturationDrive')}
                                valueText={formatDb(saturation.driveDb, 1)}
                                value={saturation.driveDb}
                                min={AUDIO_CONSOLE_SATURATION_DRIVE_MIN}
                                max={AUDIO_CONSOLE_SATURATION_DRIVE_MAX}
                                decimals={1}
                                disabled={!saturation.enabled}
                                onChange={driveDb => setSaturation({ driveDb })}
                                onCommit={() => undefined}
                            />
                            <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleSaturationDriveHint')}</p>
                            <ConsoleSlider
                                label={t('ui.consoleSaturationMix')}
                                valueText={formatPercent(saturation.mix)}
                                value={saturation.mix}
                                min={0}
                                max={1}
                                decimals={2}
                                disabled={!saturation.enabled}
                                onChange={mix => setSaturation({ mix })}
                                onCommit={() => undefined}
                            />
                            <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleSaturationMixHint')}</p>
                            <ConsoleSlider
                                label={t('ui.consoleSaturationOutput')}
                                valueText={formatDb(saturation.outputDb, 1)}
                                value={saturation.outputDb}
                                min={AUDIO_CONSOLE_SATURATION_OUTPUT_MIN}
                                max={AUDIO_CONSOLE_SATURATION_OUTPUT_MAX}
                                decimals={1}
                                disabled={!saturation.enabled}
                                onChange={outputDb => setSaturation({ outputDb })}
                                onCommit={() => undefined}
                            />
                            <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleSaturationOutputHint')}</p>
                        </div>
                    </div>
                </div>
            </EqualizerSection>

            <EqualizerSection title={t('ui.consoleLimiter')} hint={t('ui.consoleLimiterHint')}>
                <div className="space-y-3.5 px-4 pb-4 pt-3">
                    <ConsoleSlider
                        label={t('ui.consoleLimiterCeiling')}
                        valueText={formatDb(limiter.ceilingDb, 1)}
                        value={limiter.ceilingDb}
                        min={AUDIO_CONSOLE_LIMITER_CEILING_MIN}
                        max={AUDIO_CONSOLE_LIMITER_CEILING_MAX}
                        decimals={1}
                        onChange={ceilingDb => setLimiter({ ceilingDb })}
                        onCommit={() => undefined}
                    />
                    <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleLimiterCeilingHint')}</p>
                    <ConsoleSlider
                        label={t('ui.consoleLimiterRelease')}
                        valueText={formatMs(limiter.releaseMs)}
                        value={limiter.releaseMs}
                        min={AUDIO_CONSOLE_LIMITER_RELEASE_MIN}
                        max={AUDIO_CONSOLE_LIMITER_RELEASE_MAX}
                        log
                        decimals={0}
                        onChange={releaseMs => setLimiter({ releaseMs })}
                        onCommit={() => undefined}
                    />
                    <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleLimiterReleaseHint')}</p>
                </div>
            </EqualizerSection>
        </div>
    );
};

export default SaturationPane;
