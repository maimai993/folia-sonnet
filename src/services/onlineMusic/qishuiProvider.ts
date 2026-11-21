import type { LoginDiagnosticLine, LoginMethod, OnlineMusicProvider, ProviderAudioSource, ProviderCollection } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';
import { createProviderSongMetadata } from '../../utils/songMetadata';
import { parseQishuiLyrics } from '../../utils/lyrics/qishuiLyrics';
import { getQishuiTransportAvailability, requestQishui, throwQishuiDataError } from './qishuiTransport';
import {
    readProviderSessionValue, removeProviderSessionValue, writeProviderSessionValue,
} from './providerStorage';
import { isAndroidAppShell } from '../../platform/runtime';
import { normalizeQishuiCollection, normalizeQishuiSong, normalizeQishuiUser, qishuiPage, qishuiText } from './qishuiNormalize';
import { QISHUI_FEED_PLAYLIST_ID, qishuiCatalog } from './qishuiCatalog';
import { clearQishuiLibraryCache, qishuiLibrary } from './qishuiLibrary';
import { qishuiMutations } from './qishuiMutations';
import { describeQishuiFailure } from './qishuiFailure';
import { diagnosticLine } from './login/loginDiagnosticReport';

// src/services/onlineMusic/qishuiProvider.ts

// 协议层的搜索与推荐流都把 limit 收在 18 以内，请求再大也只拿得到这么多。
const QISHUI_PAGE_MAX = 18;
// 主进程没给二维码有效期时的兜底：汽水二维码按 5 分钟算。
const QISHUI_QR_TTL_MS = 5 * 60 * 1000;

// 诊断报告的一行：provider 那几行交给报告时都过这里，报告只印这里写成的那句话（见 loginDiagnosticReport）。
const line = (text: string): LoginDiagnosticLine => diagnosticLine`${text}`;

// 汽水扫码登录一步就返回 token 与二维码，而 Omni 走的是 getQrKey -> createQr 两步，
// 所以这里用 token 记住这一次会话的二维码，再由 createQr 取出来。
const qrSessions = new Map<string, string>();
let qrTtlMs = QISHUI_QR_TTL_MS;

// 最近一次登录态检查的结论。扫码确认后账户没加载出来（account-refresh-failed）
// 时，诊断报告靠它说明卡在哪：是 status 就没认下这个会话，还是续期那一拍出了问题。
let lastQishuiLoginStatus: string | null = null;
/** refresh 的失败出口单独记一行：与 status 详情互不覆盖，诊断才看得全。 */
let lastQishuiRefreshNote: string | null = null;
export const noteQishuiRefreshDiagnostic = (text: string): void => {
    lastQishuiRefreshNote = text;
};
/** 最近一次 login.check 的结论：确认了但没拿到会话 Cookie 时，靠它看清 cookie 罐里有什么。 */
let lastQishuiCheckNote: string | null = null;
/** 二维码阶段服务端下发的扫码文案（谁家 App 能扫，由上游说了算）。 */
let lastQishuiQrNote: string | null = null;

// ---- 凭据在 App 这边也留一份 ---------------------------------------------
//
// 桥自己那份存在**隐藏 WebView** 的 SharedPreferences / localStorage 里，真机上并不
// 总是读得回来：一重启它就是空的，于是登录态凭空消失，播放地址那一路还会退回公共
// 令牌（audioMeta 的 account=false，受版权保护的曲子只剩试听）。
//
// App 主 WebView 的 localStorage 是另一条通道 —— 网易 / QQ / 酷狗的登录态都靠它跨
// 重启活着。所以凭据两边各留一份：登录成功后抄出来，查登录态之前先灌回去。
//
// 判据也跟着换：不问「桥那份存储读没读出来」（那是桥的家事，且已被实测为不可靠），
// 而是**直接看账号级读取拿不拿得到东西**（拉歌单）。灌回去之后 status 认了，
// 后面 readWhole 会真的去拉歌单 —— 拉得到就是能用。
/**
 * 汽水的两套协议。
 *
 * - `luna-car`：车机协议（/api/luna/v1/platform），抖音开放平台扫码换 ticket-guard 凭据；
 * - `passport-web`：手机协议，passport 扫码换会话 Cookie，数据走 api.qishui.com 的 PC/Web 接口。
 *
 * 两套凭据互不相认：选哪套登录就用哪套拉数据。
 */
type QishuiProtocol = 'luna-car' | 'passport-web';

// ---- 两套协议，凭据各存一份 ---------------------------------------------
//
// 车机（ticket-guard）与手机（passport 会话 Cookie）是两套互不相认的凭据：切协议
// 等于换一套会话，所以 App 这边存的副本也要按协议分开 —— 共用一个键的话，
// 用手机协议登完再切回车机，会把 Cookie 当成 ticket 灌回去（或反过来），
// 表现就是「换了协议，登录态两边都不对」。
const QISHUI_SESSION_KEYS: Record<QishuiProtocol, string> = {
    'luna-car': 'car-session',
    'passport-web': 'phone-session',
};
const QISHUI_PROTOCOL_KEY = 'protocol';

/** 选了哪套协议（记住上一次的选择：登录窗口里选过一次，下次沿用）。 */
let currentProtocol: QishuiProtocol = readProtocolPreference();

function readProtocolPreference(): QishuiProtocol {
    return readProviderSessionValue('qishui', QISHUI_PROTOCOL_KEY) === 'passport-web'
        ? 'passport-web' : 'luna-car';
}

/**
 * 换协议：先告诉桥（它的默认也是车机，重启后要重新说一遍），再决定记不记住。
 *
 * ⚠ 老包不认 `protocol.use`（那时还没有这套 operation），抛错不能让它影响登录：
 * 按「只有车机」继续 —— 而 resolveLoginMethods 那边问过 `protocol.get`，
 * 老包根本不会把「手机协议」摆出来。
 */
async function useProtocol(protocol: QishuiProtocol, { remember = false } = {}): Promise<void> {
    currentProtocol = protocol;
    if (remember) writeProviderSessionValue('qishui', QISHUI_PROTOCOL_KEY, protocol);
    try {
        await requestQishui('protocol.use', { protocol });
    } catch (_) {
        // 桥不认就当只有车机：这一次的登录仍会照车机走。
    }
}

const sessionKey = (): string => QISHUI_SESSION_KEYS[currentProtocol];

/**
 * 登录窗口里给的两条路。
 *
 * ⚠ 只有**桥真的两套都支持**时才把它们摆出来（见 resolveLoginMethods）：老包没有
 * protocol.get，摆出来点了也没用 —— 那还不如维持原来的单步流程（直接出车机的码）。
 */
const QISHUI_LOGIN_METHODS: LoginMethod[] = [
    { id: 'luna-car', labelKey: 'home.loginMethodQishuiCar', iconKey: 'qishui' },
    { id: 'passport-web', labelKey: 'home.loginMethodQishuiPhone', iconKey: 'qishui' },
];

/**
 * 手机协议（passport 扫码换会话 Cookie）**暂时不摆出来**（用户 2026-10-24）：打开汽水的登录
 * 直接就是车机协议（ticket-guard）的二维码。
 *
 * 只是藏起来，不是删掉：两套协议的代码、凭据与退出都还在 —— `protocol.use` 仍认
 * 'passport-web'，`startLogin` 仍按 methodId 切，登录态与退出仍是两套各问 / 各退一次。
 * 所以之前用手机协议登着的账号照旧能用，只是登录窗口不再给它入口。
 * 要放回来就把这个常量改成 true（那一屏会重新变成「车机 / 手机」两步选择）。
 */
const PHONE_PROTOCOL_OFFERED = false;

/** 最近一次「灌回去」的结果：真机上再说账号没了，先看这一行。 */
let lastQishuiSessionNote: string | null = null;
/** 最近一次「抄出来」的失败原因（成功不记）。 */
let lastQishuiSessionKeepNote: string | null = null;

const readKeptCredential = (): unknown => {
    const text = readProviderSessionValue('qishui', sessionKey());
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
};

/** 把桥里那份凭据抄一份到 App 这边。只有安卓那条桥有 session.export。 */
async function keepQishuiCredential(): Promise<void> {
    if (!isAndroidAppShell()) return;
    try {
        const data = await requestQishui<any>('session.export', {});
        const credential = data?.credential;
        // 车机那份认 ticket，手机那份认 cookie：两套凭据长得不一样，判定也得分开
        // （统一要求 ticket 的话，手机协议永远「抄不出来」，下次重启就没账号了）。
        const usable = currentProtocol === 'passport-web'
            ? Boolean(credential?.cookie) : Boolean(credential?.ticket);
        if (usable) {
            writeProviderSessionValue('qishui', sessionKey(), JSON.stringify(credential));
            return;
        }
        removeProviderSessionValue('qishui', sessionKey());
    } catch (error) {
        // 抄不出来＝下一次重启还是没账号，这是要留在诊断里的。
        lastQishuiSessionKeepNote = error instanceof Error ? error.message : String(error);
        console.warn(`[Qishui] session: the app could not keep a copy: ${lastQishuiSessionKeepNote}`);
    }
}

/** 查登录态之前先把 App 存的那份灌回桥（桥那份读不回来时全靠它）。 */
async function restoreQishuiCredential(): Promise<void> {
    if (!isAndroidAppShell()) return;
    const credential = readKeptCredential();
    if (!credential) {
        lastQishuiSessionNote = 'the app keeps no copy yet';
        return;
    }
    try {
        const data = await requestQishui<any>('session.import', { credential });
        lastQishuiSessionNote = data?.restored
            ? 'the copy kept by the app was put back into the bridge'
            : `kept but not used (${String(data?.reason || 'unknown')})`;
    } catch (error) {
        lastQishuiSessionNote = `could not be put back: ${error instanceof Error ? error.message : String(error)}`;
    }
    // 打进日志：真机排查时不用先打开诊断面板，logcat 里直接就有这一行。
    console.info(`[Qishui] session: ${lastQishuiSessionNote}`);
}

function qishuiNotOurs(): OnlineProviderError {
    return new OnlineProviderError('unsupported', 'Song does not belong to Qishui Music', 'qishui');
}

export const qishuiProvider: OnlineMusicProvider = {
    id: 'qishui', displayName: '汽水音乐', shortName: '汽水',
    // 登录窗口里这个平台的记号（一个字 + 一种颜色）；不声明的话窗口会拿短名第一个字配中性灰。
    mark: { letter: '汽', color: '#f97316' },
    getAvailability: getQishuiTransportAvailability,
    capabilities: {
        search: true, playback: true, lyrics: true, wordByWordLyrics: true, auth: true,
        // ⚠ `playlists` 决定首页「歌单」页签置不置灰（homeSources.ts 的
        // canUsePlaylists 就是 `userLibrary && playlists`）：漏了它，歌单明明拉得到，
        // 入口却是灰的。车机协议有 /me/playlist/ 与 /me/collection/mixed/，必须留着。
        playlists: true,
        // 车机协议没有专辑端点（安卓），桌面旧协议虽有但两端能力声明取交集：
        // 专辑入口在安卓点了只会拿到「不支持」，干脆整平台关掉。
        albums: false, artists: true, recommendations: true,
        userLibrary: true, likes: true, mutations: true, playlistTrackMutations: true,
    },
    normalizeSong: normalizeQishuiSong, normalizeUser: normalizeQishuiUser, normalizeCollection: normalizeQishuiCollection,
    songMetadata: { getSongMetadata: createProviderSongMetadata },
    describeFailure: describeQishuiFailure,
    search: {
        async searchSongs(query, limit, offset) {
            if (!query.trim()) return qishuiPage([], 0, offset, limit);
            const data = await requestQishui<any>('search', { keywords: query, limit: Math.min(limit, QISHUI_PAGE_MAX), offset });
            throwQishuiDataError(data);
            if (!Array.isArray(data.songs)) throw new OnlineProviderError('invalid-response', 'Qishui search list is missing', 'qishui');
            return qishuiPage(data.songs.map(normalizeQishuiSong), data.total, offset, limit, data);
        },
    },
    playback: {
        async getSongDetail(id) {
            const data = await requestQishui<any>('song.detail', { id });
            throwQishuiDataError(data);
            return data.song ? normalizeQishuiSong(data.song) : null;
        },
        async getAudioSource(song, quality) {
            const source = song.sourceRef;
            if (source?.kind !== 'online' || source.providerId !== 'qishui') throw qishuiNotOurs();
            const data = await requestQishui<any>('song.url', { id: source.mediaId, quality });
            // 试听段不能当成整曲进缓存与时长统计，与波点保持同一判断。
            //
            // 报错文案里带上现场：有没有带凭据（`account`）、上游给的是哪一型
            // （`playerType`，2 那批在公共令牌下连 full 都不下发）、full/preview 有没有下发。
            // 「每首都 only offers a preview」时只凭文案是分不清「没登录」和
            // 「登录了但这首确实只授权试听」的，而这两种是完全不同的问题。
            if (data?.trial === true) {
                const meta = data?.audioMeta;
                // `account=false` 有两种：桥里压根没凭据（登录态没恢复），或账号那条路
                // 请求失败了退回公共令牌。前者看 accountError=no-session，后者看具体的
                // 错误码 —— 一个是「没登录」，一个是「登录了但这条路走不通」，修法完全不同。
                // 别再让它们长得一样：用户报「VIP 歌曲听不了」时只凭前半句分不出来。
                const field = (key: string, value: unknown) => (value === undefined ? '' : ` ${key}=${String(value)}`);
                throw new OnlineProviderError('preview-only',
                    'Qishui Music only offers a preview for this account'
                    + (meta ? ` (account=${meta.account}${field('accountError', meta.accountError)}`
                        + `${field('playerType', meta.playerType)}`
                        + `${field('fullModel', meta.fullModel)}${field('previewModel', meta.previewModel)}`
                        + `${field('gotFull', meta.gotFull)}${field('renewed', meta.renewed)})` : ''),
                    'qishui');
            }
            const url = qishuiText(data?.url);
            if (url && data?.playable !== false) {
                const audio: ProviderAudioSource = { url, fetchedAt: Date.now(), quality };
                return audio;
            }
            const category = qishuiText(data?.restriction?.category || data?.reason);
            if (category === 'login_required' || category === 'cookie_required') {
                throw new OnlineProviderError('auth-required',
                    qishuiText(data?.message) || 'Sign in to Qishui Music to play this track', 'qishui');
            }
            // 拿不到直连 URL 时协议层把这首歌退回「推荐/匹配源」，交给上层换源。
            throw new OnlineProviderError('not-playable',
                qishuiText(data?.message) || 'Qishui Music has no direct audio URL for this track', 'qishui');
        },
        getAvailability(song) {
            return song.sourceRef?.kind === 'online' && song.sourceRef.providerData?.unavailable
                ? { state: 'unavailable' } : { state: 'unknown' };
        },
    },
    lyrics: {
        async getLyrics(song) {
            const source = song.sourceRef;
            if (source?.kind !== 'online' || source.providerId !== 'qishui') throw qishuiNotOurs();
            const data = await requestQishui<any>('lyric', { id: source.mediaId });
            // 找不到歌词时协议层回空文本 + source: 'none'，这是合法答案而不是请求失败。
            return parseQishuiLyrics(data ?? {});
        },
    },
    auth: {
        getLoginTexts: () => ({ title: 'home.loginTitleQishui', note: 'home.loginNoteQishui' }),
        /**
         * 桥是不是两套协议都在。
         *
         * 返回空数组＝「只有一条路」，登录窗口维持单步流程（直接出车机的码）——
         * 这既是老包的行为，也是桥没起来时的行为。
         *
         * 手机协议那条路现在一律不摆出来（PHONE_PROTOCOL_OFFERED），所以这里恒为空：
         * 「先问桥再决定」这一步也就没有意义了，留着是为了放回来时不用重写。
         */
        async resolveLoginMethods() {
            if (!PHONE_PROTOCOL_OFFERED) return [];
            try {
                const data = await requestQishui<any>('protocol.get', {});
                const available = Array.isArray(data?.available) ? data.available.map(String) : [];
                if (available.includes('luna-car') && available.includes('passport-web')) return QISHUI_LOGIN_METHODS;
            } catch (_) {
                // 桥不认这个 operation（老包）：按单步流程走。
            }
            return [];
        },
        async getLoginStatus() {
            // ⚠ 桥那边的协议默认是车机，重启后要按偏好再说一遍：不然「上次选了手机
            // 协议、重启」会被当成车机来问，登录态凭空消失。
            await useProtocol(currentProtocol);
            // ⚠ 先灌凭据、再问登录态。
            //
            // 顺序反过来就是「重启后账号没了」本身：桥那份存储读不回来时，问也是白问，
            // 它只会回答「没登录」；而 accountRead 把这个答案当成「这个平台没账号」，
            // 于是账号真的从界面上消失（clearAccount），播放也随之退回公共令牌。
            // 凭据是 App 自己存的那份，先给它灌回去。
            await restoreQishuiCredential();
            // 请求本身失败时也要留下痕迹：否则诊断只会写「last status: none」，
            // 看不出是没走到这一步，还是这一步抛了错。
            const askStatus = async (): Promise<any> => {
                try {
                    return await requestQishui<any>('status', {});
                } catch (error) {
                    lastQishuiLoginStatus = 'status request failed: '
                        + (error instanceof Error ? `${error.message}` : String(error));
                    throw error;
                }
            };
            let data: any = await askStatus();
            // 这一套没登、另一套还登着：切过去再问一次。
            //
            // ⚠ 少了这一步，切一下协议就会把已经登着的账号从界面上抹掉 —— accountRead
            // 把「问出来没登录」当成「这个平台没账号」，而账号其实好好地躺在另一套里。
            const alt = data?.alt;
            if (!data?.loggedIn && alt?.loggedIn
                && (alt.protocol === 'luna-car' || alt.protocol === 'passport-web')) {
                lastQishuiSessionNote = `the other protocol (${String(alt.protocol)}) still holds a session`;
                await useProtocol(alt.protocol === 'passport-web' ? 'passport-web' : 'luna-car');
                await restoreQishuiCredential();
                data = await askStatus();
            }
            lastQishuiLoginStatus = data
                ? `loggedIn=${data.loggedIn ? 'yes' : 'no'} webSession=${data.webSession ? 'yes' : 'no'}`
                + ` cookieReady=${data.cookieReady ? 'yes' : 'no'} profileReady=${data.profileReady ? 'yes' : 'no'}`
                + ` libraryReady=${data.libraryReady ? 'yes' : 'no'} userId=${String(data.userId || '-')}`
                + ` cookieKeys=${String(data.cookieKeys ?? '-')}`
                + ` loginKeys=${String(data.loginKeys ?? '-')}`
                // 「重启后账号没了」全靠这两个：storage 是**读档**（native/local/memory/none），
                // store 再给出会话与设备 ID 各落在哪一档、设备 ID 是不是读回来的
                // （每次启动都重新生成＝那一档存储根本没读出来）。
                + ` storage=${String(data.storage ?? '-')}`
                + (data.store ? ` store=${JSON.stringify(data.store)}` : '')
                + (data.profileError ? ` profileError=${String(data.profileError)}` : '')
                + (Array.isArray(data.libraryErrors) && data.libraryErrors.length
                    ? ` libraryErrors=${data.libraryErrors.map((item: unknown) => String(item)).join(' | ')}` : '')
                : 'null';
            if (!data?.loggedIn) return null;
            // 认下了就立刻抄一份到 App 这边：下一次重启靠它活着。
            // 不 await 也行（下一次查登录态还会再抄），但让它在返回之前写完，
            // 「登录成功 → 马上重启」这种操作才不会漏。
            await keepQishuiCredential();
            const user = normalizeQishuiUser(data);
            // 登录态只有 status 这一处能读，缺 id 也不能当作未登录，否则整库会被清空。
            return { ...user, id: user.id || 'qishui-account' };
        },
        async logout() {
            clearQishuiLibraryCache();
            // 账号走了，App 这边那份也要一起走：留着它，下次启动会把它又灌回桥里，
            // 表现成「已经退出登录，重启后又回来了」。
            //
            // ⚠ 两套协议各存了一份，只清当前这份的话，另一套的会话还在：退出之后一查
            // 登录态它又冒出来（「点了退出却还登着」的另一半），所以两份一起清。
            removeProviderSessionValue('qishui', QISHUI_SESSION_KEYS['luna-car']);
            removeProviderSessionValue('qishui', QISHUI_SESSION_KEYS['passport-web']);
            // 桥那边也要两套各退一次：login.logout 只作用于当前协议。
            const preferred = readProtocolPreference();
            for (const protocol of ['luna-car', 'passport-web'] as QishuiProtocol[]) {
                await useProtocol(protocol);
                await requestQishui('login.logout', {}).catch(() => {});
            }
            await useProtocol(preferred);
        },
        async startLogin(methodId?: string) {
            // 选了哪条路就切到哪套协议，并把它记住（下次进登录还是这一套）。
            // 两套凭据互不相认，所以这一步必须在出码之前做完。
            await useProtocol(methodId === 'passport-web' ? 'passport-web' : 'luna-car', { remember: true });
            const data = await requestQishui<any>('login.qr', {});
            const token = qishuiText(data?.token);
            const imageUrl = qishuiText(data?.qrDataUrl || data?.qrcode || data?.qrCodeUrl);
            if (!token || !imageUrl) {
                throw new OnlineProviderError('invalid-response', 'Qishui QR login payload is incomplete', 'qishui');
            }
            const ttl = Number(data?.ttlMs);
            const expiresAt = Number(data?.expiresAt);
            // 主进程把协议返回的 expire_time 原样带出来（当前版本通常为 0，即用默认 5 分钟），
            // 它可能是秒级时长，也可能是秒/毫秒时间戳，所以按数值量级判定。
            const expireTime = Number(data?.expireTime);
            if (Number.isFinite(ttl) && ttl > 0) qrTtlMs = ttl;
            else if (Number.isFinite(expiresAt) && expiresAt > Date.now()) qrTtlMs = expiresAt - Date.now();
            else if (Number.isFinite(expireTime) && expireTime > 0) {
                const resolved = expireTime >= 1e12 ? expireTime - Date.now()
                    : expireTime >= 1e9 ? expireTime * 1000 - Date.now() : expireTime * 1000;
                qrTtlMs = resolved > 0 ? resolved : QISHUI_QR_TTL_MS;
            }
            qrSessions.set(token, imageUrl);
            // 服务端下发的扫码文案原样留档：上游实测是「抖音」，诊断里一眼可见，
            // 免得靠猜「到底该用哪个 App 扫」。
            lastQishuiQrNote = `protocol: ${qishuiText(data?.protocol) || currentProtocol}`
                + ` / qr copywriting: ${qishuiText(data?.copywriting) || '(none)'}`
                + ` / webName: ${qishuiText(data?.webName) || '(none)'}`
                // 手机协议的码里装的是我们自己拼的 scan_login 地址：扫不通时先看这一行，
                // 它比「扫了没反应」有用得多（服务端原来那张图装的是 sdk-next 网页）。
                + ` / scan: ${qishuiText(data?.scanUrl) || '-'}`;
            return token;
        },
        async createQr(key) {
            const imageUrl = qrSessions.get(key);
            if (!imageUrl) {
                throw new OnlineProviderError('invalid-response', 'Qishui QR session is no longer available', 'qishui');
            }
            return imageUrl;
        },
        async checkLogin(key) {
            let data: any;
            try {
                data = await requestQishui<any>('login.check', { token: key });
            } catch (error) {
                const message = error instanceof Error ? error.message : undefined;
                // 主进程把「设备侧取消验证」抛成 `mfa-cancelled`（映射后会变成 auth-required，
                // 所以这里读 transport 带下来的原始码），还原成 UI 能立刻重试的错误态。
                const rawCode = error instanceof OnlineProviderError ? String(error.cause ?? '') : '';
                if (rawCode.toLowerCase().replace(/[_\s]+/g, '-') === 'mfa-cancelled') {
                    return { state: 'error', reason: 'canceled-on-device', message };
                }
                return { state: 'error', message };
            }
            const message = qishuiText(data?.message) || undefined;
            lastQishuiCheckNote = `status=${qishuiText(data?.status) || '-'}`
                + ` errorCode=${String(data?.errorCode ?? data?.error_code ?? '0')}`
                + ` loggedIn=${data?.loggedIn ? 'yes' : 'no'}`
                + ` cookieKeys=${String(data?.cookieKeys ?? '-')}`
                + ` loginKeys=${String(data?.loginKeys ?? '-')}`
                + ` hostCookieKeys=${String(data?.hostCookieKeys ?? '-')}`
                + ` msg=${message ?? ''}`;
            const retryAfter = Number(data?.retryAfterMs);
            const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
            const errorCode = Number(data?.errorCode ?? 0);
            switch (qishuiText(data?.status)) {
                case 'waiting': return { state: 'waiting' };
                case 'scanned': return { state: 'scanned' };
                case 'confirmed': return { state: 'confirmed' };
                case 'expired': return { state: 'expired' };
                // 设备侧取消要给 UI 一个可以立刻重试的理由，其余错误（含 rate_limited）只带文字。
                case 'mfa_cancelled': return { state: 'error', reason: 'canceled-on-device', message, retryAfterMs };
                // 上游的状态词会变：未扫码时实测返回 `status: 'new'`，主进程已归一成 waiting；
                // 万一将来又出现新词，只要没有非零 errorCode 就继续等，不要把它当登录失败 ——
                // 否则 UI 会在用户还没扫码时就显示「登录错误」。
                default: return errorCode !== 0
                    ? { state: 'error', message, retryAfterMs }
                    : { state: 'waiting' };
            }
        },
        async cancelLogin(key) { qrSessions.delete(key); },
        getLoginTtlMs: () => qrTtlMs,
        async getLoginDiagnostics() {
            return [
                line(`last status: ${lastQishuiLoginStatus ?? 'none'}`),
                line(`last qr: ${lastQishuiQrNote ?? 'none'}`),
                line(`last check: ${lastQishuiCheckNote ?? 'none'}`),
                line(`last refresh: ${lastQishuiRefreshNote ?? 'none'}`),
                // 「重启后账号没了」先看这一行：App 这边有没有存下凭据、灌回去没有。
                line(`session: ${lastQishuiSessionNote ?? 'none'}`),
                ...(lastQishuiSessionKeepNote ? [line(`session copy failed: ${lastQishuiSessionKeepNote}`)] : []),
                // 两套协议：车机（/api/luna/v1/platform，签名是 WebView 自带的 WebCrypto
                // ECDSA P-256，bd-ticket-guard）与手机（passport 扫码换会话 Cookie，
                // 数据走 /luna/pc/*，实测免签名）。桌面端仍是它自己那条 passport 链路。
                line(`protocol: ${currentProtocol}`),
                line('signed requests: android=luna-car (bd-ticket-guard via WebCrypto) / passport-web (cookie only, no signature); desktop=passport cookies'),
            ];
        },
    },
    catalog: qishuiCatalog,
    library: qishuiLibrary,
    mutations: qishuiMutations,
    recommendations: {
        async getRecommendedCollections(limit) {
            const data = await requestQishui<any>('feed', { limit: Math.min(limit, QISHUI_PAGE_MAX) }).catch(() => null);
            const songs = Array.isArray(data?.songs) ? data.songs.map(normalizeQishuiSong) : [];
            if (!songs.length) return [];
            const collection: ProviderCollection = {
                providerId: 'qishui', id: QISHUI_FEED_PLAYLIST_ID, type: 'playlist', name: '汽水推荐',
                coverUrl: songs[0].album.coverUrl, trackCount: songs.length,
                providerData: { virtual: true, playbackMode: 'recommend-match' },
            };
            return [collection].slice(0, limit);
        },
        async getPersonalFm() {
            return requestQishui<any>('feed', { limit: QISHUI_PAGE_MAX })
                .then(data => (Array.isArray(data?.songs) ? data.songs.map(normalizeQishuiSong) : []))
                .catch(() => []);
        },
    },
};
