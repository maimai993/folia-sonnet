import { useDesktopSettingsStore } from '../stores/useDesktopSettingsStore';
import { resolveUiZoomFactor } from '../utils/uiZoom';

// src/services/uiZoomRuntime.ts
// 界面缩放（#1264，移植自上游）套到当前窗口上：启动时在首屏渲染前套一次，之后跟着设置改。
//
// 两条实现，按平台选：
//   · 桌面版 —— preload 的 `webFrame.setZoomFactor`，浏览器级的视图缩放，与上游完全一致；
//   · 安卓 —— 改 `<html>` 的 **font-size**。
//
// ★ 安卓为什么是 font-size 而不是 zoom / transform / initial-scale：
//   项目自己的 Tailwind 间距、字号、圆角都是 rem（见 src/styles/androidPhoneFit.css 的
//   `html { font-size: var(--folia-ui-scale-normal) }`），所以调字号就是**让整页按比例重排**——
//   布局是真重排，`position: fixed` 的播放条、设置页底栏、右侧导航都还在原位。
//   另外三条路都试过并否掉：CSS `zoom` 会把 fixed 的参考系一起缩（UI 跑到屏幕外）；
//   `transform: scale` 会新建包含块（整页塌黑）；viewport `initial-scale` 只在加载时生效
//   （改挡位不重排，表现是「只能放大、缩小没反应」）。

let installed = false;

/** 没有 webFrame 的平台：把挡位写进 `<html>` 的字号。 */
const applyHtmlScale = (enabled: boolean, step: Parameters<typeof resolveUiZoomFactor>[1]) => {
    const root = document.documentElement;
    if (!enabled) {
        // 交回设备类型那一层（它按 --folia-ui-scale-* 自己算）。
        root.style.removeProperty('font-size');
        root.removeAttribute('data-folia-ui-zoom');
        return;
    }
    /*
     * 内联样式优先级高于 androidPhoneFit.css 里的 `var(--folia-ui-scale-*)`，
     * 所以用户显式设的挡位会盖住设备类型的默认档 —— 这正是「拉过一次就以它为准」。
     */
    root.style.fontSize = `${step}%`;
    root.setAttribute('data-folia-ui-zoom', String(step));
};

/** 按当前设置缩放这个窗口，并在开关或挡位改动时跟着改。 */
export const installUiZoom = () => {
    if (installed) return;
    installed = true;
    const electron = window.electron;
    const hasNativeZoom = typeof electron?.setPageZoomFactor === 'function';

    const apply = (enabled: boolean, step: Parameters<typeof resolveUiZoomFactor>[1]) => {
        if (hasNativeZoom) {
            const factor = resolveUiZoomFactor(enabled, step);
            // 与窗口现在的缩放比，不和上次设的比 —— 默认菜单的 Ctrl+=/-/0 会绕过设置改掉它。
            const current = electron.getPageZoomFactor?.() ?? 1;
            if (Math.abs(current - factor) < 0.001) return;
            electron.setPageZoomFactor?.(factor);
        } else if (typeof document !== 'undefined') {
            applyHtmlScale(enabled, step);
        }
        console.info(`[UiZoom] ${enabled ? `${step}%` : 'off (100%)'}`);
    };

    const initial = useDesktopSettingsStore.getState();
    apply(initial.uiZoomEnabled, initial.uiZoomStep);
    useDesktopSettingsStore.subscribe(state => apply(state.uiZoomEnabled, state.uiZoomStep));

    if (!hasNativeZoom && typeof window !== 'undefined') {
        /*
         * 设备类型那一层会在转屏 / resize 时重写 --folia-ui-scale-*，而它写的是变量、
         * 我们写的是内联 font-size（优先级更高），本来不会被盖掉。这里再补一次是为了
         * 「转屏后字号被别的路径清掉」这种边角情况 —— 注册得比它晚，所以跑在它后面。
         */
        const reapply = () => {
            const state = useDesktopSettingsStore.getState();
            applyHtmlScale(state.uiZoomEnabled, state.uiZoomStep);
        };
        window.addEventListener('orientationchange', reapply);
        window.addEventListener('resize', reapply);
    }
};
