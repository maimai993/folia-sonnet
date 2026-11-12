// src/mods/android/androidModsBridge.ts
// 安卓端的模组桥：把 Capacitor 的 FoliaMods 插件包成桌面端那一份 `window.electron.mods`。
//
// 为什么做成「同形对象」而不是改 ipc.ts 的每个函数：桌面端渲染端与模组系统之间的唯一
// 契约就是 window.electron.mods 上的这组方法（electron/preload.cjs）。在安卓上装一份
// 同名同形状的实现，ipc.ts、clientLoader.ts、模组面板、乃至模组自己的 client 代码
// （它们全都只认 window.electron.mods）都不需要知道底下换了一套。
//
// 关键：这份 shim **不带 `platform` 字段**。桌面端靠 preload 里的 platform 表明身份
// （electron/preload.cjs:79），安卓上没有，于是所有「我是不是桌面端」的判断
// （Boolean(window.electron?.platform)）在这里自然为假，而「有没有 mods 能力」的判断
// （Boolean(window.electron?.mods)）为真 —— 正是需要的区分。

import { Capacitor, registerPlugin } from '@capacitor/core';
import type {
    ModClearCacheResult,
    ModExportProgress,
    ModFfmpegStatus,
    ModLogEntry,
    ModMainCallStats,
    ModRpcMessage,
    ModRuntimeInfo,
    ModRuntimeSnapshot,
    ModSecretChange,
    ModSetEnabledResult,
    ModStorageUsageResult,
    ModsListPayload,
} from '../types';

/** 原生插件的方法表（FoliaModsPlugin.java）。 */
interface FoliaModsPluginShape {
    call(options: { op: string; args?: Record<string, unknown> }): Promise<Record<string, unknown>>;
    listMods(): Promise<ModsListPayload>;
    reloadMods(): Promise<{ mods?: ModRuntimeInfo[] }>;
    setModEnabled(options: { id: string; enabled: boolean }): Promise<{ ok?: boolean; error?: string; mods?: ModRuntimeInfo[] }>;
    installModFromZip(options: { zipPath: string }): Promise<{ ok?: boolean; id?: string; error?: string }>;
    installModFromZipFile(options: { name: string; base64: string }): Promise<{ ok?: boolean; id?: string; error?: string }>;
    deleteMod(options: { modId: string }): Promise<{ ok?: boolean; error?: string; mods?: ModRuntimeInfo[] }>;
    invokeModNetFetch(options: { modId: string; url: string; init?: Record<string, unknown> }): Promise<{ ok?: boolean; result?: unknown; error?: string }>;
    invokeModRpc(options: { modId: string; name: string; args?: unknown[] }): Promise<{ ok?: boolean; result?: unknown; error?: string }>;
    invokeModStorage(options: { modId: string; operation: string; key?: string; value?: unknown }): Promise<{ ok?: boolean; result?: unknown; error?: string }>;
    getFfmpegStatus(): Promise<{ ffmpeg?: ModFfmpegStatus }>;
    getModCallStats(options?: { modId?: string }): Promise<{ stats?: Record<string, ModMainCallStats> }>;
    getModStorageUsage(options: { modId: string }): Promise<ModStorageUsageResult>;
    clearModCache(options: { modId: string }): Promise<ModClearCacheResult>;
    getNodeState(): Promise<{ ready?: boolean; failure?: string | null }>;
    /** 诊断用：原生最近一次采到的设备指标（CPU / 内存 / 温度）。 */
    getDeviceMetrics(): Promise<{ metrics?: Record<string, number | string | null> | null }>;
    openModsDirectory(): Promise<{ ok?: boolean; error?: string; path?: string }>;
    addListener(event: 'modsEvent', listener: (event: { payload?: string }) => void): Promise<{ remove: () => void }>;
}

const FoliaMods = registerPlugin<FoliaModsPluginShape>('FoliaMods');

/** 没有原生 ffmpeg 时的空状态，与 ipc.ts 的 EMPTY_PAYLOAD.ffmpeg 同形。 */
const EMPTY_FFMPEG: ModFfmpegStatus = { available: false, path: null, version: null, candidates: [] };

/**
 * 安卓上有没有这个原生插件（真机有，浏览器预览没有）。
 */
export const hasAndroidModsPlugin = (): boolean => (
    typeof window !== 'undefined'
    && Capacitor.isNativePlatform()
    && Capacitor.getPlatform() === 'android'
);

/*
 * 事件分发：原生侧只有一条 modsEvent 通道，payload 是 Node 发来的 JSON 文本，
 * 形如 { type: 'log' | 'state-changed' | 'rpc-message' | 'secret-changed' | 'ready' | 'ipc' }。
 * 这里按 type 分给各自的订阅者 —— 与 preload 把不同 IPC 频道拆成不同回调是同一件事。
 */
type EventSink = (payload: Record<string, unknown>) => void;

const sinks = new Map<string, Set<EventSink>>();
let listenerInstalled = false;

const onType = (type: string, sink: EventSink): (() => void) => {
    let set = sinks.get(type);
    if (!set) {
        set = new Set();
        sinks.set(type, set);
    }
    set.add(sink);
    ensureListener();
    return () => {
        set?.delete(sink);
    };
};

const ensureListener = () => {
    if (listenerInstalled) return;
    listenerInstalled = true;
    void FoliaMods.addListener('modsEvent', (event) => {
        if (typeof event?.payload !== 'string') return;
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(event.payload) as Record<string, unknown>;
        } catch {
            return;
        }
        const type = typeof parsed.type === 'string' ? parsed.type : '';
        sinks.get(type)?.forEach((sink) => {
            try {
                sink(parsed);
            } catch {
                // 一个订阅者抛了不该影响其他订阅者。
            }
        });
    });
};

/*
 * 启动时 Node 可能还没就绪（它是进程内起一个真 Node，几百毫秒）。渲染端在这里等一下，
 * 否则第一次 listMods 会拿到 node-not-ready 而界面显示成「没有模组」。
 */
const waitForNode = async (attempts = 40): Promise<void> => {
    for (let index = 0; index < attempts; index += 1) {
        try {
            const state = await FoliaMods.getNodeState();
            if (state?.ready) return;
            if (state?.failure) throw new Error(state.failure);
        } catch (error) {
            // 插件还没注册好时也会抛；继续等。
            if (index === attempts - 1) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
};

/** 桌面端 preload 那一份 `window.electron.mods` 的安卓等价物。 */
export const createAndroidModsBridge = () => {
    let readyPromise: Promise<void> | null = null;
    const ready = async (): Promise<void> => {
        /*
         * 缓存的是「已经成功」的那一次，不是「尝试过」的那一次。
         *
         * 以前 `readyPromise ??= waitForNode()` 会把失败的 Promise 也留在缓存里：
         * 只要第一次等待（比如启动瞬间插件还没注册好）抛了，这个 Promise 就永久是
         * rejected 状态，之后每一次 rpc / storage / 导出调用都在同一处瞬间抛出，
         * 全都被 guarded 兜成 `node-unavailable` —— 这就是听歌档案和透明视频导出
         * 明明宿主 ready 却一直报 node-unavailable 的原因。
         *
         * 现在失败就清空缓存，下一次调用会重新等（Node 此时通常已经起来了）。
         */
        if (!readyPromise) {
            readyPromise = waitForNode().catch((error) => {
                readyPromise = null;
                throw error;
            });
        }
        await readyPromise;
    };

    /*
     * 插件方法的返回值统一是宿主那一层的信封 `{ ok, result, id }`，不是桌面端 preload
     * 直接给出的业务对象。之前直接读 `payload.mods` 所以永远是空数组——模组装好了、
     * 宿主也报 loaded，界面却显示「没有模组」。
     * 这里一次性剥掉信封：失败时抛出，成功时给 result。
     */
    const unwrap = <T>(response: unknown): T => {
        const envelope = (response ?? {}) as { ok?: boolean; result?: unknown; error?: string };
        if (envelope.ok === false) {
            throw new Error(typeof envelope.error === 'string' ? envelope.error : 'node-error');
        }
        return envelope.result as T;
    };

    /**
     * 一次模组调用（rpc / storage）：把「通道不通」和「模组自己失败」分开。
     *
     * Capacitor 在插件 `resolve({ok:false})` 时会让 Promise **reject**，
     * 于是模组的业务失败也会抛出。这里先等 Node 就绪（这一步失败才算 node-unavailable），
     * 之后调用抛出的错误就是模组给的结论，原样回给调用方。
     */
    const runModCall = async (
        invoke: () => Promise<unknown>,
        fallbackError: string,
    ): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
        try {
            await ready();
        } catch (error) {
            console.warn('[ModsBridge] Node 宿主未就绪', error);
            return { ok: false, error: 'node-unavailable' };
        }
        try {
            const raw = await invoke();
            const response = unwrap<Record<string, unknown> | null>(raw);
            if (!response || typeof response !== 'object') {
                return { ok: true, result: response ?? null };
            }
            if (response.ok === false) {
                return { ok: false, error: typeof response.error === 'string' ? response.error : fallbackError };
            }
            return { ok: true, result: response };
        } catch (error) {
            /*
             * 走到这里既可能是模组返回 ok:false（Capacitor 抛出来的），
             * 也可能是通道真的断了。把 message 当业务错误交出去 —— 它比
             * 一个笼统的 node-unavailable 有用得多，而且宿主已经就绪过了。
             */
            const message = error instanceof Error ? error.message : String(error);
            console.warn('[ModsBridge] 模组调用失败', message);
            return { ok: false, error: message || fallbackError };
        }
    };

    const guarded = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
        try {
            await ready();
            return await run();
        } catch (error) {
            /*
             * 以前这里静默吞掉异常、一律回 fallback（多半是 `node-unavailable`），
             * 于是模组那边只能看到一句和真实原因无关的话 —— 排查时完全没线索。
             * 现在把原始错误打出来；fallback 仍然不变，调用方看到的形状不受影响。
             */
            console.warn('[ModsBridge] Android 调用失败，已回退', error);
            return fallback;
        }
    };

    return {
        // ---- 清单与生命周期
        listMods: () => guarded<ModsListPayload>(async () => {
            const payload = unwrap<ModsListPayload>(await FoliaMods.listMods());
            return {
                mods: Array.isArray(payload?.mods) ? payload.mods : [],
                ffmpeg: payload?.ffmpeg ?? { available: false, path: null, version: null, candidates: [] },
                directories: Array.isArray(payload?.directories) ? payload.directories : [],
                startSkipped: payload?.startSkipped === true,
            };
        }, { mods: [], ffmpeg: { available: false, path: null, version: null, candidates: [] }, directories: [], startSkipped: false }),

        reloadMods: () => guarded<{ mods: ModRuntimeInfo[] }>(async () => {
            const response = unwrap<{ mods?: ModRuntimeInfo[] }>(await FoliaMods.reloadMods());
            return { mods: Array.isArray(response?.mods) ? response.mods : [] };
        }, { mods: [] }),
        /**
         * 模组系统总开关。宿主会据此重算「哪些模组该跑」，关掉时把运行中的全部卸载
         * （桌面端在 electron/main.cjs 存设置时做同一件事）。
         */
        setModSystemEnabled: (enabled: boolean) => guarded<{ ok: boolean; mods: ModRuntimeInfo[] }>(async () => {
            const response = unwrap<{ ok?: boolean; list?: { mods?: ModRuntimeInfo[] }; error?: string }>(
                await FoliaMods.call({ op: 'set-system-enabled', args: { enabled } }),
            );
            return {
                ok: response?.ok !== false,
                mods: Array.isArray(response?.list?.mods) ? response.list.mods : [],
            };
        }, { ok: false, mods: [] }),
        setModEnabled: (modId: string, enabled: boolean) => guarded<ModSetEnabledResult>(async () => {
            /*
             * 宿主的应答是 { ok, list }，list 才是整份清单（与 listMods 同形）。
             * 之前读 response.mods 所以永远是空数组，而 ok 也跟着变 false。
             */
            const response = unwrap<{ ok?: boolean; list?: { mods?: ModRuntimeInfo[] }; error?: string }>(
                await FoliaMods.setModEnabled({ id: modId, enabled }),
            );
            return {
                ok: response?.ok !== false,
                error: response?.error,
                mods: Array.isArray(response?.list?.mods) ? response.list.mods : [],
            };
        }, { ok: false, error: 'node-unavailable', mods: [] }),

        installModFromZip: (zipPath: string) => guarded<{ ok: boolean; id?: string; error?: string }>(
            async () => {
                /*
                 * install-zip 和 list/reload 不一样：它把结果平铺在回应最外层
                 * （{ ok, id, mods }），没有 `result` 这一层，所以不能用 unwrap 取。
                 */
                const envelope = (await FoliaMods.installModFromZip({ zipPath })) as
                    | { ok?: boolean; id?: string; error?: string; result?: unknown }
                    | undefined;
                const inner = (envelope?.result ?? envelope) as { ok?: boolean; id?: string; error?: string } | undefined;
                return { ok: Boolean(inner?.ok), id: inner?.id, error: inner?.error ?? envelope?.error };
            },
            { ok: false, error: 'node-unavailable' },
        ),

        /*
         * 安卓端从 `<input type=file>` 拿到的 zip：原生侧把 base64 写成文件，
         * 再交给同一个安装流程。桌面上没有这个方法（那边用拖拽拿真实路径）。
         */
        installModFromZipFile: (file: { name: string; base64: string }) => guarded<{ ok: boolean; id?: string; error?: string }>(
            async () => {
                const envelope = (await FoliaMods.installModFromZipFile({
                    name: file.name,
                    base64: file.base64,
                })) as { ok?: boolean; id?: string; error?: string; result?: unknown } | undefined;
                const inner = (envelope?.result ?? envelope) as { ok?: boolean; id?: string; error?: string } | undefined;
                return { ok: Boolean(inner?.ok), id: inner?.id, error: inner?.error ?? envelope?.error };
            },
            { ok: false, error: 'node-unavailable' },
        ),

        /*
         * 删除（卸载）一个模组。
         *
         * 原生侧删掉目录与它的数据 / 缓存，然后我们重新读一次清单 ——
         * 返回的 `mods` 让面板直接换掉列表，不必用户再点刷新。
         */
        deleteMod: (modId: string) => guarded<{ ok: boolean; error?: string; mods: ModRuntimeInfo[] }>(
            async () => {
                const envelope = (await FoliaMods.deleteMod({ modId })) as
                    | { ok?: boolean; error?: string; result?: unknown }
                    | undefined;
                const inner = (envelope?.result ?? envelope) as { ok?: boolean; error?: string } | undefined;
                if (inner?.ok === false || envelope?.ok === false) {
                    return { ok: false, error: inner?.error ?? envelope?.error ?? 'delete-failed', mods: [] };
                }
                const list = unwrap<ModsListPayload>(await FoliaMods.listMods());
                return {
                    ok: true,
                    mods: Array.isArray(list?.mods) ? list.mods : [],
                };
            },
            { ok: false, error: 'node-unavailable', mods: [] },
        ),

        // ---- 模组调用
        /*
         * RPC/存储的返回值就是模组处理器自己那个对象（例如 market.installed 返回
         * { ok, directory, mods }），不是 { ok, result } —— 桌面端 preload 也是原样透传。
         * 所以这里只判断成败，成功时把整个内层对象交出去；不要再去找一个 result 字段。
         *
         * 关键区别（这个坑踩过）：Capacitor 在 `ok: false` 时会**抛出**异常，而不是返回对象。
         * 模组自己的业务失败（比如 `rpc-not-found`、`rpc-failed`）因此会走进 guarded 的
         * catch，被兜成 `node-unavailable` —— 看着像 Node 没起来，其实宿主好好的。
         * 所以这里把抛出的 message 还原成业务失败，只有真正的通道异常才往上抛。
         */
        invokeModRpc: (modId: string, name: string, args: unknown[]) => runModCall(
            () => FoliaMods.invokeModRpc({ modId, name, args }),
            'rpc-failed',
        ),

        invokeModStorage: (modId: string, operation: string, key?: string, value?: unknown) => runModCall(
            () => FoliaMods.invokeModStorage({ modId, operation, key, value }),
            'storage-failed',
        ),

        getModCallStats: () => guarded<{ stats: Record<string, ModMainCallStats> }>(
            async () => {
                const response = unwrap<{ stats?: Record<string, ModMainCallStats> }>(await FoliaMods.getModCallStats());
                return { stats: response?.stats ?? {} };
            },
            { stats: {} },
        ),

        /*
         * 存储统计 / 清缓存：宿主回的是 { ok, result: { data, cache, total } }，
         * 但界面（ModStorageUsage.tsx）读的是**扁平**的 { ok, data, cache, cacheBroken }。
         * 只 unwrap 会把外层的 `ok` 丢掉，界面于是 `!result.ok` 恒成立 ——
         * 数字明明算出来了却报「无法统计占用空间」。所以这里自己拼一次：ok 取外层，
         * 其余字段从 result 里摊上来。
         */
        getModStorageUsage: (modId: string) => guarded<ModStorageUsageResult>(
            async () => {
                const envelope = (await FoliaMods.getModStorageUsage({ modId })) as
                    | { ok?: boolean; error?: string; result?: { data?: number; cache?: number; total?: number } }
                    | null
                    | undefined;
                if (!envelope || envelope.ok === false) {
                    return { ok: false, error: envelope?.error ?? 'storage-usage-failed' };
                }
                const inner = envelope.result ?? {};
                return {
                    ok: true,
                    data: typeof inner.data === 'number' ? inner.data : 0,
                    cache: typeof inner.cache === 'number' ? inner.cache : 0,
                    cacheBroken: false,
                };
            },
            { ok: false, error: 'node-unavailable' },
        ),

        clearModCache: (modId: string) => guarded<ModClearCacheResult>(
            async () => {
                const envelope = (await FoliaMods.clearModCache({ modId })) as
                    | { ok?: boolean; error?: string }
                    | null
                    | undefined;
                if (!envelope || envelope.ok === false) {
                    return { ok: false, error: envelope?.error ?? 'clear-cache-failed' };
                }
                return { ok: true };
            },
            { ok: false, error: 'node-unavailable' },
        ),

        // ---- ffmpeg：安卓上没有可 spawn 的可执行文件，但原生库带了 ffmpeg-kit。
        getFfmpegStatus: () => guarded<{ ffmpeg: ModFfmpegStatus }>(
            async () => {
                // 宿主直接把状态对象作为 result 给出来，没有外面再包一层 ffmpeg。
                const response = unwrap<ModFfmpegStatus & { ffmpeg?: ModFfmpegStatus }>(await FoliaMods.getFfmpegStatus());
                const status = response?.ffmpeg ?? response;
                return {
                    ffmpeg: status && typeof status === 'object' && typeof status.available === 'boolean'
                        ? status
                        : EMPTY_FFMPEG,
                };
            },
            { ffmpeg: EMPTY_FFMPEG },
        ),

        // ---- 安卓上没有「打开文件管理器到某目录」与原生选文件框，如实报不支持。
        /*
         * 模组根目录现在落在应用的外部 files 目录（用户能用文件管理器看到），
         * 所以这颗按钮在安卓上真的能打开目录了 —— 由原生用 FileProvider 起系统文件管理器。
         */
        openModsDirectory: () => guarded<{ ok: boolean; error?: string; path?: string }>(
            async () => {
                const response = (await FoliaMods.openModsDirectory()) as
                    | { ok?: boolean; error?: string; path?: string; result?: { ok?: boolean; error?: string; path?: string } | null }
                    | undefined;
                const value = (response?.result ?? response) as { ok?: boolean; error?: string; path?: string } | undefined;
                return { ok: Boolean(value?.ok), error: value?.error, path: value?.path };
            },
            { ok: false, error: 'node-unavailable' },
        ),
        cancelExport: async () => ({ ok: false }),
        reportModsStartSettled: async () => ({ ok: true }),
        reportModsStartAlive: async () => ({ ok: true }),
        pushRuntimeSnapshot: async (snapshot: ModRuntimeSnapshot): Promise<{ ok: boolean }> => {
            try {
                await ready();
                await FoliaMods.call({ op: 'push-runtime-snapshot', args: { snapshot } });
                return { ok: true };
            } catch {
                // 快照是尽力而为的：没推上不影响模组可用。
                return { ok: false };
            }
        },

        // 这三个桌面端是原生文件选择框，安卓端形态不同，形状先留着。
        invokeModSecrets: async () => ({ ok: false, error: 'unsupported-on-android' }),
        /*
         * `folium.net.fetch`：桌面端在主进程里发（不受渲染进程 CORS 限制），
         * 安卓上同一套 netFetch.cjs 已经在 Node 宿主里，转过去就行。
         * 权限、方法白名单、超时、体积上限仍由那一份统一把关。
         */
        invokeModNetFetch: (modId: string, url: string, init?: unknown) => guarded<{ ok: boolean; result?: unknown; error?: string }>(
            async () => {
                const envelope = (await FoliaMods.invokeModNetFetch({
                    modId,
                    url,
                    init: (init ?? {}) as Record<string, unknown>,
                })) as { ok?: boolean; result?: unknown; error?: string } | undefined;
                if (!envelope || envelope.ok === false) {
                    return { ok: false, error: envelope?.error ?? 'net-fetch-failed' };
                }
                return { ok: true, result: envelope.result };
            },
            { ok: false, error: 'node-unavailable' },
        ),
        invokeModPickFile: async () => ({ ok: false, error: 'unsupported-on-android' }),
        invokeModRestoreFile: async () => ({ ok: false, error: 'unsupported-on-android' }),
        invokeModReleaseFile: async () => ({ ok: false, error: 'unsupported-on-android' }),

        // ---- 订阅（preload 里是一组 onXxx，这里按事件 type 拆开）
        onModsStateChanged: (callback: (mods: ModRuntimeInfo[]) => void) => onType('state-changed', (payload) => {
            const list = payload.list as { mods?: ModRuntimeInfo[] } | undefined;
            callback(Array.isArray(list?.mods) ? list.mods : []);
        }),

        onModLog: (callback: (entry: ModLogEntry) => void) => onType('log', (payload) => {
            callback({
                modId: String(payload.modId ?? ''),
                level: (payload.level === 'warn' || payload.level === 'error' ? payload.level : 'info'),
                message: String(payload.message ?? ''),
                details: payload.details === null || payload.details === undefined
                    ? undefined
                    : String(payload.details),
            });
        }),

        onModRpcMessage: (callback: (message: ModRpcMessage) => void) => onType('rpc-message', (payload) => {
            callback(payload as unknown as ModRpcMessage);
        }),

        onModSecretChanged: (callback: (change: ModSecretChange) => void) => onType('secret-changed', (payload) => {
            callback(payload as unknown as ModSecretChange);
        }),

        // 安卓端没有视频导出。
        onExportProgress: (_callback: (progress: ModExportProgress) => void) => () => undefined,
    };
};

/**
 * Apple Music 的安卓接口占位（本轮只留接口，不实现）。
 *
 * 桌面端 `appleMusicRequest` 由 Electron 主进程里那套隔离的 WebView 伴侣进程实现；
 * 安卓上没有它，也不该假装有 —— 所以这里如实回 `unsupported`，让
 * `getAppleMusicTransportAvailability()` 判成 unavailable，界面上不出现一个
 * 点了就炸的入口。真要做的时候，把这里换成插件转发即可，调用方不用改。
 */
const appleMusicUnsupported = async (): Promise<{ ok: false; error: string }> => ({
    ok: false,
    error: 'unsupported',
});

/**
 * 装上 `window.electron.mods`（以及模组需要的 `openExternalUrl`），**不设 `platform`**。
 *
 * 必须在任何模组 client 被 import 之前调用：模组面板与 client.mjs 都只认这个对象。
 */
export const installAndroidModsBridge = (): void => {
    if (typeof window === 'undefined' || !hasAndroidModsPlugin()) return;
    // `window.electron` 的类型是按 Electron preload 的完整对象写的（一百多个必填成员），
    // 安卓这边只提供其中一小片，所以这里必须越过类型：断言成「部分对象」而不是伪造
    // 一大堆不存在的方法 —— 后者会让能力检查（`window.electron?.getSettings`）误判为真。
    const target = window as unknown as { electron?: Record<string, unknown> };
    if (target.electron?.mods) return;
    target.electron = {
        ...(target.electron ?? {}),
        mods: createAndroidModsBridge(),
        // 苹果音乐：只有接口，Android 上还没有实现（见上方注释）。
        appleMusicRequest: appleMusicUnsupported,
    };
};
