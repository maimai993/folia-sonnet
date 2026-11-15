import React from 'react';
import { useTranslation } from 'react-i18next';
import {
    AUDIO_EFFECT_CONTROL_MAP,
    audioEffectToSliderPosition,
    formatAudioEffectValue,
    sliderPositionToAudioEffect,
    type AudioEffectId,
    type AudioEffectSettings,
} from '../../../utils/audioEffects';
import PanelSlider from '../controls/PanelSlider';
import EqualizerSection from './EqualizerSection';

// src/components/panelTab/equalizer/AudioEffectGrid.tsx
// 调音台的「频率边界」：低频截止与高频截止两颗滤波器，各自一行名字、读数、滑杆。
//
// 这里原本是九项效果链（截止、饱和、比特降质、抖晃、黑胶噪声、宽度、混响、压缩）。
// 现在只剩前两项：其余七项在安卓的原生链上没有一站接手，或者已经被压缩页 / 混响页
// 整块取代 —— 留着它们，用户拖到头也听不出变化，还会以为是自己没找对地方。
// 名单住在 audioEffects.ts 的 AUDIO_CONSOLE_EFFECT_IDS，谁要恢复某一项，
// 得先在 EqAudioProcessor 里给它一站。

/** The places along a slider's travel that the effect conversions count in. */
const SLIDER_POSITIONS = 1000;

type AudioEffectGridProps = {
    effects: AudioEffectSettings;
    /** 画哪几项，按给的顺序。 */
    ids: readonly AudioEffectId[];
    onEffectChange: (id: AudioEffectId, value: number) => void;
    onCommit: () => void;
    /** The sliders are out of reach (inert); the names and the values still read. */
    readOnly?: boolean;
};

const AudioEffectGrid: React.FC<AudioEffectGridProps> = ({ effects, ids, onEffectChange, onCommit, readOnly = false }) => {
    const { t } = useTranslation();

    return (
        <EqualizerSection title={t('ui.equalizerBounds')} hint={t('ui.equalizerBoundsHint')} marker="audio-effects">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-7 gap-y-1.5 px-4 pb-3.5 pt-3">
                {ids.map(id => {
                    const control = AUDIO_EFFECT_CONTROL_MAP[id];
                    const value = effects[id] ?? control.neutral;
                    const name = t(`ui.equalizerEffect.${id}`);
                    const valueText = formatAudioEffectValue(control, value);
                    return (
                        <div key={id} className="min-w-0">
                            <div className="flex items-center gap-1.5 text-[13px] leading-5">
                                <span className="truncate">{name}</span>
                                <span className="ml-auto shrink-0 font-mono text-xs text-[color:var(--st-t2)]">{valueText}</span>
                            </div>
                            {/* The gap keeps the slider's focus ring clear of the name above it. */}
                            <div inert={readOnly} className="mt-1 flex">
                                <PanelSlider
                                    value={audioEffectToSliderPosition(control, value) / SLIDER_POSITIONS}
                                    label={name}
                                    valueText={valueText}
                                    onPreview={(place) => {
                                        const next = sliderPositionToAudioEffect(control, place * SLIDER_POSITIONS);
                                        // The same value writes nothing: an edit turns processing on and goes to a custom slot.
                                        // (A press on the thumb that does not move it sends no value at all: PanelSlider.)
                                        if (next !== value) onEffectChange(id, next);
                                    }}
                                    onCommit={onCommit}
                                />
                            </div>
                        </div>
                    );
                })}
            </div>
        </EqualizerSection>
    );
};

export default AudioEffectGrid;
