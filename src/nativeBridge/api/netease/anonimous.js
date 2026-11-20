// src/nativeBridge/api/netease/anonimous.js
// 游客（未登录）会话：/api/register/anonimous。
//
// 为什么要真的去注册一次，而不是像早先那样直接回一个空 cookie：
//
// 桌面端这一条由内嵌的后端（@neteasecloudmusicapienhanced/api 的 register_anonimous）去做，
// 答回来的 cookie 里带着 MUSIC_A 与 __csrf；安卓内置桥原先是个空壳（`{ code: 200, cookie: '' }`），
// 于是后面每一个 weapi 请求都是**不带 cookie** 出去的 —— 而 weapiJson 里的 `csrf_token`
// 正是从 cookie 的 __csrf 取的，缺了它上游一律答 `{code: 301}`。301 又不是错（weapiJson 为了
// 不让整页失败是不抛错的），所以表现不是「读不出来」，而是**每一栏都空着**：探索页看上去
// 就是没法用（用户原话：网易云探索界面无法使用）。
//
// 上游那份实现见 node_modules/@neteasecloudmusicapienhanced/api/module/register_anonimous.js：
// username = base64("<deviceId> <md5-base64(deviceId)>")。
//
// ⚠️ 上游 4.41.1 这一条用的是 **xeapi** —— 那是一套和 eapi 不同的加密，还要启动时先取一份
// 公钥（HMAC-SHA256 签名 + AES-ECB），桥里没有。所以这里按仓库里 `/recommend/songs` 那套
// 「两条路 × 两种签名」的兜底写法：weapi 与 eapi 各试一次，哪条先答出 cookie 用哪条，
// 并把生效的那条留痕（auth:anonimous:source）—— 真到线上哪条都不通时，一眼就能看出来
// 是「没走到」还是「走到了但被拒」，而不是又一轮猜。

import CryptoJS from '../../vendor/crypto-es.mjs';
import { eapiRequest } from '../eapi.js';
import { weapiEncrypt, UA } from '../weapi.js';
import { readRawSetCookies } from '../setCookieHeaders.js';
import { noteLibraryStep } from '../libraryTrace.js';

/** 与上游 ID_XOR_KEY_1 一致：设备 id 先跟它逐位异或，再取 MD5。 */
const ID_XOR_KEY = '3go8&$8*3*3h0k(2)2';
const HEX = '0123456789ABCDEF';

/** 上游 generateDeviceId()：52 个十六进制字符。 */
function deviceId() {
    let out = '';
    for (let index = 0; index < 52; index += 1) {
        out += HEX[Math.floor(Math.random() * HEX.length)];
    }
    return out;
}

/** 上游 cloudmusic_dll_encode_id：异或 → MD5 → Base64。 */
function encodeId(id) {
    let xored = '';
    for (let index = 0; index < id.length; index += 1) {
        xored += String.fromCharCode(
            id.charCodeAt(index) ^ ID_XOR_KEY.charCodeAt(index % ID_XOR_KEY.length),
        );
    }
    return CryptoJS.enc.Base64.stringify(CryptoJS.MD5(CryptoJS.enc.Utf8.parse(xored)));
}

const base64 = (text) => CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(text));

/**
 * 一条 Set-Cookie 里的 `name=value`（分号后面的属性不要）。
 *
 * 上游是把整批 cookie 拼起来交回去的（result.cookie.join(';')）；这里只有响应头，所以自己拆。
 */
function pairsOf(setCookies) {
    const out = [];
    (setCookies || []).forEach((raw) => {
        String(raw || '')
            .split(/,(?=\s*[^;]+=)/)
            .forEach((part) => {
                const head = String(part || '').split(';')[0] || '';
                const at = head.indexOf('=');
                if (at <= 0) return;
                const name = head.slice(0, at).trim();
                const value = head.slice(at + 1).trim();
                if (name && value) out.push(`${name}=${value}`);
            });
    });
    return out;
}

/** 注册成功的判据：上游回了 200，而且真给了一份能用的 cookie。 */
function isGuestCookie(cookie) {
    return typeof cookie === 'string' && /MUSIC_A=|__csrf=/.test(cookie);
}

/**
 * 走 weapi。
 *
 * 不用 weapiRequest 是因为它只把响应体交回来（`resp.json()`），而这次要的 cookie 在
 * Set-Cookie 里 —— 头被丢掉就拿不到了。所以自己发一次，头自己读。
 */
async function byWeapi(username) {
    const encrypted = weapiEncrypt({ username });
    // 主机要和 weapiRequest 一致（见 weapi.js 的 WEAPI_BASE 说明）：安卓桥上只有
    // interface.music.163.com 在代理白名单里，发到 music.163.com 的请求读不到 Set-Cookie（M1）。
    const resp = await fetch('https://interface.music.163.com/weapi/register/anonimous', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': UA,
            Referer: 'https://music.163.com/',
            Cookie: '',
        },
        body: new URLSearchParams(encrypted).toString(),
    });
    let body = {};
    try {
        body = await resp.json();
    } catch (_) {
        body = {};
    }
    return { code: body && body.code, cookie: pairsOf(readRawSetCookies(resp)).join('; ') };
}

async function byEapi(username) {
    const answer = await eapiRequest('/api/register/anonimous', { username }, '');
    const body = (answer && answer.body) || {};
    return {
        code: body.code,
        cookie: pairsOf(answer && answer.setCookies).join('; ') || (typeof body.cookie === 'string' ? body.cookie : ''),
    };
}

/**
 * 注册一个游客，把它那份 cookie 交回去。
 *
 * 拿不到（上游拒了、Set-Cookie 没镜像回来、两条路都不通）就回空串 —— 与早先那个空壳的
 * 结果一样，并不比现在更差。生效的那条路会留痕，失败时把 code 也留下。
 */
export async function registerAnonymousCookie() {
    const id = deviceId();
    const username = base64(`${id} ${encodeId(id)}`);
    // eapi 在前：实测 2026-10-21，只有 eapi 这条下发 MUSIC_A / __csrf / NMTID；
    // weapi 那条现在能答话了（模数修好后回 `{"code":400,"参数错误"}` 而不是空 body），
    // 但不给游客 cookie。weapi 留在后面只是万一 eapi 哪天也换路 ——
    // 顺序反过来的代价是每个会话多一次注定白跑的请求。
    const routes = [
        { name: 'eapi', ask: byEapi },
        { name: 'weapi', ask: byWeapi },
    ];
    for (const route of routes) {
        try {
            const answer = await route.ask(username);
            if (isGuestCookie(answer.cookie)) {
                noteLibraryStep('netease', 'auth:anonimous:source', { route: route.name });
                return answer.cookie;
            }
            noteLibraryStep('netease', 'auth:anonimous:rejected', { route: route.name, code: answer.code ?? null });
        } catch (error) {
            noteLibraryStep('netease', 'auth:anonimous:failed', {
                route: route.name,
                message: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
            });
        }
    }
    return '';
}
