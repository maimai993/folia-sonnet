import type { ProviderAvailability, ProviderErrorCode } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';
import { isQishuiNativeAvailable, requestQishuiNative } from '../../platform/foliaNative';
import { isAndroidAppShell, isCapacitorAndroid } from '../../platform/runtime';

// src/services/onlineMusic/qishuiTransport.ts

// 冻结契约：下面的 operation 名与参数名就是桌面端 preload 接受的那一套，渲染层只有这一份真值。
export type QishuiOperation =
    | 'status'
    | 'login.qr'
    | 'login.check'
    | 'login.logout'
    // 两套协议（车机 / 手机）共用下面那一批 operation，选哪套由这两个先说好。
    // `protocol.get` 问「现在用哪一套、有哪些可选」；`protocol.use` 换一套
    // （桥把它记在模块里，之后的所有 operation 都按新的走）。
    | 'protocol.get'
    | 'protocol.use'
    // 手机协议专用：手动粘贴会话 Cookie，跳过扫码。
    | 'login.cookie'
    // 凭据在 App 这边也存一份（跨重启用）。只有安卓的隐藏 WebView 桥有这两个
    // operation，桌面端的 Electron 是另一条链路（它自己的 cookie 罐本来就持久），
    // 所以调用方要先判环境（见 qishuiProvider 的同名守卫），别在桌面端发。
    | 'session.export'
    | 'session.import'
    | 'search'
    | 'artist'
    | 'song.detail'
    | 'album'
    | 'lyric'
    | 'song.url'
    | 'feed'
    // 场景/心情/风格分类树（车机 /feed/mode/，免登录 client token 可读）；分类下的歌走 feed + scene。
    | 'feed.modes'
    // 手机端「发现 → 模式探索」（公开 /luna/discover），卡片下的歌走 discover.tracks + id。
    | 'discover.modes'
    | 'discover.tracks'
    | 'user.playlists'
    | 'playlist.tracks'
    | 'track.liked'
    | 'track.like'
    | 'playlist.collect'
    | 'playlist.addSong'
    | 'album.collect'
    | 'report.play'
    | 'comments'
    | 'comment.create';

export type QishuiParams = Record<string, unknown>;

export type QishuiBridgeResult =
    | { ok: true; data: unknown }
    | { ok: false; error: { code: string; message: string } };

// 桌面端（Electron preload）与安卓端（原生隐藏 WebView）给的是同一套信封，
// 所以「哪一边的桥在」只在这里判断一次，其余代码两边都不用分叉。
const hasDesktopBridge = () => (
    typeof window !== 'undefined' && typeof window.electron?.qishuiRequest === 'function'
);

/**
 * 汽水此刻能不能用，按运行环境分档：
 *
 * - 桌面端：Electron 那座桥在，照旧可用（旧 passport 协议）。
 * - 安卓：原生宿主确实在（`isQishuiNativeAvailable()`），协议层已整体换成汽水
 *   **车机协议**（/api/luna/v1/platform，签名用 WebView 自带的 WebCrypto，不再
 *   依赖只有 Windows x64 的 bdms.node）→ 可以正常登录与拉数据。
 * - 网页端：两条路都没有，当够不着。
 */
export const getQishuiTransportAvailability = (): ProviderAvailability => {
    if (hasDesktopBridge()) return { configured: true };
    if (isQishuiNativeAvailable()) return { configured: true };
    // ⚠ 在 App 壳里就当可用，哪怕桥这会儿还没起来。
    //
    // 这条分支的后果不是「这一项灰掉」，而是**把账号从界面上抹掉**：
    // accountRead 的 readWhole 在 `!availability.configured` 时直接
    // `store().clearAccount(providerId, reason)` 然后 return —— 不打任何日志。
    // 而 `isQishuiNativeAvailable()` 依赖 `Capacitor.isNativePlatform()`，
    // 启动头几秒原生还没把桥注入进来，它是 false（真机日志里那句
    // "deviceready has not fired after 5 seconds" 就是这段时间）。
    // 于是每次冷启动都静默清一次 → 「登录成功，重启后账号没了」，
    // 而凭据好端端地躺在 SharedPreferences 里。
    // 真正要等桥的是发请求那一步（见 requestQishui 里的 waitForNativeBridge），
    // 不是「这个平台在不在」。
    if (isAndroidAppShell()) return { configured: true };
    return { configured: false, reason: 'runtime-unavailable' };
};

/**
 * 桥起来之前最多等这么久；等不到再报不可用。
 *
 * 给得比较宽（真机上 deviceready 那句警告是 5 秒才报的）：这一路只在**确实是 App 壳**
 * 时才走，桥迟早会起来，等得久一点没有副作用 —— 而账号读那一侧有 60 秒的兜底
 * （accountRead 的 WHO_WAIT_MS），20 秒远在里面。
 */
const NATIVE_BRIDGE_WAIT_MS = 20_000;
let bridgeWaitNoted = false;
let bridgeProbeNoted = false;

/** 安卓上等 Capacitor 把桥注入进来（轮询，最多 NATIVE_BRIDGE_WAIT_MS）。 */
const waitForNativeBridge = async (): Promise<boolean> => {
    const startedAt = Date.now();
    while (!isQishuiNativeAvailable()) {
        if (Date.now() - startedAt >= NATIVE_BRIDGE_WAIT_MS) return false;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!bridgeWaitNoted) {
        bridgeWaitNoted = true;
        // 这一条是「账号为什么每次启动都要重新出现一遍」的唯一现场证据。
        console.info(`[Qishui] the native bridge came up ${Date.now() - startedAt} ms after the start`);
    }
    return true;
};

const PROVIDER_ERROR_CODES = new Set<ProviderErrorCode>([
    'auth-required', 'unsupported', 'not-public', 'unavailable', 'not-playable',
    'preview-only', 'region-restricted', 'network', 'invalid-response',
]);
const AUTH_ERROR_CODES = new Set(['QISHUI_TOKEN_REQUIRED', 'QISHUI_COOKIE_REQUIRED', 'QISHUI_LOGIN_REQUIRED']);
const REQUEST_ERROR_CODES = new Set(['QISHUI_QR_TOKEN_REQUIRED']);

// 主进程桥会把抛出的错误码统一成小写短横线形式（QISHUI_COOKIE_REQUIRED -> qishui-cookie-required），
// 而 200 + error 的数据级错误还是原始大写形式，所以匹配前先归一化。
const normalizeQishuiErrorCode = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-');

// 上游用的是自己的错误词表，落到 ProviderErrorCode 之外的类型会直接导致类型检查失败，
// 所以未知错误码一律折算成 Omni 已经会展示的最接近的那个。
export const toQishuiErrorCode = (code: unknown): ProviderErrorCode => {
    const dashed = normalizeQishuiErrorCode(code);
    if (PROVIDER_ERROR_CODES.has(dashed as ProviderErrorCode)) return dashed as ProviderErrorCode;
    const upper = dashed.toUpperCase().replace(/-/g, '_');
    if (REQUEST_ERROR_CODES.has(upper) || /QR_TOKEN_REQUIRED/.test(upper)) return 'invalid-response';
    if (AUTH_ERROR_CODES.has(upper) || /(^|_)LOGIN(_|$)|COOKIE_REQUIRED|TOKEN_REQUIRED/.test(upper)) return 'auth-required';
    if (/MISSING_|_EMPTY|NOT_FOUND|INCOMPLETE|_FAILED/.test(upper)) return 'invalid-response';
    // 手机端点「取消登录」时主进程用 mfa-cancelled 抛错：这不是环境不可用，而是本次登录作废，
    // 归到 auth-required，登录弹窗才会走「可以立刻重试、不给诊断入口」那条分支。
    if (upper === 'MFA_CANCELLED' || upper === 'MFA_CANCELED') return 'auth-required';
    return 'unavailable';
};

export async function requestQishui<T = unknown>(operation: QishuiOperation, params: QishuiParams = {}): Promise<T> {
    // 第一次发请求时把「此刻到底认不认得出这是原生」记一行。
    // `native=false shell=true` 就是「桥还没起来」—— accountRead 会据此把账号抹掉，
    // 这就是「重启后账号没了」的现场证据。
    if (!bridgeProbeNoted) {
        bridgeProbeNoted = true;
        console.info(`[Qishui] runtime: nativeBridge=${isQishuiNativeAvailable()}`
            + ` capacitorAndroid=${isCapacitorAndroid()} androidShell=${isAndroidAppShell()}`
            + ` desktop=${hasDesktopBridge()}`);
    }
    // 在 App 壳里、但桥还没注入完：等它起来再走原生那条路。
    // 不等的话这一句立刻抛「不可用」，而 accountRead 会把「问不出来」当成
    // 「这个平台没账号」—— 又是同一个「重启后账号没了」的坑。
    if (!isQishuiNativeAvailable() && isAndroidAppShell()) await waitForNativeBridge();
    // 安卓：协议层在原生那个隐藏 WebView 里，信封与桌面端一致，只是走插件。
    if (isQishuiNativeAvailable()) {
        const result = await requestQishuiNative(operation, params);
        if (!result.ok) throw new OnlineProviderError(toQishuiErrorCode(result.error.code), result.error.message, 'qishui', result.error.code);
        return result.data as T;
    }
    if (!hasDesktopBridge()) {
        throw new OnlineProviderError('unavailable', 'Qishui Music is not available on this runtime', 'qishui');
    }
    let result: QishuiBridgeResult;
    try { result = await window.electron!.qishuiRequest(operation, params); }
    catch { throw new OnlineProviderError('network', 'Qishui desktop request failed', 'qishui'); }
    // 原始错误码随 cause 一起带出：映射会丢掉 `mfa-cancelled` 这类上游专有词，调用方偶尔需要它。
    if (!result.ok) throw new OnlineProviderError(toQishuiErrorCode(result.error.code), result.error.message, 'qishui', result.error.code);
    return result.data as T;
}

// 汽水的 handler 也会用 200 + `error` 字段来拒绝请求；不在这里抛，调用方会把拒绝当成空结果页。
export function throwQishuiDataError(data: unknown): void {
    const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    if (!record.error) return;
    throw new OnlineProviderError(toQishuiErrorCode(record.error), String(record.message || record.error), 'qishui');
}
