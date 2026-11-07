// src/stores/useAutomixSettingsStore.ts
// FOLIA's smart-transition switches: whether blending is on, which strategy plans the change,
// and the two transition animation toggles.
//
// Split out of useSettingsUiStore.

import { create } from 'zustand';

import {
    clampCrossfadeSeconds,
    CROSSFADE_DEFAULT_CURVE,
    CROSSFADE_DEFAULT_SEC,
    readCrossfadeCurve,
    type CrossfadeCurve,
} from '../services/automix/crossfadePlanner';
import { DEFAULT_TRANSITION_SETTINGS, type TransitionMode } from '../services/automix/transitionStrategy';
import { writeNativeSettings } from '../services/nativeSettingsBridge';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';

const AUTOMIX_ENABLED_KEY = 'folia_automix_enabled';

const CROSSFADE_MAX_SEC_KEY = 'folia_crossfade_max_sec';

const CROSSFADE_CURVE_KEY = 'folia_crossfade_curve';

const TRANSITION_PERFORMANCE_KEY = 'folia_transition_performance';

/** 原生过渡内核的档位。与下面那个只读的 transitionMode 不是一回事，见 state 里的说明。 */
const NATIVE_TRANSITION_MODE_KEY = 'folia_native_transition_mode';

/** 手动指定的接法；空串 = 由内核按测量证据自动挑。 */
const TRANSITION_EFFECT_KEY = 'folia_transition_effect';

const TRANSITION_INTENSITY_KEY = 'folia_transition_intensity';

const TRANSITION_ENHANCER_KEY = 'folia_transition_enhancer';

const TRANSITION_ANIMATION_KEY = 'folia_transition_animation';

const TRANSITION_ANIMATION_CARD_KEY = 'folia_transition_animation_card';

/**
 * The card border's switch, seeded once from the switch the two renderers used to share.
 *
 * Before the split, that switch on meant the card's border was what you actually saw on the lyrics
 * page - the ring stood down wherever the card was up - so starting this one off would read as the
 * update having taken something away.
 *
 * Written back rather than derived on every start, and that is the part worth keeping: the old key
 * now belongs to the RING alone, so a listener who turns the ring on later would otherwise find the
 * border had switched itself back on at the next launch. A migration has to happen once and then be
 * over.
 */
const readTransitionAnimationCard = (): boolean => {
    if (typeof window === 'undefined') {
        return false;
    }

    if (localStorage.getItem(TRANSITION_ANIMATION_CARD_KEY) !== null) {
        return getStoredBoolean(TRANSITION_ANIMATION_CARD_KEY, false);
    }

    const inherited = getStoredBoolean(TRANSITION_ANIMATION_KEY, false);
    setStoredBoolean(TRANSITION_ANIMATION_CARD_KEY, inherited);
    return inherited;
};

const readStoredCrossfadeMaxSec = (): number => {
    if (typeof window === 'undefined') return CROSSFADE_DEFAULT_SEC;
    const saved = localStorage.getItem(CROSSFADE_MAX_SEC_KEY);
    return saved === null ? CROSSFADE_DEFAULT_SEC : clampCrossfadeSeconds(Number(saved));
};

const readStoredCrossfadeCurve = (): CrossfadeCurve => (
    typeof window === 'undefined'
        ? CROSSFADE_DEFAULT_CURVE
        : readCrossfadeCurve(localStorage.getItem(CROSSFADE_CURVE_KEY))
);

/**
 * 原生过渡内核的档位：`crossfade` 固定时长淡入淡出，`smart` 由原生按测量证据从 18 种接法里挑。
 *
 * 没存过时给 `smart`，与原生 `FoliaSettingsStore.DEFAULTS` 里 `transition.mode = automix` 对齐：
 * 两处默认值不一致，正是「界面写着 A、声音是 B」的来源。拾不出证据时内核自己退回等功率淡化，
 * 所以这一档在陌生设备上不会变成硬切。
 */
const readNativeTransitionMode = (): NativeTransitionMode => (
    typeof window === 'undefined' ? 'smart' : (localStorage.getItem(NATIVE_TRANSITION_MODE_KEY) === 'crossfade' ? 'crossfade' : 'smart')
);

/** 手动指定的接法。空串与没存过都当「自动」—— 与原生 `EffectId.fromWire("")` 的语义一致。 */
const readStoredTransitionEffect = (): string | null => {
    if (typeof window === 'undefined') return null;
    const saved = localStorage.getItem(TRANSITION_EFFECT_KEY);
    return saved ? saved : null;
};

/** 0.25 / 0.5 / 0.75 / 1 四档；越界值夹回去而不是丢掉，免得界面出现不存在的档位。 */
const readStoredTransitionIntensity = (): number => {
    if (typeof window === 'undefined') return 0.75;
    const saved = localStorage.getItem(TRANSITION_INTENSITY_KEY);
    if (saved === null) return 0.75;
    const value = Number(saved);
    if (!Number.isFinite(value)) return 0.75;
    return Math.min(1, Math.max(0.25, value));
};

/** 原生过渡内核的两档。wire 值在 nativeTransitionClient.ts 里是 `crossfade` / `automix`。 */
export type NativeTransitionMode = 'crossfade' | 'smart';

/** store 的档位 → 原生 wire。原生只有 crossfade / automix 两个值，不对应就落回 crossfade。 */
const toNativeTransitionMode = (mode: NativeTransitionMode): 'crossfade' | 'automix' => (
    mode === 'smart' ? 'automix' : 'crossfade'
);

export type AutomixSettingsState = {
    automixEnabled: boolean;
    /**
     * 恒为 `'crossfade'`。
     *
     * 原来这里是「用哪套策略规划换歌」的用户选择（crossfade / automix），AutoMix 那一档连同
     * 它的性能档与过渡动画已经删掉了：出声交给原生 ExoPlayer 之后，AutoMix 那条链全在 Web
     * Audio 图上，开了也只是空跑。字段留着是因为还有几处 `transitionMode === 'automix'` 的
     * 判断（浮层、命令面板、上报），它们现在恒为假 —— 删引擎是另一件事，不在这次范围里。
     *
     * 安卓上的「换歌怎么接」由下面的 nativeTransitionMode 决定，别把两者合并：这一档还牵着
     * 过渡环 / 卡片边框那几条 Web 侧判断，改成真值会让它们去找一份 Android 上不存在的 cue。
     */
    transitionMode: TransitionMode;
    /**
     * 原生过渡内核的档位，只喂给原生（`transition.mode`）。
     *
     * - `crossfade`：固定时长淡入淡出，曲线由 crossfadeCurve 决定；
     * - `smart`：原生按 BPM / 响度 / 首尾能量挑接法，长度按小节或效果自身的区间算。
     *
     * 桌面端没有这个内核，两档都还是老的交叉淡化；设置页也只在安卓上画这一行。
     */
    nativeTransitionMode: NativeTransitionMode;
    /** 手动指定的接法（18 种之一）；null = 自动。 */
    transitionEffect: string | null;
    /** 效果强度 0.25 / 0.5 / 0.75 / 1，喂给原生的 band / 滤波深度。 */
    transitionIntensity: number;
    /** 允许使用按需下载的增强包；未下载时相关效果自动剔除，其余照常。 */
    transitionEnhancer: boolean;
    /** Seconds. The crossfade mode's ceiling; automix computes its own and ignores this. */
    crossfadeMaxSec: number;
    /** 重叠期间音量怎么交叉：等功率 / 线性 / 快切。原生按它算每一步的音量。 */
    crossfadeCurve: CrossfadeCurve;
    /** Let the mix be heard. Only reachable with automix on, and only where stems exist. */
    transitionPerformance: boolean;
    /**
     * Draw the mix as a ring in the middle of the screen. Automix only, and only for blends long
     * enough to watch.
     */
    transitionAnimation: boolean;
    /**
     * Draw the same mix on the now playing card's border, on the pages that card appears on.
     *
     * Its own switch rather than a placement rule under the one above, because the two are two
     * pictures in two places and only the listener knows which they want where. They used to share
     * a switch, with the ring standing down wherever the card was up - which meant turning the
     * animation on and never seeing the ring again on the page most people watch.
     */
    transitionAnimationCard: boolean;
    handleToggleAutomix: (enable: boolean) => void;
    handleSetTransitionMode: (mode: TransitionMode) => void;
    handleSetNativeTransitionMode: (mode: NativeTransitionMode) => void;
    handleSetTransitionEffect: (effect: string | null) => void;
    handleSetTransitionIntensity: (intensity: number) => void;
    handleToggleTransitionEnhancer: (enable: boolean) => void;
    handleSetCrossfadeMaxSec: (seconds: number) => void;
    handleSetCrossfadeCurve: (curve: CrossfadeCurve) => void;
    handleToggleTransitionPerformance: (enable: boolean) => void;
    handleToggleTransitionAnimation: (enable: boolean) => void;
    handleToggleTransitionAnimationCard: (enable: boolean) => void;
};

export const useAutomixSettingsStore = create<AutomixSettingsState>((set, get) => ({
    automixEnabled: getStoredBoolean(AUTOMIX_ENABLED_KEY, false),
    // 锁在 crossfade：`folia_transition_mode` 里存着的旧值（可能还是 'automix'）不再读。
    transitionMode: 'crossfade',
    crossfadeMaxSec: readStoredCrossfadeMaxSec(),
    crossfadeCurve: readStoredCrossfadeCurve(),
    nativeTransitionMode: readNativeTransitionMode(),
    transitionEffect: readStoredTransitionEffect(),
    transitionIntensity: readStoredTransitionIntensity(),
    transitionEnhancer: getStoredBoolean(TRANSITION_ENHANCER_KEY, true),
    transitionPerformance: getStoredBoolean(
        TRANSITION_PERFORMANCE_KEY, DEFAULT_TRANSITION_SETTINGS.performance,
    ),
    // Off by default: it draws over whatever the listener is already looking at, which is a
    // choice to make rather than one to arrive at after an update.
    transitionAnimation: getStoredBoolean(TRANSITION_ANIMATION_KEY, false),
    transitionAnimationCard: readTransitionAnimationCard(),
    handleToggleAutomix: (enable) => {
        setStoredBoolean(AUTOMIX_ENABLED_KEY, enable);
        // 换歌的交叉淡化现在由原生做（两台播放器互相淡入淡出），开关得推过去。
        // 顺手把档位一起推：原生读不到 transition.mode 时会按「老用户」推断（开着且有时长
        // 就按 crossfade 走），而这里明明有用户的明确选择，没必要让原生猜。
        void writeNativeSettings({
            crossfadeEnabled: enable,
            'transition.mode': toNativeTransitionMode(get().nativeTransitionMode),
        });
        // The models ship with the app, so there is nothing to prompt for (the "download the
        // models" reminder that opened here is gone with the downloads).
        set({ automixEnabled: enable });
    },
    // 模式锁在 crossfade：命令面板那条「切到 crossfade」保留形状，但不再有另一档可切。
    handleSetTransitionMode: () => {
        set({ transitionMode: 'crossfade' });
    },
    /*
     * 原生内核档位。写两个键：transition.mode 决定规划走哪条路，
     * crossfadeEnabled 保持为总开关 —— 内核里两者是「开没开」和「怎么接」两件事。
     */
    handleSetNativeTransitionMode: (mode) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem(NATIVE_TRANSITION_MODE_KEY, mode);
        }
        set({ nativeTransitionMode: mode });
        void writeNativeSettings({ 'transition.mode': toNativeTransitionMode(mode) });
    },
    handleSetTransitionEffect: (effect) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem(TRANSITION_EFFECT_KEY, effect ?? '');
        }
        set({ transitionEffect: effect });
        // 原生侧空串 = 自动挑选（EffectId.fromWire("") 返回 null）。
        void writeNativeSettings({ 'transition.effect': effect ?? '' });
    },
    handleSetTransitionIntensity: (intensity) => {
        const next = Math.min(1, Math.max(0.25, intensity));
        if (typeof window !== 'undefined') {
            localStorage.setItem(TRANSITION_INTENSITY_KEY, String(next));
        }
        set({ transitionIntensity: next });
        void writeNativeSettings({ 'transition.intensity': next });
    },
    handleToggleTransitionEnhancer: (enable) => {
        setStoredBoolean(TRANSITION_ENHANCER_KEY, enable);
        set({ transitionEnhancer: enable });
        void writeNativeSettings({ 'transition.enhancer': enable });
    },
    handleSetCrossfadeMaxSec: (seconds) => {
        const next = clampCrossfadeSeconds(seconds);
        if (typeof window !== 'undefined') {
            localStorage.setItem(CROSSFADE_MAX_SEC_KEY, String(next));
        }
        set({ crossfadeMaxSec: next });
        /*
         * 原生拿毫秒：这边是秒。两个键都写 —— crossfadeMs 是固定淡入淡出的长度，
         * transition.maxMs 是智能过渡里「效果自身上限」与用户上限取小的那个。
         * 只写一个的话，档位一换滑杆的数值就对不上了。
         */
        const ms = Math.round(next * 1000);
        void writeNativeSettings({ crossfadeMs: ms, 'transition.maxMs': ms });
    },
    handleSetCrossfadeCurve: (curve) => {
        const next = readCrossfadeCurve(curve);
        if (typeof window !== 'undefined') {
            localStorage.setItem(CROSSFADE_CURVE_KEY, next);
        }
        set({ crossfadeCurve: next });
        // 原生的音量斜坡按名字取曲线，字符串直接过去，不在这边换算成编号。
        void writeNativeSettings({ crossfadeCurve: next });
    },
    handleToggleTransitionPerformance: (enable) => {
        setStoredBoolean(TRANSITION_PERFORMANCE_KEY, enable);
        set({ transitionPerformance: enable });
        // 表现手势（build-up / riser）由原生的效果链执行，开关得过去。
        void writeNativeSettings({ 'transition.performance': enable });
    },
    handleToggleTransitionAnimation: (enable) => {
        setStoredBoolean(TRANSITION_ANIMATION_KEY, enable);
        set({ transitionAnimation: enable });
    },
    handleToggleTransitionAnimationCard: (enable) => {
        setStoredBoolean(TRANSITION_ANIMATION_CARD_KEY, enable);
        set({ transitionAnimationCard: enable });
    },
}));

/**
 * The AutomixSettings half of the former settings snapshot, for the surfaces that
 * legitimately edit this whole domain at once. Ordinary consumers select one field instead.
 */
export const selectAutomixSettingsSnapshot = (state: AutomixSettingsState) => ({
    automixEnabled: state.automixEnabled,
    transitionMode: state.transitionMode,
    nativeTransitionMode: state.nativeTransitionMode,
    transitionEffect: state.transitionEffect,
    transitionIntensity: state.transitionIntensity,
    transitionEnhancer: state.transitionEnhancer,
    crossfadeMaxSec: state.crossfadeMaxSec,
    crossfadeCurve: state.crossfadeCurve,
    transitionPerformance: state.transitionPerformance,
    transitionAnimation: state.transitionAnimation,
    transitionAnimationCard: state.transitionAnimationCard,
    handleToggleAutomix: state.handleToggleAutomix,
    handleSetTransitionMode: state.handleSetTransitionMode,
    handleSetNativeTransitionMode: state.handleSetNativeTransitionMode,
    handleSetTransitionEffect: state.handleSetTransitionEffect,
    handleSetTransitionIntensity: state.handleSetTransitionIntensity,
    handleToggleTransitionEnhancer: state.handleToggleTransitionEnhancer,
    handleSetCrossfadeMaxSec: state.handleSetCrossfadeMaxSec,
    handleSetCrossfadeCurve: state.handleSetCrossfadeCurve,
    handleToggleTransitionPerformance: state.handleToggleTransitionPerformance,
    handleToggleTransitionAnimation: state.handleToggleTransitionAnimation,
    handleToggleTransitionAnimationCard: state.handleToggleTransitionAnimationCard,
});
