import { OnlineProviderError } from '../../types/onlineMusic';
import { readProviderSessionValue, removeProviderSessionValue, writeProviderSessionValue } from './providerStorage';
import { fetchWithTimeout } from '../../utils/fetchWithTimeout';
import { upgradeInsecureApiBase } from '../../utils/secureApiBase';
import { isFoliaExtensionBridgeConfigured, requestFoliaExtension } from '../foliaExtensionBridge';

// src/services/onlineMusic/qqTransport.ts

export const QQ_OPERATIONS = [
    'login_qr_key', 'login_qr_create', 'login_qr_check', 'login_qr_cancel', 'login_status', 'logout',
    'login_channels',
    'user_detail', 'user_playlist', 'user_albums', 'user_liked_songs', 'user_playlist_detail',
    'music_play', 'song_list_detail', 'song_info',
    'album_info', 'artist_albums', 'artist_songs',
] as const;

export type QqOperation = typeof QQ_OPERATIONS[number];
export type QqParams = Record<string, string | number | boolean | undefined>;

const ENDPOINTS: Record<QqOperation, string> = {
    login_qr_key: '/login/qr/key',
    login_qr_create: '/login/qr/create',
    login_qr_check: '/login/qr/check',
    login_qr_cancel: '/login/qr/cancel',
    login_status: '/login/status',
    logout: '/logout',
    // 只有 3.0.0 之后的后端有这条路由，旧后端回 404，调用方要把它当成「没有声明」而不是错误。
    login_channels: '/login/channels',
    user_detail: '/user/detail',
    user_playlist: '/user/playlist',
    user_albums: '/user/albums',
    user_liked_songs: '/user/liked-songs',
    // 带凭据地读登录用户自己的歌单。匿名的 `song_list_detail` 读不了不公开的歌单，这条可以。
    // 与 `login_channels` 同样的处境：旧后端没有这条路由，回 404，调用方要当成「没有声明」。
    user_playlist_detail: '/user/playlist-detail',
    music_play: '/getMusicPlay',
    song_list_detail: '/getSongListDetail',
    song_info: '/getSongInfo',
    // 曲库端点用领域语汇命名，与 provider 的 getAlbum* / getArtist* 一一对应，不沿用上游的 singer_* 路径名。
    // 上游这三条路由虽然声明了路径参数，但 controller 只读 ctx.query，所以一律走 query string。
    album_info: '/getAlbumInfo',
    artist_albums: '/getSingerAlbum',
    artist_songs: '/getSingerHotsong',
};

// qq-music-api translates the native QR states into the Netease codes; 803 is the only one carrying a session.
const QR_CONFIRMED_CODE = 803;

const getWebApiBase = (): string => {
    const viteValue = typeof import.meta !== 'undefined' && import.meta.env?.MODE !== 'test'
        ? String((import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_QQ_API_BASE || '')
        : '';
    const processValue = typeof process !== 'undefined'
        ? String(process.env?.VITE_QQ_API_BASE || '')
        : '';
    const value = viteValue || processValue;
    // 明文后端在 https 页面里会被 WebView 当混合内容拦掉（报错是毫无特征的
    // `TypeError: Failed to fetch`），所以这里先把它升级成 https。
    return upgradeInsecureApiBase(value.trim().replace(/\/$/, ''));
};

// Electron embeds qq-music-api and starts it on a free port, so the base is only known at runtime.
const getElectronQqPortReader = (): (() => Promise<number | null>) | null => {
    if (typeof window === 'undefined') return null;
    const reader = window.electron?.getQqPort;
    return typeof reader === 'function' ? () => reader() : null;
};

let electronApiBase: string | null = null;

/**
 * 后端路径怎么拼，取决于对面是哪种服务端：
 * - `path`：路径式，如 `/api/qq/login/status`。内嵌的 qq-music-api（Electron）与
 *   直接把 Express 应用挂在子路径下的自托管部署只认这种。
 * - `query`：扁平式，如 `/api/qq?path=/login/status`。这是 `api-ts/qq.ts` /
 *   `api/qq.js` 这两个 serverless 入口**原生**就认的形式，不依赖任何 rewrite。
 *
 * Vercel 上两种都能走通（rewrite 把路径式折算成扁平式），但自托管站点未必配了同样的
 * rewrite，所以不能用「有没有 rewrite」当前提。这里不去猜部署形态：先按路径式发，
 * 撞上 404 再换扁平式，并且**只有成功的那次才被记成偏好** —— 这样 `login_channels` /
 * `user_playlist_detail` 在旧后端上必然的 404 不会被误当成「拼法错了」，不会污染后续请求。
 */
export type QqEndpointStyle = 'path' | 'query';

let webEndpointStyle: QqEndpointStyle = 'path';

export const resetQqTransportRuntimeCache = (): void => {
    electronApiBase = null;
    webEndpointStyle = 'path';
};

const resolveApiBase = async (): Promise<{ base: string; embedded: boolean }> => {
    const readPort = getElectronQqPortReader();
    if (readPort) {
        if (electronApiBase) return { base: electronApiBase, embedded: true };
        const port = await readPort();
        if (!port) {
            throw new OnlineProviderError('unavailable', 'Embedded QQMusicApi is not running', 'qq');
        }
        electronApiBase = `http://127.0.0.1:${port}`;
        return { base: electronApiBase, embedded: true };
    }

    const base = getWebApiBase();
    if (!base) {
        throw new OnlineProviderError('unavailable', 'VITE_QQ_API_BASE is not configured', 'qq');
    }
    return { base, embedded: false };
};

const buildRequestUrl = (base: string, style: QqEndpointStyle, endpointPath: string, query: string): string => {
    if (style === 'path') return `${base}${endpointPath}${query ? `?${query}` : ''}`;
    const separator = query ? '&' : '';
    return `${base}?path=${encodeURIComponent(endpointPath)}${separator}${query}`;
};

// The stored value is the backend's opaque `qqmusic_session=<token>` string, never a QQ credential.
const getWebSessionCookie = (): string => readProviderSessionValue('qq', 'cookie') || '';

const SESSION_COOKIE_NAME = 'qqmusic_session';
const SESSION_HEADER_NAME = 'X-QQ-Session';

// 后端两个入口的语义不同，不能互换：header 收的是裸 token，`?cookie=` 收的是整串 cookie。
const tokenFromCookieString = (cookie: string): string => {
    for (const entry of cookie.split(';')) {
        const separator = entry.indexOf('=');
        if (separator <= 0) continue;
        if (entry.slice(0, separator).trim() === SESSION_COOKIE_NAME) return entry.slice(separator + 1).trim();
    }
    return '';
};

// 同源部署（`/api/qq`、`/qq`）改走 header：sealed token 是密文本身，query 是它唯一会被 CDN 与
// edge access log 完整记下来的地方 —— 那是 sealed 相对不透明 token 唯一真正新增的泄漏面。
// 外部 URL 与 Electron 维持 `?cookie=`：跨源发自定义头会触发 preflight，而后端是
// `Access-Control-Allow-Origin: *`，按规范不允许搭配 credentials。
const isSameOriginBase = (base: string): boolean => base.startsWith('/');

// 走本地桥时登录凭据在原生 CookieManager（网页版在扩展的 cookie 库）里，
// providerStorage 里那份是后端部署用的，这里照旧查不到 —— 别因此把用户当成未登录。
export const hasQqExtensionSession = (): boolean => isFoliaExtensionBridgeConfigured(getWebApiBase());
export const hasQqSession = (): boolean => hasQqExtensionSession() || Boolean(getWebSessionCookie());

export const clearQqSession = (): void => removeProviderSessionValue('qq', 'cookie');

// 后端的退避时长（qq-music-api 在 429 的响应体里给 retryAfterMs，同时带 Retry-After 头，单位是秒）。
// 只收非负安全整数，读不出就不给，调用方按普通失败处理。
const readRetryAfterMs = (body: unknown, response: Response): number | undefined => {
    const fromBody = body && typeof body === 'object' ? (body as { retryAfterMs?: unknown }).retryAfterMs : undefined;
    if (typeof fromBody === 'number' && Number.isSafeInteger(fromBody) && fromBody >= 0) return fromBody;
    const raw = response.headers?.get?.('Retry-After')?.trim();
    if (!raw || !/^\d+$/.test(raw)) return undefined;
    const seconds = Number(raw);
    return Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : undefined;
};

const readJsonBody = async (response: Response): Promise<any> => {
    try {
        return await response.json();
    } catch {
        return undefined;
    }
};

// 曲库三条路由被上游拒收时仍然回 HTTP 200，状态码藏在响应体里，而且层级还不一样：
// `/getAlbumInfo` 直接是 `response.code`（参数类型错时是 1101 `para error!`），
// 两条歌手路由的 `response.code` 恒为 0，真正的状态在 `response.singer.code`（400 / 104400）。
// 不看这两层就会把「被拒收」当成「这个专辑没有曲目」，UI 只剩一片空白，线上很难定位。
// 登录与播放路由用的是另一套码值（如 `login_status` 回 200），故不纳入此检查。
const CATALOG_STATUS_NODES: Partial<Record<QqOperation, string[][]>> = {
    album_info: [['response']],
    // 歌单详情的上游是匿名 CGI：歌单不存在、不公开或参数不被接受时它照样回 HTTP 200，
    // 差别只在这个 `code` 上。不登记的话拒绝会一路变成空歌单，UI 只剩「暂无内容」。
    song_list_detail: [['response']],
    artist_songs: [['response'], ['response', 'singer']],
    artist_albums: [['response'], ['response', 'singer']],
};

const readNode = (body: any, path: string[]): any => (
    path.reduce((node, key) => (node === null || node === undefined ? node : node[key]), body)
);

const assertUpstreamAccepted = (operation: QqOperation, body: any): void => {
    for (const path of CATALOG_STATUS_NODES[operation] ?? []) {
        const node = readNode(body, path);
        const code = Number(node?.code);
        if (!Number.isFinite(code) || code === 0) continue;

        const subcode = Number(node?.subcode);
        const message = typeof node?.message === 'string' ? node.message.trim() : '';
        throw new OnlineProviderError(
            'invalid-response',
            `QQMusicApi ${operation} was rejected upstream at ${path.join('.')} (code ${code}`
            + `${Number.isFinite(subcode) && subcode !== code ? `, subcode ${subcode}` : ''})`
            + `${message ? `: ${message}` : ''}`,
            'qq',
            node,
        );
    }
};

const persistConfirmedSession = (operation: QqOperation, body: any): void => {
    if (operation !== 'login_qr_check' || Number(body?.code) !== QR_CONFIRMED_CODE) return;
    const cookie = body?.cookie;
    if (typeof cookie === 'string' && cookie) writeProviderSessionValue('qq', 'cookie', cookie);
};

export const getQqTransportAvailability = () => {
    if (getElectronQqPortReader()) return { configured: true } as const;
    return getWebApiBase()
        ? { configured: true } as const
        : { configured: false, reason: 'not-configured' as const };
};

const endpointFor = (operation: QqOperation, params: QqParams): { path: string; query: QqParams } => {
    const query = { ...params };
    const takeRequiredPathParam = (name: string): string => {
        const value = query[name];
        delete query[name];
        const pathValue = value === undefined ? '' : String(value).trim();
        if (!pathValue) {
            throw new OnlineProviderError(
                'invalid-response',
                `QQMusicApi ${operation} requires ${name}`,
                'qq',
            );
        }
        return encodeURIComponent(pathValue);
    };

    if (operation === 'music_play') {
        return { path: `${ENDPOINTS[operation]}/${takeRequiredPathParam('songmid')}`, query };
    }
    if (operation === 'song_list_detail') {
        return { path: `${ENDPOINTS[operation]}/${takeRequiredPathParam('disstid')}`, query };
    }
    if (operation === 'song_info') {
        const songmid = takeRequiredPathParam('songmid');
        const songid = query.songid;
        delete query.songid;
        return {
            path: `${ENDPOINTS[operation]}/${songmid}${songid === undefined ? '' : `/${encodeURIComponent(String(songid))}`}`,
            query,
        };
    }
    return { path: ENDPOINTS[operation], query };
};

// Routes one provider request through the embedded Electron server or the configured Web base URL.
const requestQqOnce = async <T = unknown>(
    operation: QqOperation,
    params: QqParams,
    base: string,
    style: QqEndpointStyle,
): Promise<T> => {
    const endpoint = endpointFor(operation, params);
    const query = new URLSearchParams();
    Object.entries(endpoint.query).forEach(([key, value]) => {
        if (value !== undefined) query.set(key, String(value));
    });
    const cookie = getWebSessionCookie();
    const headers: Record<string, string> = {};
    if (cookie) {
        if (isSameOriginBase(base)) {
            const token = tokenFromCookieString(cookie);
            // 同源请求不允许把未知格式的 session 放回 URL；清掉无效值，交给后端按未登录处理。
            if (token) headers[SESSION_HEADER_NAME] = token;
            else clearQqSession();
        } else {
            query.set('cookie', cookie);
        }
    }
    query.set('timestamp', String(Date.now()));

    // Same-origin serverless calls must retain deployment-protection cookies; external qq-music-api instances
    // answer with `Access-Control-Allow-Origin: *`, so those requests still omit browser credentials.
    const credentials: RequestCredentials = isSameOriginBase(base) ? 'same-origin' : 'omit';
    const response = await fetchWithTimeout(
        buildRequestUrl(base, style, endpoint.path, query.toString()),
        { credentials, headers },
    );
    if (!response.ok) {
        const failure = await readJsonBody(response);
        // A missing, expired, rejected, or non-persisted backend session is surfaced uniformly as 401.
        if (response.status === 401) {
            clearQqSession();
            throw new OnlineProviderError('auth-required', 'QQMusicApi login required', 'qq', failure, response.status);
        }
        // 404 是「这个后端没有这条路由」，不是网络故障 —— 用户可以自行部署任意版本的后端，
        // 新路由在旧后端上必然 404。报成 `unsupported`，调用方才能据此回落到旧路径，
        // 而不必去解析错误文案里的状态码。
        if (response.status === 404) {
            throw new OnlineProviderError(
                'unsupported',
                `QQMusicApi has no ${operation} route`,
                'qq',
                failure,
                response.status,
            );
        }
        throw new OnlineProviderError(
            'network',
            `QQMusicApi request failed: ${response.status}`,
            'qq',
            failure,
            response.status,
            readRetryAfterMs(failure, response),
        );
    }

    const body = await readJsonBody(response);
    if (body === undefined) {
        throw new OnlineProviderError('invalid-response', `QQMusicApi returned an unreadable ${operation} body`, 'qq');
    }
    assertUpstreamAccepted(operation, body);
    persistConfirmedSession(operation, body);
    return body as T;
};

/**
 * fetch 在 WebView 里失败时抛的是 `TypeError: Failed to fetch` —— 混合内容被拦、
 * CORS 没配、后端宕机、DNS 不通，四种原因长得完全一样。前两种恰恰都可能是**拼法**
 * 造成的（路径式的 404 页往往不带 CORS 头，浏览器连 404 都不给 JS 看），
 * 所以网络级失败同样值得换一种拼法再试一次。
 */
const isNetworkLevelFailure = (error: unknown): boolean => {
    if (error instanceof TypeError) return true;
    return error instanceof Error
        && /failed to fetch|networkerror|network request failed|load failed/i.test(error.message);
};

export const requestQq = async <T = unknown>(operation: QqOperation, params: QqParams = {}): Promise<T> => {
    const { base, embedded } = await resolveApiBase();
    // 内嵌的 qq-music-api 就是一个 Express 应用，只有路径式一种拼法，不需要试错。
    if (embedded) return requestQqOnce<T>(operation, params, base, 'path');

    // 本地登录：请求交给内置在 App 里的接口代码，不出网、也不经过任何自建后端。
    if (isFoliaExtensionBridgeConfigured(base)) {
        const endpoint = endpointFor(operation, params);
        try {
            const body = await requestFoliaExtension<any>({
                provider: 'qq',
                operation,
                method: 'GET',
                path: endpoint.path,
                params: endpoint.query,
            });
            if (body?.__foliaBridgeError) {
                if (body.__foliaBridgeError === 'AUTH_REQUIRED') {
                    throw new OnlineProviderError('auth-required', body.message || 'QQMusicApi login required', 'qq', body);
                }
                if (body.__foliaBridgeError === 'UNSUPPORTED') {
                    throw new OnlineProviderError('unsupported', body.message || `QQMusicApi has no ${operation} route`, 'qq', body);
                }
                throw new OnlineProviderError('network', body.message || body.__foliaBridgeError, 'qq', body);
            }
            persistConfirmedSession(operation, body);
            return body as T;
        } catch (error) {
            if (error instanceof OnlineProviderError) throw error;
            throw new OnlineProviderError('network', error instanceof Error ? error.message : String(error), 'qq', error);
        }
    }

    const preferred = webEndpointStyle;
    const fallback: QqEndpointStyle = preferred === 'query' ? 'path' : 'query';
    try {
        return await requestQqOnce<T>(operation, params, base, preferred);
    } catch (error) {
        // 值得换拼法的只有两种：「后端根本没有这条路由」的 404，以及拼错地址时被
        // 浏览器吞掉、只剩网络级错误的情况。其余失败（401 / 429 / 上游拒收）如实上抛。
        const worthRetrying = error instanceof OnlineProviderError
            ? error.httpStatus === 404
            : isNetworkLevelFailure(error);
        if (!worthRetrying) throw error;
        const result = await requestQqOnce<T>(operation, params, base, fallback);
        // 仅在备用拼法真的成功时才改偏好：路由本身不存在的 404 两边都会失败，不会走到这里。
        webEndpointStyle = fallback;
        return result;
    }
};
