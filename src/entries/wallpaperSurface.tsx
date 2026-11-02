import React from 'react';
import ReactDOM from 'react-dom/client';

/*
 * 这个 import 不能省。
 *
 * 全局样式（Tailwind 那套工具类）本来是 src/bootstrap.tsx 引的，而壁纸页是**另一个 HTML 入口**，
 * 不经过 bootstrap —— 结果整个壁纸页没有任何工具类生效：`absolute` / `inset-0` / `w-full`
 * 全是空字符串，各模式的容器全是普通流里的 auto 高度，画布被卡在兜底下限（240），
 * 内容跑到屏幕外、被拉伸、甚至整个不显示。
 * 症状很有迷惑性（看起来像窗口尺寸问题），实际是**样式表根本没加载**。
 */
import '../index.css';

import WallpaperSurface from './WallpaperSurfaceView';
import { afterLayout, forceCanvasChainToFill, forceShellToFill, pinToNativeSize } from './wallpaperSurfaceLayout';
import { installGlobalVisualizerFrameRateLimiter } from '../utils/frameRateLimiter';
import { installRenderPixelRatioLimit } from '../utils/renderPixelRatio';
import { syncLyricFlatAttribute, useLyricFlatSettingsStore } from '../stores/useLyricFlatSettingsStore';
import { builtinModRuntimeInfos } from '../mods/builtin/builtinMods';
import { reconcileFoliumClients } from '../mods/runtime/clientLoader';
import { installFoliumFaultNotice } from '../mods/runtime/faultNotice';

/*
 * 把整页底色压回透明。
 *
 * 全局样式（src/index.css）里有一条 `body { background-color: #09090b; }` ——
 * 那是给 App 本体用的底色。壁纸页引了同一份样式表，这一条也跟着生效，
 * 于是整页被刷成一层深灰、把底下的壁纸全糊住（用户看到的就是"灰色遮罩"）。
 *
 * 之前没引样式表时没有这条规则，所以问题看起来像是"引入 CSS 之后才出现的"。
 * 用 !important + 放在 head 末尾，压过样式表里那条。
 */
const forceTransparentBackdrop = () => {
    const style = document.createElement('style');
    style.textContent = `
        html, body, #wallpaper-root {
            background: transparent !important;
            background-color: transparent !important;
        }
    `;
    document.head.appendChild(style);
};

forceTransparentBackdrop();

/*
 * 让「可视化器帧率」这个设置也管到壁纸/叠层这一页。
 *
 * 全局限帧装在 index.tsx 那个入口上，而壁纸页是另一个入口（wallpaper.html），不经过 index.tsx
 * —— 于是桌面上那层叠层一直按屏幕刷新率画（60/90/120Hz），用户在设置里选的 60fps 对它完全无效。
 * 桌面停留时间远长于前台，这一条省下来的正好是最大的一块。
 *
 * 只装限帧，**不装** backgroundRenderGate：那道闸门是「应用退到后台就一帧不画」，
 * 而叠层恰恰要在应用后台时照常画（它画在桌面上，应用在前台还是后台和它无关）。
 * 挂上去就会让桌面歌词在退到后台的瞬间冻住 —— 恰恰把它存在的意义取消了。
 */
installGlobalVisualizerFrameRateLimiter();
/*
 * 渲染分辨率上限同理：壁纸页的歌词画布也是自己算 DPR 的，不装就只剩主窗口受这个设置管。
 */
installRenderPixelRatioLimit();

/*
 * 挂「歌词改为纯色扁平」这个开关。
 *
 * 叠层页面是**另一个 WebView / document**：扁平化认的是**本页** <html> 上的
 * `data-lyric-flat` —— CSS 那一段在 index.css 里（本页引了同一份样式表），
 * canvas 侧（glowBlurQuantize / dioramaTextRaster 等）则读 `utils/lyricFlat` 的
 * `isLyricFlat()`，两边都只看这个属性。
 *
 * 而属性原本只在 store 模块被加载时同步一次，这个入口的依赖树里又没人用到它 ——
 * 于是「扁平歌词」只能在主界面生效，叠层照旧发光 + 渐变染色。
 * 这里挂一份，并在开关变化时跟着更新（幂等，和 store 内部那次重复也没关系）。
 */
syncLyricFlatAttribute(useLyricFlatSettingsStore.getState().flatLyrics);
useLyricFlatSettingsStore.subscribe(state => syncLyricFlatAttribute(state.flatLyrics));

/*
 * 模组也要在这一层起来。
 *
 * 叠层挂的是播放页同一个 VisualizerRenderer，但模组客户端本来只在 src/bootstrap.tsx
 * （主窗口）里启动 —— 于是模组注册的歌词样式与可视化模式在这层 WebView 的注册表里根本不存在，
 * 用户在设置里选了模组样式，桌面这层却画不出来。
 *
 * 这里只起内置模组：叠层没有主进程通道（folia-mod:// 是 Electron 那边的），
 * 用户自己装的模组在这层无从读取。失败不阻塞渲染 —— 画不出模组样式也比整个叠层白屏好。
 */
installFoliumFaultNotice();
void reconcileFoliumClients(builtinModRuntimeInfos(), 'main').catch((error: unknown) => {
    console.warn('[Wallpaper] 内置模组启动失败', error);
});

// src/entries/wallpaperSurface.tsx
// 动态壁纸里那层 WebView 的页面 —— 挂的就是播放页同一个 VisualizerRenderer。
//
// 为什么要有这个页面：播放页的十几个可视化是 PixiJS / three.js 场景，
// 而 WallpaperService 只能往 Surface 上画原生 GLES。想让壁纸「和播放页一模一样」，
// 唯一的办法就是让壁纸跑同一套渲染代码，而不是在 GLES 里照着参数模仿。
//
// 数据分两路：
//  - **静态设置**（模式、不透明度、字体、各模式 tuning）来自 localStorage。
//    叠层页面的 origin 和应用主 WebView 相同（都是 https://localhost），
//    所以这些直接读 store 就有，不需要从原生传一遍。
//  - **动态数据**（当前行、播放位置、播放状态、主题色）由原生每 200ms 注入一次
//    window.__foliaWallpaperPush(...)，页面按 rAF 自己往前插值。

const container = document.getElementById('wallpaper-root');
if (container) {
    pinToNativeSize(container);
    void afterLayout().then(() => {
        // 挂载前先撑一次，挂载后头几秒再补几次 —— 可视化是懒加载的，
        // 画布出现的时机不确定（还在动态 import 里），第一次多半找不到 canvas。
        const fillAll = () => {
            forceShellToFill();
            forceCanvasChainToFill();
        };
        let remaining = 30;
        const timer = window.setInterval(() => {
            fillAll();
            if (--remaining <= 0) window.clearInterval(timer);
        }, 100);
        window.addEventListener('resize', fillAll);
        // 布局落定后再通知一次：可视化内部若监听 resize 重新量尺寸，这一次才是准的。
        window.dispatchEvent(new Event('resize'));
        ReactDOM.createRoot(container).render(
            <React.StrictMode>
                <WallpaperSurface />
            </React.StrictMode>,
        );
    });
}
