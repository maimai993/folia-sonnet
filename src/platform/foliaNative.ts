import { Capacitor, registerPlugin } from '@capacitor/core';

// src/platform/foliaNative.ts
// 通用原生插件（FoliaNative）的 Web 侧入口。
//
// 这里只放那些不属于某个具体功能（壁纸 / 状态栏歌词）的小动作：退出、屏幕常亮，
// 以及应用内更新的下载与安装。它们共同点是「只有原生能做，且不需要知道播放器里
// 发生了什么」。

/** 一次插件事件监听的句柄。 */
export type FoliaNativeListenerHandle = { remove: () => Promise<void> };

/** 当前跑在 Capacitor Android WebView 里（原生插件桥可用）。 */
const isCapacitorAndroid = (): boolean => (
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
);

/** 更新包下载进度：原生侧每 100ms 推一次，直到 done。 */
export type UpdateDownloadProgress = {
    receivedBytes: number;
    /** 服务端没给 Content-Length 时为 0。 */
    totalBytes: number;
    /** 0-100；总量未知时为 -1 —— UI 据此切成「已下载 X MB」而不是百分比。 */
    percent: number;
    done: boolean;
};

/**
 * 原生桥 `httpRequest` 的返回。headers 两种形状都可能出现（见 FoliaNativePlugin 那边）。
 *
 * 响应体是二选一（#262）：文本类回 `bodyText`，其余回 `bodyBase64`。读它一律走
 * `nativePayloadBytes` / `decodeNativePayload`，不要自己猜是哪一种。
 */
export type NativeHttpResponse = {
    status: number;
    headers?: Array<{ name?: string; value?: string }> | Record<string, string>;
    /** 文本类响应：原生已按 UTF-8 解好（严格解码失败时会退回 base64）。 */
    bodyText?: string;
    bodyBase64?: string;
    /** 原生读到的实际字节数；排查「谁把响应撑大了」时用。 */
    byteLength?: number;
};

interface FoliaNativePlugin {
    /** 销毁 Activity，结束这次会话。设置里的「退出」才用它，返回键不用 —— 见 moveToBackground。 */
    exitApp(): Promise<void>;
    /**
     * 把整个任务挪到后台（等价于按 Home 键），Activity 与播放状态都留着。
     *
     * 返回键走到主界面时该是它而不是 exitApp：这是个播放器，按返回时歌还在放，
     * 销毁 Activity 等于把页面、播放页、搜索结果全扔掉，下次进来一切从头。
     */
    moveToBackground(): Promise<void>;
    /**
     * 可视化歌词页面专用：隐藏系统栏（状态栏 + 导航栏）。
     *
     * 传 false 恢复显示。**默认是显示** —— 只有 Web 层明确说「现在是歌词页」时才隐藏，
     * 首页 / 搜索 / 设置这些页面状态栏一直在（时间、电量、通知图标要看得见）。
     * 判定在 Web 层做：原生不知道哪个页面算歌词页，这里只负责把结论送过去。
     */
    setImmersive(options: { immersive: boolean }): Promise<void>;
    /**
     * 系统栏的**常驻**策略：true = 不管在哪个页面都把状态栏收起来。
     *
     * 平板（屏一直够宽）与手机横屏（高度本来就小）都走这一条 —— 那两种情况下状态栏
     * 只是白占一条，还压着内容。手机竖屏才需要留着（时间 / 电量 / 通知图标）。
     * 与 setImmersive 是**或**的关系：歌词页本来就要隐，这里只是让它在别的页面也隐。
     */
    setSystemBarsPolicy(options: { alwaysHidden: boolean }): Promise<void>;
    /**
     * 屏幕常亮开关。
     *
     * 传进来的值必须是**已经算好的结论**（开关 && 正在播放）：原生那边的 FLAG 只有
     * 开和关，它不该、也不知道「什么算在播」。
     */
    setScreenAwake(options: { awake: boolean }): Promise<void>;
    /**
     * 「HDR 投影」的显示那一半：亮度顶到最亮。
     *
     * 亮度是 **Activity 窗口** 的属性，WebView 里改不动，所以走这里。原生那半做两件事：
     * 窗口级覆盖（不用任何权限，总能做）+ 拿到 WRITE_SETTINGS 时顺手把系统亮度也顶满。
     * 只有前者生效时，设置里那个滑块是不动的，带自动亮度的 ROM 还可能把它压回去 ——
     * 所以结果要报回来，界面上才好提示。
     */
    setDisplayBoost(options: { boost: boolean }): Promise<DisplayBoostResult>;
    /**
     * 音频焦点策略：是否允许后台与其他音源同时播放。
     *
     * 值要**落盘**（见原生 FoliaAudioFocus）：WebView 是在下一次请求音频焦点时才来
     * 向 Application 要 AudioManager 的，启动时 Web 侧根本还没跑到，只有磁盘上的值
     * 能决定第一次给出去的是哪一个。
     */
    setAudioFocusPolicy(options: { mixWithOthers: boolean }): Promise<void>;
    /**
     * 下载更新包。
     *
     * 落在 App 私有缓存目录（无需存储权限），进度通过 `updateDownloadProgress` 事件
     * 往外推；返回的路径直接喂给 {@link installUpdate}。
     */
    downloadUpdate(options: { url: string; fileName: string }): Promise<{ path: string; bytes: number }>;
    /**
     * 把下载好的包交给系统安装器。
     *
     * `status: 'permission-required'` 表示 Android O+ 上「允许来自此来源的应用」还没开，
     * 原生侧已经把设置页拉起来了 —— 用户授权回来再点一次即可，界面要把这句话说清楚。
     */
    installUpdate(options: { path: string }): Promise<{ status: string }>;
    /** 用原生 OkHttp 发一次请求，不受 WebView 的 CORS 限制。 */
    httpRequest(options: {
        url: string;
        method: string;
        headers: Record<string, string>;
        bodyText: string;
        bodyBase64: string;
        redirect: string;
        timeoutMs?: number;
        /** 允许回传的最大字节数；原生还会按硬上限再夹一次（见 FoliaNativePlugin）。 */
        maxBytes?: number;
        /** auto（默认，按 Content-Type 猜）| text | base64。 */
        responseMode?: 'auto' | 'text' | 'base64';
    }): Promise<NativeHttpResponse>;
    /** 往 WebView 的 cookie 罐里写一条。`<img>` / `<audio>` 加不了请求头，只能靠它带凭据。 */
    cookiesSet(options: {
        url: string;
        name: string;
        value: string;
        path?: string;
        domain?: string;
    }): Promise<{ ok?: boolean }>;
    /** 删一条 cookie（Max-Age=0）。 */
    cookiesRemove(options: { url: string; name: string }): Promise<{ ok?: boolean }>;
    /**
     * 弹一条系统小气泡（Toast）。
     *
     * 界面在后台时它是唯一看得见的提示方式：Web 层的提示条挂在页面里，回到前台才显示，
     * 而播放出错（试听限制、登录过期、网络断了）恰恰都在后台发生。
     */
    showToast(options: { text: string; long?: boolean }): Promise<void>;
    /**
     * 弹一条**自己画**的悬浮提示条，样子照 Web 层那条提示，贴屏幕下边。
     *
     * 与 `showToast` 的区别：系统 Toast 从 Android 11 起后台只给纯文本，画不出我们想要
     * 的样子；这条路能画，但要先有「显示在其他应用上层」的授权。
     *
     * 回 `shown`：没授权 / 窗口令牌失效时是 false，调用方据此回退到系统 Toast。
     * **不是**报错 —— 一句提示弹不出来不该让调用方以为出了故障。
     */
    showOverlayNotice(options: { text: string; durationMs?: number }): Promise<{ shown?: boolean }>;
    /**
     * 歌词后方视频层：挑一个本地视频。
     *
     * 原生拿到 URI 自己拷进 App 私有目录，这里只拿「成没成」和一个回环地址 ——
     * 视频动辄几十上百 MB，字节绝不过桥。选了却用不了（太大 / 读不出来）是 `rejected`，
     * 与用户取消（`picked` 与 `rejected` 都假）分开，界面才好分别给提示。
     */
    pickVideoLayerFile(): Promise<{ picked?: boolean; rejected?: boolean; name?: string; url?: string }>;
    /** 下载网络视频并存成视频层文件（市场背景用）。 */
    downloadVideoLayerFile(options: { url: string; progressId?: string }): Promise<{
        stored?: boolean;
        name?: string;
        url?: string;
        /** 落盘后的真实路径（`url` 是回环播放地址，文件操作要用这个）。 */
        path?: string;
        error?: string;
    }>;
    /**
     * 挑过的那个视频此刻还在不在，地址是什么。
     *
     * 地址里带着本地服务的端口，而端口每次启动都可能不同（原生那边是端口 0 由系统分配），
     * 所以这个地址**不能存死**：每次启动都要重新问一次。
     */
    getVideoLayerFile(): Promise<{ has?: boolean; name?: string; url?: string }>;
    /** 删掉原生那一份视频副本（设置里的「清除本地视频」）。 */
    clearVideoLayerFile(): Promise<void>;
    addListener(
        eventName: 'updateDownloadProgress',
        listener: (progress: UpdateDownloadProgress) => void,
    ): Promise<FoliaNativeListenerHandle>;
    /**
     * 视频层文件（`downloadVideoLayerFile`）的下载进度，`percent` 是 0-100。
     *
     * 原生发在**这个**插件上，和 FoliaWallpaper 那个同名事件不是一个来源，
     * 两边各订各的（见 services/backgroundMarket/progress.ts）。
     */
    addListener(
        eventName: 'videoDownloadProgress',
        listener: (progress: { id?: string; percent?: number }) => void,
    ): Promise<FoliaNativeListenerHandle>;
}

const FoliaNative = registerPlugin<FoliaNativePlugin>('FoliaNative');

/**
 * 当前手上有没有「真正把应用关掉」这条路。
 *
 * 桌面端 Electron 给 quitApp；安卓这边是 exitApp（销毁 Activity）。浏览器里两者都没有，
 * 界面上就不该摆「退出应用」这一项 —— 摆了也只能 silently 退化成暂停，不如说清楚。
 */
export const canExitApp = (): boolean => (
    isCapacitorAndroid() || Boolean(window.electron?.quitApp)
);

/**
 * 定时关闭的「退出应用」。
 *
 * 走 Async 顺序（await 抛错才 return false，不是 reject）。失败由调用方自己兜底：
 * 到点了却退不掉，至少得把播放停了，而不是假装什么都没发生。
 */
export const requestAppExit = async (): Promise<boolean> => {
    if (isCapacitorAndroid()) {
        try {
            await FoliaNative.exitApp();
            return true;
        } catch {
            return false;
        }
    }
    if (window.electron?.quitApp) {
        try {
            return await window.electron.quitApp();
        } catch {
            return false;
        }
    }
    return false;
};

/**
 * 进出可视化歌词页面时切换系统栏。
 *
 * 只有歌词页需要整块屏幕；其余页面状态栏一直显示。
 * 窗口布局本身始终是边到边（targetSdk 36 强制），这里切的只是**可见性** ——
 * 栏位该让出的空间由 CSS 的安全区变量负责，不受影响。
 */
export const setNativeImmersive = async (immersive: boolean): Promise<void> => {
    try {
        await FoliaNative.setImmersive({ immersive });
    } catch {
        // 桌面端 / 插件没注册：静默。系统栏可见性不该影响播放本身。
    }
};

/**
 * 让屏幕保持常亮（或交还给系统）。
 *
 * 用窗口的 FLAG_KEEP_SCREEN_ON 而不是 WakeLock（见原生那边的说明）：
 * 这个标记只在**我们的窗口在前台**时有效，应用退到后台后系统照常熄屏 ——
 * 所以根本不存在「忘了关就一直耗电」这回事，也不需要在生命周期里到处补释放。
 */
export const setScreenAwake = async (awake: boolean): Promise<void> => {
    try {
        await FoliaNative.setScreenAwake({ awake });
    } catch {
        // 桌面端 / 插件不可用：静默，屏幕常亮不该影响播放本身。
    }
};

/** 亮度那半落地的结果：「系统亮度写没写进去」与「有没有那个权限」。 */
export type DisplayBoostResult = {
    /** 系统设置里的亮度真的被顶满了（窗口覆盖总是会做，不体现在这里）。 */
    systemBrightness: boolean;
    /** WRITE_SETTINGS 授权拿到了没有 —— 没拿到就是只有窗口覆盖那一条在起作用。 */
    canWriteSettings: boolean;
};

/**
 * 「HDR 投影」的显示那一半：最高亮度（见 FoliaNativePlugin.setDisplayBoost）。
 *
 * 失败一律静默 —— 桌面端 / 老版本 App 没有这个方法，而**横屏与镜像那两半照旧生效**，
 * 整个开关不该因为亮度够不着就看起来是坏的。够不着就按「什么都没做成」报回去。
 */
export const setDisplayBoost = async (boost: boolean): Promise<DisplayBoostResult> => {
    try {
        const result = await FoliaNative.setDisplayBoost({ boost });
        return {
            systemBrightness: result?.systemBrightness === true,
            canWriteSettings: result?.canWriteSettings === true,
        };
    } catch {
        // 同上：亮度不该影响界面本身能不能用。
        return { systemBrightness: false, canWriteSettings: false };
    }
};

/**
 * 告诉原生「要不要允许与其他音源同时播放」。
 *
 * 非 Android 没有这一层（桌面端没有音频焦点这回事），失败一律静默。
 */
export const setAudioFocusPolicy = async (mixWithOthers: boolean): Promise<void> => {
    try {
        await FoliaNative.setAudioFocusPolicy({ mixWithOthers });
    } catch {
        // 同上：策略推不过去最多是保持现状，不该打断设置流程。
    }
};

/**
 * 系统栏的常驻策略：平板 / 手机横屏把状态栏收起来。
 *
 * 判定在 Web 层（设备类型 + 朝向），原生只执行。非 Android 没有这一层，静默。
 */
export const setSystemBarsAlwaysHidden = async (alwaysHidden: boolean): Promise<void> => {
    try {
        await FoliaNative.setSystemBarsPolicy({ alwaysHidden });
    } catch {
        // 桌面端 / 插件不可用：静默，系统栏怎么显不该影响其它功能。
    }
};

/**
 * 弹一条系统小气泡。
 *
 * 失败一律静默：非 Android（桌面端 / 浏览器）本来就没有这个通道，插件没注册也一样 ——
 * 这些平台上界面就在眼前，Web 层的提示条够用了。
 */
export const showNativeToast = async (text: string, options: { long?: boolean } = {}): Promise<void> => {
    if (!isCapacitorAndroid() || !text) return;
    try {
        await FoliaNative.showToast({ text, ...(options.long ? { long: true } : {}) });
    } catch (error) {
        console.warn('[FoliaNative] showToast failed', error);
    }
};

/**
 * 弹一条自己画的悬浮提示条。**返回有没有真的挂上去。**
 *
 * 为什么要回这个值：悬浮窗要「显示在其他应用上层」的授权，而授权是用户在系统设置里
 * 给的 —— 没给就是没给。调用方拿 false 就该退回系统 Toast，别让「放不出来」这件事
 * 因为换了更好看的通道反而说不出口。
 *
 * 老包（还没这个方法）/ 桌面端一律 false：那里本来就该走别条路。
 */
export const showNativeOverlayNotice = async (
    text: string,
    options: { durationMs?: number } = {},
): Promise<boolean> => {
    if (!isCapacitorAndroid() || !text) return false;
    try {
        const result = await FoliaNative.showOverlayNotice({
            text,
            ...(options.durationMs ? { durationMs: options.durationMs } : {}),
        });
        return result?.shown === true;
    } catch {
        // 插件没这个方法（老包）/ 桥没起来：都不算错误，只是这条路走不通。
        return false;
    }
};

/** 视频层挑到的那一个：名字是给设置里看的，地址是给 <video> 用的。 */
export type NativeVideoLayerFile = { name: string; url: string };

/**
 * 挑一次的结果。'rejected' 是「选了文件却用不了」（太大 / 读不出来），
 * 与用户取消（'cancelled'）分开 —— 前者要给提示，后者什么都不说。
 */
export type NativeVideoLayerPick =
    | { status: 'applied'; name: string; url: string }
    | { status: 'rejected' }
    | { status: 'cancelled' };

/** 挑一个视频当歌词后方的视频层：原生拷进私有目录后回它的回环地址。 */
export const pickNativeVideoLayerFile = async (): Promise<NativeVideoLayerPick> => {
    if (!isCapacitorAndroid()) return { status: 'cancelled' };
    try {
        const result = await FoliaNative.pickVideoLayerFile();
        if (result?.picked && result.url) {
            return { status: 'applied', name: result.name ?? '', url: result.url };
        }
        return result?.rejected ? { status: 'rejected' } : { status: 'cancelled' };
    } catch (error) {
        console.warn('[FoliaNative] pickVideoLayerFile failed', error);
        return { status: 'cancelled' };
    }
};

/**
 * 把一个网络视频下载成视频层文件。
 *
 * 走原生：视频地址多半带签名和防盗链，直接塞给 <video> 播，
 * 过几天签名过期就黑屏；而且边走边播容易被限速卡顿。
 * 下载完后原生会把它放进视频层自己的位置，回一个回环地址。
 *
 * @returns 成功时的回环地址与显示名；失败时 error 有说明。
 */
export const downloadNativeVideoLayerFile = async (
    url: string,
    progressId?: string,
): Promise<{ ok: boolean; url: string | null; name: string | null; error: string | null; path: string | null }> => {
    if (!isCapacitorAndroid()) {
        return { ok: false, url: null, name: null, error: '仅安卓支持', path: null };
    }
    try {
        const result = await FoliaNative.downloadVideoLayerFile({ url, progressId });
        if (result?.stored && result.url) {
            /*
             * path 是落盘后的真实路径，交给壁纸层做「安装」用。
             *
             * url 是回环播放地址，文件操作拿不到它。市场里两个目标同时勾选时，
             * 靠这个路径避免同一个视频下两遍（FoliaWallpaper.adoptDownloadedVideo）。
             */
            return { ok: true, url: result.url, name: result.name ?? '', error: null, path: result.path ?? null };
        }
        return { ok: false, url: null, name: null, error: result?.error ?? '视频下载失败', path: null };
    } catch (error) {
        console.warn('[FoliaNative] downloadVideoLayerFile failed', error);
        return { ok: false, url: null, name: null, error: (error as Error)?.message ?? '视频下载失败', path: null };
    }
};

/** 上一次挑的那个视频还在不在（重启后靠它把地址重新拿回来）。 */
export const readNativeVideoLayerFile = async (): Promise<NativeVideoLayerFile | null> => {
    if (!isCapacitorAndroid()) return null;
    try {
        const result = await FoliaNative.getVideoLayerFile();
        if (!result?.has || !result.url) return null;
        return { name: result.name ?? '', url: result.url };
    } catch (error) {
        console.warn('[FoliaNative] getVideoLayerFile failed', error);
        return null;
    }
};

/** 删掉原生那一份副本。非 Android 没有这一层，静默。 */
export const clearNativeVideoLayerFile = async (): Promise<void> => {
    if (!isCapacitorAndroid()) return;
    try {
        await FoliaNative.clearVideoLayerFile();
    } catch (error) {
        console.warn('[FoliaNative] clearVideoLayerFile failed', error);
    }
};

/** 监听更新包下载进度；句柄记得在组件卸载时 remove。 */
export const watchUpdateDownloadProgress = (
    listener: (progress: UpdateDownloadProgress) => void,
): Promise<FoliaNativeListenerHandle> => (
    FoliaNative.addListener('updateDownloadProgress', listener)
);

/** 下载更新包。文件名由原生侧清洗，这里只需保证带版本号即可。 */
export const downloadUpdate = (
    options: { url: string; fileName: string },
): Promise<{ path: string; bytes: number }> => FoliaNative.downloadUpdate(options);

/**
 * 监听 `downloadVideoLayerFile` 的下载进度（0..1）。
 *
 * 原生在 `FoliaNativePlugin` 上发 `videoDownloadProgress`，**不是** FoliaWallpaper
 * 那个同名事件 —— 桌面壁纸和 App 内的视频下载分别发在两处，各自要订各的。
 * 以前只订了壁纸那一侧，所以「选 App 内」时进度条永远是 0%。
 *
 * 返回取消订阅的函数，组件卸载时要调用。
 */
export const subscribeNativeVideoLayerProgress = async (
    listener: (progress: number) => void,
): Promise<() => void> => {
    if (!isCapacitorAndroid()) return () => {};
    try {
        const handle = await FoliaNative.addListener('videoDownloadProgress', (payload) => {
            const percent = payload?.percent;
            if (typeof percent === 'number' && Number.isFinite(percent)) {
                listener(Math.min(1, Math.max(0, percent / 100)));
            }
        });
        return () => {
            try {
                handle?.remove();
            } catch {
                // 已经卸载过了。
            }
        };
    } catch {
        return () => {};
    }
};

/** 拉起系统安装器。 */
export const installUpdate = (
    options: { path: string },
): Promise<{ status: string }> => FoliaNative.installUpdate(options);

/** base64 里偶尔会带换行（Java 的 MIME 编码器），atob 不认，先清掉。 */
const body64Safe = (value: string): string => value.replace(/\s+/g, '');

/** 原生桥给的 base64 → 字节。空值给空数组。 */
export const nativeBase64ToBytes = (bodyBase64?: string): Uint8Array => {
    if (!bodyBase64) return new Uint8Array();
    const binary = atob(body64Safe(bodyBase64));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
};

/** 原生桥给的 base64 响应体 → UTF-8 文本。清单里可能有中文更新日志，必须按 UTF-8 解。 */
export const decodeNativeBody = (bodyBase64?: string): string => (
    new TextDecoder().decode(nativeBase64ToBytes(bodyBase64))
);

/**
 * 原生回包 → 字节。
 *
 * 文本类响应原生直接给 `bodyText`（#262），这里按 UTF-8 编回字节即可 —— 不再走
 * 「先 base64 再 atob」那条 1.33× 的往返；二进位才是 `bodyBase64`。
 */
export const nativePayloadBytes = (payload: NativeHttpResponse | null | undefined): Uint8Array => {
    if (!payload) return new Uint8Array();
    if (typeof payload.bodyText === 'string') return new TextEncoder().encode(stripUtf8Bom(payload.bodyText));
    return nativeBase64ToBytes(payload.bodyBase64);
};

/** 原生回包 → UTF-8 文本（文本响应直接用原生解好的那一份）。 */
export const decodeNativePayload = (payload: NativeHttpResponse | null | undefined): string => {
    if (!payload) return '';
    if (typeof payload.bodyText === 'string') return stripUtf8Bom(payload.bodyText);
    return decodeNativeBody(payload.bodyBase64);
};

/**
 * 去掉开头的 UTF-8 BOM。
 *
 * 走 base64 的旧路径由 `TextDecoder` 负责剥（默认 ignoreBOM = false），而 #262 之后
 * 文本响应是原生用 `CharsetDecoder` 严格解码出来的 —— 它**不剥** BOM。不在这里补一刀，
 * 带 BOM 的 JSON（更新清单、自建 NAS 的资料库接口）就会 `JSON.parse` 失败，被误报成
 * 「不是接口 / 非 JSON 响应」。
 */
const stripUtf8Bom = (value: string): string => (
    value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
);

/** 一次原生转发的结果：状态码 + 按 UTF-8 解出来的响应体。 */
export type NativeHttpRequestResult = {
    status: number;
    text: string;
    /** 响应头（含重复的 Set-Cookie），按原生给的原样传回。 */
    headers?: Array<{ name?: string; value?: string }> | Record<string, string>;
};

/**
 * 用原生 OkHttp 发一次完整请求（任意方法 / 自定义头 / 请求体）。
 *
 * 走它而不是 WebView 的 fetch，是因为页面跑在 `https://localhost` 上，而自建服务
 * （飞牛这类用户自己的 NAS）几乎不会下发 `Access-Control-Allow-Origin` —— 同源检查
 * 在最前面就把请求挡掉了，抛出来的是一句毫无特征的 `TypeError: Failed to fetch`，
 * 跟「地址填错」「服务端没开」长得一模一样。原生侧没有同源策略这回事。
 *
 * 连不上 / TLS 握手失败这些真网络错误，插件会 reject，由调用方当网络故障处理。
 */
export const nativeHttpRequest = async (options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    bodyText?: string;
    timeoutMs?: number;
}): Promise<NativeHttpRequestResult> => {
    // 头名一律用小写：原生侧拼 OkHttp 请求时按 `content-type` 取 media type，
    // 大小写不敏感的是浏览器的 Headers，不是 Capacitor 那个 JSONObject。
    const headers: Record<string, string> = {};
    Object.entries(options.headers ?? {}).forEach(([name, value]) => {
        if (value == null || value === '') return;
        headers[name.toLowerCase()] = String(value);
    });
    const response = await FoliaNative.httpRequest({
        url: options.url,
        method: options.method,
        headers,
        bodyText: options.bodyText ?? '',
        bodyBase64: '',
        redirect: 'follow',
        ...(options.timeoutMs && options.timeoutMs > 0 ? { timeoutMs: options.timeoutMs } : {}),
    });
    return {
        status: Number(response?.status) || 0,
        text: decodeNativePayload(response),
        ...(response?.headers ? { headers: response.headers } : {}),
    };
};

/**
 * 用原生 OkHttp 取一份文本。
 *
 * 安卓上走这条路而不是直接 fetch，是因为 WebView 里的 fetch 受同源策略约束：自建 CDN
 * 通常不会回 `Access-Control-Allow-Origin`，版本清单的请求当场就被拦掉，界面只能干巴巴
 * 显示一句「检查失败」。原生侧没有同源策略这回事。
 */
export const nativeGetText = async (url: string, timeoutMs?: number): Promise<string> => {
    const response = await nativeHttpRequest({ url, method: 'GET', headers: {}, timeoutMs });
    if (response.status >= 400) {
        throw new Error(`Request failed with HTTP ${response.status}: ${url}`);
    }
    return response.text;
};

/** 原生 HTTP 转发可用（仅 Capacitor Android 上插件注册了才算）。 */
export const isNativeHttpAvailable = (): boolean => (
    isCapacitorAndroid() && typeof FoliaNative.httpRequest === 'function'
);

/**
 * 往 WebView 的 cookie 罐里写一条。
 *
 * 自建服务（飞牛）的封面是 `<img src=...>` 直连的 —— 图片元素没法挂请求头，
 * 服务端要的那个 `music-token` 只能靠 cookie 自动带上。登录成功后把 token 同步一份
 * 进罐里，封面才不会全裂。写不进去不该影响登录本身，所以失败只记不抛。
 */
export const setNativeCookie = async (options: {
    url: string;
    name: string;
    value: string;
}): Promise<void> => {
    if (!isCapacitorAndroid()) return;
    try {
        await FoliaNative.cookiesSet({ ...options, path: '/' });
    } catch (error) {
        console.warn('[FoliaNative] setNativeCookie failed', error);
    }
};

/** 登出时把同步进去的那条清掉，免得下次换账号还带着旧凭据。 */
export const removeNativeCookie = async (options: { url: string; name: string }): Promise<void> => {
    if (!isCapacitorAndroid()) return;
    try {
        await FoliaNative.cookiesRemove(options);
    } catch (error) {
        console.warn('[FoliaNative] removeNativeCookie failed', error);
    }
};

// ─── 汽水音乐（FoliaQishui）────────────────────────────────────────────
// 汽水的协议层要跑在「一个真的浏览器页面里」：它的签名组件（官方 bdms.js）会改写
// 页面里的 XHR/fetch 给请求补签名，桌面端靠 Electron 的隐藏 BrowserWindow 提供这个页面，
// 安卓端由原生起的隐藏 WebView（QishuiSignHost）提供。所以这里不是一个普通的网络插件：
// 它把 operation 递给那个页面里的协议层，再把结果原样带回来。

export type QishuiBridgeEnvelope =
    | { ok: true; data: unknown }
    | { ok: false; error: { code: string; message: string } };

interface FoliaQishuiPlugin {
    // params 以字符串过桥（理由见 requestQishuiNative），所以这里两种形状都认。
    request(options: { operation: string; params?: Record<string, unknown> | string }): Promise<QishuiBridgeEnvelope>;
    status(): Promise<{ ready: boolean; reason?: string }>;
    dispose(): Promise<void>;
}

const FoliaQishui = registerPlugin<FoliaQishuiPlugin>('FoliaQishui');

/**
 * 安卓上汽水音源有没有可用：插件在（说明原生把隐藏 WebView 建起来了）才算数。
 *
 * 桌面端走 window.electron.qishuiRequest，两边信封完全一致，所以渲染层只有这一处判断。
 */
export const isQishuiNativeAvailable = (): boolean => (
    isCapacitorAndroid() && typeof FoliaQishui?.request === 'function'
);

/** 把一个汽水 operation 交给原生的签名宿主；返回与桌面端同一套信封。 */
export const requestQishuiNative = async (
    operation: string,
    params: Record<string, unknown> = {},
): Promise<QishuiBridgeEnvelope> => {
    if (!isQishuiNativeAvailable()) {
        return { ok: false, error: { code: 'unavailable', message: 'Qishui bridge is not available' } };
    }
    try {
        // params 以字符串过桥：Capacitor 的嵌套对象转换在个别版本上会把内层
        // 对象丢成 null（安卓上表现为「二维码登录 token 缺失」），字符串零歧义。
        const envelope = await FoliaQishui.request({ operation, params: JSON.stringify(params ?? {}) });
        if (envelope && typeof envelope === 'object' && 'ok' in envelope) return envelope;
        return { ok: false, error: { code: 'invalid-response', message: 'Qishui bridge returned a malformed envelope' } };
    } catch (error) {
        return {
            ok: false,
            error: { code: 'unavailable', message: error instanceof Error ? error.message : String(error) },
        };
    }
};

/** 让原生把隐藏 WebView 与它占的资源收掉（登出 / 退出时调用，可重复调用）。 */
export const disposeQishuiNative = async (): Promise<void> => {
    if (!isCapacitorAndroid()) return;
    try {
        await FoliaQishui.dispose();
    } catch (error) {
        console.warn('[FoliaQishui] dispose failed', error);
    }
};

// ─── bilibili MV（FoliaBilibili）──────────────────────────────────────
// api.bilibili.com 不给任意来源 CORS 头，WebView 里直连一定被拦。安卓这边由
// FoliaBilibili 插件用 OkHttp 代发只读 GET —— 和 FoliaNative.httpRequest 是同一套思路。
//
// 不需要登录：实测 nav / search / playurl 在未登录时都回 code=0，只有画质上限停在
// 480p（1080p 要大会员）。所以这里没有任何账号状态。

interface FoliaBilibiliPlugin {
    request(options: {
        url: string;
        headers?: Record<string, string>;
    }): Promise<{ ok: boolean; status: number; bodyText: string; setCookies?: string[] }>;
    /** 当前登录态：有没有 SESSDATA、uid 是谁。不回 cookie 本身。 */
    authStatus(): Promise<{ signedIn: boolean; uid: string }>;
    /**
     * 把扫码登录拿到的 cookie 落进原生 CookieManager。
     *
     * 之后所有 request 都会自动带上 —— 插件自己不发登录请求，也不持有凭据。
     */
    setCookies(options: { cookie: string }): Promise<{ ok: boolean }>;
    clearCookies(): Promise<{ ok: boolean }>;
}

const FoliaBilibili = registerPlugin<FoliaBilibiliPlugin>('FoliaBilibili');

/** 安卓上能不能替我们发 bilibili 请求。 */
export const isBilibiliNativeAvailable = (): boolean => (
    isCapacitorAndroid() && typeof FoliaBilibili?.request === 'function'
);

/**
 * 通过原生代发一次 bilibili GET。
 *
 * 回 `{ ok, status, bodyText }`：`ok` 只表示 HTTP 通不通，业务码（code）由调用方解析。
 * 这样「bilibili 说没有这条视频」和「网络断了」在 JS 那边分得开。
 */
export const requestBilibiliNative = async (
    url: string,
    headers?: Record<string, string>,
): Promise<{ ok: boolean; status: number; bodyText: string; setCookies?: string[] }> => {
    if (!isBilibiliNativeAvailable()) {
        return { ok: false, status: 0, bodyText: '' };
    }
    try {
        const result = await FoliaBilibili.request({ url, headers });
        if (result && typeof result === 'object' && 'status' in result) return result;
        return { ok: false, status: 0, bodyText: '' };
    } catch (error) {
        console.warn('[FoliaBilibili] request failed', error);
        return { ok: false, status: 0, bodyText: '' };
    }
};

/** 当前 bilibili 登录态。没有原生桥就是未登录。 */
export const readBilibiliAuthNative = async (): Promise<{ signedIn: boolean; uid: string }> => {
    if (!isBilibiliNativeAvailable()) return { signedIn: false, uid: '' };
    try {
        const result = await FoliaBilibili.authStatus();
        if (result && typeof result === 'object') return result;
        return { signedIn: false, uid: '' };
    } catch (error) {
        console.warn('[FoliaBilibili] authStatus failed', error);
        return { signedIn: false, uid: '' };
    }
};

/** 保存扫码登录得到的 cookie。 */
export const saveBilibiliCookiesNative = async (cookie: string): Promise<boolean> => {
    if (!isBilibiliNativeAvailable()) return false;
    try {
        const result = await FoliaBilibili.setCookies({ cookie });
        return Boolean(result?.ok);
    } catch (error) {
        console.warn('[FoliaBilibili] setCookies failed', error);
        return false;
    }
};

/** 清掉 bilibili 登录态。 */
export const clearBilibiliCookiesNative = async (): Promise<void> => {
    if (!isBilibiliNativeAvailable()) return;
    try {
        await FoliaBilibili.clearCookies();
    } catch (error) {
        console.warn('[FoliaBilibili] clearCookies failed', error);
    }
};
