// src/utils/appSurface.ts
// Which root this window mounts, decided once from the URL. bootstrap.tsx picks the React root with
// it; features that only make sense in the main app window (the video layer, mod clients) read the
// same answer instead of re-parsing the URL.

// `location` is checked too: unit tests stub a bare `window` without one.
const pageLocation = typeof window === 'undefined' ? undefined : (window.location as Location | undefined);
const searchParams = new URLSearchParams(pageLocation?.search ?? '');

export const isObsBrowserSourceSurface = typeof window !== 'undefined'
    && (searchParams.get('obs') === '1' || pageLocation?.pathname === '/obs');

export const obsSourceKind = searchParams.get('obsSource');

export const isRemoteControlSurface = !isObsBrowserSourceSurface && searchParams.get('remote') === '1';

/** The performance check's window (electron/perfCheck.cjs, components/perfCheck/). */
export const isPerfCheckSurface = !isObsBrowserSourceSurface && !isRemoteControlSurface && searchParams.get('perfCheck') === '1';

/*
 * 壁纸 / 桌面叠层那一页（wallpaper.html，见 src/entries/wallpaperSurface.tsx）。
 *
 * 它是**另一个 HTML 入口**，URL 上没有查询串，所以按下面那条「不是 OBS / 遥控 / 自检就是主应用」
 * 的判据，它会被当成主应用 —— 于是那层叠层里也跟着挂上了「歌词后方的视频层」：桌面叠层本该只有
 * 歌词与壁纸，多出来的视频块是 issue #399 报的第一半。更要紧的是第二半：那一页也会去
 * ensureVideoLayerFileRestored()，而桌面端本地视频是一份 File System Access 的句柄，
 * 第二个窗口没有用户手势就打不开 → 主窗口那边看着就是「视频层加载不出来」。
 */
export const isWallpaperSurface = typeof window !== 'undefined'
    && /\/wallpaper\.html$/.test(pageLocation?.pathname ?? '');

export const isMainAppSurface = typeof window !== 'undefined'
    && !isObsBrowserSourceSurface
    && !isRemoteControlSurface
    && !isPerfCheckSurface
    && !isWallpaperSurface;
