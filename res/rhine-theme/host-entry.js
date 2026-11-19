// res/rhine-theme/host-entry.js
// 改编自 RhinE（https://github.com/ericzhang12111-cell/RhinE，v2.1.1，MIT）。本文件由 Folia 编写。
//
// Entry the iframe in `src/library/suites/rhine/RhineHome.tsx` loads, and the only file of this
// directory that this app owns. Upstream's `js/`, `columns/`, `tokens/` and `online/` are copied in
// unchanged (see RHINE-SOURCE.md); this file reads the host's parameters and the host messages, and
// hands the result to `window.FOLIA_RHINE` (`adapt/rhineHostConfig.js`).
//
// What it does, in order:
//   1. read the host's parameters (`?lang=&theme=&assets=&entry=`) into window.FOLIA_RHINE;
//   2. apply the asset-package switch (adds `data-rhine-assets="bundled"` on <html>; the CSS in
//      adapt/rhineFallback.css is what degrades missing art to flat colour);
//   3. listen for the host's postMessages (language / theme / assets pack / note / insets).
//
// Why a config script at all: Columns UI runs the theme's scripts in foobar2000's own runtime, with
// `fb`, `window`, `plman` and the `include()` helper around. Here the same files would run in a
// WebView with none of that. Nothing in this file pretends otherwise: it does not stub those
// globals, so a script that needs them still fails loudly in its own file instead of half-working.
(function bootstrapRhineHost() {
    'use strict';

    var config = window.FOLIA_RHINE;
    if (!config) return;

    var root = document.documentElement;

    /** 把一次配置写进页面：CSS 看 `data-*`，脚本看 `window.FOLIA_RHINE`。 */
    function apply(patch) {
        var next = patch || {};
        if (next.language) config.language = String(next.language);
        if (next.theme === 'light' || next.theme === 'dark') config.theme = next.theme;
        if (typeof next.assets === 'string' && next.assets) {
            config.assets = next.assets === 'downloaded' ? 'downloaded' : 'bundled';
            config.hasAssetsPackage = config.assets === 'downloaded';
        }
        if (typeof next.assetsBase === 'string') config.assetsBase = next.assetsBase;
        // 宿主的文案（i18n 在 React 那一侧）：资源包缺失时显示在舞台底部。
        if (typeof next.note === 'string') config.note = next.note;
        // 安全区：把宿主的真实值写成 CSS 变量，`adapt/rhineFallback.css` 用它顶掉 env()。
        if (next.insets && typeof next.insets === 'object') {
            config.insets = next.insets;
            ['top', 'right', 'bottom', 'left'].forEach(function (side) {
                var value = Number(next.insets[side]);
                if (Number.isFinite(value) && value >= 0) {
                    root.style.setProperty('--rhine-safe-' + side, value + 'px');
                }
            });
        }

        root.setAttribute('data-rhine-assets', config.hasAssetsPackage ? 'downloaded' : 'bundled');
        root.setAttribute('data-rhine-theme', config.theme);
        root.setAttribute('lang', config.language);
        // 每次 apply 都重取：壳的 DOM 现在就有了，但宿主可能在两次配置之间换掉它。
        var stage = document.querySelector('.rhine-stage');
        if (stage) stage.setAttribute('data-rhine-note', config.note || '');
    }

    apply({});

    // 本脚本排在 <head> 里，跑的时候 <body> 还没解析出来：壳上的属性要等 DOM 就绪后再补一遍，
    // 否则 `data-rhine-note` 永远挂不上（`<html>` 上的属性不受影响，先写先生效）。
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function onShellReady() { apply({}); }, { once: true });
    } else {
        apply({});
    }

    window.addEventListener('message', function onHostMessage(event) {
        var data = event && event.data;
        if (!data || typeof data !== 'object') return;
        // 只认上一级窗口：iframe 没加 sandbox，别的窗口也 post 得进来。
        if (event.source !== window.parent) return;
        if (data.type === 'rhine-config') apply(data.config);
    });
}());
