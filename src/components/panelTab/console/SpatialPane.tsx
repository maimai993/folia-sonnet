import React from 'react';
import { useTranslation } from 'react-i18next';
import {
    AUDIO_CONSOLE_BASS_MONO_MAX,
    AUDIO_CONSOLE_STEREO_WIDTH_MAX,
    AUDIO_CONSOLE_STEREO_WIDTH_MIN,
    AUDIO_CONSOLE_CROSSFEED_MAX,
    AUDIO_CONSOLE_CROSSFEED_MIN,
    AUDIO_CONSOLE_ROTATION_MAX,
    AUDIO_CONSOLE_ROTATION_MIN,
} from '../../../utils/audioConsole';
import { useAudioConsoleStore } from '../../../stores/useAudioConsoleStore';
import { Toggle } from '../../ui';
import EqualizerSection from '../equalizer/EqualizerSection';
import { ConsoleSlider, formatHz, formatPercent } from './controls';

// 整首混音的立体声处理，不触发音轨分离。
const SpatialPane: React.FC = () => {
    const { t } = useTranslation();
    const stereo = useAudioConsoleStore(state => state.settings.stereo);
    const setStereo = useAudioConsoleStore(state => state.setStereo);

    return (
        <EqualizerSection title={t('ui.consoleStereo')} hint={t('ui.consoleStereoHint')}>
            <div className="space-y-3.5 px-4 pb-4 pt-3">
                <div className="flex items-center justify-between gap-3">
                    <span className="text-[13px] leading-5">{t('ui.consoleStereoEnabled')}</span>
                    <Toggle
                        checked={stereo.enabled}
                        onChange={enabled => setStereo({ enabled })}
                        label={t('ui.consoleStereoEnabled')}
                    />
                </div>
                <div className={stereo.enabled ? '' : 'opacity-40'}>
                    <ConsoleSlider
                        label={t('ui.consoleStereoWidth')}
                        valueText={formatPercent(stereo.width)}
                        value={stereo.width}
                        min={AUDIO_CONSOLE_STEREO_WIDTH_MIN}
                        max={AUDIO_CONSOLE_STEREO_WIDTH_MAX}
                        decimals={2}
                        disabled={!stereo.enabled}
                        onChange={width => setStereo({ width })}
                        onCommit={() => undefined}
                    />
                    <p className="mt-1.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleStereoWidthHint')}</p>

                    {/* 低频单声道：拖到最左边是关。它和宽度是两件事 —— 宽度管「侧向有多少」，
                        这一根管「多低的频率不算侧向」。 */}
                    <div className="mt-3">
                        <ConsoleSlider
                            label={t('ui.consoleStereoBassMono')}
                            valueText={stereo.bassMonoHz < 1 ? t('ui.consoleOff') : formatHz(stereo.bassMonoHz)}
                            value={stereo.bassMonoHz}
                            min={0}
                            max={AUDIO_CONSOLE_BASS_MONO_MAX}
                            log
                            decimals={0}
                            disabled={!stereo.enabled}
                            onChange={bassMonoHz => setStereo({ bassMonoHz })}
                            onCommit={() => undefined}
                        />
                        <p className="mt-1.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleStereoBassMonoHint')}</p>
                    </div>
                    <div className="mt-3">
                        <ConsoleSlider
                            label={t('ui.consoleStereoCrossfeed')}
                            valueText={formatPercent(stereo.crossfeed)}
                            value={stereo.crossfeed}
                            min={AUDIO_CONSOLE_CROSSFEED_MIN}
                            max={AUDIO_CONSOLE_CROSSFEED_MAX}
                            decimals={2}
                            disabled={!stereo.enabled}
                            onChange={crossfeed => setStereo({ crossfeed })}
                            onCommit={() => undefined}
                        />
                    </div>
                    <div className="mt-3">
                        <ConsoleSlider
                            label={t('ui.consoleStereoRotation')}
                            valueText={`${Math.round(stereo.rotation / 180 * 100)}%`}
                            value={stereo.rotation}
                            min={AUDIO_CONSOLE_ROTATION_MIN}
                            max={AUDIO_CONSOLE_ROTATION_MAX}
                            decimals={0}
                            disabled={!stereo.enabled}
                            onChange={rotation => setStereo({ rotation })}
                            onCommit={() => undefined}
                        />
                    </div>
                </div>
            </div>
        </EqualizerSection>
    );
};

export default SpatialPane;
