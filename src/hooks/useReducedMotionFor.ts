import { useEffect } from 'react';
import {
    MOTION_SURFACE_IDS,
    resolveReducedMotion,
    useMotionSettingsStore,
    type MotionSurfaceId,
} from '../stores/useMotionSettingsStore';

// src/hooks/useReducedMotionFor.ts
// 组件读「我这一面要不要降级」的唯一入口。
//
// 替代了散落在各处的 framer-motion `useReducedMotion()` 和裸 `matchMedia` 调用：那些写法把
// 系统偏好直接焊死在组件里，用户无从覆盖（issue #370）。改完之后组件代码里不应再出现
// `prefers-reduced-motion` 字样，只有 useMotionSettingsStore 认识那条 media query。

/** 订阅某个动效面的降级状态，随设置和系统偏好变化重渲染。 */
export const useReducedMotionFor = (surface: MotionSurfaceId): boolean => (
    useMotionSettingsStore(state => resolveReducedMotion(state, surface))
);

/** 当前处于降级状态的面，拼成 `data-reduce-motion` 用的空格分隔串。空串表示全部完整播放。 */
const selectReducedSurfaceList = (state: ReturnType<typeof useMotionSettingsStore.getState>) => (
    MOTION_SURFACE_IDS.filter(surface => resolveReducedMotion(state, surface)).join(' ')
);

/**
 * 把降级状态写到 `<html data-reduce-motion="...">`，供纯 CSS 的动效读取。
 *
 * CSS 里原来写的是 `@media (prefers-reduced-motion: reduce)`，媒体查询读不到 store，所以改成
 * `[data-reduce-motion~="lattice"]` 这类属性选择器 —— `~=` 匹配空格分隔的词，一个属性就能带多个面。
 * 只在 App 根部挂一次。
 */
export const useMotionSurfaceAttributes = (): void => {
    const reducedSurfaces = useMotionSettingsStore(selectReducedSurfaceList);

    useEffect(() => {
        if (typeof document === 'undefined') return;
        const root = document.documentElement;
        if (reducedSurfaces) {
            root.setAttribute('data-reduce-motion', reducedSurfaces);
        } else {
            root.removeAttribute('data-reduce-motion');
        }
    }, [reducedSurfaces]);
};

export default useReducedMotionFor;
