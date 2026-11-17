import React from 'react';
import { useTranslation } from 'react-i18next';
import {
    AUDIO_CONSOLE_SPATIAL_LEVEL_MAX,
    AUDIO_CONSOLE_SPATIAL_LEVEL_MIN,
    AUDIO_CONSOLE_SPATIAL_PAN_MAX,
    AUDIO_CONSOLE_SPATIAL_PAN_MIN,
    AUDIO_CONSOLE_SPATIAL_WIDTH_MAX,
    AUDIO_CONSOLE_SPATIAL_WIDTH_MIN,
    AUDIO_CONSOLE_STEM_KINDS,
    type AudioConsoleStemKind,
} from '../../../utils/audioConsole';
import { useAudioConsoleStore } from '../../../stores/useAudioConsoleStore';
import { Segmented, Toggle } from '../../modal/settings/kit';
import EqualizerSection from '../equalizer/EqualizerSection';
import { ConsoleSlider, formatDb } from './controls';

// src/components/panelTab/console/SpatialPane.tsx
// 调音台的空间声场页：把 SCNet 拆出的四轨（鼓 / 贝斯 / 其他 / 人声）分别摆位。
//
// 自动（auto）用内置摆位 —— 人声居中、贝斯略收、鼓与其他铺开；自定义（custom）则
// 逐轨调 audible / pan / width / level。两条路共用同一组数据，切到 custom 时滑杆
// 显示的就是自定义值，不会覆盖。
//
// 这一页只管参数。真正把四轨混起来的是原生 StemMixProcessor（挂在 EQ 链之前）。

const STEM_LABEL_KEYS: Record<AudioConsoleStemKind, string> = {
    drums: 'ui.consoleStemDrums',
    bass: 'ui.consoleStemBass',
    other: 'ui.consoleStemOther',
    vocals: 'ui.consoleStemVocals',
};

const MODES = [
    { value: 'auto', labelKey: 'ui.consoleSpatialAuto' },
    { value: 'custom', labelKey: 'ui.consoleSpatialCustom' },
] as const;

const SpatialPane: React.FC = () => {
    const { t } = useTranslation();
    const spatial = useAudioConsoleStore(state => state.settings.spatial);
    const setSpatial = useAudioConsoleStore(state => state.setSpatial);
    const setStemSpatial = useAudioConsoleStore(state => state.setStemSpatial);

    return (
        <div className="flex min-h-full flex-col">
            <EqualizerSection title={t('ui.consoleSpatial')} hint={t('ui.consoleSpatialHint')}>
                <div className="space-y-3.5 px-4 pb-4 pt-3">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] leading-5">{t('ui.consoleSpatialEnabled')}</span>
                        <Toggle
                            checked={spatial.enabled}
                            onChange={enabled => setSpatial({ enabled })}
                            label={t('ui.consoleSpatialEnabled')}
                        />
                    </div>

                    <div className={spatial.enabled ? '' : 'opacity-40'}>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[12px] text-[color:var(--st-t2)]">{t('ui.consoleSpatialMode')}</span>
                            <Segmented
                                value={spatial.mode}
                                options={MODES.map(item => ({ value: item.value, label: t(item.labelKey) }))}
                                onChange={mode => setSpatial({ mode })}
                            />
                        </div>
                    </div>
                </div>
            </EqualizerSection>

            {AUDIO_CONSOLE_STEM_KINDS.map(kind => {
                const stem = spatial.stems[kind];
                const editable = spatial.enabled && spatial.mode === 'custom';
                return (
                    <EqualizerSection key={kind} title={t(STEM_LABEL_KEYS[kind])}>
                        <div className={`space-y-3.5 px-4 pb-4 pt-3${editable ? '' : ' opacity-40'}`}>
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-[13px] leading-5">{t('ui.consoleStemAudible')}</span>
                                <Toggle
                                    checked={stem.audible}
                                    onChange={audible => setStemSpatial(kind, { audible })}
                                    label={t('ui.consoleStemAudible')}
                                />
                            </div>
                            <ConsoleSlider
                                label={t('ui.consoleStemPan')}
                                valueText={stem.pan.toFixed(2)}
                                value={stem.pan}
                                min={AUDIO_CONSOLE_SPATIAL_PAN_MIN}
                                max={AUDIO_CONSOLE_SPATIAL_PAN_MAX}
                                decimals={2}
                                disabled={!editable}
                                onChange={pan => setStemSpatial(kind, { pan })}
                                onCommit={() => undefined}
                            />
                            <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleStemPanHint')}</p>
                            <ConsoleSlider
                                label={t('ui.consoleStemWidth')}
                                valueText={stem.width.toFixed(2)}
                                value={stem.width}
                                min={AUDIO_CONSOLE_SPATIAL_WIDTH_MIN}
                                max={AUDIO_CONSOLE_SPATIAL_WIDTH_MAX}
                                decimals={2}
                                disabled={!editable}
                                onChange={width => setStemSpatial(kind, { width })}
                                onCommit={() => undefined}
                            />
                            <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleStemWidthHint')}</p>
                            <ConsoleSlider
                                label={t('ui.consoleStemLevel')}
                                valueText={formatDb(stem.levelDb, 1)}
                                value={stem.levelDb}
                                min={AUDIO_CONSOLE_SPATIAL_LEVEL_MIN}
                                max={AUDIO_CONSOLE_SPATIAL_LEVEL_MAX}
                                decimals={1}
                                disabled={!editable}
                                onChange={levelDb => setStemSpatial(kind, { levelDb })}
                                onCommit={() => undefined}
                            />
                            <p className="-mt-2.5 text-[11px] leading-4 text-[color:var(--st-t3)]">{t('ui.consoleStemLevelHint')}</p>
                        </div>
                    </EqualizerSection>
                );
            })}
        </div>
    );
};

export default SpatialPane;
