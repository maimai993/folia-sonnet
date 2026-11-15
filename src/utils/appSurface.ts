// src/utils/appSurface.ts
// Which root this window mounts, decided once from the URL. bootstrap.tsx picks the React root with
// it; features that only make sense in the main app window (the video layer, mod clients) read the
// same answer instead of re-parsing the URL.

const searchParams = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);

export const isObsBrowserSourceSurface = typeof window !== 'undefined'
    && (searchParams.get('obs') === '1' || window.location.pathname === '/obs');

export const obsSourceKind = searchParams.get('obsSource');

export const isRemoteControlSurface = !isObsBrowserSourceSurface && searchParams.get('remote') === '1';

/**
 * 桌面歌词的网页叠层。
 *
 * 这个页面和主应用同源（都是 https://localhost），只靠 origin 分不开，
 * 所以看路径：原生加载的是 /wallpaper.html?w=..&h=..
 * （见 WallpaperOverlay 的 PAGE_URL）。
 *
 * 为什么要单独认出来：叠层复用的是同一个 VisualizerRenderer，
 * 而视频层默认只在「主界面」渲染 —— 不排除叠层的话它会被当成主界面，
 * 于是桌面歌词后面也去加载那段视频。那段视频是给主 WebView 用的，
 * 叠层这个 WebView 读不到它的本地句柄，加载失败就只剩一个暂停标志。
 */
export const isWallpaperOverlaySurface = typeof window !== 'undefined'
    && !isObsBrowserSourceSurface
    && window.location.pathname === '/wallpaper.html';

/*
 * 「主界面」= 真正那个应用窗口。
 *
 * 叠层和 OBS 源都不算：它们各有各的渲染规矩，
 * 视频层这类只该在主窗口出现的东西必须被排除在外。
 */
export const isMainAppSurface = typeof window !== 'undefined'
    && !isObsBrowserSourceSurface
    && !isRemoteControlSurface
    && !isWallpaperOverlaySurface;
