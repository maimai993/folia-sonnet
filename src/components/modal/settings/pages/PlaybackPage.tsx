import React from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { CROSSFADE_CURVES, CROSSFADE_MAX_SEC, CROSSFADE_MIN_SEC, type CrossfadeCurve } from '../../../../services/automix/crossfadePlanner';
import { modelsPresent, subscribeModelAvailability } from '../../../../services/analysis/modelAvailability';
import { isNativeModelsAvailable, modelCanRun, subscribeModelAvailability as subscribeNativeModels } from '../../../../services/automix/nativeModels';
import { ANALYSIS_MODELS_ENABLED, modelStoreSnapshot, subscribeModelStore, importModelFile, type DownloadableModel } from '../../../../services/analysis/modelStore';
import { useAudioSettingsStore } from '../../../../stores/useAudioSettingsStore';
import { useAnalysisModelStore } from '../../../../stores/useAnalysisModelStore';
import { useAutomixSettingsStore } from '../../../../stores/useAutomixSettingsStore';
import { useDesktopSettingsStore } from '../../../../stores/useDesktopSettingsStore';
import { isAndroidAppShell, isCapacitorAndroid } from '../../../../platform/runtime';

import { runsOnWindows } from '../../../../utils/platform';
import { Button, Group, Reveal, Row, Segmented, Select, Slider, Toggle, option, type SettingsGroupDef, type SettingsOptionDef } from '../kit';
import AudioOutputDeviceRow from './AudioOutputDeviceRow';
import NativeModelsSection from '../NativeModelsSection';
import AndroidAutoLandscapeSetting from '../AndroidAutoLandscapeSetting';
import AndroidKeepAliveSetting from '../AndroidKeepAliveSetting';
import HifiSettings, { HIFI_OPTIONS } from './hifi/HifiSettings';
import { useSettingsPage } from './settingsPageContext';
import { TextField } from '@/components/ui';

// src/components/modal/settings/pages/PlaybackPage.tsx
// The 播放控制 page: (desktop app) which engine plays local and Navidrome songs, Web Audio or mpv,
// with mpv's own settings under it (pages/hifi/); how one song hands over to the next (Folia
// transitions), where the sound goes and how loud it is, what play and add-to-queue do.

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
 *
 * 上面那段是 Web 侧 AutoMix 退场时的原话，保留着当历史。现在安卓上多了一层东西：
 * player/transition/ 里的原生内核接管了换歌，它不依赖 Web Audio，所以「智能过渡」这一档
 * 在安卓是可用的 —— 档位、接法、强度、表现手势、增强包这五行只在安卓画（见下面的
 * androidSmart），桌面端仍是固定交叉淡化，一行没变。
 */

/** 18 种接法的顺序与原生 EffectCatalog.ALL 一致：分组连在一起，Select 里读起来成块。 */
const EFFECT_IDS = [
    'plainBlend', 'hardCut', 'fadeOutIn', 'plateauBlend',
    'bassSwap', 'threeBandSeam', 'filterSweepIn', 'vocalRecede',
    'beatCut', 'barAlignedBlend', 'tempoBend',
    'tailRide', 'echoThrow', 'reverbCarry',
    'buildUp', 'riserDrop', 'vinylBrake', 'reverseCrescendo',
] as const;

/** 强度四档：值用字符串是因为 Segmented 只吃 string，取用时再 Number 回去。 */
const INTENSITY_LEVELS = [
    { value: '0.25', labelKey: 'options.transitionIntensity_light' },
    { value: '0.5', labelKey: 'options.transitionIntensity_normal' },
    { value: '0.75', labelKey: 'options.transitionIntensity_strong' },
    { value: '1', labelKey: 'options.transitionIntensity_max' },
] as const;

const O = {
    transition: option(TRANSITION, 'transitionEnable', 'options.transitionEnable'),
    crossfadeMax: option(TRANSITION, 'crossfadeMaxSeconds', 'options.crossfadeMaxSeconds'),
    crossfadeCurve: option(TRANSITION, 'crossfadeCurve', 'options.crossfadeCurve'),
    handoffMode: option(TRANSITION, 'handoffMode', 'options.handoffMode'),
    transitionEffect: option(TRANSITION, 'transitionEffect', 'options.transitionEffect'),
    transitionIntensity: option(TRANSITION, 'transitionIntensity', 'options.transitionIntensity'),
    transitionPerformance: option(TRANSITION, 'transitionPerformance', 'options.transitionPerformance'),
    /*
     * 过渡动画：混音时把这次过渡画出来（屏幕圆环 / 卡片描边）。
     *
     * 这两项在 store 里一直有完整的读写实现，但设置页里曾经没有入口 ——
     * 于是它们只能靠导入配置或别处的默认值决定，用户改不了。
     * 现在补回来，跟着「智能过渡」一起展开。
     */
    transitionAnimation: option(TRANSITION, 'transitionAnimation', 'options.transitionAnimation'),
    transitionAnimationCard: option(TRANSITION, 'transitionAnimationCard', 'options.transitionAnimationCard'),
    transitionEnhancer: option(TRANSITION, 'transitionEnhancer', 'options.transitionEnhancer'),
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
    /*
     * 后台运行（保活）：一行业务体检 + 两个跳转按钮，不是开关。
     *
     * 它读的是系统的真实状态（电池优化白名单），并把用户送到各家 ROM 的自启动 / 耗电页。
     * 应用侧没有任何办法自己拿到这些授权 —— 所以这一行不承诺「打开就不断」，只负责
     * 把路铺到用户面前，并如实显示现在过没过。
     */
    keepAlive: option(BEHAVIOR, 'keepAlive', 'options.keepAlive', {
        noteKey: 'options.keepAliveDesc',
        available: isCapacitorAndroid,
    }),
    modelBeatThis: option(MODELS, 'analysisModelBeatThis', 'options.analysisModelBeatThis', { noteKey: 'options.analysisModelBeatThisDesc', available: () => ANALYSIS_MODELS_ENABLED }),
    modelHtdemucs: option(MODELS, 'analysisModelHtdemucs', 'options.analysisModelHtdemucs', { noteKey: 'options.analysisModelHtdemucsDesc', available: () => ANALYSIS_MODELS_ENABLED }),
};

export const OPTIONS: SettingsOptionDef[] = [...HIFI_OPTIONS, ...Object.values(O)];

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
        crossfadeCurve: state.crossfadeCurve,
        nativeMode: state.nativeTransitionMode,
        effect: state.transitionEffect,
        intensity: state.transitionIntensity,
        performance: state.transitionPerformance,
        animation: state.transitionAnimation,
        animationCard: state.transitionAnimationCard,
        enhancer: state.transitionEnhancer,
        setEnabled: state.handleToggleAutomix,
        setCrossfadeMaxSec: state.handleSetCrossfadeMaxSec,
        setCrossfadeCurve: state.handleSetCrossfadeCurve,
        setNativeMode: state.handleSetNativeTransitionMode,
        setEffect: state.handleSetTransitionEffect,
        setIntensity: state.handleSetTransitionIntensity,
        setPerformance: state.handleToggleTransitionPerformance,
        setAnimation: state.handleToggleTransitionAnimation,
        setAnimationCard: state.handleToggleTransitionAnimationCard,
        setEnhancer: state.handleToggleTransitionEnhancer,
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

    /*
     * 分轨模型能不能跑。
     *
     * 两条来源分开问：安卓问原生（内置在包里），桌面问 WebGPU 那一套。
     * 上层只关心结果，所以这里压成一个布尔值。
     */
    const nativeStems = React.useSyncExternalStore(
        subscribeNativeModels,
        () => (isNativeModelsAvailable() ? modelCanRun('htdemucs') : false),
        () => false,
    );
    const wgslStems = React.useSyncExternalStore(subscribeModelAvailability, modelsPresent, modelsPresent).htdemucs_gpu;
    const stemModelReady = isNativeModelsAvailable() ? nativeStems : wgslStems;

    /*
     * 原生过渡内核只在安卓的壳里。桌面端没有这个内核，两档都是老的固定交叉淡化，
     * 所以这里用一对方便读的布尔值把「有没有这层东西」和「它现在是不是智能档」分开，
     * 下面的条件就不是一串混在一起的平台判断。
     *
     * 用 isAndroidAppShell 而不是 isCapacitorAndroid：前者不依赖 Capacitor 桥
     * 初始化完（后者在启动头几秒会答 false）。用错的话设置页刚打开时
     * 整块原生选项都不画，看起来就是「这些开关没了」——
     * 而它们只是还没到能回答的时机。
     */
    const hasNativeHandoff = isAndroidAppShell();
    const smartHandoff = hasNativeHandoff && automix.nativeMode === 'smart';

    return (
        <>
            {isElectron && <HifiSettings />}
            <Group def={TRANSITION}>
                <Row option={O.transition}>
                    <Toggle checked={automix.enabled} onChange={automix.setEnabled} />
                </Row>
                <Reveal when={automix.enabled}>
                    {/* 安卓：换歌方式。桌面端整行不画，那里只有固定淡化一种。 */}
                    {hasNativeHandoff && (
                        <Row sub option={O.handoffMode} hint={t('options.handoffModeDesc')}>
                            <Segmented
                                value={automix.nativeMode}
                                options={[
                                    { value: 'crossfade' as const, label: t('options.handoffMode_crossfade') },
                                    { value: 'smart' as const, label: t('options.handoffMode_smart') },
                                ]}
                                onChange={automix.setNativeMode}
                            />
                        </Row>
                    )}
                    {/* 接法：18 种，末尾的「自动」放在最前面 —— 绝大多数人用这一项。 */}
                    {smartHandoff && (
                        <Row sub option={O.transitionEffect} hint={t('options.transitionEffectDesc')}>
                            <Select
                                value={automix.effect ?? 'auto'}
                                options={[
                                    { value: 'auto', label: t('options.transitionEffectAuto') },
                                    ...EFFECT_IDS.map(id => ({ value: id as string, label: t(`options.transitionEffect_${id}`) })),
                                ]}
                                onChange={next => automix.setEffect(next === 'auto' ? null : next)}
                                name={t('options.transitionEffect')}
                            />
                        </Row>
                    )}
                    {/* 时长：固定淡化是「淡多久」，智能过渡是「最长允许多久」。 */}
                    <Row sub option={O.crossfadeMax} hint={t(smartHandoff ? 'options.transitionMaxDesc' : 'options.transitionCrossfadeDesc')}>
                        <Slider
                            value={automix.crossfadeMaxSec}
                            min={CROSSFADE_MIN_SEC}
                            max={CROSSFADE_MAX_SEC}
                            onChange={automix.setCrossfadeMaxSec}
                            format={seconds => t('options.crossfadeSecondsValue', { seconds })}
                        />
                    </Row>
                    {/* 曲线只影响重叠那几秒的音量怎么交叠：等功率中点不塌，线性是旧行为。
                        智能过渡下曲线由效果自己定（平台混音要 plateau、回声抛掷要快切），
                        所以这一行在智能档收起，免得写着一个不起作用的选项。 */}
                    {!smartHandoff && (
                        <Row sub option={O.crossfadeCurve} hint={t('options.crossfadeCurveDesc')}>
                            <Segmented<CrossfadeCurve>
                                value={automix.crossfadeCurve}
                                options={CROSSFADE_CURVES.map(curve => ({
                                    value: curve,
                                    label: t(`options.crossfadeCurve_${curve}`),
                                }))}
                                onChange={automix.setCrossfadeCurve}
                            />
                        </Row>
                    )}
                    {smartHandoff && (
                        <>
                            <Row sub option={O.transitionIntensity} hint={t('options.transitionIntensityDesc')}>
                                <Segmented
                                    value={String(automix.intensity)}
                                    options={INTENSITY_LEVELS.map(level => ({ value: level.value as string, label: t(level.labelKey) }))}
                                    onChange={next => automix.setIntensity(Number(next))}
                                />
                            </Row>
                            <Row sub option={O.transitionPerformance} hint={t('options.transitionPerformanceDesc')}>
                                <Toggle checked={automix.performance} onChange={automix.setPerformance} />
                            </Row>
                            {/*
                             * 性能档需要 htdemucs 分轨；缺了才提示，有就不画。
                             *
                             * 这里原来问的是 modelsPresent（WebGPU 那套），
                             * 而那一套在安卓整体关着，于是不管装没装都会挂着
                             * 「这次安装缺少音轨分离模型」。现在问原生那一份。
                             */}
                            {automix.performance && !stemModelReady && (
                                <Row notice={t('options.transitionPerformanceNeedsModel')} />
                            )}
                            <Row sub option={O.transitionEnhancer} hint={t('options.transitionEnhancerDesc')}>
                                <Toggle checked={automix.enhancer} onChange={automix.setEnhancer} />
                            </Row>
                        </>
                    )}
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
                {/* 保活体检：只在安卓原生壳里出现，读不到状态时整行不画。 */}
                <AndroidKeepAliveSetting def={O.keepAlive} />
            </Group>

            {/*
             * 安卓这一条：模型内置在安装包里，所以只要有这层原生能力就画。
             *
             * 与上面那组（ANALYSIS_MODELS_ENABLED，从 CDN 取、跑 WebGPU）是两套东西：
             * 那边关着是因为手机 WebGPU 不稳；这里走 onnxruntime-android，不依赖 WebGPU。
             * 组件内部自己判端，非安卓返回 null。
             */}
            <NativeModelsSection />

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
