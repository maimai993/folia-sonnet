import React from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { CROSSFADE_MAX_SEC, CROSSFADE_MIN_SEC } from '../../../../services/automix/crossfadePlanner';
import { modelsPresent, subscribeModelAvailability } from '../../../../services/analysis/modelAvailability';
import { transitionCapabilities } from '../../../../services/automix/stems';
import { announceTransition, type TransitionRenderer } from '../../../../services/automix/transitionCue';
import { canAnalyseTracks } from '../../../../services/automix/transitionStrategy';
import { useAudioSettingsStore } from '../../../../stores/useAudioSettingsStore';
import { useAutomixSettingsStore } from '../../../../stores/useAutomixSettingsStore';
import { useDesktopSettingsStore } from '../../../../stores/useDesktopSettingsStore';
import { runsOnWindows } from '../../../../utils/platform';
import { Button, Chips, Group, Reveal, Row, Segmented, Select, Slider, Status, Toggle, option, type SettingsGroupDef, type SettingsOptionDef } from '../kit';
import AudioOutputDeviceRow from './AudioOutputDeviceRow';
import HifiSettings, { HIFI_OPTIONS } from './hifi/HifiSettings';
import { useSettingsPage } from './settingsPageContext';

// src/components/modal/settings/pages/PlaybackPage.tsx
// The 播放控制 page: (desktop app) which engine plays local and Navidrome songs, Web Audio or mpv,
// with mpv's own settings under it (pages/hifi/); how one song hands over to the next (Folia
// transitions), where the sound goes and how loud it is, what play and add-to-queue do.

const TRANSITION: SettingsGroupDef = { id: 'transitionSettings', titleKey: 'options.transitionSettings' };
const SOUND: SettingsGroupDef = { id: 'audioOutputSettings', titleKey: 'options.settingsHeadingSound' };
const BEHAVIOR: SettingsGroupDef = { id: 'queueSettings', titleKey: 'options.settingsHeadingPlaybackBehavior' };

const O = {
    transition: option(TRANSITION, 'transitionEnable', 'options.transitionEnable'),
    mode: option(TRANSITION, 'transitionMode', 'options.transitionMode'),
    effect: option(TRANSITION, 'transitionEffect', 'options.transitionEffect'),
    intensity: option(TRANSITION, 'transitionIntensity', 'options.transitionIntensity'),
    crossfadeMax: option(TRANSITION, 'crossfadeMaxSeconds', 'options.crossfadeMaxSeconds'),
    performance: option(TRANSITION, 'transitionPerformance', 'options.transitionPerformance'),
    animation: option(TRANSITION, 'transitionAnimation', 'options.transitionAnimation'),
    animationRing: option(TRANSITION, 'transitionAnimationRing', 'options.transitionAnimationRing'),
    animationCard: option(TRANSITION, 'transitionAnimationCard', 'options.transitionAnimationCard'),
    outputDevice: option(SOUND, 'audioOutputDevice', 'options.audioOutputDevice'),
    replayGain: option(SOUND, 'replayGainSettings', 'options.replayGainMode'),
    fade: option(SOUND, 'playbackFade', 'options.playbackFade'),
    // 本 fork 只出安卓包，没有 PC 版，所以不再按平台隐藏这一项。
    mixWithOtherAudio: option(SOUND, 'mixWithOtherAudio', 'options.mixWithOtherAudio'),
    transcode: option(SOUND, 'transcodeFallback', 'options.transcodeFallback', { electronOnly: true }),
    queueBehavior: option(BEHAVIOR, 'queueDefaultBehavior', 'options.queueDefaultBehavior'),
    autoSkipUnplayable: option(BEHAVIOR, 'autoSkipUnplayable', 'options.autoSkipUnplayable'),
    shuffleRoundNoRepeat: option(BEHAVIOR, 'shuffleRoundNoRepeat', 'options.shuffleRoundNoRepeat'),
    preventSleep: option(BEHAVIOR, 'preventDisplaySleepDuringPlayback', 'options.preventDisplaySleepDuringPlayback', { electronOnly: true }),
    voiceInputPause: option(BEHAVIOR, 'voiceInputPause', 'options.voiceInputPause', { electronOnly: true, available: () => runsOnWindows() }),
};

/** 与原生 EffectId.wire 一一对应（android/.../TransitionStyle.kt）。改名要两边一起改。 */
const TRANSITION_EFFECTS = [
    'plainBlend', 'hardCut', 'fadeOutIn', 'plateauBlend',
    'bassSwap', 'threeBandSeam', 'filterSweepIn', 'vocalRecede',
    'beatCut', 'barAlignedBlend', 'tempoBend',
    'tailRide', 'echoThrow', 'reverbCarry',
    'buildUp', 'riserDrop', 'vinylBrake', 'reverseCrescendo',
] as const;

/** 强度四档。值是字符串（Segmented 只收 string），提交时再转回数字。 */
const TRANSITION_INTENSITIES = [
    { value: '0.25', labelKey: 'options.transitionIntensity_light' },
    { value: '0.5', labelKey: 'options.transitionIntensity_normal' },
    { value: '0.75', labelKey: 'options.transitionIntensity_strong' },
    { value: '1', labelKey: 'options.transitionIntensity_max' },
] as const;

export const OPTIONS: SettingsOptionDef[] = [...HIFI_OPTIONS, ...Object.values(O)];

/**
 * The pass an animation chip plays when it is switched on: a ten-second blend at 120 BPM, addressed
 * to the drawing that was switched on, so the other one does not play again with it.
 */
const previewCue = (renderer: TransitionRenderer) => (
    { seconds: 10, crossover: 0.55, periodSec: 0.5, preview: renderer } as const
);

const PlaybackPage: React.FC = () => {
    const { t } = useTranslation();
    const { isElectron, viewProps } = useSettingsPage();
    const { replayGainMode, onReplayGainModeChange, onAudioOutputDeviceChange } = viewProps.playback;
    const { voiceInputPause } = viewProps.lab;
    const automix = useAutomixSettingsStore(useShallow(state => ({
        enabled: state.automixEnabled,
        mode: state.transitionMode,
        crossfadeMaxSec: state.crossfadeMaxSec,
        performance: state.transitionPerformance,
        animationRing: state.transitionAnimation,
        animationCard: state.transitionAnimationCard,
        effect: state.transitionEffect,
        intensity: state.transitionIntensity,
        setEffect: state.handleSetTransitionEffect,
        setIntensity: state.handleSetTransitionIntensity,
        setEnabled: state.handleToggleAutomix,
        setMode: state.handleSetTransitionMode,
        setCrossfadeMaxSec: state.handleSetCrossfadeMaxSec,
        setPerformance: state.handleToggleTransitionPerformance,
        setAnimationRing: state.handleToggleTransitionAnimation,
        setAnimationCard: state.handleToggleTransitionAnimationCard,
    })));
    const audio = useAudioSettingsStore(useShallow(state => ({
        mediaCache: state.enableMediaCache,
        fade: state.playbackFadeEnabled,
        mixWithOtherAudio: state.mixWithOtherAudio,
        transcode: state.enableTranscodeFallback,
        queueBehavior: state.queueAddBehavior,
        autoSkipUnplayable: state.autoSkipUnplayable,
        shuffleRoundNoRepeat: state.shuffleRoundNoRepeat,
        setMediaCache: state.handleToggleMediaCache,
        setFade: state.handleTogglePlaybackFade,
        setMixWithOtherAudio: state.handleToggleMixWithOtherAudio,
        setTranscode: state.handleToggleTranscodeFallback,
        setQueueBehavior: state.handleSetQueueAddBehavior,
        setAutoSkipUnplayable: state.handleToggleAutoSkipUnplayable,
        setShuffleRoundNoRepeat: state.handleToggleShuffleRoundNoRepeat,
    })));
    const preventSleep = useDesktopSettingsStore(state => state.preventDisplaySleepDuringPlayback);
    const setPreventSleep = useDesktopSettingsStore(state => state.handleTogglePreventDisplaySleepDuringPlayback);

    // Asked on every render, not kept: whether the models are on disk can change while the page is
    // open, and the subscription below only makes the page render again when it does.
    React.useSyncExternalStore(subscribeModelAvailability, modelsPresent);
    const analysable = canAnalyseTracks();
    const capabilities = transitionCapabilities();
    const usesAutomix = automix.mode === 'automix';
    // Automix without a full engine says why in place of what Automix does.
    const modeHint = !usesAutomix
        ? t('options.transitionCrossfadeDesc')
        : !analysable || capabilities.full
            ? t('options.transitionAutomixDesc')
            : t(capabilities.desktop ? 'options.transitionEngineNeedsModels' : 'options.transitionEngineLiteDesc');

    // Switching a drawing on plays it once at once; otherwise it would wait for the next long blend.
    const animationChip = (def: SettingsOptionDef, renderer: TransitionRenderer, checked: boolean, set: (enabled: boolean) => void) => ({
        id: def.id,
        label: t(def.labelKey),
        checked,
        onChange: (next: boolean) => {
            set(next);
            if (next) announceTransition(previewCue(renderer));
        },
    });

    return (
        <>
            {isElectron && <HifiSettings />}
            <Group def={TRANSITION}>
                <Row option={O.transition}>
                    <Toggle checked={automix.enabled} onChange={automix.setEnabled} />
                </Row>
                <Reveal when={automix.enabled}>
                    <Row sub option={O.mode} hint={modeHint}>
                        {/* The mode that runs is not always the chosen one: Automix that cannot
                            measure a track runs as a crossfade, and without the models as the
                            lighter engine. */}
                        {usesAutomix && (analysable ? (
                            <Status tone={capabilities.full ? 'ok' : undefined}>
                                {t(capabilities.full ? 'options.transitionEngineFull' : 'options.transitionEngineLite')}
                            </Status>
                        ) : (
                            <Status tone="warn">{t('options.transitionFellBack')}</Status>
                        ))}
                        <Segmented
                            value={automix.mode}
                            options={[
                                { value: 'crossfade', label: t('options.transitionCrossfade') },
                                { value: 'automix', label: t('options.transitionAutomix'), disabled: !analysable },
                            ]}
                            onChange={automix.setMode}
                        />
                    </Row>
                    {/* 混音时长两个模式都显示：固定淡化是「就接这么久」，智能过渡是「最多这么久」。 */}
                    <Row
                        sub
                        option={O.crossfadeMax}
                        hint={usesAutomix ? t('options.crossfadeMaxAutomixDesc') : undefined}
                    >
                        <Slider
                            value={automix.crossfadeMaxSec}
                            min={CROSSFADE_MIN_SEC}
                            max={CROSSFADE_MAX_SEC}
                            onChange={automix.setCrossfadeMaxSec}
                            format={seconds => t('options.crossfadeSecondsValue', { seconds })}
                        />
                    </Row>
                    <Reveal when={usesAutomix}>
                        {!analysable && <Row sub notice={t('options.transitionAutomixUnavailable')} />}
                        <Reveal when={analysable && !audio.mediaCache}>
                            <Row sub notice={t('options.transitionAutomixNeedsCache')}>
                                <Button onClick={() => audio.setMediaCache(true)}>{t('options.transitionAutomixEnableCache')}</Button>
                            </Row>
                        </Reveal>
                        <Row sub option={O.effect} hint={t('options.transitionEffectDesc')}>
                            <Select
                                value={automix.effect ?? 'auto'}
                                options={[
                                    { value: 'auto', label: t('options.transitionEffectAuto') },
                                    ...TRANSITION_EFFECTS.map(effect => ({
                                        value: effect,
                                        label: t(`options.transitionEffect_${effect}`),
                                    })),
                                ]}
                                onChange={next => automix.setEffect(next === 'auto' ? null : next)}
                            />
                        </Row>
                        <Row sub option={O.intensity} hint={t('options.transitionIntensityDesc')}>
                            <Segmented
                                value={String(automix.intensity)}
                                options={TRANSITION_INTENSITIES.map(step => ({
                                    value: step.value,
                                    label: t(step.labelKey),
                                }))}
                                onChange={next => automix.setIntensity(Number(next))}
                            />
                        </Row>
                        {/* Kept in view when the app cannot separate a track: the reason is under the label. */}
                        <Row
                            sub
                            option={O.performance}
                            hint={t(capabilities.stems
                                ? 'options.transitionPerformanceDesc'
                                : capabilities.desktop ? 'options.transitionPerformanceNeedsModel' : 'options.transitionPerformanceNeedsStems')}
                            disabled={!capabilities.stems}
                        >
                            <Toggle checked={automix.performance && capabilities.stems} onChange={automix.setPerformance} />
                        </Row>
                        <Row
                            sub
                            option={O.animation}
                            hint={t('options.transitionAnimationDesc')}
                            note={(
                                <>
                                    <span className="text-[color:var(--st-t1)]">{t('options.transitionAnimationRing')}</span> {t('options.transitionAnimationRingDesc')}
                                    <br />
                                    <span className="text-[color:var(--st-t1)]">{t('options.transitionAnimationCard')}</span> {t('options.transitionAnimationCardDesc')}
                                </>
                            )}
                        >
                            <Chips
                                items={[
                                    animationChip(O.animationRing, 'ring', automix.animationRing, automix.setAnimationRing),
                                    animationChip(O.animationCard, 'card', automix.animationCard, automix.setAnimationCard),
                                ]}
                            />
                        </Row>
                    </Reveal>
                </Reveal>
            </Group>

            <Group def={SOUND}>
                <AudioOutputDeviceRow option={O.outputDevice} onDeviceChange={onAudioOutputDeviceChange} />
                <Row option={O.replayGain} note={t('options.replayGainModeDesc')}>
                    <Segmented
                        value={replayGainMode}
                        options={[
                            { value: 'off', label: t('localMusic.replayGainOff') },
                            { value: 'auto', label: t('localMusic.replayGainAuto') },
                            { value: 'track', label: t('localMusic.replayGainTrack') },
                            { value: 'album', label: t('localMusic.replayGainAlbum') },
                        ]}
                        onChange={onReplayGainModeChange}
                    />
                </Row>
                <Row option={O.fade} hint={t('options.playbackFadeDesc')}>
                    <Toggle checked={audio.fade} onChange={audio.setFade} />
                </Row>
                {/*
                 * 「与其他音源同时播放」：后台被别的应用抢走音频焦点时继续放，并自动接回来。
                 * ★ 必须有这一行：选项进了 OPTIONS 就进了搜索索引，只声明不渲染会让搜索结果
                 *   点过来是一片空气（#419 反馈）。
                 */}
                <Row option={O.mixWithOtherAudio} hint={t('options.mixWithOtherAudioDesc')}>
                    <Toggle checked={audio.mixWithOtherAudio} onChange={audio.setMixWithOtherAudio} />
                </Row>
                {window.electron?.requestTranscodeFallback && (
                    <Row option={O.transcode} hint={t('options.transcodeFallbackDesc')}>
                        <Toggle checked={audio.transcode} onChange={audio.setTranscode} />
                    </Row>
                )}
            </Group>

            <Group def={BEHAVIOR}>
                <Row option={O.queueBehavior}>
                    <Segmented
                        value={audio.queueBehavior}
                        options={[
                            { value: 'append', label: t('options.queueAppendLabel') },
                            { value: 'next', label: t('options.queueNextLabel') },
                        ]}
                        onChange={audio.setQueueBehavior}
                    />
                </Row>
                <Row option={O.autoSkipUnplayable} note={t('options.autoSkipUnplayableDesc')}>
                    <Toggle checked={audio.autoSkipUnplayable} onChange={audio.setAutoSkipUnplayable} />
                </Row>
                <Row option={O.shuffleRoundNoRepeat} note={t('options.shuffleRoundNoRepeatDesc')}>
                    <Toggle checked={audio.shuffleRoundNoRepeat} onChange={audio.setShuffleRoundNoRepeat} />
                </Row>
                {isElectron && (
                    <Row option={O.preventSleep} hint={t('options.preventDisplaySleepDuringPlaybackDesc')}>
                        <Toggle checked={preventSleep} onChange={setPreventSleep} />
                    </Row>
                )}
                {voiceInputPause.supported && (
                    <Row option={O.voiceInputPause} hint={t('options.voiceInputPauseDesc')}>
                        <Toggle checked={voiceInputPause.enabled} onChange={voiceInputPause.onToggle} />
                    </Row>
                )}
            </Group>
        </>
    );
};

export default PlaybackPage;
