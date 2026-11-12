import { requestBilibiliUrl } from './transport';
import { BilibiliApiError } from './api';

// src/services/bilibili/login.ts
//
// bilibili 扫码登录。用它只是为了**拿到更高画质的 MV**：未登录看 480p，
// 大会员账号能到 1080p。它不参与 folia 的账号体系 —— 登录结果只是一组 cookie，
// 存进原生 CookieManager，之后 MV 的请求自动带上。
//
// 用的是 bilibili 网页端那套三个接口：
//   auth/info   申请一个二维码
//   poll        轮询扫码状态
//   exlogin     用跳转 URL 里的临时票据换真正的 cookie
//
// 流程（和网页版一致）：
//   1. generateQrCode() 拿到 qrcodeKey + 二维码内容（是一串 URL，前端画成二维码）
//   2. 用户用 B 站 App 扫、确认 → poll 返回 code 86101 / 86090 / 0
//   3. code 0 时 poll 回的不是 cookie，而是一个跨域跳转 URL；
//      把它的 query 再打给 exlogin，才换出 SESSDATA 那组 cookie

const PASSPORT_BASE = 'https://passport.bilibili.com';

/** 二维码的有效期（秒）。接口一般给 180。 */
export const QR_EXPIRES_SEC = 180;

export interface BilibiliQrCode {
    /** 轮询时要带回去的 key。 */
    qrcodeKey: string;
    /** 二维码的内容，画成二维码给用户扫。 */
    url: string;
}

interface PassportEnvelope<T> {
    code: number;
    message?: string;
    data?: T;
}

const unwrapPassport = <T>(envelope: PassportEnvelope<T>): T => {
    if (envelope.code !== 0) {
        throw new BilibiliApiError(envelope.code, envelope.message || `passport error ${envelope.code}`);
    }
    if (envelope.data === undefined) {
        throw new BilibiliApiError(envelope.code, 'empty payload');
    }
    return envelope.data;
};

const fetchPassport = async <T>(url: string): Promise<PassportEnvelope<T>> => {
    const response = await requestBilibiliUrl(url, { method: 'GET' });
    if (!response.bodyText) {
        throw new BilibiliApiError(-1, `empty response (${response.status})`);
    }
    try {
        return JSON.parse(response.bodyText) as PassportEnvelope<T>;
    } catch {
        throw new BilibiliApiError(-1, `unreadable response (${response.status})`);
    }
};

/** 第一步：申请一个登录二维码。 */
export const generateQrCode = async (): Promise<BilibiliQrCode> => {
    const envelope = await fetchPassport<{ url: string; qrcode_key: string }>(
        `${PASSPORT_BASE}/x/passport-login/web/qrcode/generate`,
    );
    const data = unwrapPassport(envelope);
    return { qrcodeKey: data.qrcode_key, url: data.url };
};

/** 轮询结果的三态，加上一个「过期」。 */
export type BilibiliQrState = 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';

export interface BilibiliQrPoll {
    state: BilibiliQrState;
    /**
     * 确认之后用来换 cookie 的跳转 URL。
     *
     * 只有 `state === 'confirmed'` 时才有值。里面带着临时票据，
     * 由 exchangeLogin 换成真正的 SESSDATA。
     */
    redirectUrl?: string;
    message?: string;
}

/**
 * 第二步：问一次扫码状态。
 *
 * bilibili 的业务码：0 = 成功，86101 = 未扫码，86090 = 已扫待确认，
 * 86038 = 二维码过期。
 */
export const pollQrCode = async (qrcodeKey: string): Promise<BilibiliQrPoll> => {
    const envelope = await fetchPassport<{
        code?: number;
        message?: string;
        url?: string;
    }>(`${PASSPORT_BASE}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`);

    // 注意这里的 code 有两层：外层 envelopes.code 是接口通不通，
    // data.code 才是扫码状态。别把两者搞混。
    const data = envelope.data;
    if (!data) {
        throw new BilibiliApiError(envelope.code, envelope.message || 'empty poll payload');
    }

    switch (data.code) {
        case 0:
            return { state: 'confirmed', redirectUrl: data.url };
        case 86090:
            return { state: 'scanned' };
        case 86038:
            return { state: 'expired' };
        case 86101:
        default:
            return { state: 'waiting' };
    }
};

/**
 * 第三步：用跳转 URL 把 cookie 换出来。
 *
 * 这一步是照网页版那条路走的：二维码确认后，poll 回的是一个**跨域跳转 URL**，
 * 用它发起一次请求，bilibili 会在响应的 `Set-Cookie` 里下发 SESSDATA 那一组。
 * 响应体本身是个跳转页，不用看。
 *
 * 所以原生桥必须把 Set-Cookie 头带回来（见 FoliaBilibiliPlugin.request），
 * 前端才能拿到凭据。
 */
export const exchangeLogin = async (
    redirectUrl: string,
): Promise<{ cookie: string; uid: string }> => {
    const response = await requestBilibiliUrl(redirectUrl, { method: 'GET' });
    const headers = response.setCookies ?? [];
    if (headers.length === 0) {
        throw new BilibiliApiError(-1, 'no Set-Cookie in the login response');
    }

    const wanted = new Map<string, string>();
    let uid = '';
    for (const header of headers) {
        // 每个头是 `name=value; Path=/; Domain=.bilibili.com; Expires=...`
        const first = header.split(';')[0]?.trim() ?? '';
        const eq = first.indexOf('=');
        if (eq <= 0) continue;
        const name = first.slice(0, eq);
        const value = first.slice(eq + 1);
        if (!value) continue;
        wanted.set(name, value);
        if (name === 'DedeUserID') uid = value;
    }

    // 只留下能用得上的那几个，别把整串无头参数都塞进 CookieManager。
    const keep = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];
    const pairs = keep
        .map(name => (wanted.has(name) ? `${name}=${wanted.get(name)}` : ''))
        .filter(pair => pair.length > 0);
    if (pairs.length === 0) {
        throw new BilibiliApiError(-1, 'the login response carried no SESSDATA');
    }
    return { cookie: pairs.join('; '), uid };
};
