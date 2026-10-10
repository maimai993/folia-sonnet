// src/services/nativeRemoteAudio.ts
/**
 * 把远端音频地址换成安卓本地回环服务的地址（只有真机生效）。
 *
 * 为什么需要它：播放器给 <audio> 挂了 `crossOrigin="anonymous"`，而某些 CDN
 * （目前就是波点用的 Kuwo）**根本不下发 Access-Control-Allow-Origin** ——
 * 同源检查在最前面就把字节挡掉了，报出来的却是一句毫无特征的
 * `MEDIA_ELEMENT_ERROR: Format error` / "The element has no supported sources"。
 *
 * 原生侧（LocalAudioServer）代为转发，回包带 `ACAO: *`，Range 原样透传，
 * 于是拖进度条也不受影响。非安卓或换地址失败时原样返回，让播放照旧直连一次 ——
 * 代理只是为了让"本来能播的"能播，不该因为代理本身出问题就把整首歌判死。
 */

type RegisterRemoteAudioResponse = {
    url?: string;
    proxied?: boolean;
    error?: string;
};

type NativePlugin = {
    registerRemoteAudio?: (options: { url: string }) => Promise<RegisterRemoteAudioResponse>;
};

const getPlugin = (): NativePlugin | null => (
    (window as any).Capacitor?.Plugins?.FoliaNative ?? null
);

/** 已经是本机回环地址了，不用再套一层。 */
const isLoopbackAudio = (url: string): boolean => url.includes('127.0.0.1') || url.includes('localhost');

export const proxyNativeRemoteAudioUrl = async (url: string | null | undefined): Promise<string> => {
    const value = String(url || '').trim();
    if (!value) return '';
    // 本地文件（blob / 回环服务自己发的）本来就同源，套代理纯属多此一举。
    if (value.startsWith('blob:') || value.startsWith('data:') || isLoopbackAudio(value)) return value;

    const plugin = getPlugin();
    if (!plugin?.registerRemoteAudio) return value;

    try {
        const response = await plugin.registerRemoteAudio({ url: value });
        const proxied = typeof response?.url === 'string' && response.url ? response.url : value;
        if (response?.proxied !== true) return value;
        return proxied;
    } catch {
        return value;
    }
};
