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

export type AutomixSettingsState = {
    automixEnabled: boolean;
    /**
     * 恒为 `'crossfade'`。
     *
     * 原来这里是「用哪套策略规划换歌」的用户选择（crossfade / automix），AutoMix 那一档连同
     * 它的性能档与过渡动画已经删掉了：出声交给原生 ExoPlayer 之后，AutoMix 那条链全在 Web
     * Audio 图上，开了也只是空跑。字段留着是因为还有几处 `transitionMode === 'automix'` 的
     * 判断（浮层、命令面板、上报），它们现在恒为假 —— 删引擎是另一件事，不在这次范围里。
     */
    transitionMode: TransitionMode;
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
        void writeNativeSettings({ crossfadeEnabled: enable });
        // The models ship with the app, so there is nothing to prompt for (the "download the
        // models" reminder that opened here is gone with the downloads).
        set({ automixEnabled: enable });
    },
    // 模式锁在 crossfade：命令面板那条「切到 crossfade」保留形状，但不再有另一档可切。
    handleSetTransitionMode: () => {
        set({ transitionMode: 'crossfade' });
    },
    handleSetCrossfadeMaxSec: (seconds) => {
        const next = clampCrossfadeSeconds(seconds);
        if (typeof window !== 'undefined') {
            localStorage.setItem(CROSSFADE_MAX_SEC_KEY, String(next));
        }
        set({ crossfadeMaxSec: next });
        // 原生拿毫秒：这边是秒。
        void writeNativeSettings({ crossfadeMs: Math.round(next * 1000) });
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
    crossfadeMaxSec: state.crossfadeMaxSec,
    crossfadeCurve: state.crossfadeCurve,
    transitionPerformance: state.transitionPerformance,
    transitionAnimation: state.transitionAnimation,
    transitionAnimationCard: state.transitionAnimationCard,
    handleToggleAutomix: state.handleToggleAutomix,
    handleSetTransitionMode: state.handleSetTransitionMode,
    handleSetCrossfadeMaxSec: state.handleSetCrossfadeMaxSec,
    handleSetCrossfadeCurve: state.handleSetCrossfadeCurve,
    handleToggleTransitionPerformance: state.handleToggleTransitionPerformance,
    handleToggleTransitionAnimation: state.handleToggleTransitionAnimation,
    handleToggleTransitionAnimationCard: state.handleToggleTransitionAnimationCard,
});
