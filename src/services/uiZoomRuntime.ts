import { useDesktopSettingsStore } from '../stores/useDesktopSettingsStore';
import { resolveUiZoomFactor } from '../utils/uiZoom';

// src/services/uiZoomRuntime.ts
// 界面缩放（#1264，移植自上游）套到当前窗口上：启动时在首屏渲染前套一次，之后跟着设置改。
//
// 桌面版走 preload 的 `webFrame.setZoomFactor`（与上游一致）。
//
// ★ 安卓没有 webFrame。这里用 **viewport meta 的 initial-scale**，而不是 CSS `zoom`：
//   CSS zoom 会把视口单位与 `position: fixed` 的参考系一起改掉，于是固定定位的播放条、
//   设置页底栏会跑到屏幕外或停在中间（实测反馈：「播放条、设置页面有一些 UI 不见了」
//   「底部没铺满」「切换条在中下位置挡住内容」）。
//   initial-scale 是浏览器自己的缩放：布局视口按 1/scale 变宽，页面正常重排，
//   固定定位仍贴在可视区边上，不需要任何补偿。

let installed = false;

/** 安卓 / 网页：改写 viewport meta 的 initial-scale。 */
const applyViewportScale = (factor: number) => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    /*
     * 保留 `viewport-fit=cover`（安全区要用）与其余字段，只换 initial-scale。
     * 缩放变小时要放宽布局视口：否则内容仍按原宽度排版，右侧留白。
     */
    const width = factor < 1 ? `${100 / factor}%` : 'device-width';
    meta.setAttribute('content', `width=${width}, initial-scale=${factor}, viewport-fit=cover`);
    const root = document.documentElement;
    if (Math.abs(factor - 1) < 0.001) root.removeAttribute('data-folia-ui-zoom');
    else root.setAttribute('data-folia-ui-zoom', String(factor));
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
            applyViewportScale(factor);
        }
        console.info(`[UiZoom] page zoom ${Math.round(factor * 100)}%`);
    };
    const initial = useDesktopSettingsStore.getState();
    apply(initial.uiZoomEnabled, initial.uiZoomStep);
    useDesktopSettingsStore.subscribe(state => apply(state.uiZoomEnabled, state.uiZoomStep));
};
