import React from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { CROSSFADE_MAX_SEC, CROSSFADE_MIN_SEC } from '../../../../services/automix/crossfadePlanner';
import { modelsPresent, subscribeModelAvailability } from '../../../../services/analysis/modelAvailability';
import { ANALYSIS_MODELS_ENABLED, modelStoreSnapshot, subscribeModelStore, importModelFile, type DownloadableModel } from '../../../../services/analysis/modelStore';
import { transitionCapabilities } from '../../../../services/automix/stems';
import { announceTransition, type TransitionRenderer } from '../../../../services/automix/transitionCue';
import { canAnalyseTracks } from '../../../../services/automix/transitionStrategy';
import { useAudioSettingsStore } from '../../../../stores/useAudioSettingsStore';
import { useAnalysisModelStore } from '../../../../stores/useAnalysisModelStore';
import { useAutomixSettingsStore } from '../../../../stores/useAutomixSettingsStore';
import { useDesktopSettingsStore } from '../../../../stores/useDesktopSettingsStore';
import { isCapacitorAndroid } from '../../../../platform/runtime';
import { isNativePlayerAvailable } from '../../../../services/playbackEngine/nativePlayerPlugin';
import { runsOnWindows } from '../../../../utils/platform';
import { Button, Chips, Group, Reveal, Row, Segmented, Slider, Status, Toggle, option, type SettingsGroupDef, type SettingsOptionDef } from '../kit';
import AudioOutputDeviceRow from './AudioOutputDeviceRow';
import AndroidPlaybackAutoLandscapeSetting from '../AndroidPlaybackAutoLandscapeSetting';
import { useSettingsPage } from './settingsPageContext';
import { TextField } from '@/components/ui';

// src/components/modal/settings/pages/PlaybackPage.tsx
// The 播放控制 page: how one song hands over to the next (Folia transitions), where the sound goes
// and how loud it is, what play and add-to-queue do, and (desktop app) the folded group of the
// analysis models the full transition engine needs.

const TRANSITION: SettingsGroupDef = { id: 'transitionSettings', titleKey: 'options.transitionSettings' };
const SOUND: SettingsGroupDef = { id: 'audioOutputSettings', titleKey: 'options.settingsHeadingSound' };
const BEHAVIOR: SettingsGroupDef = { id: 'queueSettings', titleKey: 'options.settingsHeadingPlaybackBehavior' };
/*
 * 分析模型：不随包，从 CDN 取，所以这里既是开关也是它唯一的可见状态。
 *
 * 两个模型各服务两处（beat_this：automix 的节拍网格 + 智能动感模式的节拍；htdemucs：automix 的
 * 分轨 + 智能动感模式的鼓点），所以分开给开关 —— 41MB 的节拍不是 92MB 的分轨那种请求。
 *
 * available 挂着总开关：整组不画，搜索也不索引这两行（isDrawnHere 会问）。跟着总开关而不是各写
 * 一遍，是为了关掉的时候不留下「搜得到、点进去什么都没有」的条目。
 */
const MODELS: SettingsGroupDef = { id: 'analysisModels', titleKey: 'options.analysisModels', available: () => ANALYSIS_MODELS_ENABLED };

const O = {
    transition: option(TRANSITION, 'transitionEnable', 'options.transitionEnable'),
    mode: option(TRANSITION, 'transitionMode', 'options.transitionMode'),
    crossfadeMax: option(TRANSITION, 'crossfadeMaxSeconds', 'options.crossfadeMaxSeconds'),
    performance: option(TRANSITION, 'transitionPerformance', 'options.transitionPerformance'),
    animation: option(TRANSITION, 'transitionAnimation', 'options.transitionAnimation'),
    animationRing: option(TRANSITION, 'transitionAnimationRing', 'options.transitionAnimationRing'),
    animationCard: option(TRANSITION, 'transitionAnimationCard', 'options.transitionAnimationCard'),
    outputDevice: option(SOUND, 'audioOutputDevice', 'options.audioOutputDevice'),
    replayGain: option(SOUND, 'replayGainSettings', 'options.replayGainMode'),
    fade: option(SOUND, 'playbackFade', 'options.playbackFade'),
    transcode: option(SOUND, 'transcodeFallback', 'options.transcodeFallback', { electronOnly: true }),
    /*
     * 后台播放时别的应用一出声，系统就把 WebView 持有的音频焦点收走，Chromium 于是直接
     * 把 <audio> 暂停 —— 界面显示「正在播」却没声音（用户原话：「无法正常唤醒」）。
     * 开着这一项，被打断后自动接回去，并让原生那一层给出「同时播放」的焦点策略。
     *
     * 只在安卓出现：音频焦点是安卓的概念，桌面端没有对应的开关。
     */
    mixWithOtherAudio: option(SOUND, 'mixWithOtherAudio', 'options.mixWithOtherAudio', { available: isCapacitorAndroid }),
    /*
     * 原生播放（P1）：音频改由 ExoPlayer 出声，不再走 WebView 的 `<audio>`。
     *
     * 只在**原生播放器真的编进这个包**时出现（`isNativePlayerAvailable`）—— 桌面端与还没
     * 带上这一层的包里，这一行既不画也不被搜索索引。说明走 noteKey（收进「i」）：
     * fork 自建的行一律不占 label 下面那块地方。
     */
    nativePlayback: option(SOUND, 'nativePlayback', 'options.nativePlayback', {
        available: isNativePlayerAvailable,
        noteKey: 'options.nativePlaybackNote',
    }),
    queueBehavior: option(BEHAVIOR, 'queueDefaultBehavior', 'options.queueDefaultBehavior'),
    autoSkipUnplayable: option(BEHAVIOR, 'autoSkipUnplayable', 'options.autoSkipUnplayable'),
    preventSleep: option(BEHAVIOR, 'preventDisplaySleepDuringPlayback', 'options.preventDisplaySleepDuringPlayback', { electronOnly: true }),
    voiceInputPause: option(BEHAVIOR, 'voiceInputPause', 'options.voiceInputPause', { electronOnly: true, available: () => runsOnWindows() }),
    modelBeatThis: option(MODELS, 'analysisModelBeatThis', 'options.analysisModelBeatThis', { noteKey: 'options.analysisModelBeatThisDesc', available: () => ANALYSIS_MODELS_ENABLED }),
    modelHtdemucs: option(MODELS, 'analysisModelHtdemucs', 'options.analysisModelHtdemucs', { noteKey: 'options.analysisModelHtdemucsDesc', available: () => ANALYSIS_MODELS_ENABLED }),
};

export const OPTIONS: SettingsOptionDef[] = Object.values(O);

/**
 * The pass an animation chip plays when it is switched on: a ten-second blend at 120 BPM, addressed
 * to the drawing that was switched on, so the other one does not play again with it.
 */
const previewCue = (renderer: TransitionRenderer) => (
    { seconds: 10, crossover: 0.55, periodSec: 0.5, preview: renderer } as const
);

/**
 * One model's row: the switch is the listener's wish, and the words under it are what is actually
 * there - modelStore's answer, read live rather than kept, because a download is still moving while
 * this page is open.
 */
const AnalysisModelRow: React.FC<{ def: SettingsOptionDef; name: DownloadableModel }> = ({ def, name }) => {
    const { t } = useTranslation();
    const wanted = useAnalysisModelStore(state => state[name]);
    const setWanted = useAnalysisModelStore(state => state.handleSetModelWanted);
    const entry = React.useSyncExternalStore(subscribeModelStore, modelStoreSnapshot)[name];
    const fileInput = React.useRef<HTMLInputElement>(null);

    const hint = entry.phase === 'ready'
        ? t('options.analysisModelReady')
        : entry.phase === 'downloading'
            ? t('options.analysisModelDownloading', { percent: Math.round(entry.progress * 100) })
            : entry.phase === 'error'
                ? entry.error ?? t('options.analysisModelFailed')
                : entry.phase === 'checking'
                    ? t('options.analysisModelChecking')
                    : t('options.analysisModelOff');

    // Absent and failed both take the same press, and both are the states a switch on its own cannot
    // act on: absent has not been asked for yet, and after a failure the switch is already on, so the
    // row has to offer another go rather than sit there naming what went wrong. Only the wording
    // differs - "download" the first time, "try again" after one.
    const canFetch = entry.phase === 'absent' || entry.phase === 'error';

    /**
     * Takes the weights from a file the listener picked. For a CDN this build cannot reach, or one
     * they would rather not wait on: the same file either way, checked the same way.
     */
    const takeFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const picked = event.target.files?.[0];
        // Cleared before the read, so choosing the same file twice in a row still fires a change.
        event.target.value = '';
        if (!picked) return;
        const ok = await importModelFile(name, await picked.arrayBuffer());
        // The switch has to agree with what is on disk: a file sitting there under a switch that says
        // it is not wanted is a pair that answers nothing the next time someone asks.
        if (ok) setWanted(name, true);
    };

    return (
        <Row option={def} hint={hint}>
            <Toggle checked={wanted} onChange={next => setWanted(name, next)} />
            {canFetch && (
                <Button onClick={() => setWanted(name, true)}>
                    {t(entry.phase === 'error' ? 'options.analysisModelRetry' : 'options.analysisModelDownload')}
                </Button>
            )}
            {entry.phase === 'downloading' && (
                <Button variant="quiet" disabled>{t('options.analysisModelDownloading', { percent: Math.round(entry.progress * 100) })}</Button>
            )}
            {entry.phase === 'ready' && (
                // Gives the space back without having to find the switch's meaning in a row that
                // already says it is there.
                <Button variant="quiet" onClick={() => setWanted(name, false)}>{t('options.analysisModelDelete')}</Button>
            )}
            {entry.phase !== 'downloading' && (
                <Button variant="quiet" onClick={() => fileInput.current?.click()}>{t('options.analysisModelImport')}</Button>
            )}
            {/* Not a file picker of our own make: the system's, so it can reach wherever the listener
                put the file. Hidden, and pressed by the button above. */}
            <TextField ref={fileInput} type="file" accept="*/*" className="hidden" onChange={event => void takeFile(event)} />
        </Row>
    );
};

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
        transcode: state.enableTranscodeFallback,
        queueBehavior: state.queueAddBehavior,
        autoSkipUnplayable: state.autoSkipUnplayable,
        mixWithOtherAudio: state.mixWithOtherAudio,
        nativePlayback: state.nativePlaybackEnabled,
        setMediaCache: state.handleToggleMediaCache,
        setFade: state.handleTogglePlaybackFade,
        setTranscode: state.handleToggleTranscodeFallback,
        setQueueBehavior: state.handleSetQueueAddBehavior,
        setAutoSkipUnplayable: state.handleToggleAutoSkipUnplayable,
        setMixWithOtherAudio: state.handleToggleMixWithOtherAudio,
        setNativePlayback: state.handleToggleNativePlayback,
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
                    <Reveal when={!usesAutomix}>
                        <Row sub option={O.crossfadeMax}>
                            <Slider
                                value={automix.crossfadeMaxSec}
                                min={CROSSFADE_MIN_SEC}
                                max={CROSSFADE_MAX_SEC}
                                onChange={automix.setCrossfadeMaxSec}
                                format={seconds => t('options.crossfadeSecondsValue', { seconds })}
                            />
                        </Row>
                    </Reveal>
                    <Reveal when={usesAutomix}>
                        {!analysable && <Row sub notice={t('options.transitionAutomixUnavailable')} />}
                        <Reveal when={analysable && !audio.mediaCache}>
                            <Row sub notice={t('options.transitionAutomixNeedsCache')}>
                                <Button onClick={() => audio.setMediaCache(true)}>{t('options.transitionAutomixEnableCache')}</Button>
                            </Row>
                        </Reveal>
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
                            { value: 'track', label: t('localMusic.replayGainTrack') },
                            { value: 'album', label: t('localMusic.replayGainAlbum') },
                        ]}
                        onChange={onReplayGainModeChange}
                    />
                </Row>
                <Row option={O.fade} hint={t('options.playbackFadeDesc')}>
                    <Toggle checked={audio.fade} onChange={audio.setFade} />
                </Row>
                {window.electron?.requestTranscodeFallback && (
                    <Row option={O.transcode} hint={t('options.transcodeFallbackDesc')}>
                        <Toggle checked={audio.transcode} onChange={audio.setTranscode} />
                    </Row>
                )}
                {/* 安卓的音频焦点那一层才有这件事，桌面端整行不显示（见 O.mixWithOtherAudio）。 */}
                {isCapacitorAndroid() && (
                    <Row option={O.mixWithOtherAudio} note={t('options.mixWithOtherAudioDesc')}>
                        <Toggle checked={audio.mixWithOtherAudio} onChange={audio.setMixWithOtherAudio} />
                    </Row>
                )}
                {isNativePlayerAvailable() && (
                    <Row option={O.nativePlayback}>
                        <Toggle checked={audio.nativePlayback} onChange={audio.setNativePlayback} />
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
                {/* 「进入可视化自动横屏」是播放行为而不是外观：它只在播放页生效、离开就转回，
                    和上面几行同属「播放时怎么表现」，放在这里比塞进「外观 → 显示」好找。
                    组件内部自己判端，非安卓返回 null。 */}
                <AndroidPlaybackAutoLandscapeSetting />
            </Group>

            {/* The whole group answers to ANALYSIS_MODELS_ENABLED, same as the rows inside it say:
                while the models are not offered there is nothing here to draw or to offer. */}
            {ANALYSIS_MODELS_ENABLED && (
                <Group def={MODELS} foot={t('options.analysisModelsFoot')}>
                    <AnalysisModelRow def={O.modelBeatThis} name="beat_this" />
                    <AnalysisModelRow def={O.modelHtdemucs} name="htdemucs" />
                </Group>
            )}
        </>
    );
};

export default PlaybackPage;
