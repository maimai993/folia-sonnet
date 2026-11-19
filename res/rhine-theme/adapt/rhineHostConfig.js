// res/rhine-theme/adapt/rhineHostConfig.js
// 改编自 RhinE（https://github.com/ericzhang12111-cell/RhinE，v2.1.1，MIT）。本文件由 Folia 编写。
//
// 主题骨架和 Folia 之间唯一的配置对象，挂在 `window.FOLIA_RHINE`。上游代码不读这个文件；
// 宿主侧需要传给主题的一切（语言、明暗、资源包在不在、从哪一屏进）都收在这个对象里。
//
// Kept as a classic script (not a module) on purpose: the theme's own files are classic scripts that
// call `include()` / declare globals, so this must be evaluated first and in the same global scope.
(function initRhineHostConfig() {
    'use strict';
    if (window.FOLIA_RHINE) return;

    var params = new URLSearchParams(window.location.search);
    // 资源包是运行时可选的下载（见 RHINE-ASSETS.md 与 issue #440）。没有它的时候没有任何代码会去
    // 请求 `assets/...`，`adapt/rhineFallback.css` 用纯色撑住画面。
    var assetsParam = params.get('assets');
    var packaged = assetsParam === '1' || assetsParam === 'available';

    window.FOLIA_RHINE = {
        /** 'bundled'：只有仓库里的骨架；'downloaded'：用户下载过资源包。 */
        assets: packaged ? 'downloaded' : 'bundled',
        /** 资源根目录前缀；'' 表示页面同目录。 */
        assetsBase: '',
        /** 资源包在不在（`assets === 'downloaded'` 的派生值，读的地方不用自己比字符串）。 */
        hasAssetsPackage: packaged,
        /** 界面语言（BCP 47）；主题不支持时退回英文。 */
        language: params.get('lang') || 'en',
        /** 'light' | 'dark'，跟 Folia 的明暗设置走。 */
        theme: params.get('theme') === 'light' ? 'light' : 'dark',
        /** 从哪一屏进：'boot' 播开场，'archive' 直接进档案。 */
        entry: params.get('entry') === 'archive' ? 'archive' : 'boot',
        /** 安全区（逻辑像素）：安卓 WebView 里 env(safe-area-inset-*) 报 0，真实值由原生侧送进来。 */
        insets: {},
        /** 宿主给的提示文案（资源包缺失等），由 React 那一侧按 i18n 传进来。 */
        note: params.get('note') || '',
    };
}());
