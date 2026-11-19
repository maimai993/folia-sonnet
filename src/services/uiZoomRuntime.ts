import { useDesktopSettingsStore } from '../stores/useDesktopSettingsStore';
import { resolveUiZoomFactor } from '../utils/uiZoom';

// src/services/uiZoomRuntime.ts
// 界面缩放（#1264，移植自上游）套到当前窗口上：启动时在首屏渲染前套一次，之后跟着设置改。
//
// 上游走 preload 的 `webFrame.setZoomFactor`；这里**两路都支持**：
//   桌面版有 preload，行为与上游完全一致；
//   安卓没有 preload，退到 CSS —— 给 <html> 设 `zoom`。WebView 对 zoom 的支持是完整的
//   （Tailwind 的 px 值、vh/vw、canvas 尺寸都会跟着变），这正是「整页缩放」想要的效果。
//   不用 font-size：项目里 `--folia-ui-scale-*` 已经在管字号，两套叠在一起会把文字缩两次。

let installed = false;

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
            // 安卓 / 网页：整页 zoom。100% 时把属性摘掉，别留一个 "1" 影响布局计算。
            const root = document.documentElement;
            if (Math.abs(factor - 1) < 0.001) root.style.removeProperty('zoom');
            else root.style.setProperty('zoom', String(factor));
        }
        console.info(`[UiZoom] page zoom ${Math.round(factor * 100)}%`);
    };
    const initial = useDesktopSettingsStore.getState();
    apply(initial.uiZoomEnabled, initial.uiZoomStep);
    useDesktopSettingsStore.subscribe(state => apply(state.uiZoomEnabled, state.uiZoomStep));
};
