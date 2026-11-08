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
    lanCastPrepare?: () => Promise<{ port?: number; lanIp?: string }>;
    lanCastRelease?: () => Promise<unknown>;
};

type CastPlugin = {
    discover?: (options: { timeoutMs?: number }) => Promise<{ devices?: LanSpeaker[] }>;
    play?: (options: LanCastTrack & { controlUrl: string }) => Promise<{ ok?: boolean }>;
    stop?: (options: { controlUrl: string }) => Promise<{ ok?: boolean }>;
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
        const url = new URL(value, location.href);
        return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    } catch {
        return false;
    }
};

/**
 * 把播放地址变成音响能真正拉到的地址。
 *
 * 安卓上绝大多数在线歌曲走 `http://127.0.0.1:<port>/remote-audio/<token>`（绕 CORS 的转发），
 * 这个地址对音响毫无意义。投送前让原生把转发服务临时对局域网开放，再把 host 换成手机 IP，
 * token 与端口保持原样，音响就能连回来拿字节，连音源需要的请求头也照样由转发服务带上。
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
    const url = new URL(value);
    url.protocol = 'http:';
    url.host = `${info.lanIp}:${info.port}`;
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

// ------------------------------------------------------------------ 对外能力

export const discoverLanSpeakers = async (timeoutMs = 3200): Promise<LanSpeaker[]> => {
    const plugin = cast();
    if (!plugin?.discover) throw new Error('当前设备不支持局域网投送');
    const result = await plugin.discover({ timeoutMs });
    return (result?.devices ?? []).filter(device => Boolean(device?.controlUrl && device?.name));
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
    try {
        await relay()?.lanCastRelease?.();
    } catch { /* 收口失败不影响还原。 */ }
    restoreCastingMute();
    if (stopError) throw new Error(errorText(stopError));
};

export const lanCastErrorText = errorText;
