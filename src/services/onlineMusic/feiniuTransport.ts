import { OnlineProviderError } from '../../types/onlineMusic';
import { fetchWithTimeout } from '../../utils/fetchWithTimeout';
import { sha256Hex } from '../../utils/sha256';
import { isNativeHttpAvailable, nativeHttpRequest, removeNativeCookie, setNativeCookie } from '../../platform/foliaNative';
import { readProviderSessionValue, removeProviderSessionValue, writeProviderSessionValue } from './providerStorage';

// src/services/onlineMusic/feiniuTransport.ts
// 飞牛（FNOS）音乐服务的 HTTP 层：拼地址、带 Cookie、把响应体拆成 `data`。
// 与网易 / 酷狗不同，飞牛没有中间的 API 服务器：它就是用户自己的 NAS，地址由用户在
// 登录表单里填（构建期的 VITE_FEINIU_API_BASE 只是默认值，方便自部署）。
//
// 直连带来一个必须绕开的坑：App 里页面跑在 https://localhost 上，而 NAS 上的服务几乎
// 不会下发 `Access-Control-Allow-Origin`。WebView 的 fetch 会在同源检查这一关被挡掉，
// 抛出来的是一句毫无特征的 `TypeError: Failed to fetch` —— 与「地址填错」「NAS 没开机」
// 长得完全一样，界面上只能干巴巴报「网络错误」。所以真机上整个飞牛的 HTTP 都改由原生
// OkHttp 代发（没有同源策略这回事），桌面 / 网页端仍是浏览器 fetch。

/** 接口前缀。用户填的地址不带它，发请求时才拼上。 */
const API_PREFIX = '/music/api/v1';

/** 账号或密码错误。服务端只给 code，msg 是英文，界面要换成自己的提示。 */
const CODE_INVALID_CREDENTIALS = 120001;

/** 翻页接口一次最多取这么多，再大服务端也不认。 */
const MAX_PAGE_SIZE = 300;

const readEnvBase = (): string => {
    const viteValue = typeof import.meta !== 'undefined' && import.meta.env?.MODE !== 'test'
        ? String((import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_FEINIU_API_BASE || '')
        : '';
    const processValue = typeof process !== 'undefined'
        ? String(process.env?.VITE_FEINIU_API_BASE || '')
        : '';
    return viteValue || processValue;
};

/**
 * 飞牛（fnOS）音乐服务的默认端口。
 *
 * fnOS 的 Web 网关就挂在这个端口上，音乐是它下面的 `/music/`（接口 `/music/api/v1`）。
 * 用户从浏览器地址栏复制下来的多半是 `http://192.168.x.x:5666/music/` 这一段，
 * 但手写时经常只写个 IP —— 那就必须补上这个端口，否则请求会打到 80 上去。
 */
const DEFAULT_PORT = 5666;

/**
 * 存之前先洗干净。
 *
 * 用户在手机上填地址，粘贴进来带空格、中文冒号（`：`）是家常便饭，而这两种东西
 * 拼进 URL 就会让 `new URL()` 直接抛 `Invalid URL` —— 抛出来还是一句看不懂的话，
 * 界面上只显示「未知错误」。所以在这里就把它们收拾掉。
 */
export const normalizeFeiniuServerUrl = (value: string): string => (
    String(value ?? '')
        .replace(/\s+/g, '')
        .replace(/[：︓]/g, ':')
        // 照着浏览器地址栏复制的两种尾巴都要剥掉：飞牛音乐的网页地址是
        // `http://NAS:5666/music/`，接口是它下面的 `/music/api/v1`。留着它们，
        // 拼出来的就成了 `/music/music/api/v1` —— 网关找不到这个 location，
        // 把请求兜到前端页面上，登录报「非 JSON 响应」。
        .replace(/\/music\/api\/v1\/*$/i, '')
        .replace(/\/music\/*$/i, '')
        .replace(/\/+$/, '')
);

/**
 * FN ID 那台 NAS 的域名后缀（FN Connect 的中继网关）。
 *
 * 飞牛的远程访问是 FN Connect：每台 NAS 领一个 FN ID，中继地址是 `https://<FN ID>.fnos.net`
 * —— 域名是飞牛自己的，不是用户搭的反代，在这里补后缀就够了，也不需要那个 5666 的局域网
 * 端口（网关走 https 443）。例：填 `baixiao` → `https://baixiao.fnos.net`。
 *
 * ⚠️ 后缀只有这一家（实测，`baixiao.fnos.net` 在多个公共 DNS 上都解析得到）。`5ddd.com` 是
 * **旧**的中继域名：早先的通道，如今不再下发 —— 用户在旧版本里连过的地址可能还是它，所以
 * 判定「走不走中继」时两个都认，但**拼地址只用 fnos.net**。
 */
const FNID_HOST_SUFFIX = 'fnos.net';
/** 上一代中继通道的域名：只用来认「这条地址是中继」，不再用来拼新地址。 */
const LEGACY_RELAY_SUFFIX = '5ddd.com';

/** 这一条地址是不是走飞牛的中继（而不是局域网直连）：是的话请求都要带 `mode=relay`。 */
export const isFeiniuRelayAddress = (value: string): boolean => {
    const host = normalizeFeiniuServerUrl(value).replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
    return host.endsWith(`.${FNID_HOST_SUFFIX}`) || host.endsWith(`.${LEGACY_RELAY_SUFFIX}`);
};

/**
 * 这一页是不是 FN Connect 网关自己的登录页。
 *
 * 网关没放行时，任何请求（连密码登录那一步也在内）都只回一页 HTML —— 请求其实到了那台机器，
 * 所以这里的失败原因不是「地址上没有服务」，而是「这一层不放行」。
 * 判据取网关页自己的特征（标题与它引用的静态资源都带 FN Connect / fnnas.com/connect）。
 */
export const isFnConnectLoginPage = (text: string): boolean => (
    /fn\s*connect|fnnas\.com\/connect/i.test(text.slice(0, 4096))
);

/**
 * 用户在「FN ID」那一栏填的东西（可能带了 https、端口、或者干脆就是整条域名）变成服务器地址。
 *
 * 只有「不带点、不带端口」的一串才是 FN ID，才去补中继后缀；写了域名或 IP 的是另一回事，
 * 那种照他写的来 —— 连自己域名的人知道自己在连哪里，不该被我们改成 https。
 */
export const feiniuServerUrlFromFnId = (value: string): string => {
    const cleaned = normalizeFeiniuServerUrl(value);
    const bare = cleaned.replace(/^https?:\/\//i, '');
    const head = bare.split('/')[0] ?? '';
    if (!head) return '';
    const [name, maybePort] = head.split(':');
    // 一串没有点的东西才可能是 FN ID（域名一定有点，IP 也有点）。
    if (!name.includes('.')) return `https://${name.toLowerCase()}.${FNID_HOST_SUFFIX}${/^\d+$/.test(maybePort ?? '') ? `:${maybePort}` : ''}`;
    const port = /^\d+$/.test(maybePort ?? '') ? `:${maybePort}` : '';
    const scheme = /^https:\/\//i.test(cleaned) ? 'https' : /^http:\/\//i.test(cleaned) ? 'http' : 'https';
    return `${scheme}://${name.toLowerCase()}${port}`;
};

/** 反方向：上次的地址是一条 FN ID 的远程地址时给出它的 ID（用来预填那一栏）；不是就给空串。 */
export const feiniuFnIdFromServerUrl = (value: string): string => {
    const head = normalizeFeiniuServerUrl(value).replace(/^https?:\/\//i, '').split('/')[0] ?? '';
    const host = head.split(':')[0].toLowerCase();
    for (const suffix of [FNID_HOST_SUFFIX, LEGACY_RELAY_SUFFIX]) {
        if (host.endsWith(`.${suffix}`)) return host.slice(0, -(suffix.length + 1));
    }
    return '';
};

/**
 * 补 scheme 与默认端口。
 *
 * 只补 http：https 走 443 是普遍约定（FN ID 的远程地址反代通常也挂在 443 上），而 http 这一侧
 * 飞牛几乎都跑在 5666 —— 没写端口的 http 地址按 80 去连，连上的多半是 NAS 上别的
 * 服务，回一个 HTML 页面，于是登录报「非 JSON 响应」，看着像是接口坏了。
 */
const withSchemeAndPort = (value: string): string => {
    const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
    if (/^https:\/\//i.test(withScheme)) return withScheme;
    if (/^http:\/\/[^/?#]+:\d+/i.test(withScheme)) return withScheme;
    return withScheme.replace(/^(http:\/\/[^/?#]+)/i, (head) => `${head}:${DEFAULT_PORT}`);
};

/** 当前生效的服务器地址：会话里存的那份优先，否则用构建期配的默认值。 */
export const getFeiniuServerUrl = (): string => (
    normalizeFeiniuServerUrl(readProviderSessionValue('feiniu', 'server') || readEnvBase())
);

/** 登录成功（或用户改地址）后记下来。登出不清：下次登录少填一项。 */
export const setFeiniuServerUrl = (value: string): void => {
    const normalized = normalizeFeiniuServerUrl(value);
    if (!normalized) return;
    if (normalized !== getFeiniuServerUrl()) {
        // 换了地址：旧地址下的登录态用不上了，先清掉再存新地址。
        clearFeiniuSession();
        writeProviderSessionValue('feiniu', 'server', normalized);
    }
    // 原生兜底切歌要自己拼取流地址与 Cookie，地址（以及随之清掉的会话）都要推过去。
    syncFeiniuGatewayCredentials();
    getFeiniuResourceSession();
};

const randomHex = (bytes: number): string => {
    const buffer = new Uint8Array(bytes);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        crypto.getRandomValues(buffer);
    } else {
        for (let index = 0; index < bytes; index += 1) buffer[index] = Math.floor(Math.random() * 256);
    }
    return Array.from(buffer).map(value => value.toString(16).padStart(2, '0')).join('');
};

/**
 * 设备 id（32 位 hex），登录与漫游都要带。
 * 一次生成之后就钉住：换一个 id 服务端会当成新设备，漫游的进度会从头开始。
 */
const getDeviceId = (): string => {
    const stored = readProviderSessionValue('feiniu', 'deviceId');
    if (stored && /^[0-9a-f]{32}$/i.test(stored)) return stored;
    const generated = randomHex(16);
    writeProviderSessionValue('feiniu', 'deviceId', generated);
    return generated;
};

export const getFeiniuDeviceId = getDeviceId;

export const getFeiniuToken = (): string => readProviderSessionValue('feiniu', 'token') || '';

/** 中继模式：飞牛在外网穿透下要靠 `mode=relay` 这个 Cookie 值区分访问方式。 */
export const isFeiniuRelayMode = (): boolean => readProviderSessionValue('feiniu', 'relay') === '1';

export const setFeiniuRelayMode = (relay: boolean): void => {
    writeProviderSessionValue('feiniu', 'relay', relay ? '1' : '0');
    syncFeiniuGatewayCredentials();
    syncFeiniuCookieJarForRelay(relay);
    getFeiniuResourceSession();
};

/** Cookie 的值：登录态全靠它，图片与音频流也要带同一个头。 */
export const feiniuAuthCookie = (): string => (
    isFeiniuRelayMode() ? `music-token=${getFeiniuToken()}; mode=relay` : `music-token=${getFeiniuToken()}`
);

/**
 * 把飞牛的会话三件套（地址 / token / 中继）推给原生网关。
 *
 * 原生兜底切歌（WebView 冻结时的播放延续）要自己拼取流地址、给 ExoPlayer 带会话
 * Cookie —— 飞牛的凭据全在 Web 层的会话存储里，不推过去原生那边就两手空空。
 * 没装插件（网页 / 桌面端、worker、单测）时是空操作。token 为空＝登出，原生清掉。
 */
export const syncFeiniuGatewayCredentials = (): void => {
    if (typeof window === 'undefined') return;
    const plugin = (window as any).Capacitor?.Plugins?.FoliaNative;
    if (!plugin?.setGatewayCredentials) return;
    void plugin.setGatewayCredentials({
        provider: 'feiniu',
        serverUrl: getFeiniuServerUrl(),
        token: getFeiniuToken(),
        relayMode: isFeiniuRelayMode(),
    }).catch(() => undefined);
};

/** 封面与音频流的鉴权头；没登录时给 null（那时本来也取不到资源）。 */
export const feiniuResourceHeaders = (): Record<string, string> | null => {
    const token = getFeiniuToken();
    if (!token) return null;
    return { Cookie: feiniuAuthCookie() };
};

const assetBase = (): string => {
    const base = getFeiniuServerUrl();
    return base ? withSchemeAndPort(base) : '';
};

export type FeiniuResourceSession = {
    origin: string;
    headers: Record<string, string>;
};
let resourceSessionKey = '';
let resourceSession: FeiniuResourceSession | null = null;
const resourceSessionListeners = new Set<() => void>();

/** 会话对象只在地址、账号或凭据变化时替换；凭据不放进缓存键或代理 URL。 */
export const getFeiniuResourceSession = (): FeiniuResourceSession | null => {
    const base = assetBase();
    const headers = feiniuResourceHeaders();
    const key = JSON.stringify([base, headers, readProviderSessionValue('feiniu', 'user')]);
    if (key !== resourceSessionKey) {
        resourceSessionKey = key;
        resourceSession = null;
        try {
            const parsed = new URL(base);
            if (headers && /^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password) {
                resourceSession = { origin: parsed.origin, headers };
            }
        } catch { /* 未配置或地址无效时不代理带凭据的资源。 */ }
        resourceSessionListeners.forEach(listener => listener());
    }
    return resourceSession;
};

export const onFeiniuResourceSessionChange = (listener: () => void): (() => void) => {
    resourceSessionListeners.add(listener);
    return () => { resourceSessionListeners.delete(listener); };
};

/** 只接受当前 NAS 同源的静态资源，不把 URL 路径当作来源身份。 */
export const isFeiniuCoverUrl = (value: string, session: FeiniuResourceSession): boolean => {
    try {
        const url = new URL(value);
        return url.origin === session.origin && !url.username && !url.password
            && url.pathname.startsWith(`${API_PREFIX}/static/`);
    } catch {
        return false;
    }
};

/**
 * 中继开关同样要落在 cookie 上：拉资源的那两个元素读不到代码里的变量，只看 cookie。
 * 关掉时要真的删掉，否则服务端会一直按中继方式回包。
 */
const syncFeiniuCookieJarForRelay = (relay: boolean): void => {
    const base = assetBase();
    if (!base) return;
    if (relay) {
        void setNativeCookie({ url: `${base}/`, name: 'mode', value: 'relay' });
        return;
    }
    void removeNativeCookie({ url: `${base}/`, name: 'mode' });
};

export const feiniuCoverUrl = (coverId?: string | null, size = 480): string => {
    const base = assetBase();
    if (!base || !coverId) return '';
    return `${base}${API_PREFIX}/static/cover?coverId=${encodeURIComponent(String(coverId))}&size=${size}`;
};

export const feiniuStreamUrl = (guid: string): string => {
    const base = assetBase();
    return base ? `${base}${API_PREFIX}/track/stream?guid=${encodeURIComponent(guid)}` : '';
};

export type FeiniuEnvelope<T = unknown> = { code: number; msg: string; data: T };

export type FeiniuRequestOptions = {
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    method?: 'GET' | 'POST';
    /** 登录请求自己没有 token，不该带一个空的 Cookie 上去。 */
    anonymous?: boolean;
    timeoutMs?: number;
};

/** 日志里要说清连的是哪台机器：只取 `scheme://host:port`，不带路径与凭据。 */
const describeFeiniuTarget = (url: URL): string => url.origin;

/**
 * 飞牛自己的超时。比其它平台短一截：NAS 就在局域网里，十几秒还不回就是有问题了，
 * 没必要让一个请求挂在那儿占着资源。
 */
const FEINIU_TIMEOUT_MS = 12_000;

/**
 * 飞牛的请求闸门：同一时刻只放行一个，两个之间还要让出一个宏任务。
 *
 * 为什么必须限：真机上飞牛的请求走的是 Capacitor 桥（原生 OkHttp），而网易 / QQ / 酷狗
 * 那些接口**同样**过这条桥（fetch shim 把它们的请求也转到 `FoliaNative.httpRequest`）。
 * 登录飞牛之后界面会并发去拉歌单、收藏、历史、曲目总数 —— 收藏那一路还是无限翻页，
 * 几十个请求连着把桥占住，别的平台的请求就只能在队列里排队，等排到时调用方那边的
 * 超时早就到了，于是「登录飞牛之后其它平台集体超时」（退出飞牛重启即恢复）。
 *
 * 串行 + 让一帧不是为了变快，是**给别的平台留出插空的缝**：桥是共用的，
 * 谁都不该被一个后台翻页的任务独占。
 */
let feiniuChain: Promise<unknown> = Promise.resolve();

const throughFeiniuGate = <T>(work: () => Promise<T>): Promise<T> => {
    const started = feiniuChain
        .catch(() => undefined)
        .then(() => new Promise<void>(resolve => setTimeout(resolve, 0)))
        .then(work);
    feiniuChain = started.catch(() => undefined);
    return started;
};

/**
 * 网页 / 桌面端这一路：浏览器 fetch 直连。
 *
 * 受同源策略约束 —— 服务端不下发 CORS 头就是一句 `Failed to fetch`；真机上不走它。
 */
const browserRequest = async (
    url: string,
    method: string,
    headers: Record<string, string>,
    payload: string | undefined,
    timeoutMs: number,
): Promise<{ status: number; text: string }> => {
    const response = await fetchWithTimeout(url, { method, headers, body: payload, credentials: 'omit' }, timeoutMs);
    return { status: response.status, text: await response.text() };
};

export const feiniuRequest = async <T = unknown>(path: string, options: FeiniuRequestOptions = {}): Promise<T> => {
    const base = getFeiniuServerUrl();
    if (!base) {
        throw new OnlineProviderError('unavailable', 'FeiNiu server address is not configured', 'feiniu');
    }
    if (!options.anonymous && !getFeiniuToken()) {
        throw new OnlineProviderError('auth-required', 'FeiNiu is not signed in', 'feiniu');
    }

    let url: URL;
    try {
        url = new URL(`${withSchemeAndPort(base)}${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`);
    } catch {
        // 地址本身拼不出 URL 时，`new URL` 抛的是一句 "Failed to construct 'URL'"，
        // 调用方只能当未知错误处理。这里换成「地址不对」并把它回显出来 ——
        // 用户看着自己填的那串才知道该改什么。
        throw new OnlineProviderError('unavailable', `FeiNiu server address is not a valid URL: ${base}`, 'feiniu');
    }
    Object.entries(options.query ?? {}).forEach(([key, value]) => {
        if (value === undefined || value === '') return;
        url.searchParams.set(key, String(value));
    });

    // 头名用小写：原生侧按 `content-type` 取 media type，而 Capacitor 那个 JSONObject
    // 取键名是大小写敏感的（浏览器的 Headers 才不敏感）。
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.anonymous) {
        // ⭐登录这一发**恒带** `mode=relay`。
        //
        // 中继网关（fnos.net）放不放行，看的就只有这一个值 —— 实测：
        //   带 `Cookie: mode=relay`  → 200 + JSON（放行，接口照常回 code）
        //   不带                     → 302 + nginx 的 HTML（拦下）
        // 而「走不走中继」这个标志恰恰要**登录成功之后**才知道（首次登录时它还不存在）：
        // 按标志决定带不带，等于首次登录永远带不上，FN ID 这条路就永远登不进来。
        // 局域网直连的那台收下一个不认识的 cookie 并不影响什么（顺手带上，省一条分支）。
        headers.cookie = 'mode=relay';
    } else {
        headers.cookie = feiniuAuthCookie();
    }
    const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
    let payload: string | undefined;
    if (options.body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(options.body);
    }

    const timeoutMs = options.timeoutMs ?? FEINIU_TIMEOUT_MS;
    let status: number;
    let text: string;
    try {
        const result = await throughFeiniuGate(() => (
            isNativeHttpAvailable()
                ? nativeHttpRequest({ url: url.toString(), method, headers, bodyText: payload ?? '', timeoutMs })
                : browserRequest(url.toString(), method, headers, payload, timeoutMs)
        ));
        status = result.status;
        text = result.text;
    } catch (error) {
        if (error instanceof OnlineProviderError) throw error;
        // 到底连的是哪台机器必须出现在日志里：地址填错、NAS 没开机、CORS 被挡，
        // 三种原因在调用方看到的都是同一句「网络错误」。
        throw new OnlineProviderError(
            'network',
            `FeiNiu request failed: ${path} (${describeFeiniuTarget(url)})`,
            'feiniu',
            error,
        );
    }

    if (status === 401 || status === 403) {
        throw new OnlineProviderError(
            'auth-required',
            `FeiNiu rejected the session (HTTP ${status})`,
            'feiniu',
            undefined,
            status,
        );
    }

    // 中继网关拦下请求的方式是一次 302，正文是 nginx 那一页「302 Found」——
    // 它**不带** FN Connect 的字样，所以只能按状态码认（下面那个认登录页的判据认不出它）。
    // 这就是「没带 mode=relay」/「这台 NAS 没开 FN Connect」的那一面，别按「地址上没有服务」说。
    if (status >= 300 && status < 400 && /^\s*(<!doctype|<html|<head)/i.test(text)) {
        throw new OnlineProviderError(
            'web-login-required',
            `FeiNiu gateway redirected the request instead of answering it for ${path} (HTTP ${status}, ${describeFeiniuTarget(url)}) — 中继网关把请求拨走了：FN ID 这条路要求请求带 mode=relay，并确认这台 NAS 开了 FN Connect 远程访问`,
            'feiniu',
            undefined,
            status,
        );
    }

    let envelope: FeiniuEnvelope<T>;
    try {
        envelope = JSON.parse(text) as FeiniuEnvelope<T>;
    } catch (error) {
        // 拿到一个 HTML 页面是最值得说清的一种失败：请求其实**到了**那台机器，
        // 只是那里不是飞牛的接口 —— 常见的是地址只写到 NAS 的 Web 端口（比如
        // fnOS 面板本身），或者这台机器上压根没装「音乐」应用，网关就把请求
        // 兜到了前端页面上。必须把这句话说出来，否则只能看到「非 JSON 响应」。
        const head = text.trimStart().slice(0, 64).toLowerCase();
        const isHtml = head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<head');
        // FN Connect 的登录页：请求**到了**网关，只是网关没有会话 —— 它把任何接口都换成这一页
        // （连密码登录也是），所以这里要说「先去网页里登录一次」，而不是「这个地址上没有服务」。
        const isGatewayLogin = isHtml && isFnConnectLoginPage(text);
        if (isGatewayLogin) {
            throw new OnlineProviderError(
                'web-login-required',
                `FeiNiu gateway asked for a web sign-in first for ${path} (HTTP ${status}, ${describeFeiniuTarget(url)}) — FN Connect 网关没有会话：它把所有请求都换成自己的登录页，密码登录也过不去`,
                'feiniu',
                error,
            );
        }
        throw new OnlineProviderError(
            'invalid-response',
            isHtml
                ? `FeiNiu returned an HTML page instead of JSON for ${path} (HTTP ${status}, ${describeFeiniuTarget(url)}) — 这个地址不是飞牛音乐的接口：检查端口与路径（接口是 http://NAS:5666/music/api/v1），并确认这台 NAS 上装了「音乐」应用`
                : `FeiNiu returned a non-JSON response for ${path} (HTTP ${status}, ${describeFeiniuTarget(url)})`,
            'feiniu',
            error,
        );
    }
    if (!envelope || typeof envelope !== 'object') {
        throw new OnlineProviderError('invalid-response', `FeiNiu returned an unexpected payload for ${path}`, 'feiniu');
    }
    if (envelope.code === CODE_INVALID_CREDENTIALS) {
        throw new OnlineProviderError('invalid-credentials', 'FeiNiu rejected the username or password', 'feiniu', envelope);
    }
    if (Number(envelope.code) !== 0) {
        throw new OnlineProviderError(
            'unavailable',
            envelope.msg || `FeiNiu request failed (${envelope.code})`,
            'feiniu',
            envelope,
        );
    }
    return envelope.data;
};

/**
 * 取一页列表。飞牛的分页是 1 起始的 `page` + `size`，而 omni 用的是 offset + limit，
 * 两边不对齐时（比如 offset=30、limit=50）多要一点再在本地切。
 */
/**
 * 列表字段的候选名。
 *
 * 飞牛各接口、各版本给的数组字段名并不统一（`list` / `tracks` / `items` …），
 * 而写死只认 `list` 的后果是**静默拿到空列表** —— 不报错、界面上就是「没有歌」，
 * 看日志也看不出所以然。所以按候选逐个试到**真的有内容**的那个为止。
 */
const LIST_KEYS = ['list', 'tracks', 'items', 'songs', 'records', 'rows', 'data'];
const TOTAL_KEYS = ['total', 'totalCount', 'count', 'totalSize'];

const asRecord = (value: unknown): Record<string, unknown> => (
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

/** 取列表：先找非空的数组，都空就退到第一个数组字段，再没有才认作空。 */
export const pickFeiniuList = (data: unknown): unknown[] => {
    if (Array.isArray(data)) return data;
    const record = asRecord(data);
    for (const key of LIST_KEYS) {
        const value = record[key];
        if (Array.isArray(value) && value.length > 0) return value;
    }
    for (const key of LIST_KEYS) {
        const value = record[key];
        if (Array.isArray(value)) return value;
    }
    return [];
};

/** 取总数：拿不到就报 0，调用方按「这一页取满了就还有下一页」推进。 */
export const pickFeiniuTotal = (data: unknown): number => {
    const record = asRecord(data);
    for (const key of TOTAL_KEYS) {
        const value = Number(record[key]);
        if (Number.isFinite(value) && value > 0) return value;
    }
    return 0;
};

export const feiniuList = async <T>(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    offset: number,
    limit: number,
): Promise<{ items: T[]; total: number }> => {
    const size = Math.min(Math.max(limit, 1) + (offset % Math.max(limit, 1)), MAX_PAGE_SIZE);
    const page = Math.floor(offset / Math.max(limit, 1)) + 1;
    const data = await feiniuRequest<unknown>(path, { query: { ...query, page, size } });
    const all = pickFeiniuList(data) as T[];
    // 数据回来了、却一个数组字段都没认出来时把键名打出来：
    // 下次就能直接照着真实结构改，不用再猜。
    if (all.length === 0 && data !== null && data !== undefined) {
        console.warn('[Feiniu] unexpected list payload for', path, 'keys:', Object.keys(asRecord(data)));
    }
    const skip = offset % Math.max(limit, 1);
    return { items: all.slice(skip, skip + limit), total: pickFeiniuTotal(data) };
};

export type FeiniuLoginData = {
    userToken?: string;
    user?: { name?: string; guid?: string; role?: string };
};

/**
 * 飞牛的资源地址（封面 / 音频流）是由 `<img>` / `<audio>` 直接去拉的，
 * 这两个元素都加不了请求头 —— 服务端要的 `music-token` 只能靠 cookie 自动带上。
 * 所以登录成功、改地址、开中继，都要把这一份同步进 WebView 的 cookie 罐。
 */
const syncFeiniuCookieJar = (): void => {
    const base = assetBase();
    const token = getFeiniuToken();
    if (!base) return;
    if (token) void setNativeCookie({ url: `${base}/`, name: 'music-token', value: token });
    syncFeiniuCookieJarForRelay(isFeiniuRelayMode());
};

/** 密码登录。成功就把 token 与地址落盘，之后所有请求自动带上。 */
export const feiniuPasswordLogin = async (username: string, password: string, serverUrl?: string): Promise<FeiniuLoginData> => {
    if (serverUrl) setFeiniuServerUrl(serverUrl);
    const data = await feiniuRequest<FeiniuLoginData>('/user/password-login', {
        method: 'POST',
        anonymous: true,
        body: { username, password: await sha256Hex(password), deviceId: getDeviceId() },
    });
    if (!data?.userToken) {
        throw new OnlineProviderError('invalid-response', 'FeiNiu login returned no token', 'feiniu', data);
    }
    writeProviderSessionValue('feiniu', 'token', data.userToken);
    // 连的是中继网关还是自家局域网，只有登录成功（地址已经落盘）之后才说得准：
    // 这里补上标志，之后 API 与封面 / 音频流才会带上 `mode=relay`（见 feiniuAuthCookie）。
    setFeiniuRelayMode(isFeiniuRelayAddress(getFeiniuServerUrl()));
    syncFeiniuCookieJar();
    syncFeiniuGatewayCredentials();
    return data;
};

/** 登出：只丢登录态，地址留着（飞牛音乐自己的做法）。 */
export const clearFeiniuSession = (): void => {
    const base = assetBase();
    if (base) {
        void removeNativeCookie({ url: `${base}/`, name: 'music-token' });
        void removeNativeCookie({ url: `${base}/`, name: 'mode' });
    }
    removeProviderSessionValue('feiniu', 'token');
    removeProviderSessionValue('feiniu', 'relay');
    removeProviderSessionValue('feiniu', 'user');
    // 原生网关那边留着旧 token 就会继续按已登出的人取流，所以两边一起清。
    syncFeiniuGatewayCredentials();
    getFeiniuResourceSession();
};

/**
 * 登录时把用户信息留在本地：飞牛没有「取当前登录用户」的接口，
 * 而账号 id 是刷新歌单这些请求的必备参数，登录之后每次都得拿得出来。
 */
export const rememberFeiniuUser = (user: { id: string | number; nickname: string; avatarUrl?: string }): void => {
    writeProviderSessionValue('feiniu', 'user', JSON.stringify(user));
    getFeiniuResourceSession();
};

export const readFeiniuUser = (): { id: string | number; nickname: string; avatarUrl?: string } | null => {
    if (!getFeiniuToken()) return null;
    const raw = readProviderSessionValue('feiniu', 'user');
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as { id?: string | number; nickname?: string };
        return parsed && parsed.id !== undefined && parsed.id !== '' ? parsed as { id: string | number; nickname: string } : null;
    } catch {
        return null;
    }
};

/**
 * 飞牛是「连上才知道」的：地址由用户在登录时填，不像托管服务那样能在启动前判定配没配。
 * 所以这里永远报已配置 —— 否则可用性检查会把用户挡在登录界面之外。
 */
export const getFeiniuTransportAvailability = () => ({ configured: true } as const);
