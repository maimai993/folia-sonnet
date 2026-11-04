import { installGlassJelly, installGlassLight, makeGlass } from './liquidglass';

// src/shinoinject/injectGlassSurfaces.ts
// 把液态玻璃挂到全站的玻璃面板上。面板散落在各处，还有不少是第三方组件自带的，逐个组件加
// data-glass 必然漏；这里按与外观同源的玻璃选择器找出玻璃面板，统一 makeGlass。

// 全站的玻璃面。分三类：
//  1) 已经自带半透明/模糊的面（backdrop-blur-*、内联 backdrop-filter）—— 直接挂滤镜。
//  2) 项目自己的玻璃类（theme-glass-panel、拍立得卡、各 suite 的下拉与胶囊）—— 这些背景在
//     index.css 里被压透过（见那里的 data-liquid-glass 规则），挂上才有东西可折射。
//  3) 舞台 / 资料库墙这类固定结构。
// 用属性选择器而不是逐组件写 data-glass：面板散落在几十个组件里，还有第三方组件自带的，
// 枚举一遍必然漏，新加的面也会漏。这里只按「看起来是玻璃」的类名找，漏了补一条即可。
const GLASS_SURFACE_SELECTORS = [
    // 已经带模糊的面。
    '[class*="backdrop-blur"]',
    '[style*="backdrop-filter"]',
    // 项目自己的玻璃类。
    '.theme-glass-panel',
    '.theme-polaroid-card',
    // 播放页右下角那张正在播放的卡（NowPlayingToast / 悬浮播放条）。
    '[data-now-playing-card]',
    // 首页顶部与页面切换的胶囊、下拉、搜索框（Grid3D / GridViewTabs / GridHomeActions）。
    '[data-folia-grid-tabs]',
    '[data-grid3d-slider-root] .theme-polaroid-card',
    // 资料库墙与舞台。
    '.lattice-back',
    '.lattice-tools-panel',
    '.lattice-tools-island',
    '.bravais-root.has-seam-blur .bravais-seam',
    '.bravais-root.has-seam-blur .bravais-seam-tab',
    '.bravais-focus-menu',
].join(', ');

// 已挂过玻璃的元素集合（WeakMap 在 liquidglass 内部，这里用 WeakSet 做幂等与撤销）。
const injected = new WeakSet<HTMLElement>();

let mo: MutationObserver | null = null;

const injectInto = (root: ParentNode): void => {
    root.querySelectorAll<HTMLElement>(GLASS_SURFACE_SELECTORS).forEach((el) => {
        if (injected.has(el)) return;
        // makeGlass 幂等（liquidglass 内部也查重），这里再用 WeakSet 记住以便撤销时统一收掉。
        injected.add(el);
        makeGlass(el);
    });
};

/** 液态玻璃总开关：挂载滤镜、监听 DOM 变化，让新出现的面板（弹层、命令面板）也立刻生效。 */
export const installGlassSurfaces = (): void => {
    if (typeof document === 'undefined') return;
    installGlassJelly();
    installGlassLight();
    injectInto(document);
    if (mo) return;
    mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
            m.addedNodes.forEach((node) => {
                if (node instanceof HTMLElement) {
                    // 新节点自己可能是玻璃，也可能只是装着玻璃的容器，两头都查。
                    injectInto(node);
                    if (node.matches?.(GLASS_SURFACE_SELECTORS)) {
                        injected.add(node);
                        makeGlass(node);
                    }
                }
            });
        }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
};

/** 关掉液态玻璃：收掉观察者，把在场玻璃的 backdrop-filter 还原（滤镜记录留在 liquidglass 里，可复挂）。 */
export const removeGlassSurfaces = (): void => {
    if (typeof document === 'undefined') return;
    if (mo) {
        mo.disconnect();
        mo = null;
    }
    document.querySelectorAll<HTMLElement>(GLASS_SURFACE_SELECTORS).forEach((el) => {
        if (!injected.has(el)) return;
        injected.delete(el);
        el.style.removeProperty('backdrop-filter');
        el.style.removeProperty('-webkit-backdrop-filter');
    });
};
