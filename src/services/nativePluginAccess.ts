// src/services/nativePluginAccess.ts
// 取原生插件的那一层共同地基：Capacitor 全局对象、平台判据、「这一拍能不能问桥」。
//
// 为什么单独一处：`aiNativeCompletion` / `aiNativeFetch` / `nativeHttpFetch` 各自抄了一份
// 「window.Capacitor 在不在、是不是安卓、插件报没报上来」，三份各写各的，任一处改了判据
// 另外两处不会跟上（issue M35）。这里只收**共用的东西**，不收「这个模块要不要走原生」——
// 那件事每个模块的答案不同，见下面 `bridgeIsReady` 的说明。

/** Capacitor 注入的全局对象里我们会用到的部分。全部可选：桥没起来时它们都不在。 */
export type CapacitorGlobalShape = {
    isNativePlatform?: () => boolean;
    getPlatform?: () => string;
    isPluginAvailable?: (name: string) => boolean;
    Plugins?: Record<string, unknown>;
};

/**
 * 读 `window.Capacitor`。非浏览器环境（单测、主进程）返回 null。
 *
 * 刻意不做缓存：桥是启动过程中才注入的，第一次读到 null 不代表以后都读不到。
 */
export const readCapacitor = (): CapacitorGlobalShape | null => {
    if (typeof window === 'undefined') return null;
    return (window as unknown as { Capacitor?: CapacitorGlobalShape }).Capacitor ?? null;
};

/**
 * Capacitor 自己认为的「这是不是安卓原生端」。
 *
 * ⚠️ 这条判据**依赖桥已经初始化**：`isNativePlatform()` 读的是原生注入的
 * `window.CapacitorPlatform`，桥起来之前一律 false。冷启动头几秒拿它判断「这个功能在不在」
 * 会答错，而错的那一侧通常是破坏性的（`isAndroidAppShell` 的注释里有具体例子）。
 * 需要「不依赖桥」的判据时用 `../platform/runtime` 的 `isAndroidAppShell`，别在这里加。
 */
export const isCapacitorAndroidPlatform = (capacitor: CapacitorGlobalShape | null = readCapacitor()): boolean => {
    if (!capacitor) return false;
    return capacitor.isNativePlatform?.() === true || capacitor.getPlatform?.() === 'android';
};

/**
 * 插件是不是真的在原生侧注册了。
 *
 * ⚠️ 不能写成 `typeof plugin?.someMethod === 'function'`：`registerPlugin()` 给回来的是
 * **代理**，任何方法名问过去都是 function，原生一行没写时也返回 true（真出过一次：于是
 * 凭空点亮平台入口，报「未登录却有账号」）。同步的 `isPluginAvailable()` 查的是原生上报的
 * pluginHeaders，那才是真的；拿不到这个函数时（极老的容器）退回「插件的构造器在不在」。
 */
export const isPluginRegistered = (name: string, capacitor: CapacitorGlobalShape | null = readCapacitor()): boolean => {
    if (!capacitor) return false;
    if (typeof capacitor.isPluginAvailable === 'function') return capacitor.isPluginAvailable(name);
    return capacitor.Plugins?.[name] != null;
};

/**
 * 取一个原生插件实例；这一拍用不了就返回 null。
 *
 * 平台判据由调用方**传进来**（`isOnNativePlatform`），因为各模块要的语义本来就不同，
 * 而那套判据各有自己的家：
 *   · 「桥起来之后的 Capacitor 判据」—— 传 `() => isCapacitorAndroidPlatform()`。
 *     适合调用时机一定在桥起来之后的模块，最严格。
 *   · 「是不是 App 壳、不依赖桥」—— 传 `platform/runtime` 的 `isAndroidAppShell`。
 *     适合冷启动就可能被问到的模块：这时「桥还没起来」和「平台不支持」必须分开。
 *   · 已经有别的平台门路、只想查注册 —— 传 `() => true`。
 *
 * 判据不在这里复制一份：`isAndroidAppShell` 只有一处实现，改它的时候不会漏掉这里。
 */
export const getNativePlugin = <T>(
    pluginName: string,
    isOnNativePlatform: () => boolean,
): T | null => {
    if (!isOnNativePlatform()) return null;
    const capacitor = readCapacitor();
    if (!capacitor) return null;
    if (!isPluginRegistered(pluginName, capacitor)) return null;
    return (capacitor.Plugins?.[pluginName] as T | undefined) ?? null;
};
