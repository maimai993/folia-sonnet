// android/qishui-bridge/src/entry.js
//
// 签名宿主页面的协议层入口（车机协议版）。
//
// 旧链路是 passport 扫码拿 cookie + /luna a_bogus 签名，而 /luna 现在只认
// bdms.node 的 X-Helios/X-Medusa（Windows x64 原生模块，安卓永远没有）→
// 「能登录、拿不到任何数据」。本版整体换成汽水**车机协议**
// （/api/luna/v1/platform，参考 GSQZ/qishui-music-api，MIT）：
//
//   - 扫码授权走 open.douyin.com/oauth（抖音 App 扫），换回 bd-ticket-guard 凭据，
//     签名用 WebCrypto 的 ECDSA P-256 —— 签名宿主页面里就有，不需要任何原生模块；
//   - 公共读取用客户端令牌（client token），不登录也能搜/看详情/听标准音质；
//   - 账号读取与写入（我的歌单/喜欢/最近播放/加删歌）用 ticket-guard。
//
// 不再使用的旧模块：qishui-api.js / qishui-qr-login.js / sdk-glue / bdms.js /
// react*。bootstrap.html 仍由 build.mjs 生成，但只剩两个脚本：folia-xhr.js（原生
// http 桥）与 protocol.js（本入口的打包产物）。
//
// 对外入口不变：window.__foliaQishui.start(operation, paramsJson, ticket)，
// 结果经 FoliaQishuiHost.resolve(ticket, envelopeJson) 回原生，信封仍是
// { ok, data } / { ok, error }，渲染层零改动。
//
// ⚠ 两套协议（车机 / 手机）共用这一套 operation 名，**选哪套由渲染层在运行时说**
// （`protocol.use`，记在模块里；默认车机）。两套的凭据各自独立：切协议等于换一套
// 会话，登录态互不相认 —— 车机是 ticket-guard，手机是 passport 会话 Cookie。

import { createQishuiCar } from './car/api.js';
import { QISHUI_FEED_ID, QISHUI_LIKED_ID } from './car/api.js';
import { createQishuiPhone } from './phone/api.js';

const CAR = 'luna-car';
const PHONE = 'passport-web';

const log = message => console.info(message);
const car = createQishuiCar({ log });

// 手机协议那一份懒建：它要把桌面端协议层一起初始化（缓存、设备身份读档），
// 只用汽水车机协议时不该付这一笔。
let phone = null;
let protocol = CAR;

const normalizeProtocol = value => (String(value || '').trim().toLowerCase() === PHONE ? PHONE : CAR);
const api = () => {
    if (protocol === PHONE) {
        if (!phone) phone = createQishuiPhone({ log });
        return phone;
    }
    return car;
};

/**
 * 另一套协议此刻有没有会话（**不问网络**，只看它自己那份凭据在不在）。
 *
 * status 把它带进 `alt`，渲染层据此决定「当前协议没登录时，要不要认另一套」——
 * 少了它，切一下协议就会把已经登录的账号从界面上抹掉（accountRead 把
 * 「这一套没登录」当成「这个平台没账号」）。
 */
const altStatus = () => {
    if (protocol === PHONE) return { protocol: CAR, loggedIn: Boolean(car.sessions.get()?.ticket) };
    try {
        // 手机协议的登录判定只读 Cookie，不联网；懒建一份来问是安全的。
        if (!phone) phone = createQishuiPhone({ log });
        return { protocol: PHONE, loggedIn: Boolean(phone.sessions.get()?.cookie) };
    } catch (_) {
        return { protocol: PHONE, loggedIn: false };
    }
};

// ---- 信封与失败归一（字段与渲染层 qishuiTransport 的错误码表对齐）-----------

function qishuiErrorCode(value) {
    return String(value == null ? '' : value)
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function qishuiClampInt(value, fallback, min, max) {
    const raw = value === undefined || value === null || value === '' ? String(fallback) : String(value);
    const parsed = parseInt(raw, 10) || fallback;
    return Math.max(min, Math.min(max, parsed));
}

function failureEnvelope(code, message) {
    return {
        ok: false,
        error: {
            code: qishuiErrorCode(code) || 'qishui-error',
            message: String(message || code || 'Qishui request failed'),
        },
    };
}

// 车机协议错误码 → 渲染层认的词表（qishuiTransport.toQishuiErrorCode）。
// auth-required 是最常见的：未扫码就点进账号功能。
function envelopeFromCarError(error, operation) {
    const code = error && error.code ? qishuiErrorCode(error.code) : '';
    const stage = error && error.stage ? ` (${error.stage})` : '';
    const upstream = error && error.upstreamCode ? ` [${error.upstreamCode}]` : '';
    const message = String((error && error.message) || `Qishui ${operation} failed`) + stage + upstream;
    if (code === 'auth-required') return failureEnvelope('login-required', message);
    if (code === 'network') return failureEnvelope('network', message);
    if (code === 'not-playable' || code === 'unsupported') return failureEnvelope(code, message);
    return failureEnvelope(code || 'qishui-error', message);
}

// 渲染层会把 200 + error 字段的数据级错误再判一次（throwQishuiDataError），
// 派发层就不重复造这个形状了：失败一律走 { ok:false } 信封。

// ---- operation 派发 --------------------------------------------------------
//
// operation 名与参数名就是渲染层 qishuiTransport 冻结的那一套契约；不支持的
// operation（专辑 / 收藏歌单 / 评论：车机协议没有这些端点）给明确错误，
// 不静默返回空。

const handlers = {
    // 登录态按**当前协议**问，并顺带给出另一套有没有会话（`alt`）：切了协议之后
    // 「这一套没登录」不等于「这个平台没账号」，渲染层靠 alt 决定认哪一套。
    status: async () => ({ ...(await api().status()), alt: altStatus() }),

    /** 当前用的哪一套协议，以及有哪些可选（渲染层据此画「车机 / 手机」的选择）。 */
    'protocol.get': () => ({ provider: 'qishui', protocol, available: [CAR, PHONE] }),

    /**
     * 换协议。只在真的换成功时才动状态，并返回换完之后的两套会话情况 ——
     * 渲染层据此决定要不要提示「另一套还登着」。
     */
    'protocol.use': params => {
        const wanted = normalizeProtocol((params && params.protocol) || '');
        const changed = wanted !== protocol;
        protocol = wanted;
        return { provider: 'qishui', protocol, changed, alt: altStatus() };
    },

    /**
     * 手动粘贴 Cookie（手机协议专用）：跳过扫码，直接把一段会话灌进手机协议。
     *
     * 给的是「从汽水客户端 / 浏览器导出来的完整会话」，协议层只认里面有没有
     * sessionid 那几个登录键；没有就明确拒绝，别让用户以为登录成功了。
     */
    'login.cookie': async params => {
        const raw = String((params && params.cookie) || '').trim();
        if (!raw) {
            return failureEnvelope('missing-cookie', '汽水会话 Cookie 是空的');
        }
        protocol = PHONE;
        const applied = api().importCookie(raw);
        if (!applied?.restored) {
            return failureEnvelope('login-required', String(applied?.reason || '汽水会话 Cookie 里没有登录凭据'));
        }
        const statusData = await api().status();
        return Object.assign({}, statusData, {
            provider: 'qishui', ok: true, loggedIn: true, status: 'confirmed',
            errorCode: 0, error_code: 0, message: '登录成功',
        });
    },

    'login.qr': async () => {
        const result = await api().startLogin();
        return {
            provider: 'qishui',
            // 这一张码是哪套协议出的：两套的扫码 App 可能一样，但换来的凭据完全不同，
            // 诊断里要能一眼分清（渲染层把它记进 last qr 那一行）。
            protocol,
            token: result.key,
            qrcode: result.qrDataUrl,
            qrDataUrl: result.qrDataUrl,
            // 码里装的那个地址（真机排查用：二维码是一张图，看不出它指向哪）。
            scanUrl: result.scanUrl,
            expireTime: 300,
            message: '请使用抖音/汽水音乐 App 扫码并确认授权',
        };
    },

    'login.check': async params => {
        const token = String((params && params.token) || '').trim();
        if (!token) {
            const keys = Object.keys(params && typeof params === 'object' ? params : {}).join(',') || '(empty)';
            throw Object.assign(new Error('二维码登录 token 缺失（params keys: ' + keys + '）'), { code: 'missing-token' });
        }
        // 状态词表与渲染层一致：confirmed 之外的状态原样映射，未知状态继续等。
        const result = await api().checkLogin(token);
        if (result.state === 'error' && result.failure?.case === 'refused') {
            return { provider: 'qishui', status: 'error', errorCode: 0, message: '授权被拒绝，请重试' };
        }
        const statusMap = { waiting: 'waiting', scanned: 'scanned', confirmed: 'confirmed', expired: 'expired' };
        const status = statusMap[result.state] || 'waiting';
        if (result.state === 'confirmed') {
            // 确认即凭据已入库（auth.check 内完成），这里补一次 status 让上层立刻有账号。
            const statusData = await api().status();
            return Object.assign({}, statusData, {
                provider: 'qishui',
                ok: true,
                status: 'confirmed',
                errorCode: 0,
                error_code: 0,
                message: '登录成功',
            });
        }
        return {
            provider: 'qishui',
            loggedIn: false,
            status,
            errorCode: 0,
            error_code: 0,
            retryAfterMs: 0,
            message: status === 'expired' ? '二维码已过期，请重新生成' : '',
        };
    },

    'login.logout': () => api().logout(),

    // 凭据在 App 侧也留一份（跨重启用）：桥自己那份存储读不回来时，启动时灌回去。
    'session.export': () => api().exportSession(),
    'session.import': params => api().importSession(params && params.credential),

    search: params => {
        const p = params || {};
        const keywords = String(p.keywords || p.query || '');
        const limit = qishuiClampInt(p.limit, 12, 4, 20);
        const offset = qishuiClampInt(p.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        return api().search(keywords, limit, offset);
    },

    // 车机没有专辑端点；专辑入口在这里明确拒绝（上层把它显示为「暂不支持」，
    // 比静默空列表诚实）。单曲详情可以回，专辑聚合不行。
    album: () => {
        throw Object.assign(new Error('汽水车机协议没有专辑接口'), { code: 'unsupported' });
    },

    'song.detail': params => api().songDetail(String((params && params.id) || '')),

    lyric: params => api().lyrics(String((params && params.id) || '')),

    'song.url': async params => {
        const p = params || {};
        // 渲染层的音质档（standard/high/ultra/lossless/hires）直接下传，
        // playback.js 内部会折算到车机的档位。
        return api().audio(String(p.id || ''), String(p.quality || 'standard'));
    },

    artist: params => {
        const p = params || {};
        const artistId = String(p.artistId || '');
        if (!artistId) {
            throw Object.assign(new Error('汽水音乐需要艺人 ID'), { code: 'missing-artist-id' });
        }
        const limit = qishuiClampInt(p.limit, 36, 10, 50);
        // 歌手名由渲染层从搜索结果里记住再传回来（手机协议只能按名字搜，见 phone/api.js）。
        return api().artist(artistId, limit, 0, String((p || {}).artistName || ''));
    },

    feed: params => {
        const p = params || {};
        const scene = /^\d+$/.test(String(p.scene ?? '')) ? String(p.scene) : undefined;
        return api().feed(qishuiClampInt(p.limit, 8, 4, 12), scene);
    },

    // 场景/心情/风格分类树（免登录）。分类 id 回传给 feed 的 scene 参数即可拉该分类的歌。
    'feed.modes': () => api().feedModes(),

    // 手机端「发现 → 模式探索」：公开的 /luna/discover，每次会换一批卡；
    // 点开某张卡后用 discover.tracks + 卡 id 拉那一路的歌。
    'discover.modes': () => api().discoverModes(),
    'discover.tracks': params => {
        const p = params || {};
        return api().discoverTracks(
            String(p.id || ''),
            qishuiClampInt(p.limit, 20, 1, 50),
            String(p.cursor || ''),
        );
    },

    'user.playlists': () => api().userPlaylists(500, 0),

    'playlist.tracks': params => {
        const p = params || {};
        const id = String(p.id || '') || QISHUI_FEED_ID;
        const limit = qishuiClampInt(p.limit, 50, 1, Number.MAX_SAFE_INTEGER);
        const offset = qishuiClampInt(p.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        return api().playlistTracks(id, limit, offset);
    },

    'track.liked': async params => {
        const raw = Array.isArray((params || {}).ids) ? params.ids.join(',') : String((params || {}).ids || '');
        const ids = raw.split(',').map(value => value.trim()).filter(Boolean);
        const result = await api().checkTracks(ids);
        // 渲染层要的形状：{ id, liked }[]（risk_result 0 = 无风险即可播/已收藏口径
        // 车机不给，统一按「可播」回，喜欢状态由 likedSongs 单独拉）。
        return {
            provider: 'qishui',
            statuses: result.statuses,
        };
    },

    'track.like': async params => {
        const p = params || {};
        const liked = String(p.liked != null ? p.liked : 'true') !== 'false';
        return api().likeSong(String(p.id || ''), liked);
    },

    'playlist.collect': () => {
        throw Object.assign(new Error('汽水车机协议不支持收藏歌单'), { code: 'unsupported' });
    },

    'playlist.addSong': async params => {
        const p = params || {};
        return api().addSongs(String(p.playlistId || ''), [String(p.trackId || '')].filter(Boolean));
    },

    'album.collect': () => {
        throw Object.assign(new Error('汽水车机协议不支持收藏专辑'), { code: 'unsupported' });
    },

    'report.play': () => ({ provider: 'qishui', success: true, note: 'car protocol has no play report endpoint' }),

    comments: () => {
        throw Object.assign(new Error('汽水车机协议没有评论接口'), { code: 'unsupported' });
    },

    'comment.create': () => {
        throw Object.assign(new Error('汽水车机协议没有评论接口'), { code: 'unsupported' });
    },
};

/**
 * 入参归一：原生把 params 直接当 JS 字面量拼进 evaluateJavascript 的脚本里，
 * 所以这里拿到的是**对象**而不是 JSON 字符串 —— 一律 JSON.parse 会把它
 * String() 成 "[object Object]" 再解析，必然抛错并悄悄落回空对象，
 * 表现就是「二维码登录 token 缺失」。两种形态都认。
 */
function normalizeParams(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    if (typeof value === 'string') {
        try { return JSON.parse(value); } catch (_) { return {}; }
    }
    return {};
}

async function request(operation, params) {
    const name = String(operation || '');
    if (!Object.prototype.hasOwnProperty.call(handlers, name)) {
        return failureEnvelope('unsupported', 'Unsupported qishui operation: ' + name);
    }
    try {
        const data = await handlers[name](params && typeof params === 'object' ? params : {});
        return { ok: true, data };
    } catch (error) {
        if (typeof console !== 'undefined' && console.warn) {
            console.warn('[FoliaQishui] ' + name + ' failed:', (error && error.message) || error);
        }
        return envelopeFromCarError(error, name);
    }
}

// ---- 对外入口 ------------------------------------------------------------

window.__foliaQishui = {
    async start(operation, params, ticket) {
        const envelope = await request(operation, normalizeParams(params));
        const host = window.FoliaQishuiHost;
        if (host && typeof host.resolve === 'function') {
            try {
                host.resolve(String(ticket), JSON.stringify(envelope));
            } catch (error) {
                // resolve 只可能因为序列化失败而抛；退回一个保守的信封。
                host.resolve(String(ticket), '{"ok":false,"error":{"code":"serialize-failed","message":"'
                    + String(error && error.message || error).replace(/[\\"]/g, ' ') + '"}}');
            }
        }
    },
};

// 车机协议全程不需要用户在页面上交互（扫码图由渲染层展示），MFA 全屏钩子保留
// 一个空实现：旧裁剪签名层还可能调用它，新协议不会，但留空比删掉安全（宿主侧
// 的 setMfaVisible 接口仍在）。
window.__foliaSetMfaVisible = function () {};

// 页面与协议层都就绪了：告知原生。
(function announceReady() {
    const host = window.FoliaQishuiHost;
    if (host && typeof host.onReady === 'function') {
        try { host.onReady(''); } catch (_) {}
    }
})();
