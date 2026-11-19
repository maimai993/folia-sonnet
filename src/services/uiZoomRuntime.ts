import { useDesktopSettingsStore } from '../stores/useDesktopSettingsStore';
import { resolveUiZoomFactor } from '../utils/uiZoom';

// src/services/uiZoomRuntime.ts
// 界面缩放（#1264，移植自上游）套到当前窗口上：启动时在首屏渲染前套一次，之后跟着设置改。
//
// 上游走 preload 的 `webFrame.setZoomFactor`；这里**两路都支持**：
//   桌面版有 preload，行为与上游完全一致；
//   安卓没有 preload，退到 CSS。
//
// ★ 安卓这边不能只写 `html { zoom: 0.75 }`：CSS zoom 会把**视口单位**也一起缩，
//   100vh / 100dvh 变成「缩小后的那一份」，于是固定定位的底栏、整高面板会停在中间偏上的位置，
//   底下露出空白或者被挡住（#424 的实测反馈：设置页底部没铺满、切换条浮在中下位置挡内容）。
//   所以缩放的同时要把根元素的高宽按 1/zoom 撑回去，让视口单位与实际屏幕重新对齐。

let installed = false;

/** 安卓 / 网页的缩放：`zoom` 负责把内容缩小，根元素尺寸补偿负责让视口单位别跟着缩。 */
const applyCssZoom = (factor: number) => {
    const root = document.documentElement;
    if (Math.abs(factor - 1) < 0.001) {
        root.style.removeProperty('zoom');
        root.style.removeProperty('width');
        root.style.removeProperty('height');
        return;
    }
    root.style.setProperty('zoom', String(factor));
    /*
     * 补偿：zoom 0.75 时内容只占 75%，把根撑到 1/0.75 倍，屏幕才被真正铺满。
     * 用 `%` 而不是 `vh`：根元素的百分比相对视口算，而 vh 自己也会被 zoom 影响，套两层就错了。
     */
    root.style.setProperty('width', `${100 / factor}%`);
    root.style.setProperty('height', `${100 / factor}%`);
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
            applyCssZoom(factor);
        }
        console.info(`[UiZoom] page zoom ${Math.round(factor * 100)}%`);
    };
    const initial = useDesktopSettingsStore.getState();
    apply(initial.uiZoomEnabled, initial.uiZoomStep);
    useDesktopSettingsStore.subscribe(state => apply(state.uiZoomEnabled, state.uiZoomStep));
};
