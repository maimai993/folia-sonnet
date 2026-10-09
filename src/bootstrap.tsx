import React from 'react';
import ReactDOM from 'react-dom/client';
import './i18n/config';
import './index.css';
// 手机适配的整套覆盖样式。规则全部由 <html data-folia-phone-fit='true'> 门控，
// 开关关着时这里等于一张空表，上游桌面布局不会被碰到。放在 bootstrap 而不是 App 里，
// 是为了让下面按 URL 挂的几个根（远程控制 / OBS）也能拿到同样的属性语义。
import './styles/androidPhoneFit.css';
import App from './App';
import AppSplashGate from './components/AppSplashGate';
import RemoteControlApp from './components/remote/RemoteControlApp';
import ObsBrowserSourceApp from './components/obs/ObsBrowserSourceApp';
import ObsNowPlayingSourceApp from './components/obs/ObsNowPlayingSourceApp';
import ObsPlayerCapSourceApp from './components/obs/ObsPlayerCapSourceApp';
import { initializeLocalCoverRuntime } from './services/localCoverRuntime';
import { initFoliumClients } from './mods/folium/clientLoader';
import { restoreSavedFoliumSelections } from './mods/folium/missingEntries';
import { installFoliumCommandPaletteSync } from './mods/folium/commandPaletteSync';
import { installFoliumHostEvents } from './mods/folium/hostEvents';
import { installNativeDragGuard } from './utils/nativeDragGuard';
import { isMainAppSurface, isObsBrowserSourceSurface, isRemoteControlSurface, obsSourceKind } from './utils/appSurface';
// 副作用 import：store 在模块加载时就把 `<html data-reduce-motion>` 写好并保持同步。放在 bootstrap
// 而不是 App 里，是因为下面按 URL 挂的根不止 App —— 远程控制窗口的进度辉光也读这个属性。
import './stores/useMotionSettingsStore';

// src/bootstrap.tsx
// Mounts the React app after index.tsx installs runtime-level browser shims.

// A mod visualizer or background saved to localStorage can only survive a
// restart if its registry entry exists before the settings store validates the
// stored mode. The store initializes eagerly through the static import graph,
// so the mode it read may already have fallen back to a builtin; after mod
// clients register their entries we restore the saved selections
// (src/mods/folium/missingEntries.ts, which also re-runs on every mod reload).

// #394: with a selection on the page, native drag-and-drop would hijack slider gestures. Installed
// here, for every surface this bundle mounts, rather than inside App so the remote-control and OBS
// roots are covered too and App.tsx does not grow. See utils/nativeDragGuard.ts.
installNativeDragGuard();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
const isObsBrowserSource = isObsBrowserSourceSurface;
// obsSource=now-playing / playercap: static OBS overlay that connects directly to NowPlaying / PlayerCap in the browser (no Electron SSE relay).
const isNowPlayingObsSource = isObsBrowserSource && obsSourceKind === 'now-playing';
const isPlayerCapObsSource = isObsBrowserSource && obsSourceKind === 'playercap';
const isRemoteControl = isRemoteControlSurface;
// Mod clients belong to the main app window only. The remote-control window
// also has the Electron bridge, but mod state pushes only reach the main
// window, so a client activated there would never be torn down.
const isMainApp = isMainAppSurface;
const renderApp = () => root.render(
    <React.StrictMode>
      <AppSplashGate>
        {isNowPlayingObsSource
          ? <ObsNowPlayingSourceApp />
          : isPlayerCapObsSource
            ? <ObsPlayerCapSourceApp />
            : isObsBrowserSource
              ? <ObsBrowserSourceApp />
              : isRemoteControl
                ? <RemoteControlApp />
                : <App />}
      </AppSplashGate>
    </React.StrictMode>
  );

const bootFolium = async () => {
    if (!isMainApp) return;
    installFoliumCommandPaletteSync();
    installFoliumHostEvents();
    await initFoliumClients();
    restoreSavedFoliumSelections();
};

// 启动链上的每一步都是 await 串起来的，而 #app-splash 遮罩要等 renderApp 跑完才移除。
// 只要其中任何一步不 settle（WebView 里的 serviceWorker.ready、Dexie 打开、某个 host
// 桥调用），遮罩就会永久停在首屏动画上，而且控制台可能一条错误都没有——比崩溃更难排查。
// 这里给整条链套一个兜底超时：先渲染出界面，迟到的初始化结果被忽略。
const BOOT_RENDER_FALLBACK_MS = 8_000;
let hasRendered = false;
const renderOnce = () => {
    if (hasRendered) return;
    hasRendered = true;
    renderApp();
};
const bootFallbackTimer = setTimeout(renderOnce, BOOT_RENDER_FALLBACK_MS);
// 正常路径下这个定时器必然会被 renderOnce 抢跑或在同一轮事件循环里失效，不必留着。
void bootFolium()
    .catch((error) => {
        console.error('[bootstrap] Folium initialization failed; continuing to render.', error);
    })
    .finally(() => {
        void initializeLocalCoverRuntime()
            .catch((error) => {
                console.error('[bootstrap] Local cover runtime failed; continuing to render.', error);
            })
            .finally(() => {
                clearTimeout(bootFallbackTimer);
                renderOnce();
            });
    });
