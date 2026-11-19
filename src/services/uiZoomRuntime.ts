import { useDesktopSettingsStore } from '../stores/useDesktopSettingsStore';
import { resolveUiZoomFactor } from '../utils/uiZoom';

// src/services/uiZoomRuntime.ts
// 界面缩放（#1264，移植自上游）套到当前窗口上：启动时在首屏渲染前套一次，之后跟着设置改。
//
// 桌面版走 preload 的 `webFrame.setZoomFactor`（与上游一致）。
//
// 安卓没有 webFrame。两条路都试过，各有一个坑：
//   · CSS `zoom`：会把 `position: fixed` 的参考系与 `100vh` 一起缩小，播放条 / 设置页底栏
//     跑到屏幕外或停在中间（实测）。
//   · viewport `initial-scale`：布局正确，但**只在页面加载时生效**，改挡位后不重排 ——
//     用户实测「只能放大，缩小没反应」。
//
// 所以安卓走第三种：给根元素设 `zoom`，同时把**根元素的高宽按 1/zoom 撑开**。
// 撑开之后布局视口仍是原来的像素数，fixed 元素照旧贴边，`100vh` 也回到真实高度 ——
// 两处坑都不再出现。改挡位只是改这两个属性，立刻生效，不需要重新加载。

let installed = false;

/** 安卓 / 网页：zoom + 根元素尺寸补偿。 */
const applyDomZoom = (factor: number) => {
    const root = document.documentElement;
    if (Math.abs(factor - 1) < 0.001) {
        root.style.removeProperty('zoom');
        root.style.removeProperty('width');
        root.style.removeProperty('height');
        root.removeAttribute('data-folia-ui-zoom');
        return;
    }
    root.style.setProperty('zoom', String(factor));
    /*
     * 补偿：zoom 0.75 时内容只占 75%，把根撑到 1/0.75 倍，屏幕才被真正铺满，
     * 而 fixed 元素的定位参考系仍是「撑开后的视口」，所以依旧贴边。
     * 用 `%`：根元素的百分比相对初始包含块算，不受自身 zoom 影响。
     */
    root.style.setProperty('width', `${100 / factor}%`);
    root.setAttribute('data-folia-ui-zoom', String(factor));
};

/** 按当前设置缩放这个窗口，并在开关或挡位改动时跟着改。 */
export const installUiZoom = () => {
    if (installed) return;
    installed = true;
    const electron = window.electron;
    const apply = (enabled: boolean, step: Parameters<typeof resolveUiZoomFactor>[1]) => {
        const factor = resolveUiZoomFactor(enabled, step);
        if (electron?.setPageZoomFactor) {
            // 桌面版：与窗口现在的缩放比，不和上次设的比 —— 默认菜单的 Ctrl+=/-/0 会绕过设置改掉它。
            const current = electron.getPageZoomFactor?.() ?? 1;
            if (Math.abs(current - factor) < 0.001) return;
            electron.setPageZoomFactor(factor);
        } else if (typeof document !== 'undefined') {
            applyDomZoom(factor);
        }
        console.info(`[UiZoom] page zoom ${Math.round(factor * 100)}%`);
    };
    const initial = useDesktopSettingsStore.getState();
    apply(initial.uiZoomEnabled, initial.uiZoomStep);
    useDesktopSettingsStore.subscribe(state => apply(state.uiZoomEnabled, state.uiZoomStep));
};
