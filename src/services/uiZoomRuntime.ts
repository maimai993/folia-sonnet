import { useDesktopSettingsStore } from '../stores/useDesktopSettingsStore';
import { resolveUiZoomFactor } from '../utils/uiZoom';

// src/services/uiZoomRuntime.ts
// 界面缩放（#1264，移植自上游）套到当前窗口上：启动时在首屏渲染前套一次，之后跟着设置改。
//
// 桌面版走 preload 的 `webFrame.setZoomFactor`（与上游一致）。
//
// 安卓没有 webFrame。试过的三条路各有各的坑，记在这里免得再走一遍：
//   · CSS `zoom`：`position: fixed` 的参考系与 `100vh` 一起被缩，播放条 / 设置页底栏
//     跑到屏幕外或停在中间，右侧导航也会错位。
//   · `zoom` + 根元素 width/height 补偿：仍然错位（根变大后 fixed 以更大的画布为参考）。
//   · viewport `initial-scale`：布局正确，但**只在页面加载时生效**，改挡位后不重排，
//     表现是「只能放大、缩小没反应」。
//
// 现在这条同时满足两件事：`transform: scale()` 只影响渲染，**不改变布局计算**；
// 想让缩小之后不留白，再把宿主按 1/scale 反向放大即可 —— 布局按原尺寸算，画面上铺满。

let installed = false;

/** 缩放作用的宿主：优先 #root（应用本体），没有就用 body。 */
const zoomHost = (): HTMLElement | null => (
    document.getElementById('root') ?? document.body ?? null
);

const applyDomZoom = (factor: number) => {
    const root = document.documentElement;
    const host = zoomHost();
    if (!host) return;
    if (Math.abs(factor - 1) < 0.001) {
        host.style.removeProperty('transform');
        host.style.removeProperty('transform-origin');
        host.style.removeProperty('width');
        host.style.removeProperty('height');
        root.removeAttribute('data-folia-ui-zoom');
        return;
    }
    /*
     * 先按 1/scale 把宿主撑大，再整体 scale 回去：
     * 布局阶段宿主拿到「撑大后」的宽高，缩小渲染之后正好铺满可视区。
     * transform 会为 fixed 子元素建立新的包含块，但宿主与视口同尺寸，两边重合，
     * 所以播放条与设置页底栏仍然贴在屏幕边上。
     */
    host.style.transformOrigin = 'top left';
    host.style.transform = `scale(${factor})`;
    host.style.width = `${100 / factor}%`;
    host.style.height = `${100 / factor}%`;
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
