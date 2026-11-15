import React from 'react';
import { useTranslation } from 'react-i18next';
import {
    AUDIO_EQUALIZER_MAX_GAIN_DB,
    AUDIO_EQUALIZER_MIN_GAIN_DB,
    type AudioEqualizerModeId,
    type AudioEqualizerSettings,
} from '../../../utils/audioEqualizer';
import { AUDIO_CONSOLE_EFFECT_IDS, type AudioEffectId } from '../../../utils/audioEffects';
import { useAudioConsoleStore } from '../../../stores/useAudioConsoleStore';
import { AUDIO_CONSOLE_GLOBAL_GAIN_MAX, AUDIO_CONSOLE_GLOBAL_GAIN_MIN, AUDIO_CONSOLE_Q_MAX, AUDIO_CONSOLE_Q_MIN } from '../../../utils/audioConsole';
import { Segmented } from '../../modal/settings/kit';
import AudioEffectGrid from '../equalizer/AudioEffectGrid';
import EqualizerBandGrid from '../equalizer/EqualizerBandGrid';
import EqualizerSection from '../equalizer/EqualizerSection';
import PresetChips from '../equalizer/PresetChips';
import { ConsoleSlider, formatDb } from './controls';

// src/components/panelTab/console/EqualizerPane.tsx
// 调音台的第一页：十段增益、预设、曲线形状（GEQ 定 Q / PEQ 可变 Q），以及频率边界。
//
// 十段增益本身仍归 useAudioSettingsStore 管（那边还有 mod 曲线与自定义槽位），
// 这里只是多给两个旋钮：Q 值和总增益，它们存在 useAudioConsoleStore 里。
// 分成两个 store 不影响这一页 —— 用户看到的就是一页均衡器。
//
// 「频率边界」只放高频截止与低频截止两颗：这两项真的接在原生链上。原来那九项效果
// 里的其余七项，要么原生没有一站接手，要么已经被压缩页 / 混响页整块取代（见
// audioEffects.ts 的 AUDIO_CONSOLE_EFFECT_IDS）。

type EqualizerPaneProps = {
    draft: AudioEqualizerSettings;
    /** 正在听模组的曲线：十段与效果都是只读的。 */
    curveHeard: boolean;
    presetIds: AudioEqualizerModeId[];
    onChoosePreset: (presetId: AudioEqualizerModeId) => void;
    canReset: boolean;
    onReset: () => void;
    onBandChange: (index: number, value: number) => void;
    onEffectChange: (id: AudioEffectId, value: number) => void;
    onCommit: () => void;
};

const EqualizerPane: React.FC<EqualizerPaneProps> = ({
    draft,
    curveHeard,
    presetIds,
    onChoosePreset,
    canReset,
    onReset,
    onBandChange,
    onEffectChange,
    onCommit,
}) => {
    const { t } = useTranslation();
    const frontEq = useAudioConsoleStore(state => state.settings.frontEq);
    const setFrontEq = useAudioConsoleStore(state => state.setFrontEq);

    return (
        <div className="flex min-h-full flex-col">
            {/* 预设条自己一圈，方便「哪个预设亮着」这类判断落在它身上：窗口里还有页签与曲线形状
                两组按钮，它们同样用 aria-pressed 表达选中，混在一起数会把预设数错。 */}
            <div data-folia-presets>
                <PresetChips
                    presetIds={presetIds}
                    chosen={curveHeard ? null : draft.preset}
                    onChoose={onChoosePreset}
                    canReset={canReset}
                    onReset={onReset}
                />
            </div>
            <div className={`st-t-move flex flex-1 flex-col transition-opacity${draft.enabled && !curveHeard ? '' : ' opacity-40'}`}>
                <EqualizerBandGrid gains={draft.gains} onBandChange={onBandChange} onCommit={onCommit} readOnly={curveHeard} />

                {/* 曲线形状与两个旋钮也一起让路：曲线接管时改 Q 或总增益，等于在改模组那条曲线的
                    形状，而这一页此刻呈现的不是用户自己的声音。 */}
                <div inert={curveHeard}>
                    <EqualizerSection title={t('ui.equalizerCurve')} hint={t('ui.equalizerCurveHint')}>
                        <div className="px-4 pb-3.5 pt-3">
                            <Segmented
                                value={frontEq.curve}
                                options={[
                                    { value: 'geq', label: t('ui.equalizerCurveGeq') },
                                    { value: 'peq', label: t('ui.equalizerCurvePeq') },
                                ]}
                                onChange={value => setFrontEq({ curve: value })}
                                fill
                            />
                            <p className="mt-2 text-[11px] leading-4 text-[color:var(--st-t3)]">
                                {t(frontEq.curve === 'geq' ? 'ui.equalizerCurveGeqHint' : 'ui.equalizerCurvePeqHint')}
                            </p>
                            <div className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
                                {frontEq.curve === 'peq' && (
                                    <ConsoleSlider
                                        label={t('ui.equalizerQ')}
                                        valueText={frontEq.q.toFixed(2)}
                                        value={frontEq.q}
                                        min={AUDIO_CONSOLE_Q_MIN}
                                        max={AUDIO_CONSOLE_Q_MAX}
                                        log
                                        onChange={q => setFrontEq({ q })}
                                        onCommit={() => undefined}
                                    />
                                )}
                                <ConsoleSlider
                                    label={t('ui.equalizerGlobalGain')}
                                    valueText={formatDb(frontEq.globalGainDb)}
                                    value={frontEq.globalGainDb}
                                    min={AUDIO_CONSOLE_GLOBAL_GAIN_MIN}
                                    max={AUDIO_CONSOLE_GLOBAL_GAIN_MAX}
                                    decimals={1}
                                    onChange={globalGainDb => setFrontEq({ globalGainDb })}
                                    onCommit={() => undefined}
                                />
                            </div>
                            <p className="mt-3 font-mono text-[11px] leading-4 text-[color:var(--st-t3)]">
                                {AUDIO_EQUALIZER_MIN_GAIN_DB} ~ +{AUDIO_EQUALIZER_MAX_GAIN_DB} dB · 31 Hz – 16 kHz · 10
                            </p>
                        </div>
                    </EqualizerSection>
                </div>

                <AudioEffectGrid
                    effects={draft.effects}
                    ids={AUDIO_CONSOLE_EFFECT_IDS}
                    onEffectChange={onEffectChange}
                    onCommit={onCommit}
                    readOnly={curveHeard}
                />
            </div>
        </div>
    );
};

export default EqualizerPane;
