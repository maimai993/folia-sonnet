// src/services/lanCast.ts
// 局域网音响投送的前端门面。SSDP 发现与 SOAP 推送都在 FoliaLanCast 原生插件里，
// 这里负责能力探测、把本机回环转发地址换成音响能连的局域网地址、归一化错误，
// 以及投送会话本身的生命周期（手机静音 / 还原、跨组件共享当前音响）。

import { isCapacitorAndroid } from '../platform/runtime';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';

export type LanSpeaker = {
    id: string;
    name: string;
    location: string;
    controlUrl: string;
    manufacturer: string;
    /** RenderingControl 的 controlURL；没有就是这台音响不支持手机调音量。 */
    volumeControlUrl?: string;
};

export type LanCastTrack = {
    url: string;
    title: string;
    artist: string;
    album?: string;
    coverUrl?: string;
    durationMs?: number;
};

type RelayPlugin = {
    lanCastPrepare?: () => Promise<RelayPrepareInfo>;
    lanCastRelease?: () => Promise<unknown>;
};

type CastPlugin = {
    discover?: (options: { timeoutMs?: number }) => Promise<{ devices?: LanSpeaker[] }>;
    play?: (options: LanCastTrack & { controlUrl: string }) => Promise<{ ok?: boolean }>;
    stop?: (options: { controlUrl: string }) => Promise<{ ok?: boolean }>;
    getVolume?: (options: { volumeControlUrl: string }) => Promise<{ volume?: number }>;
    setVolume?: (options: { volumeControlUrl: string; volume: number }) => Promise<{ ok?: boolean }>;
    setMute?: (options: { volumeControlUrl: string; muted: boolean }) => Promise<{ ok?: boolean }>;
    getWifiState?: () => Promise<{ wifi?: boolean }>;
    setWifiAutoCast?: (options: { enabled: boolean }) => Promise<unknown>;
};

const nativePlugin = <T>(name: string): T | null => {
    if (typeof window === 'undefined') return null;
    const capacitor = (window as any).Capacitor;
    return (capacitor?.Plugins?.[name] ?? null) as T | null;
};

const relay = (): RelayPlugin | null => nativePlugin<RelayPlugin>('FoliaNative');
const cast = (): CastPlugin | null => nativePlugin<CastPlugin>('FoliaLanCast');

/** 桌面 / iOS / Web 上没有 SSDP 能力，播放页就不该出现投送入口。 */
export const isLanCastAvailable = (): boolean => (
    typeof window !== 'undefined' && isCapacitorAndroid() && cast()?.discover != null
);

const errorText = (error: unknown): string => {
    const raw = error instanceof Error ? error.message : String(error ?? '');
    // Capacitor 把 reject 包成 "Error: xxx"，去掉前缀免得界面上重复两遍。
    return raw.replace(/^Error:\s*/i, '').trim() || '未知错误';
};

/** 判断是不是本机回环的转发地址（音响拿到会当成它自己）。 */
const isLoopbackUrl = (value: string): boolean => {
    try {
        // 第二个参数在值本身是绝对地址时根本用不到，但它要求一个能解析的基准：
        // 直接用 location.href 会在没有 location 的宿主（宁可不猜）里抛进 catch，
        // 把回环地址误判成「不是回环」，于是一次投送跳过 prepare 直接推过去。
        const base = typeof location !== 'undefined' && location?.href ? location.href : undefined;
        const url = new URL(value, base);
        return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    } catch {
        return false;
    }
};

/**
 * 局域网主机白名单（与原生 LanCastTargetPolicy 同一套判定）。
 *
 * 为什么要在前端再判一次：`controlUrl` 会被持久化到 localStorage（上次那台音响），
 * 下次启动「WiFi 自动投送」时会不经重新发现直接把它传回原生。一旦某次发现被伪造的
 * SSDP 应答污染过，落盘的地址就可能指向任意主机 —— 存进来这条路上就先挡掉，
 * 而不是指望原生每次都拦得住。原生侧仍然独立校验一遍，两边都不依赖对方。
 */
const LAN_PORTS = new Set([80, 443, 49152, 49153, 49154, 49155, 49156, 49157, 8080, 8443]);

const isLanHost = (hostname: string): boolean => {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host) return false;
    if (host.endsWith('.local')) return true;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (v4) {
        const parts = v4.slice(1).map(Number);
        if (parts.some(part => part > 255)) return false;
        const [a, b] = parts;
        return a === 10
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 100 && b >= 64 && b <= 127)
            || (a === 198 && (b === 18 || b === 19));
    }
    // IPv6：只认唯一本地地址 fc00::/7 与链路本地 fe80::/10。
    if (host.includes(':')) return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
    return false;
};

/** 投送目标（音响的 controlUrl / volumeControlUrl）是否可信：局域网、常见端口、http(s)。 */
export const isTrustedLanTarget = (value: string | null | undefined): boolean => {
    const text = String(value || '').trim();
    if (!text) return false;
    try {
        const url = new URL(text);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        if (url.username || url.password) return false;
        const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
        if (!LAN_PORTS.has(port)) return false;
        return isLanHost(url.hostname);
    } catch {
        return false;
    }
};

type RelayPrepareInfo = {
    port?: number;
    lanIp?: string;
    /** 本次投送签发的局域网令牌（原生 LanCastLeaseRegistry）。旧版本插件不给。 */
    token?: string;
    /** 给人看的配对码，日志与界面提示用。 */
    pairCode?: string;
    /** 租约到期时间戳（毫秒）。 */
    expiresAt?: number;
};

/** 回环服务的局域网音频路由（与 LocalAudioServer.REMOTE_AUDIO_PATH_PREFIX 一致）。 */
const REMOTE_AUDIO_PATH = '/remote-audio/';

/**
 * 当前这次投送在原生侧开着的租约。
 *
 * 为什么要单独记：过去的收回只有 `stopCastingToSpeaker()` 一个点，投送中途异常、
 * 页面被关、网络切走、App 进后台这几种情况都不会走到那里，原生侧的开闸就一直挂着。
 * 这里记下租约，收回路径（见 releaseCastLease / installLanCastLifecycleGuards）据此判断
 * 还有没有开着的闸，并对「收回之后迟到的 prepare」兜底。
 */
type CastLease = {
    token: string | null;
    expiresAt: number | null;
    pairCode: string | null;
};
let lease: CastLease | null = null;

/** 租约的硬度：留 5 分钟余量，宁可早关也不让闸在没人用的时候一直开着。 */
const LEASE_EXPIRY_SLACK_MS = 5 * 60 * 1000;

/** 页面是否还在前台。拿不到 document 时按前台处理（桌面 / 测试环境）。 */
const isPageActive = (): boolean => (
    typeof document === 'undefined' || document.visibilityState !== 'hidden'
);

/**
 * 把播放地址变成音响能真正拉到的地址。
 *
 * 安卓上绝大多数在线歌曲走 `http://127.0.0.1:<port>/remote-audio/<token>`（绕 CORS 的转发），
 * 这个地址对音响毫无意义。投送前让原生开一次带截止时间的租约，再把 host 换成手机 IP，
 * 音响就能连回来拿字节，连音源需要的请求头也照样由转发服务带上。
 *
 * 安全：租约不是「开一个全局布尔」。原生只认本次签发的令牌 —— 回环注册表里的 token
 * 在局域网侧一律不认，所以这里用返回的 `token` 覆盖路径里的那一段。老版本插件不返回
 * `token` 时保留原路径（退化为旧行为，但仍受租约 + 来源校验约束）。
 */
const toCastableUrl = async (raw: string): Promise<string> => {
    const value = String(raw || '').trim();
    if (!value) throw new Error('当前没有正在播放的歌曲');
    if (value.startsWith('blob:') || value.startsWith('data:')) {
        throw new Error('本机文件没有局域网地址，暂时不能投送');
    }
    if (!/^https?:\/\//i.test(value)) throw new Error('这首歌的地址不能投送');
    if (!isLoopbackUrl(value)) return value;

    const bridge = relay();
    if (!bridge?.lanCastPrepare) throw new Error('当前版本不支持本机中继投送');
    const info = await bridge.lanCastPrepare();
    if (!info?.lanIp || !info?.port) {
        throw new Error('没取到手机的局域网地址，请确认已连接 WiFi');
    }
    // 记下本次租约：收回路径、后台 / 页面关闭时要用它判断有没有还开着的闸。
    lease = {
        token: typeof info.token === 'string' ? info.token : null,
        expiresAt: typeof info.expiresAt === 'number' ? info.expiresAt : null,
        pairCode: typeof info.pairCode === 'string' ? info.pairCode : null,
    };
    if (lease.expiresAt !== null) armLeaseExpiry(lease.expiresAt);
    // 收回之后迟到的 prepare：prepare 发起时页面还在前台，await 回来时用户已经退到后台 /
    // 关掉页面，收回已经跑过一遍。这里再关一次，别让一次「晚到的开闸」把闸留在原地，
    // 同时让这次投送明确失败（宁可让用户重试，也不能让它悄悄继续）。
    if (!isPageActive()) {
        releaseCastLease();
        throw new Error('页面已经退到后台，投送已取消');
    }
    const url = new URL(value);
    url.protocol = 'http:';
    url.host = `${info.lanIp}:${info.port}`;
    if (lease.token) url.pathname = `${REMOTE_AUDIO_PATH}${lease.token}`;
    return url.toString();
};

// ------------------------------------------------------------------ 投送会话

const MUTE_STORAGE_KEY = 'player_is_muted';

type CastSession = {
    speaker: LanSpeaker;
    /** 投送前手机是否本就静音。停止投送时据此还原，别把用户原本的静音一起解掉。 */
    wasMuted: boolean;
    /** 投送前 localStorage 里的原值（null = 当时没有这个 key）。 */
    storedMuted: string | null;
};

// 会话放在模块里而不是组件 state：离开播放页时 LanCastControl 会卸载，
// 但音响还在播，手机必须保持静音；回到播放页时也要能恢复「正在投送」的显示。
let activeSession: CastSession | null = null;
const listeners = new Set<() => void>();
const notifyCasting = () => { for (const listener of listeners) listener(); };

export const subscribeCasting = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};
export const getCastingSpeaker = (): LanSpeaker | null => activeSession?.speaker ?? null;
export const isCasting = (): boolean => activeSession !== null;

const readStoredMuted = (): string | null => {
    if (typeof window === 'undefined') return null;
    try { return localStorage.getItem(MUTE_STORAGE_KEY); } catch { return null; }
};

/**
 * handleSetMuted 会顺手把状态写进 localStorage。投送期间的静音只该是「这一次会话」的，
 * 否则中途被杀进程，下次打开应用会莫名其妙没声音。这里把落盘的值改回投送前的原值，
 * 内存里的 isMuted 仍然是 true，音量链路照常读到 0。
 */
const undoMutePersistence = (stored: string | null) => {
    if (typeof window === 'undefined') return;
    try {
        if (stored === null) localStorage.removeItem(MUTE_STORAGE_KEY);
        else localStorage.setItem(MUTE_STORAGE_KEY, stored);
    } catch { /* 存储不可用时忽略。 */ }
};

/**
 * 手机端静音，但**不暂停**：项目里 isMuted 只把输出增益降到 0，
 * 播放时钟（currentTime / lyricCurrentTime）只看 audio.paused，所以进度条和歌词照常走。
 * 安卓上出声走 ExoPlayer，这条链路也会把它 setVolume(0)，不会两边同时响。
 */
const applyCastingMute = () => {
    const session = activeSession;
    if (!session) return;
    const state = useAudioSettingsStore.getState();
    if (state.isMuted) return;
    state.handleSetMuted(true);
    undoMutePersistence(session.storedMuted);
};

/** 投送期间若被手动取消静音（拖音量条会自动取消），立刻压回去。 */
export const ensureCastingMute = () => applyCastingMute();

const restoreCastingMute = () => {
    const session = activeSession;
    if (!session) return;
    // 先清会话再改音量：ensureCastingMute 的守卫看到 isCasting() 为 false 就不会把还原压回去。
    activeSession = null;
    notifyCasting();
    const state = useAudioSettingsStore.getState();
    if (!session.wasMuted && state.isMuted) state.handleSetMuted(false);
    else undoMutePersistence(session.storedMuted);
};

// ------------------------------------------------------------------ 音响音量 / WiFi 自动投送

export const supportsSpeakerVolume = (speaker: LanSpeaker | null): boolean => (
    Boolean(speaker?.volumeControlUrl) && cast()?.setVolume != null
);

export const getSpeakerVolume = async (speaker: LanSpeaker): Promise<number> => {
    const plugin = cast();
    if (!speaker.volumeControlUrl || !plugin?.getVolume) throw new Error('这台音响不支持音量控制');
    const result = await plugin.getVolume({ volumeControlUrl: speaker.volumeControlUrl });
    const value = Number(result?.volume);
    if (!Number.isFinite(value)) throw new Error('音响没有返回音量');
    return Math.max(0, Math.min(100, Math.round(value)));
};

export const setSpeakerVolume = async (speaker: LanSpeaker, volume: number): Promise<void> => {
    const plugin = cast();
    if (!speaker.volumeControlUrl || !plugin?.setVolume) throw new Error('这台音响不支持音量控制');
    await plugin.setVolume({
        volumeControlUrl: speaker.volumeControlUrl,
        volume: Math.max(0, Math.min(100, Math.round(volume))),
    });
};

export const setSpeakerMuted = async (speaker: LanSpeaker, muted: boolean): Promise<void> => {
    const plugin = cast();
    if (!speaker.volumeControlUrl || !plugin?.setMute) return;
    await plugin.setMute({ volumeControlUrl: speaker.volumeControlUrl, muted });
};

const WIFI_AUTO_KEY = 'lanCastWifiAutoEnabled';
const LAST_SPEAKER_KEY = 'lanCastLastSpeaker';

export const getWifiAutoCastEnabled = (): boolean => {
    if (typeof window === 'undefined') return false;
    try { return localStorage.getItem(WIFI_AUTO_KEY) === '1'; } catch { return false; }
};

export const setWifiAutoCastEnabled = (enabled: boolean): void => {
    if (typeof window === 'undefined') return;
    try {
        if (enabled) localStorage.setItem(WIFI_AUTO_KEY, '1');
        else localStorage.removeItem(WIFI_AUTO_KEY);
    } catch { /* 存储不可用时只影响持久化，不影响本次会话。 */ }
    void cast()?.setWifiAutoCast?.({ enabled });
};

export const getLastSpeaker = (): LanSpeaker | null => {
    if (typeof window === 'undefined') return null;
    try {
        const raw = localStorage.getItem(LAST_SPEAKER_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as LanSpeaker;
        // 落盘之后可能已经被污染（见 isTrustedLanTarget）：读回来先过一遍白名单，
        // 不合格就当没有记住过，下次让用户重新扫一遍。
        if (!parsed?.controlUrl || !isTrustedLanTarget(parsed.controlUrl)) return null;
        return parsed;
    } catch { return null; }
};

export const rememberSpeaker = (speaker: LanSpeaker): void => {
    if (typeof window === 'undefined') return;
    // 只记可信的地址；不可思议就干脆不记，免得下一次自动投送打向别处。
    if (!isTrustedLanTarget(speaker.controlUrl)) return;
    try { localStorage.setItem(LAST_SPEAKER_KEY, JSON.stringify(speaker)); } catch { /* 忽略 */ }
};

/** 原生 NetworkCallback 在 WiFi 连上 / 断开时推事件；返回取消订阅函数。 */
export const subscribeWifiCast = (listener: (wifi: boolean) => void): (() => void) => {
    type ListenerHandle = { remove?: () => Promise<void> };
    type ListenerCapable = CastPlugin & {
        addListener?: (event: string, cb: (data: { wifi?: boolean }) => void) =>
            Promise<ListenerHandle> | ListenerHandle;
    };
    const plugin = cast() as ListenerCapable | null;
    if (!plugin?.addListener) return () => {};
    let handle: ListenerHandle | null = null;
    try {
        // 原生只在「连通性真的变了」时才推这条事件（见 FoliaLanCastPlugin.publishWifiState）。
        // 开关的启停不再是网络事件：过去 unregisterNetworkCallback 合成的 onLost 会被
        // 当成断网，用户关掉自动投送反而掐断了正在进行的投送。
        const pending = plugin.addListener('wifiCastChange', data => listener(Boolean(data?.wifi)));
        void Promise.resolve(pending).then(value => { handle = value ?? null; }).catch(() => {});
    } catch { return () => {}; }
    return () => { void Promise.resolve(handle).then(value => value?.remove?.()).catch(() => {}); };
};

/**
 * 当前是否真的在一个局域网里（而不是只「Wi-Fi 开关开着」）。
 *
 * 投送选址的判据来自这里：关掉 Wi-Fi 开关但设备还有别的可用网络时，
 * 一次投送不该被当成「断网」终止。拿不到原生能力时返回 null，调用方按原样处理。
 */
export const queryWifiState = async (): Promise<boolean | null> => {
    const plugin = cast();
    if (!plugin?.getWifiState) return null;
    try {
        const result = await plugin.getWifiState();
        return typeof result?.wifi === 'boolean' ? result.wifi : null;
    } catch {
        return null;
    }
};

// ------------------------------------------------------------------ 对外能力

export const discoverLanSpeakers = async (timeoutMs = 3200): Promise<LanSpeaker[]> => {
    const plugin = cast();
    if (!plugin?.discover) throw new Error('当前设备不支持局域网投送');
    const result = await plugin.discover({ timeoutMs });
    // 原生已经拦过一遍，这里再拦是防旧版本插件（升级后第一次启动仍可能路由到旧的原生实现）。
    return (result?.devices ?? []).filter(device => (
        Boolean(device?.controlUrl && device?.name) && isTrustedLanTarget(device.controlUrl)
    ));
};

export const castTrackToSpeaker = async (speaker: LanSpeaker, track: LanCastTrack): Promise<void> => {
    const plugin = cast();
    if (!plugin?.play) throw new Error('当前设备不支持局域网投送');
    const url = await toCastableUrl(track.url);
    try {
        await plugin.play({ ...track, url, controlUrl: speaker.controlUrl });
    } catch (error) {
        throw new Error(errorText(error));
    }
    // 换音响时，等新音响确实接上了再停旧的；推送失败就什么都不动，
    // 免得旧音响停了、新的没响、手机还静音。
    const previous = activeSession;
    if (previous && previous.speaker.controlUrl !== speaker.controlUrl && plugin.stop) {
        try {
            await plugin.stop({ controlUrl: previous.speaker.controlUrl });
        } catch { /* 旧音响可能已离线，忽略即可。 */ }
    }
    // 只有推送真的成功才静音，失败时手机照常出声。
    // 切歌自动跟随会复用同一会话，保留最初的静音记录，别把状态一层层覆盖掉。
    activeSession = {
        speaker,
        wasMuted: previous ? previous.wasMuted : useAudioSettingsStore.getState().isMuted,
        storedMuted: previous ? previous.storedMuted : readStoredMuted(),
    };
    notifyCasting();
    applyCastingMute();
    rememberSpeaker(speaker);
};

/** 停止音响播放、关掉对局域网开放的转发入口、把手机声音还原。 */
export const stopCastingToSpeaker = async (): Promise<void> => {
    const session = activeSession;
    const plugin = cast();
    let stopError: unknown = null;
    try {
        if (session && plugin?.stop) await plugin.stop({ controlUrl: session.speaker.controlUrl });
    } catch (error) {
        // 音响可能已离线；本地状态无论如何都要收口，不能留一个「永远静音」的手机。
        stopError = error;
    }
    releaseCastLease();
    restoreCastingMute();
    if (stopError) throw new Error(errorText(stopError));
};

/**
 * 只收回原生侧的局域网音频租约，但不碰音响、不还原静音。
 *
 * 用于「手机不再提供服务、但音响还在放」的场景（页面被关、进程即将被杀、
 * 租约到期兜底）。过去这一步只写在 stopCastingToSpeaker 里，其它出口都漏掉了。
 * 幂等：没有开着的租约时什么都不做。
 */
export const releaseCastLease = (): void => {
    // 先拆定时器：不管是用户停止、退到后台还是到点兜底，后续都不该再留着一个会再触发一次收回的计时器。
    if (leaseExpiryTimer !== null) {
        clearTimeout(leaseExpiryTimer);
        leaseExpiryTimer = null;
    }
    if (!lease) return;
    lease = null;
    try {
        void Promise.resolve(relay()?.lanCastRelease?.()).catch(() => {});
    } catch { /* 收口失败不影响其它状态。 */ }
};

/** 当前是否有原生侧的租约开着（调试与测试用）。 */
export const hasCastLease = (): boolean => lease !== null;

/**
 * 租约到点自动收回。
 *
 * 原生侧的租约自带截止时间，正常情况下会自己过期；这里额外盯一个定时器，
 * 是因为「过期」只是拒绝新请求，已经建立的连接仍会把这首歌传完。
 * 定时器与租约同寿命，收回或重开时会被清掉，不会累积。
 */
let leaseExpiryTimer: ReturnType<typeof setTimeout> | null = null;

const armLeaseExpiry = (expiresAt: number) => {
    if (leaseExpiryTimer !== null) clearTimeout(leaseExpiryTimer);
    const delay = Math.max(1000, expiresAt - LEASE_EXPIRY_SLACK_MS - Date.now());
    leaseExpiryTimer = setTimeout(() => {
        leaseExpiryTimer = null;
        releaseCastLease();
    }, delay);
};

/** 已安装的生命周期守卫的卸载函数；null 表示当前没装。 */
let uninstallLifecycleGuards: (() => void) | null = null;

/**
 * 安装「完整收回」的生命周期守卫：页面关闭、App 进后台/退出、网络切换都收口。
 *
 * 为什么不能只靠 stopCastingToSpeaker 一处：那条路径只在用户手动停止、或者
 * Wi-Fi 真的断了时才走。投送中途异常、页面被关、进程被杀，都会让原生侧的
 * 局域网音频通道一直开着 —— 同网段任何设备都能继续拉流。
 *
 * 这里挂四个点，且只做「关掉本机对局域网的开放」，不打断音响上的播放：
 *  - `pagehide` / `beforeunload`：页面被关闭或 WebView 被回收；
 *  - `visibilitychange`（hidden）/ `pause`：App 进后台（Android 上 WebView 随后可能被冻结，
 *    这时再没有任何 JS 能执行，所以必须在这一刻就关）；
 *  - `offline` / `online`：网络切换（换网之后旧地址本来就失效了，顺手关闸）；
 *  - 租约到期：兜底，见 armLeaseExpiry。
 *
 * 返回卸载函数：只由应用级 wiring 调一次，调用方卸载时把监听和定时器一起撤掉。
 */
export const installLanCastLifecycleGuards = (): (() => void) => {
    if (typeof window === 'undefined') return () => {};
    // 只装一次：这个守卫挂在应用级 wiring 上，重挂（React 严格模式的双调用、页面重载）
    // 只会让同一份收回逻辑被注册两遍，既浪费也会让「卸载后仍有人在听」变成难查的问题。
    if (uninstallLifecycleGuards) return uninstallLifecycleGuards;
    const release = () => releaseCastLease();
    const onVisibility = () => {
        if (document.visibilityState === 'hidden') release();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', release);
    window.addEventListener('beforeunload', release);
    window.addEventListener('offline', release);
    uninstallLifecycleGuards = () => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', release);
        window.removeEventListener('beforeunload', release);
        window.removeEventListener('offline', release);
        if (leaseExpiryTimer !== null) {
            clearTimeout(leaseExpiryTimer);
            leaseExpiryTimer = null;
        }
        uninstallLifecycleGuards = null;
    };
    return uninstallLifecycleGuards;
};

export const lanCastErrorText = errorText;
