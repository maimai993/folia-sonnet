/**
 * src/services/nativeTransitionClient.ts
 *
 * 原生过渡系统的 Web 侧薄桥接层。这里是「保留 UI 只换内核」之后，WebView 里唯一
 * 还和过渡有关的新代码 —— 它不做任何规划、分析、执行，只负责：
 *   1. 把设置页的开关 / 选项转发给原生插件；
 *   2. 在预取阶段让原生去分析下几首；
 *   3. 换歌前问原生要一份 TransitionPlan；
 *   4. 把原生 cue 事件原样广播给现有的过渡动画与 Remote 快照。
 *
 * 被替换掉的是 src/services/automix/ 下的证据层 / 决策层 / 执行层，以及两个 <audio>
 * deck、Web Audio 节点链、OfflineAudioContext 分析。播放链本来就在原生
 * （FoliaNativePlayer），现在过渡的「大脑」也搬过去了。
 *
 * 字段名与旧 automix 的 TransitionPlan 保持一致，所以设置页、过渡环动画、Remote
 * 快照那几个组件不需要改数据结构，只改数据来源。
 */

import { registerPlugin, Capacitor, type PluginListenerHandle } from '@capacitor/core';

// ---------------------------------------------------------------------------
// 类型（与原生 TransitionPlan / TransitionCue / EffectSpec 的 wire 值一一对应）
// ---------------------------------------------------------------------------

export type PlanKind = 'hardCut' | 'fade';
export type KeyRelation = 'compatible' | 'adjacent' | 'neutral' | 'clashing' | 'unknown';
export type TempoRelation = 'locked' | 'near' | 'stretchable' | 'drifting' | 'far' | 'unknown';
export type TransitionMode = 'crossfade' | 'automix';
export type CuePhase = 'armed' | 'started' | 'progress' | 'finished' | 'cancelled' | 'preview';

/** 18 种接法。与 EffectCatalog.ALL 的 wire 一一对应。 */
export type EffectId =
    | 'plainBlend' | 'hardCut' | 'fadeOutIn' | 'plateauBlend'
    | 'bassSwap' | 'threeBandSeam' | 'filterSweepIn' | 'vocalRecede'
    | 'beatCut' | 'barAlignedBlend' | 'tempoBend'
    | 'tailRide' | 'echoThrow' | 'reverbCarry'
    | 'buildUp' | 'riserDrop' | 'vinylBrake' | 'reverseCrescendo';

export interface TransitionPlan {
    cueId: string;
    kind: PlanKind;
    style: EffectId;
    relation: KeyRelation;
    tempo: TempoRelation;
    stretch: number;
    tiltDb: number;
    echoThrow: boolean;
    outStartMs: number;
    inStartMs: number;
    overlapMs: number;
    minOverlapMs: number;
    reason: string;
    expansion?: number | null;
    curve: string;
    together: number;
    intensity: number;
    needsDsp: boolean;
    enhanced: boolean;
    needsBeatGrid: boolean;
    createdAtMs: number;
}

export interface TransitionCue {
    cueId: string;
    phase: CuePhase;
    style: string;
    progress: number;
    overlapMs: number;
    elapsedMs: number;
    reason: string;
    preview: boolean;
    plain: boolean;
    plan?: TransitionPlan;
}

export interface EffectSpec {
    id: EffectId;
    label: string;
    summary: string;
    family: string;
    needsEnhancer: boolean;
    needsBeatGrid: boolean;
    minOverlapMs: number;
    maxOverlapMs: number;
}

export interface TransitionCapabilities {
    dspAnalysis: boolean;
    beatGrid: boolean;
    stems: boolean;
    enhancerInstalled: boolean;
    enhancerBytes: number;
    enhancerMaxBytes: number;
    dspChain: boolean;
    effects: string[];
    mode: TransitionMode;
    enabled: boolean;
}

export interface TransitionSettingsPatch {
    crossfadeEnabled?: boolean;
    crossfadeMs?: number;
    crossfadeCurve?: string;
    transitionMode?: TransitionMode;
    /** 空串 / undefined = 自动挑选 */
    transitionEffect?: EffectId | '';
    transitionMaxMs?: number;
    transitionPerformance?: boolean;
    transitionIntensity?: number;
    transitionEnhancer?: boolean;
    transitionCurve?: string;
}

// ---------------------------------------------------------------------------
// 插件契约
// ---------------------------------------------------------------------------

interface FoliaTransitionPlugin {
    getCapabilities(): Promise<TransitionCapabilities>;
    listEffects(): Promise<{ effects: EffectSpec[] }>;
    setSettings(options: TransitionSettingsPatch): Promise<Record<string, unknown>>;
    analyse(options: {
        key: string;
        url: string;
        durationMs: number;
        headers?: Record<string, string>;
    }): Promise<{ ok: boolean; profile: unknown | null }>;
    plan(options: {
        fromKey?: string;
        toKey?: string;
        bpmLive?: number;
        fromLyricLines?: number;
    }): Promise<TransitionPlan>;
    execute(options: { url: string; mediaId?: string }): Promise<{ accepted: boolean; style: string }>;
    cancel(options?: { reason?: string }): Promise<void>;
    interrupt(options?: { reason?: string }): Promise<void>;
    preview(options: {
        fromKey?: string;
        toKey?: string;
        bpmLive?: number;
        fromLyricLines?: number;
    }): Promise<TransitionPlan>;
    getSnapshot(): Promise<{
        state: string;
        progress: number;
        plan: TransitionPlan | null;
        settings: Record<string, unknown>;
    }>;
    addListener(
        eventName: 'foliaTransitionCue',
        listenerFunc: (cue: TransitionCue) => void,
    ): Promise<PluginListenerHandle> & PluginListenerHandle;
}

const FoliaTransition = registerPlugin<FoliaTransitionPlugin>('FoliaTransition');

/** 只在 Android + 插件真的在时才走原生；桌面 / 浏览器保持原有行为。 */
export const isNativeTransitionAvailable = (): boolean =>
    Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('FoliaTransition');

// ---------------------------------------------------------------------------
// 对外 API（供设置页、预取、播放桥调用）
// ---------------------------------------------------------------------------

export const getTransitionCapabilities = () => FoliaTransition.getCapabilities();
export const listTransitionEffects = async (): Promise<EffectSpec[]> =>
    (await FoliaTransition.listEffects()).effects;

export const setTransitionSettings = (patch: TransitionSettingsPatch) =>
    FoliaTransition.setSettings(patch);

/**
 * 预取阶段调用。原生会在后台线程解码首尾 PCM 并落盘缓存，不占 WebView 主线程。
 * 失败返回 ok=false 是正常降级（无证据 → 等功率交叉），不需要报错。
 */
export const analyseTrack = (
    key: string,
    url: string,
    durationMs: number,
    headers?: Record<string, string>,
) => FoliaTransition.analyse({ key, url, durationMs, headers });

/** 换歌前算计划并 arm 引擎。bpmLive 是正在播放那一路自测的速度（没有档案时也是证据）。 */
export const planTransition = (options: {
    fromKey?: string;
    toKey?: string;
    bpmLive?: number;
    fromLyricLines?: number;
}): Promise<TransitionPlan> => FoliaTransition.plan(options);

/** 立即执行交接。播放桥在 nearEnd / 自动切歌时调它，不再自己挂 Web Audio 节点。 */
export const executeTransition = (url: string, mediaId?: string) =>
    FoliaTransition.execute({ url, mediaId });

export const cancelTransition = (reason?: string) => FoliaTransition.cancel({ reason });
export const interruptTransition = (reason?: string) => FoliaTransition.interrupt({ reason });
export const previewTransition = (options: {
    fromKey?: string;
    toKey?: string;
    bpmLive?: number;
    fromLyricLines?: number;
}) => FoliaTransition.preview(options);
export const getTransitionSnapshot = () => FoliaTransition.getSnapshot();

// ---------------------------------------------------------------------------
// cue 订阅：保留现有 UI 组件的接口名
// ---------------------------------------------------------------------------

type CueListener = (cue: TransitionCue) => void;

/**
 * 与旧 automix/transitionCue.ts 的 subscribeToTransitionCue 同名同签名，
 * 因此 AutomixTransitionAnimation.tsx 与 useElectronPlaybackBridge.ts 只需改 import，
 * 一行渲染逻辑都不用动。
 */
export const subscribeToTransitionCue = (listener: CueListener): (() => void) => {
    if (!isNativeTransitionAvailable()) return () => {};
    let handle: PluginListenerHandle | undefined;
    let removed = false;
    FoliaTransition.addListener('foliaTransitionCue', listener)
        .then((h) => {
            if (removed) void h.remove();
            else handle = h;
        })
        .catch(() => { /* 插件不在时不让 UI 崩，动画安静地不画 */ });
    return () => {
        removed = true;
        if (handle) void handle.remove();
    };
};

/**
 * 与旧组件同名的判据：纯淡化（plain）不该画混音过渡环，preview 不该发布到 Remote。
 * 这两个规则原本散在 UI 里，现在集中到桥接层，原生与 Web 侧各认一份即可。
 */
export const shouldDrawCue = (cue: TransitionCue): boolean =>
    !cue.plain && !cue.preview && cue.phase !== 'cancelled';

/** Remote 快照投影：只认真实交接，preview 与 plain 都拒掉（对齐 README §8）。 */
export const shouldProjectToRemote = (cue: TransitionCue): boolean =>
    !cue.preview && !cue.plain && (cue.phase === 'started' || cue.phase === 'finished');
