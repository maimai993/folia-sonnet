// src/services/aiMemoryGate.ts
// 「这台机器现在不该再跑 AI 推理」的闸门（issue #401）。
//
// 两条判据，任一成立就关闸：
//
//   ① 手机处于低内存：系统自己的 ActivityManager.MemoryInfo.lowMemory（它决定杀谁之前就会置这一位），
//      或可用内存掉到系统阈值以下。数据来自原生本来就在采的 DeviceMetrics.snapshot()
//      （复用 FoliaMods.getDeviceMetrics，不新开通道）。
//   ② 频繁 OOM / 被杀：连续几次启动都没能活过「稳定期」。安卓上 OOM 是被系统直接杀，进程里收不到
//      任何回调 —— 唯一可靠的证据就是「上次那回没走到标记点就没了」。所以这里在 localStorage 记一个
//      「这次启动到过稳定期」的标记：启动时读到没到过 → 上次崩了或被杀了，计数 +1；连续 N 次就锁闸。
//
// 关闸期间所有 AI 推理（在线补全、云端主题/导演、原生 ONNX 的拍点与分轨）一律不发起，
// 界面拿到的是 AI_MEMORY_GUARDED，提示用户稍后再试。
//
// 只在安卓上真正介入：桌面/网页没有「系统要杀我」这件事，闸门恒开。

import { isCapacitorAndroid } from '../platform/runtime';
import { readAiInferenceDisabled } from '../stores/useAiInferenceSettingsStore';
import { getStoredString, removeStoredKey, setStoredString } from '../stores/storagePrimitives';

/** 闸门关着时抛出的前缀（调用方据此换成人话，别当普通失败报）。 */
export const AI_MEMORY_GUARDED = 'ai-memory-guarded: ';

// 三把键直接写在调用点上（不走变量）：dev/dedicatus 的键扫描按字面量认「这把键还在用」。
const LOW_MEMORY_FLAG_KEY = 'folia_ai_low_memory_gate';
const UNSTABLE_RUNS_KEY = 'folia_ai_unstable_runs';
const RUN_ALIVE_KEY = 'folia_ai_run_alive';

/** 连续几次「没走到稳定期就没了」就认定频繁 OOM。 */
const UNSTABLE_RUNS_LIMIT = 2;
/** 启动后多久算「这一回活下来了」。太短会把正常切后台也当成崩。 */
const STABLE_AFTER_MS = 60_000;
/** 采样间隔：低内存是个缓变量，30 秒足够，也不至于在内存紧张时自己添负担。 */
const POLL_INTERVAL_MS = 30_000;

type GateState = {
    /** 系统报低内存 / 可用内存低于阈值。 */
    lowMemory: boolean;
    /** 连续「没活到稳定期」的次数。 */
    unstableRuns: number;
    /** 最近一次采样拿到的可用内存（KB），没采到是 null。 */
    availMemKb: number | null;
    /** 最近一次报低内存的时间。 */
    lastLowMemoryAt: number | null;
};

const state: GateState = {
    lowMemory: false,
    unstableRuns: 0,
    availMemKb: null,
    lastLowMemoryAt: null,
};

const listeners = new Set<() => void>();
let installed = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/*
 * 闸门自己的记账。
 *
 * 键名一律以字面量出现在下面的 storage().getItem / setItem 调用里：dev/dedicatus 的 D507 扫描
 * 按「localStorage / storage() 上的读写 + 字面量键」认「这把键还在用」，走一层封装它会当成
 * 已废弃的孤儿键。storage() 自己吞掉「存储不可用」这件事（隐私模式、被裁的 WebView）。
 */
/*
 * 闸门自己的记账。
 *
 * 读写直接调 storagePrimitives 并把**常量名**传进去：dev/dedicatus 的 D507 扫描按「这些函数 +
 * 本文件里解析得出的键」认「这把键还在用」，中间再包一层就认不出来了。
 * storagePrimitives 自己吞掉「存储不可用」这件事（隐私模式、被裁的 WebView）。
 */

const notify = () => listeners.forEach((listener) => {
    try {
        listener();
    } catch {
        /* 一个坏订阅者不该挡住别人 */
    }
});

const setLowMemory = (low: boolean, availMemKb: number | null) => {
    const changed = state.lowMemory !== low || state.availMemKb !== availMemKb;
    state.lowMemory = low;
    state.availMemKb = availMemKb;
    if (low) state.lastLowMemoryAt = Date.now();
    if (!changed) return;
    // 低内存状态也落盘：进程被杀死后重开时，界面至少知道「上次是内存紧的时候没的」。
    setStoredString(LOW_MEMORY_FLAG_KEY, low ? '1' : '0');
    notify();
};

/**
 * 把「本地推理能不能跑」推给原生，让 ONNX 在根源上就起不来。
 *
 * 原生侧（FoliaAutomixModelsPlugin.inferenceEnabled）默认 false：关着时 9 个推理方法入口直接
 * 拒绝，而且**不加载模型**；这里改成 false 时还会让原生把已加载的 OrtSession 与权重放掉。
 * 所以「禁掉之后内存真的还回去」，而不是只是不再发起新推理。
 *
 * 无插件方法（老包 / 非安卓）时静默跳过。
 */
const syncNativeInferenceSwitch = async (): Promise<void> => {
    if (!isCapacitorAndroid()) return;
    try {
        const { NativeBeats } = await import('./automix/nativeBeats');
        await NativeBeats.setInferenceEnabled?.({ enabled: isLocalInferenceAllowed() });
    } catch (error) {
        console.warn('[AiMemoryGate] 同步原生推理开关失败', error);
    }
};
/**
 * 读一次原生指标并更新闸门。
 *
 * 走 `window.electron.mods.getDeviceMetrics`（安卓上是 androidModsBridge 装的那份 shim，
 * 桌面端是 preload 的同一组合约）：原生本来就在按固定间隔采 CPU / 内存 / 温度，这里只是把
 * 内存那几项读出来，不新开通道、也不多一次采样线程。
 */
const sample = async (): Promise<void> => {
    if (!isCapacitorAndroid()) return;
    try {
        /*
         * `getDeviceMetrics` 不在 window.electron.mods 的类型声明里（它由 androidModsBridge 在安卓上装），
         * 所以这里必须自己断言一次形状 —— lint 的 no-unnecessary-type-assertion 认不出这个缺口。
         */
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- 见上：声明里没有这个方法
        const mods = (window as typeof window & {
            electron?: { mods?: { getDeviceMetrics?: () => Promise<{ metrics?: Record<string, unknown> | null }> } };
        }).electron?.mods;
        if (typeof mods?.getDeviceMetrics !== 'function') return;
        const reply = await mods.getDeviceMetrics();
        const metrics = reply?.metrics ?? null;
        if (!metrics) return;
        const lowMemory = Number(metrics.lowMemory ?? 0) === 1;
        const availMemKb = Number.isFinite(Number(metrics.availMemKb)) ? Number(metrics.availMemKb) : null;
        const thresholdKb = Number.isFinite(Number(metrics.thresholdKb)) ? Number(metrics.thresholdKb) : null;
        // 系统没置 lowMemory、但可用内存已经贴着阈值时按低内存处理：那一档离被判定 low 只差一步。
        const nearThreshold = availMemKb !== null && thresholdKb !== null && thresholdKb > 0
            ? availMemKb < thresholdKb * 1.5
            : false;
        setLowMemory(lowMemory || nearThreshold, availMemKb);
    } catch (error) {
        // 采不到不是「内存够」：保持上一次的结论，宁可保守。
        console.warn('[AiMemoryGate] 读设备内存失败', error);
    }
};

/**
 * 启动时调用一次：读上一回的稳定性标记、算连续崩溃次数、起轮询。
 *
 * 幂等 —— 重复调用只装一次。
 */
export const installAiMemoryGate = (): void => {
    if (installed) return;
    installed = true;

    // 上一回有没有活到稳定期？没有就记一次。
    const lastRunAlive = getStoredString(RUN_ALIVE_KEY, '') === '1';
    if (!isCapacitorAndroid()) {
        state.unstableRuns = 0;
    } else if (lastRunAlive) {
        state.unstableRuns = 0;
        removeStoredKey(UNSTABLE_RUNS_KEY);
    } else {
        state.unstableRuns = Math.min(Number(getStoredString(UNSTABLE_RUNS_KEY, '') || 0) + 1, 99);
        setStoredString(UNSTABLE_RUNS_KEY, String(state.unstableRuns));
    }
    setStoredString(RUN_ALIVE_KEY, '0');

    // 走到稳定期就把这一轮记成「活下来了」。
    setTimeout(() => {
        setStoredString(RUN_ALIVE_KEY, '1');
        if (state.unstableRuns !== 0) {
            state.unstableRuns = 0;
            removeStoredKey(UNSTABLE_RUNS_KEY);
            notify();
        }
    }, STABLE_AFTER_MS);

    if (!isCapacitorAndroid()) return;
    // 原生那边的 ONNX 总闸：装闸门时先按当前结论设一次（默认关 = 不加载任何模型）。
    void syncNativeInferenceSwitch();
    void sample();
    pollTimer = setInterval(() => { void sample(); }, POLL_INTERVAL_MS);
    // 页面回到前台时补采一次：后台期间系统的内存状况可能已经变了。
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') void sample();
        });
    }
};

/*
 * 两道闸，管的东西不一样 —— 别合并成一个。
 *
 *   · 本地推理（on-device）：整曲 PCM + 几十 MB 权重 + onnxruntime，峰值内存是整机的大头。
 *     它同时受「总闸」和「内存水位」管：系统已经在赶内存时再起推理，等于自己送上门被杀。
 *   · 在线补全（AI 主题 / 导演 / 云缓存）：只是一次网络请求，本地只解析一段文本，**不占本地内存**。
 *     它只受总闸管 —— 内存紧的时候禁它没有任何收益，只会让用户以为功能坏了。
 */

/** 内存压力：系统报低内存，或最近连续几次启动都没活到稳定期（频繁 OOM / 被杀）。 */
export const isUnderMemoryPressure = (): boolean => (
    state.lowMemory || state.unstableRuns >= UNSTABLE_RUNS_LIMIT
);

/** 本地推理被挡住的原因；可以跑返回 null。 */
export const localInferenceBlockedReason = (): 'disabled-in-settings' | 'low-memory' | 'recent-oom' | null => {
    if (readAiInferenceDisabled()) return 'disabled-in-settings';
    if (state.lowMemory) return 'low-memory';
    if (state.unstableRuns >= UNSTABLE_RUNS_LIMIT) return 'recent-oom';
    return null;
};

/** 在线补全被挡住的原因；可以发返回 null（只看总闸，不看内存）。 */
export const onlineInferenceBlockedReason = (): 'disabled-in-settings' | null => (
    readAiInferenceDisabled() ? 'disabled-in-settings' : null
);

/** 本地推理能不能跑：总闸关着，且不处在内存压力下。 */
export const isLocalInferenceAllowed = (): boolean => localInferenceBlockedReason() === null;

/** 在线补全能不能发：只看总闸。 */
export const isOnlineInferenceAllowed = (): boolean => onlineInferenceBlockedReason() === null;

const guardError = (reason: string) => Object.assign(
    new Error(`${AI_MEMORY_GUARDED}${reason}`),
    { code: 'ai-memory-guarded' },
);

/** 本地推理被挡住就抛（原生模型入口用）。 */
export const assertLocalInferenceAllowed = (): void => {
    const reason = localInferenceBlockedReason();
    if (reason !== null) throw guardError(reason);
};

/** 在线补全被挡住就抛（requestAiCompletion 用）。 */
export const assertOnlineInferenceAllowed = (): void => {
    const reason = onlineInferenceBlockedReason();
    if (reason !== null) throw guardError(reason);
};

/** 一次性读快照（界面显示 / 诊断用）。 */
export const readAiMemoryGateState = (): Readonly<GateState> => ({ ...state });

export const subscribeAiMemoryGate = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/** 测试用：把闸门恢复到刚装好的样子。 */
export const resetAiMemoryGateForTest = (): void => {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
    installed = false;
    state.lowMemory = false;
    state.unstableRuns = 0;
    state.availMemKb = null;
    state.lastLowMemoryAt = null;
    listeners.clear();
};
