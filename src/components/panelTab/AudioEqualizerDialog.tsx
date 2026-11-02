import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    AUDIO_EQUALIZER_CUSTOM_SLOT_IDS,
    areAudioEqualizerSettingsEqual,
    getAudioEqualizerCustomSlotIndex,
    isAudioEqualizerCustomSlotId,
    resolveAudioEqualizerSettings,
    type AudioEqualizerCustomSlotId,
    type AudioEqualizerModeId,
    type AudioEqualizerSettings,
} from '../../utils/audioEqualizer';
import { AUDIO_SOUND_PRESETS, AUDIO_SOUND_PRESET_IDS } from '../../utils/audioPresets';
import { createNeutralAudioEffects, type AudioEffectId, type AudioEffectSettings } from '../../utils/audioEffects';
import { resolveHeardAudioEqualizerSettings } from '../../utils/audioEqualizerModCurve';
import Sheet from '../shared/Sheet';
import { Toggle } from '../modal/settings/kit';
import ModCurveNotice from './equalizer/ModCurveNotice';
import ConsoleTabs from './console/ConsoleTabs';
import ProfileBar from './console/ProfileBar';
import EqualizerPane from './console/EqualizerPane';
import CompressorPane from './console/CompressorPane';
import ReverbPane from './console/ReverbPane';
import PostEqPane from './console/PostEqPane';
import SaturationPane from './console/SaturationPane';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { useAudioProfilesStore } from '../../stores/useAudioProfilesStore';

// src/components/panelTab/AudioEqualizerDialog.tsx
// 调音台窗口：从控制页打开的那扇「音频效果」。
//
// 从一页变成五页（均衡器 / 压缩器 / 空间混响 / 后置均衡器 / 染色），因为声音的处理已经不在
// Web Audio 里跑了 —— 原生的 ExoPlayer 一次能做的事比一个 `<audio>` 多得多，
// 界面得跟得上。五页共用同一颗总开关：关掉它，整条链（含压缩、混响与染色）一起让路。
//
// 均衡器那一页的数据仍归 useAudioSettingsStore（十段增益、预设、自定义槽位、mod 曲线），
// 其余四页归 useAudioConsoleStore。这一层只管草稿与落盘时机：
// 拖的时候只改草稿，松手才写 store —— 与原来那扇窗口的规矩一样。

type AudioEqualizerDialogProps = {
    isDaylight: boolean;
};

type ConsoleTabId = 'equalizer' | 'compressor' | 'reverb' | 'postEq' | 'saturation';

const PRESET_IDS: AudioEqualizerModeId[] = [...AUDIO_SOUND_PRESET_IDS, ...AUDIO_EQUALIZER_CUSTOM_SLOT_IDS];

const AudioEqualizerDialog: React.FC<AudioEqualizerDialogProps> = ({ isDaylight }) => {
    const { t } = useTranslation();
    const ownSettings = useAudioSettingsStore(state => state.audioEqualizerSettings);
    const modCurve = useAudioSettingsStore(state => state.audioEqualizerModCurve);
    const modCurveSuspended = useAudioSettingsStore(state => state.audioEqualizerModCurveSuspended);
    const isOpen = useAudioSettingsStore(state => state.isAudioEqualizerOpen);
    const close = useAudioSettingsStore(state => state.closeAudioEqualizer);
    const syncActiveProfile = useAudioProfilesStore(state => state.syncActive);
    const commitSettings = useAudioSettingsStore(state => state.handleSetAudioEqualizerSettings);
    const commitEnabled = useAudioSettingsStore(state => state.handleSetAudioEqualizerEnabled);
    // What is heard: the listener's own settings, with a mod's curve over the gains while it plays (Folium 1.7).
    const settings = useMemo(
        () => resolveHeardAudioEqualizerSettings(ownSettings, modCurve, modCurveSuspended),
        [ownSettings, modCurve, modCurveSuspended],
    );
    const curveHeard = Boolean(modCurve) && !modCurveSuspended;
    const [tab, setTab] = useState<ConsoleTabId>('equalizer');
    const [draft, setDraft] = useState<AudioEqualizerSettings>(settings);
    const draftRef = useRef(draft);
    const mountedRef = useRef(false);

    const updateDraft = (next: AudioEqualizerSettings) => {
        draftRef.current = next;
        setDraft(next);
    };

    useEffect(() => {
        if (isOpen) {
            updateDraft({
                enabled: settings.enabled,
                gains: [...settings.gains],
                preset: settings.preset,
                effects: { ...settings.effects },
                customSlots: settings.customSlots.map(slot => ({ gains: [...slot.gains], effects: { ...slot.effects } })),
            });
        }
    }, [isOpen, settings]);

    // 只在窗口打开的那一下回到均衡器那一页。不能跟着 settings 一起跑：切换耳机方案会
    // 更新 settings，若在这里重置页签，人在压缩页切方案就会被弹回均衡页。
    useEffect(() => {
        if (isOpen) setTab('equalizer');
    }, [isOpen]);

    /*
     * The window is drawn only while the controls tab is up, and the tab can be switched away under it (a
     * Personal FM start, the now-playing card, a mod opening another tab), which leaves the open flag up and
     * every mod write refused `panel-open`. So going away closes it. A microtask later, and only if it did
     * not come back: development's StrictMode unmounts and remounts at once, and the "Audio effects" command
     * raises the flag before the window mounts.
     */
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            queueMicrotask(() => {
                if (!mountedRef.current) close();
            });
        };
    }, [close]);

    // Edits are always written into a custom slot: the active one, or the first while a built-in plays.
    const writeCustomDraft = (gains: number[], effects: AudioEffectSettings) => {
        const slotId: AudioEqualizerCustomSlotId = isAudioEqualizerCustomSlotId(draftRef.current.preset)
            ? draftRef.current.preset
            : AUDIO_EQUALIZER_CUSTOM_SLOT_IDS[0];
        const slotIndex = getAudioEqualizerCustomSlotIndex(slotId);
        updateDraft({
            ...draftRef.current,
            enabled: true,
            gains,
            effects,
            preset: slotId,
            customSlots: draftRef.current.customSlots.map((slot, index) => (
                index === slotIndex ? { gains: [...gains], effects: { ...effects } } : slot
            )),
        });
    };

    const updateBandDraft = (index: number, value: number) => {
        const gains = [...draftRef.current.gains];
        gains[index] = value;
        writeCustomDraft(gains, { ...draftRef.current.effects });
    };

    const updateEffectDraft = (id: AudioEffectId, value: number) => {
        writeCustomDraft([...draftRef.current.gains], { ...draftRef.current.effects, [id]: value });
    };

    const applyPreset = (presetId: AudioEqualizerModeId) => {
        const source = isAudioEqualizerCustomSlotId(presetId)
            ? draftRef.current.customSlots[getAudioEqualizerCustomSlotIndex(presetId)]
            : AUDIO_SOUND_PRESETS[presetId];
        const next: AudioEqualizerSettings = {
            ...draftRef.current,
            enabled: true,
            preset: presetId,
            gains: [...source.gains],
            effects: { ...source.effects },
        };
        updateDraft(next);
        commitSettings(next);
    };

    // Reset only ever clears a custom slot; the built-in presets are not editable, so nothing to undo.
    const resetActiveCustomSlot = () => {
        const slotId = isAudioEqualizerCustomSlotId(draftRef.current.preset) ? draftRef.current.preset : null;
        if (!slotId) return;

        const slotIndex = getAudioEqualizerCustomSlotIndex(slotId);
        const gains = [...AUDIO_SOUND_PRESETS.flat.gains];
        const effects = createNeutralAudioEffects();
        const next: AudioEqualizerSettings = {
            ...draftRef.current,
            gains,
            effects,
            customSlots: draftRef.current.customSlots.map((slot, index) => (
                index === slotIndex ? { gains: [...gains], effects: { ...effects } } : slot
            )),
        };
        updateDraft(next);
        commitSettings(next);
    };

    // The switch stops the processing and keeps every value.
    const setEnabled = (enabled: boolean) => {
        updateDraft({ ...draftRef.current, enabled });
        // Only the switch: a mod's curve stays, and nothing else in the draft is written by it.
        commitEnabled(enabled);
    };

    // While a mod's curve plays the bands and effects are read-only; this keeps a stray commit from writing it into a slot.
    // A let-go with nothing edited (a key, focus passing through, a press on a thumb) writes nothing either: any
    // write ends a curve on hold, and only an edit of the listener's own sound is meant to.
    const commitDraft = () => {
        if (curveHeard) return;
        if (areAudioEqualizerSettingsEqual(resolveAudioEqualizerSettings(draftRef.current), ownSettings)) return;
        commitSettings(draftRef.current);
    };

    // 关窗时把当前设置写回正在用的那套方案：下次切换拿到的就是最后一次听到的声音。
    const closeWindow = () => {
        syncActiveProfile();
        close();
    };

    return (
        <Sheet
            isOpen={isOpen}
            onClose={closeWindow}
            isDaylight={isDaylight}
            size="l"
            title={t('ui.consoleTitle')}
            subtitle={t('ui.consoleDescription')}
            headerActions={(
                // The switch takes its name from the label it sits in. A narrow window has no room for the words: they stay for a screen reader.
                <label className="flex cursor-pointer items-center gap-3">
                    <span className="whitespace-nowrap text-xs text-[color:var(--st-t2)] max-sm:sr-only">
                        {t(draft.enabled ? 'ui.equalizerEnabled' : 'ui.equalizerDisabled')}
                    </span>
                    <Toggle checked={draft.enabled} onChange={setEnabled} />
                </label>
            )}
        >
            {/* 这一层排窗口里的内容（至少和窗口一样高，多出的高度给推子），也让这扇对话框自己能被思索命中。
                标记仍叫 audio-equalizer：思索（ponder）的悬停目标按这个名字找，改名会让引导指不到窗口。 */}
            <div data-ponder="audio-equalizer" className="flex min-h-full flex-col">
                {/* 页签与方案都不吸顶，跟正文一起排、一起滚。窗口里没有常驻的横条，
                    也就不会有它盖住内容、或者底色和窗口对不上时透出正文的问题。

                    顺序按「先说明、再选页、最后细调」：方案条在最上（换耳机是整窗级的动作），
                    页签紧随其后，两者之间只留间距、不叠底色，看着是一层而不是两层。 */}
                <div className="flex flex-col gap-2 pb-1 pt-2">
                    <ProfileBar isDaylight={isDaylight} />
                    <ConsoleTabs
                        tab={tab}
                        options={[
                            { value: 'equalizer', label: t('ui.consoleTabEqualizer') },
                            { value: 'compressor', label: t('ui.consoleTabCompressor') },
                            { value: 'reverb', label: t('ui.consoleTabReverb') },
                            { value: 'postEq', label: t('ui.consoleTabPostEq') },
                            { value: 'saturation', label: t('ui.consoleTabSaturation') },
                        ]}
                        onTabChange={value => setTab(value as typeof tab)}
                    />
                </div>

                {tab === 'equalizer' && <ModCurveNotice />}

                {tab === 'equalizer' && (
                    <EqualizerPane
                        draft={draft}
                        curveHeard={curveHeard}
                        presetIds={PRESET_IDS}
                        onChoosePreset={applyPreset}
                        canReset={!curveHeard && isAudioEqualizerCustomSlotId(draft.preset)}
                        onReset={resetActiveCustomSlot}
                        onBandChange={updateBandDraft}
                        onEffectChange={updateEffectDraft}
                        onCommit={commitDraft}
                    />
                )}
                {tab === 'compressor' && <CompressorPane />}
                {tab === 'reverb' && <ReverbPane />}
                {tab === 'postEq' && <PostEqPane />}
                {tab === 'saturation' && <SaturationPane />}
            </div>
        </Sheet>
    );
};

export default AudioEqualizerDialog;
