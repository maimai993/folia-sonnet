import { create } from 'zustand';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';

// src/stores/useMotionSettingsStore.ts
// 降低动态效果的显式控制面。
//
// 这里存在的理由是 issue #370：Windows 的「动画效果」一关，Chromium 就让
// `prefers-reduced-motion: reduce` 命中，队列拼贴的展开、相机飞行、入场波整套退化成瞬移，
// 用户既没有提示也没有覆盖入口，只能怀疑是应用坏了。所以动效不再无条件跟随系统偏好：
// 默认全开，要降级得自己在实验室设置或命令面板里点。
//
// 刻意不进外观配置的导入导出（buildVisualSettingsConfig）：短码和 OBS 链接是拿来分享一套外观的，
// 而「要不要降低动态效果」是接收者自己的无障碍偏好。导入别人的主题顺手把自己的动画关掉是 bug，
// 不是功能。GridViewSettingsSection 出于同样的理由留在 payload 之外。
//
// `followSystemReducedMotion` 是留给真正需要无障碍的人的兜底 —— 不给这个开关，这次改动等于
// 单方面把系统偏好废掉了。它默认关闭，只有主动打开才恢复旧行为。

/** 一个可以单独降级的动效面。每个 id 对应一组用户能指认出来的界面动画。 */
export type MotionSurfaceId =
    | 'lattice'
    | 'transitionOverlay'
    | 'monetBackground'
    | 'uiMicroMotion'
    | 'settingsScroll';

export const MOTION_SURFACE_IDS = [
    'lattice',
    'transitionOverlay',
    'monetBackground',
    'uiMicroMotion',
    'settingsScroll',
] as const satisfies readonly MotionSurfaceId[];

export const SYSTEM_REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// 每个 key 都写成独立常量而不是模板拼出来：test/unit/stores/storeContract.test.ts 的快照靠扫描
// 源码里的字面量来盯住改名，拼出来的 key 它看不见，而看不见的改名会静默丢掉用户的选择。
const FOLLOW_SYSTEM_KEY = 'reduce_motion_follow_system';
const LATTICE_KEY = 'reduce_motion_lattice';
const TRANSITION_OVERLAY_KEY = 'reduce_motion_transitionOverlay';
const MONET_BACKGROUND_KEY = 'reduce_motion_monetBackground';
const UI_MICRO_MOTION_KEY = 'reduce_motion_uiMicroMotion';
const SETTINGS_SCROLL_KEY = 'reduce_motion_settingsScroll';

const SURFACE_STORAGE_KEYS: Record<MotionSurfaceId, string> = {
    lattice: LATTICE_KEY,
    transitionOverlay: TRANSITION_OVERLAY_KEY,
    monetBackground: MONET_BACKGROUND_KEY,
    uiMicroMotion: UI_MICRO_MOTION_KEY,
    settingsScroll: SETTINGS_SCROLL_KEY,
};

const surfaceStorageKey = (surface: MotionSurfaceId) => SURFACE_STORAGE_KEYS[surface];

const readSystemPreference = () => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(SYSTEM_REDUCED_MOTION_QUERY).matches
);

const readStoredSurfaces = (): Record<MotionSurfaceId, boolean> => (
    Object.fromEntries(
        MOTION_SURFACE_IDS.map(surface => [surface, getStoredBoolean(surfaceStorageKey(surface), false)]),
    ) as Record<MotionSurfaceId, boolean>
);

export type MotionSettingsState = {
    /** 每个面自己的降级开关，全部默认 false，即完整动效。 */
    reducedMotionSurfaces: Record<MotionSurfaceId, boolean>;
    /** 打开后系统偏好重新参与判定；默认关闭，这正是 #370 要解决的事。 */
    followSystemReducedMotion: boolean;
    /** 系统当前的偏好，由模块级监听写入，不由 UI 直接改。 */
    systemPrefersReducedMotion: boolean;

    handleToggleReducedMotionSurface: (surface: MotionSurfaceId, enabled: boolean) => void;
    handleToggleFollowSystemReducedMotion: (enabled: boolean) => void;
    handleSetAllReducedMotionSurfaces: (enabled: boolean) => void;
    setSystemPrefersReducedMotion: (matches: boolean) => void;
};

export const useMotionSettingsStore = create<MotionSettingsState>(set => ({
    reducedMotionSurfaces: readStoredSurfaces(),
    followSystemReducedMotion: getStoredBoolean(FOLLOW_SYSTEM_KEY, false),
    systemPrefersReducedMotion: readSystemPreference(),

    handleToggleReducedMotionSurface: (surface, enabled) => {
        set(state => ({ reducedMotionSurfaces: { ...state.reducedMotionSurfaces, [surface]: enabled } }));
        setStoredBoolean(surfaceStorageKey(surface), enabled);
    },
    handleToggleFollowSystemReducedMotion: (enabled) => {
        set({ followSystemReducedMotion: enabled });
        setStoredBoolean(FOLLOW_SYSTEM_KEY, enabled);
    },
    handleSetAllReducedMotionSurfaces: (enabled) => {
        set({
            reducedMotionSurfaces: Object.fromEntries(
                MOTION_SURFACE_IDS.map(surface => [surface, enabled]),
            ) as Record<MotionSurfaceId, boolean>,
        });
        MOTION_SURFACE_IDS.forEach(surface => setStoredBoolean(surfaceStorageKey(surface), enabled));
    },
    setSystemPrefersReducedMotion: (matches) => set({ systemPrefersReducedMotion: matches }),
}));

/**
 * 某个动效面此刻是否应该降级。自己的开关优先，系统偏好只在用户主动选择跟随时才参与。
 *
 * 写成接 state 的纯函数而不是 hook，是因为 CSS 属性同步和命令面板这些地方要在 React 之外读它。
 */
export const resolveReducedMotion = (
    state: Pick<MotionSettingsState, 'reducedMotionSurfaces' | 'followSystemReducedMotion' | 'systemPrefersReducedMotion'>,
    surface: MotionSurfaceId,
): boolean => (
    state.reducedMotionSurfaces[surface]
    || (state.followSystemReducedMotion && state.systemPrefersReducedMotion)
);

/** 非响应式读取，给只在动画启动那一刻取值的命令式代码用。 */
export const readReducedMotion = (surface: MotionSurfaceId): boolean => (
    resolveReducedMotion(useMotionSettingsStore.getState(), surface)
);

// 系统偏好只需要一份监听。挂在模块级而不是某个组件里：它跟任何一棵子树的生命周期都无关，
// 而且 CSS 属性同步也要在没有组件挂载的时候读到正确的值。
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const query = window.matchMedia(SYSTEM_REDUCED_MOTION_QUERY);
    query.addEventListener('change', event => {
        useMotionSettingsStore.getState().setSystemPrefersReducedMotion(event.matches);
    });
}
