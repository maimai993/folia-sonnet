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
    /*
     * 玻璃层本体：Sheet 弹层和设置窗口都把它作为独立一层放在面板里
     * （见 issue #279 —— 模糊不能和圆角写在同一个元素上，那样收不住角）。
     * 它们自己带 backdrop-blur 也会被第一条命中，这里显式列出是为了
     * 万一将来哪层忘了写 blur 类也能挂上玻璃。
     */
    '[data-glass-layer]',
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

/*
 * 补一轮：「模糊写在 CSS 文件里」的面。
 *
 * GLASS_SURFACE_SELECTORS 的两条通配是 [class*="backdrop-blur"]（Tailwind 类）
 * 和 [style*="backdrop-filter"]（内联样式），**都看不见写在 .css 文件里的 backdrop-filter**。
 * 结果是这类面一直在用模糊、却从没被液态玻璃接管 —— 它们和旁边的玻璃材质对不上，
 * 而且因为是「自己写死的 blur」，不吃设置里那几根滑杆。
 * .status-toast（statusToast.css）、.lattice-sections-list（LatticeSections.css）都是这种。
 *
 * 这里对已挂载的根下所有元素读一遍计算样式，把「声明了 backdrop-filter 但还没接管」
 * 的挑出来补挂。只在安装/新增节点时跑，不进动画帧，代价可接受。
 */
const injectStylesheetBlur = (root: ParentNode): void => {
    const scope = root instanceof Document ? root.body : root;
    if (!(scope instanceof Element || scope instanceof Document)) return;
    scope.querySelectorAll<HTMLElement>('*').forEach((el) => {
        if (injected.has(el)) return;
        // 已经带了类名通配的元素上面第一轮就挂过了，跳过省一次 getComputedStyle。
        if (el.matches(GLASS_SURFACE_SELECTORS)) return;
        const style = getComputedStyle(el);
        const filter = style.backdropFilter;
        if (!filter || filter === 'none') return;
        // 直角面不接管：折射位移图按元素自身的圆角算（liquidglass.ts 里按 borderRadius 生成），
        // 半径为 0 时整块按直角折射，四角是方的，比它原来那条单纯的模糊还难看。
        // Lattice 的方块列表就是这种 —— 它有意保持方角（见 LatticeSections.css 的注释），
        // 那就让它保留自己写的那层模糊，不换成玻璃材质。
        if (!(parseFloat(style.borderRadius) > 0)) return;
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
    // 启动时补一轮：把「模糊写在 CSS 文件里」的面也接管进来（见 injectStylesheetBlur）。
    injectStylesheetBlur(document);
    if (mo) return;
    mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
            m.addedNodes.forEach((node) => {
                if (node instanceof HTMLElement) {
                    // 新节点自己可能是玻璃，也可能只是装着玻璃的容器，两头都查。
                    injectInto(node);
                    injectStylesheetBlur(node);
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
    /*
     * 按 [data-glass] 收，不按 GLASS_SURFACE_SELECTORS 收。
     *
     * makeGlass 会给每一块挂上的玻璃打这个标记，所以它能覆盖**两条**接入路径：
     * 类名通配命中的，和自己写在 CSS 文件里、被 injectStylesheetBlur 补挂的。
     * 只按选择器收的话，后者（.status-toast、.lattice-sections-list 这类）
     * 关掉玻璃时内联 backdrop-filter 不会被还原，等于开关失灵。
     */
    document.querySelectorAll<HTMLElement>('[data-glass]').forEach((el) => {
        if (!injected.has(el)) return;
        injected.delete(el);
        el.style.removeProperty('backdrop-filter');
        el.style.removeProperty('-webkit-backdrop-filter');
        // 接管前它自己就带模糊的（CSS 文件里写的），把这层原样还回去，
        // 否则关掉液态玻璃后它们会从「有模糊」变成「硬底」。
        const previous = el.getAttribute('data-glass-prev-backdrop');
        if (previous) {
            el.style.setProperty('backdrop-filter', previous);
            el.style.setProperty('-webkit-backdrop-filter', previous);
        }
        el.removeAttribute('data-glass-prev-backdrop');
        // data-glass 是 makeGlass 打的标记，refreshAllGlasses 按它找在场的玻璃。
        // 关掉玻璃后这些面已经不在其中了，标记留着只会让拖滑杆时白白跑一次查询。
        el.removeAttribute('data-glass');
    });
};
