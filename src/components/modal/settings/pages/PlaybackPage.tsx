import React from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { CROSSFADE_MAX_SEC, CROSSFADE_MIN_SEC } from '../../../../services/automix/crossfadePlanner';
import { modelsPresent, subscribeModelAvailability } from '../../../../services/analysis/modelAvailability';
import { ANALYSIS_MODELS_ENABLED, modelStoreSnapshot, subscribeModelStore, importModelFile, type DownloadableModel } from '../../../../services/analysis/modelStore';
import { useAudioSettingsStore } from '../../../../stores/useAudioSettingsStore';
import { useAnalysisModelStore } from '../../../../stores/useAnalysisModelStore';
import { useAutomixSettingsStore } from '../../../../stores/useAutomixSettingsStore';
import { useDesktopSettingsStore } from '../../../../stores/useDesktopSettingsStore';
import { isCapacitorAndroid } from '../../../../platform/runtime';

import { runsOnWindows } from '../../../../utils/platform';
import { Button, Group, Reveal, Row, Segmented, Slider, Toggle, option, type SettingsGroupDef, type SettingsOptionDef } from '../kit';
import AudioOutputDeviceRow from './AudioOutputDeviceRow';
import AndroidAutoLandscapeSetting from '../AndroidAutoLandscapeSetting';
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

/*
 * 过渡只剩 crossfade 一档。
 *
 * AutoMix（那种按节拍对齐、能上分轨的过渡）与它那一组开关（性能档、过渡动画）已经删掉：
 * 出声交给原生 ExoPlayer 之后，这些都是 Web Audio 图上的东西，开关在那儿也只是空跑。
 * crossfade 与暂停 / 继续的淡化改由原生做音量斜坡（见 FoliaNativePlayer）。
 */
const O = {
    transition: option(TRANSITION, 'transitionEnable', 'options.transitionEnable'),
    crossfadeMax: option(TRANSITION, 'crossfadeMaxSeconds', 'options.crossfadeMaxSeconds'),
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
     * 原生播放（P1）不再有开关：安卓上恒开，出声交给 ExoPlayer。
     *
     * 原来这一行是「原生播放（实验）」，它留了一条「一半歌走原生、一半走网页」的岔路
     * —— 同一个 bug 在两种音频栈上表现不同，最难复现。现在没有岔路可选。
     * 已知代价（均衡器 / 音效 / 淡入淡出 / 频谱失效）写在 useAudioSettingsStore 的注释里。
     */
    queueBehavior: option(BEHAVIOR, 'queueDefaultBehavior', 'options.queueDefaultBehavior'),
    autoSkipUnplayable: option(BEHAVIOR, 'autoSkipUnplayable', 'options.autoSkipUnplayable'),
    backgroundSilentSkip: option(BEHAVIOR, 'backgroundSilentSkip', 'options.backgroundSilentSkip', {
        noteKey: 'options.backgroundSilentSkipDesc',
        available: isCapacitorAndroid,
    }),
    preventSleep: option(BEHAVIOR, 'preventDisplaySleepDuringPlayback', 'options.preventDisplaySleepDuringPlayback', { electronOnly: true }),
    voiceInputPause: option(BEHAVIOR, 'voiceInputPause', 'options.voiceInputPause', { electronOnly: true, available: () => runsOnWindows() }),
    /*
     * 「进入可视化自动横屏」：只在播放页生效、离开就还回去，属于「播放时怎么表现」，
     * 所以放在播放行为组里，不在外观。判定在原生（PhoneLayoutOrientation.resolve），
     * 这里只是一行开关。
     */
    autoLandscapeForVisualizer: option(BEHAVIOR, 'autoLandscapeForVisualizer', 'options.autoLandscapeForVisualizer', {
        noteKey: 'options.autoLandscapeForVisualizerDesc',
        available: isCapacitorAndroid,
    }),
    modelBeatThis: option(MODELS, 'analysisModelBeatThis', 'options.analysisModelBeatThis', { noteKey: 'options.analysisModelBeatThisDesc', available: () => ANALYSIS_MODELS_ENABLED }),
    modelHtdemucs: option(MODELS, 'analysisModelHtdemucs', 'options.analysisModelHtdemucs', { noteKey: 'options.analysisModelHtdemucsDesc', available: () => ANALYSIS_MODELS_ENABLED }),
};

export const OPTIONS: SettingsOptionDef[] = Object.values(O);

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
        crossfadeMaxSec: state.crossfadeMaxSec,
        setEnabled: state.handleToggleAutomix,
        setCrossfadeMaxSec: state.handleSetCrossfadeMaxSec,
    })));
    const audio = useAudioSettingsStore(useShallow(state => ({
        mediaCache: state.enableMediaCache,
        fade: state.playbackFadeEnabled,
        transcode: state.enableTranscodeFallback,
        queueBehavior: state.queueAddBehavior,
        autoSkipUnplayable: state.autoSkipUnplayable,
        backgroundSilentSkip: state.backgroundSilentSkip,
        mixWithOtherAudio: state.mixWithOtherAudio,
        setMediaCache: state.handleToggleMediaCache,
        setFade: state.handleTogglePlaybackFade,
        setTranscode: state.handleToggleTranscodeFallback,
        setQueueBehavior: state.handleSetQueueAddBehavior,
        setAutoSkipUnplayable: state.handleToggleAutoSkipUnplayable,
        setBackgroundSilentSkip: state.handleToggleBackgroundSilentSkip,
        setMixWithOtherAudio: state.handleToggleMixWithOtherAudio,
    })));
    const preventSleep = useDesktopSettingsStore(state => state.preventDisplaySleepDuringPlayback);
    const setPreventSleep = useDesktopSettingsStore(state => state.handleTogglePreventDisplaySleepDuringPlayback);

    // Asked on every render, not kept: whether the models are on disk can change while the page is
    // open, and the subscription below only makes the page render again when it does.
    React.useSyncExternalStore(subscribeModelAvailability, modelsPresent);

    return (
        <>
            <Group def={TRANSITION}>
                <Row option={O.transition}>
                    <Toggle checked={automix.enabled} onChange={automix.setEnabled} />
                </Row>
                <Reveal when={automix.enabled}>
                    {/* 只剩 crossfade 一档，所以「过渡要淡多久」直接跟着开关出现，
                        不再挂在「选了哪个模式」下面。 */}
                    <Row sub option={O.crossfadeMax} hint={t('options.transitionCrossfadeDesc')}>
                        <Slider
                            value={automix.crossfadeMaxSec}
                            min={CROSSFADE_MIN_SEC}
                            max={CROSSFADE_MAX_SEC}
                            onChange={automix.setCrossfadeMaxSec}
                            format={seconds => t('options.crossfadeSecondsValue', { seconds })}
                        />
                    </Row>
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
                {isCapacitorAndroid() && (
                    <Row option={O.backgroundSilentSkip} note={t('options.backgroundSilentSkipDesc')}>
                        <Toggle checked={audio.backgroundSilentSkip} onChange={audio.setBackgroundSilentSkip} />
                    </Row>
                )}
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
                {/* 组件内部自己判端：非安卓返回 null。 */}
                <AndroidAutoLandscapeSetting def={O.autoLandscapeForVisualizer} />
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
