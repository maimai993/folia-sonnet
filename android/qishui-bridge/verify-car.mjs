// android/qishui-bridge/verify-car.mjs
//
// 车机协议层的本机验证（不进 APK，仅供开发期跑）：
//
//   node android/qishui-bridge/verify-car.mjs
//
// 模拟签名宿主页面的环境：btoa/atob、WebCrypto、localStorage（Map 兜底）、
// __foliaHttpTransport（这里走 node 的 fetch，真机上是原生 OkHttp 桥）。
// 覆盖两条线：
//   1. 密码学：PKCS#10 CSR 能被 openssl 解析、WebCrypto DER 签名能被 node:crypto
//      的公钥校验通过（证明与参考实现 node:crypto 输出等价）；
//   2. 协议：公共读取（搜索/详情/歌词/音频/推荐/歌单搜索/歌单曲目/场景）与
//      二维码创建（真网络，验证授权参数仍被接受）。
//
// 跑不过不等于上线必挂（上游随时可能变），但跑得过至少说明打包前的模块没有
// 低级错误。真机验证仍以用户安装后的实测为准。

import { createRequire } from 'node:module';
import { createVerify, createPublicKey } from 'node:crypto';

const require2 = createRequire(import.meta.url);
const nodeCrypto = require2('node:crypto');

globalThis.btoa ||= s => Buffer.from(s, 'binary').toString('base64');
globalThis.atob ||= s => Buffer.from(s, 'base64').toString('binary');
// node 24 已带全局 WebCrypto，只在缺失时补。

// localStorage 模拟：真实持久化不重要，重要的是接口形状。
const memoryStore = new Map();
// 原生持久化出口（真机上是 SharedPreferences；见 car/storage.js）。
const nativeStore = new Map();
globalThis.window = {
    localStorage: {
        getItem: k => (memoryStore.has(k) ? memoryStore.get(k) : null),
        setItem: (k, v) => memoryStore.set(String(k), String(v)),
        removeItem: k => memoryStore.delete(k),
    },
    FoliaQishuiHost: {
        getStore: k => (nativeStore.has(k) ? nativeStore.get(k) : ''),
        putStore: (k, v) => { if (v == null) nativeStore.delete(k); else nativeStore.set(String(k), String(v)); },
    },
    // entry.js 用不到；transport 在显式传入时不看 window。
};

let failures = 0;
function check(name, ok, detail = '') {
    if (!ok) failures++;
    console.log((ok ? 'OK  ' : 'FAIL') + ' ' + name + (ok || !detail ? '' : '  → ' + detail));
}

// ─── 1. 密码学 ─────────────────────────────────────────────────────────────

const { createGuard, signTextDerBase64 } = await import('./src/car/guard.js');
const { pemFromBytes } = await import('./src/car/bytes.js');
import('./src/car/bytes.js');

const guard = await createGuard();
// 上游要的是「PEM 文本再 base64」：解码后必须是一份带 BEGIN/END 的 PEM 文本，
// 不能是裸 DER —— 早先发 DER base64，扫码确认后 ticket 那一步直接回 10001。
const { base64ToBytes } = await import('./src/car/bytes.js');
const csrPem = new TextDecoder().decode(base64ToBytes(guard.csr));
check('CSR is base64(PEM text), not base64(DER)', csrPem.startsWith('-----BEGIN CERTIFICATE REQUEST-----'),
    csrPem.slice(0, 40));
const { writeFileSync } = await import('node:fs');
writeFileSync('.verify-csr.pem', csrPem);

// openssl 解析 CSR（Git Bash 自带；没有就跳过这一项，下一项的 node 校验仍有效）。
const { execFileSync } = await import('node:child_process');
try {
    const out = execFileSync('openssl', ['req', '-in', '.verify-csr.pem', '-noout', '-verify'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    check('openssl CSR verify', /OK/i.test(String(out)), String(out).trim());
} catch (error) {
    console.log('SKIP openssl CSR verify (openssl unavailable): ' + String(error.message || error).slice(0, 120));
}

// WebCrypto DER 签名 ←→ node:crypto 公钥校验（等价性证明）。
{
    const message = 'ticket=abc&path=/api/luna/v1/platform/me/info/&timestamp=1792575529';
    const signatureB64 = await signTextDerBase64(guard.privateKey, message);
    const publicKey = createPublicKey(guard.guardKey);
    const verified = createVerify('sha256')
        .update(message)
        .verify(publicKey, Buffer.from(signatureB64, 'base64'));
    check('WebCrypto DER signature verified by node:crypto', verified);
}

// guard 响应头的三种失败要各说各话：真机诊断里一句 'invalid guard response'
// 等于没有信息（ticket 那一步就是这样白排查一轮）。
{
    const { readQishuiGuard } = await import('./src/car/protocol.js');
    const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64');
    const expect = (name, run, needle) => {
        let message = '';
        try { run(); } catch (error) { message = String(error.message || error); }
        check(name, message.includes(needle), `message="${message}" want~"${needle}"`);
    };
    expect('guard header missing', () => readQishuiGuard(null), 'guard header is missing');
    expect('guard header not JSON', () => readQishuiGuard('!!!not-base64!!!'), 'not base64 JSON');
    expect('guard field missing', () => readQishuiGuard(b64({ ticket: 't', ts_sign: '' })), 'ts_sign');
    const ok = readQishuiGuard(b64({ ticket: 'T', ts_sign: 'S', client_cert: 'C' }));
    check('guard header parsed', ok.ticket === 'T' && ok.guardTsSign === 'S' && ok.guardCert === 'C');
}

// ─── 2. 协议（真网络）─────────────────────────────────────────────────────

// transport：与真机 folia-xhr.js 的 __foliaHttpTransport 同一形状，
// 底下换成 node fetch。
const transport = {
    async request(payload) {
        const response = await fetch(payload.url, {
            method: payload.method || 'GET',
            headers: payload.headers || {},
            body: payload.body == null ? undefined : payload.body,
        });
        const headers = {};
        response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
        return {
            status: response.status,
            headers,
            body: await response.text(),
        };
    },
};

const { createQishuiCar } = await import('./src/car/api.js');
const car = createQishuiCar({ transport });

async function attempt(name, run) {
    try {
        const result = await run();
        check(name, true, JSON.stringify(result).slice(0, 80));
        return result;
    } catch (error) {
        check(name, false, String(error && error.message || error));
        return null;
    }
}

// 未登录 status：应该给出 loggedIn=false 而不是抛错。
await attempt('status (signed out)', async () => {
    const status = await car.status();
    if (status.loggedIn) throw new Error('expected loggedIn=false');
    return 'loggedIn=false';
});

const search = await attempt('search 晴天', () => car.search('晴天', 5, 0));
let trackId = '';
if (search && search.songs.length) {
    trackId = search.songs[0].id;
    const song = search.songs[0];
    check('search song shape', Boolean(song.name && song.cover && song.duration > 0 && song.artists.length),
        JSON.stringify(song).slice(0, 200));
} else {
    check('search song shape', false, 'no songs');
}

if (trackId) {
    await attempt('song.detail', async () => {
        const detail = await car.songDetail(trackId);
        if (!detail.song?.name) throw new Error('song.name missing');
        return detail.song.name;
    });
    await attempt('lyrics (yrc present)', async () => {
        const lyrics = await car.lyrics(trackId);
        if (!lyrics.yrc && !lyrics.lyric) throw new Error('both lyric and yrc empty');
        return `lyric=${lyrics.lyric.length}b yrc=${lyrics.yrc.length}b`;
    });
    await attempt('audio url (full, not the preview clip)', async () => {
        const audio = await car.audio(trackId, 'standard');
        if (!audio.url || !/^https:\/\//.test(audio.url)) throw new Error('no https url');
        // 回归闸门：/media/mget/ 曾用公共令牌问，受保护的曲子 upstream 连 full 都不给，
        // 于是「每首歌都 only offers a preview」。现在详情走账号那条路，这里必须是整曲。
        if (audio.trial) throw new Error('got the preview clip instead of the full track');
        // 直链真拉一次头，确认 200 且是音频（不是签名被拒的错误页）。
        const head = await fetch(audio.url, { method: 'GET', headers: { Range: 'bytes=0-1' } });
        if (head.status !== 200 && head.status !== 206) throw new Error('audio fetch HTTP ' + head.status);
        return `HTTP ${head.status} ${head.headers.get('content-type')}`;
    });
    // 「VIP 歌曲听不了」的分诊闸门：没登录时 audio 必须点名是**没有凭据**
    // （accountError=no-session），不能只给一个 account=false —— 那是两种故障
    // （登录态没恢复 / 账号那条路请求失败）共用的一个值，混在一起就没法修。
    await attempt('a signed-out audio read names the missing credential', async () => {
        const audio = await car.audio(trackId, 'standard');
        if (audio.audioMeta?.account !== false) throw new Error('account=' + audio.audioMeta?.account);
        if (audio.audioMeta?.accountError !== 'no-session') throw new Error('accountError=' + audio.audioMeta?.accountError);
        return JSON.stringify(audio.audioMeta);
    });
}

await attempt('feed', async () => {
    const feed = await car.feed(6);
    if (!feed.songs.length) throw new Error('empty feed');
    return feed.songs.length + ' songs';
});

const playlists = await attempt('searchPlaylists 华语', () => car.searchPlaylists('华语', 3, 0));
if (playlists && playlists.playlists.length) {
    const playlist = playlists.playlists[0];
    // trackCount 曾经恒为 0：resource_cnt 是**对象**（{ track_cnt, ... }），直接
    // Number() 得 NaN。界面上「0 首」的歌单卡会被当成空歌单 → 入口置灰。
    check('playlist shape + trackCount > 0',
        Boolean(playlist.id && playlist.name) && playlist.trackCount > 0,
        `trackCount=${playlist.trackCount} ${JSON.stringify(playlist).slice(0, 120)}`);
    await attempt('playlistTracks', async () => {
        const page = await car.playlistTracks(playlist.id, 3, 0);
        if (!page.tracks.length) throw new Error('empty tracks');
        return page.tracks.length + ' tracks';
    });
    // 前提（只记录不断言）：歌单自己那张图是取不到字节的。哪天它回 200 了，
    // 「一律换成第一首歌的封面」就该改回「没封面才补」。
    if (playlist.cover) {
        const own = await fetch(playlist.cover, { method: 'GET', headers: { Range: 'bytes=0-1' } });
        console.log(`NOTE playlist own cover → HTTP ${own.status} (${playlist.cover.slice(0, 60)}…)`);
    }
    // 歌单封面兜底：只写「没封面才补」是不够的 —— 封面字段非空，只是取不到字节
    // （403 fail to get resource），界面上照样是占位图，而兜底一次都不会触发。
    await attempt('playlist cover replaced by the first track cover', async () => {
        const page = await car.playlistTracks(playlist.id, 3, 0);
        const card = page.playlist;
        const first = page.tracks[0];
        if (!card?.cover) throw new Error('card has no cover');
        if (!first?.cover) throw new Error('first track has no cover');
        if (card.cover !== first.cover) throw new Error(`not replaced: ${card.cover}`);
        const res = await fetch(card.cover, { method: 'GET', headers: { Range: 'bytes=0-1' } });
        if (res.status !== 200 && res.status !== 206) throw new Error('cover HTTP ' + res.status);
        return `card cover = first track cover, HTTP ${res.status}`;
    });
}

await attempt('feedModes', async () => {
    const modes = await car.feedModes();
    if (!Array.isArray(modes) || !modes.length) throw new Error('no modes');
    return modes.length + ' modes';
});

// 发现页「模式探索」：公开 /luna/discover，卡片和曲目都要能没登录就读到。
await attempt('discoverModes', async () => {
    const cards = await car.discoverModes();
    if (!Array.isArray(cards) || !cards.length) throw new Error('no mode cards');
    const first = cards[0];
    if (!first.id || !first.name || !first.cover) throw new Error('mode card lacks id/name/cover');
    const res = await fetch(first.cover, { method: 'GET', headers: { Range: 'bytes=0-1' } });
    if (res.status !== 200 && res.status !== 206) throw new Error('mode cover HTTP ' + res.status);
    return cards.length + ' cards, cover HTTP ' + res.status;
});
await attempt('discoverTracks', async () => {
    const cards = await car.discoverModes();
    if (!cards.length) throw new Error('no cards');
    const page = await car.discoverTracks(cards[0].id, 5, '');
    if (!page.songs.length || !page.songs[0].name) throw new Error('no tracks');
    return page.songs.length + ' tracks';
});

// 二维码创建：授权参数（client_key/signature/scope）还被人认的证明。
await attempt('login QR created', async () => {
    const result = await car.startLogin();
    if (!result.qrDataUrl.startsWith('data:image/png;base64,')) throw new Error('qr payload malformed');
    car.cancelLogin(result.key);
    return 'qr ok, key=' + result.key.slice(0, 8) + '…';
});

// ─── 3. 模拟登录全链路（扫码确认 → 换 ticket → 拿账号）───────────────────
//
// 真扫码只能靠真机，但「确认之后」这一串（access code → ticket → guard 解析 →
// 过期时间 → /me/info → 写会话 → status）完全可以伪造上游响应来验证：签名是真的
// （WebCrypto 现签），只有上游是假的。之前 expires 返回数字导致
// `.getTime is not a function` 就是这类本机能抓住却漏到真机的错误。

const { qishuiCredentialExpiry } = await import('./src/car/protocol.js');
{
    const expiry = qishuiCredentialExpiry(String(Math.floor(Date.now() / 1000) + 7200));
    check('qishuiCredentialExpiry returns a Date', typeof expiry.getTime === 'function'
        && Number.isFinite(expiry.getTime()), String(expiry));
}

const base64Json = value => Buffer.from(JSON.stringify(value)).toString('base64');
const GUARD_HEADERS = {
    'bd-ticket-guard-server-data': base64Json({
        ticket: 'FAKE-TICKET', ts_sign: 'FAKE-TS', client_cert: 'FAKE-CERT',
    }),
};
// /media/mget/ 是「账号那条路」的读取（见 api.js 的 accountTrack）：这个开关用来
// 让它返回坏数据，好把**回退分支**也跑一遍 —— 成功路径测不到那一支。
let mgetBroken = false;
// 让账号那条路先被判一次 auth-required（28001003 是 ticket 无效/过期那个码）：
// 真机上最常见的就是「启动那一问没跑完，凭据没续上，于是这里拿到的还是旧 ticket」。
// 只坏一次，用来验证「补一次续期再试一遍」真的会把这一首救回账号那条路。
let mgetAuthOnce = false;
const loginTransport = {
    async request(payload) {
        const url = String(payload.url || '');
        const headers = {};
        const send = body => ({ status: 200, headers, body: JSON.stringify(body) });
        if (url.includes('/media/mget/')) {
            if (mgetAuthOnce) {
                mgetAuthOnce = false;
                return send({ err_no: 28001003, status_msg: 'ticket invalid' });
            }
            if (mgetBroken) return send({ err_no: 0, data: {} });
            return send({ err_no: 0, data: { media_list: [{
                media_id: 'T-1',
                track_entity: { base_info: { id: 'T-1', name: '测试曲目', duration_ms: 200000 } },
            }] } });
        }
        if (url.includes('/oauth/get_qrcode/')) {
            return send({ err_no: 0, data: { token: 'TOKEN-1', qrcode: 'iVBORw0KGgo=' } });
        }
        if (url.includes('/oauth/check_qrcode/')) {
            return send({ err_no: 0, data: { status: 'confirmed', code: 'AUTH-CODE' } });
        }
        if (url.includes('/access/code/get/')) {
            // 真实响应是一层 data：{ err_no, data: { access_code, ... } }。
            return send({ err_no: 0, data: {
                access_code: 'ACCESS-CODE', open_id: 'OPEN-ID',
                expires_time: Math.floor(Date.now() / 1000) + 7200,
            } });
        }
        if (url.includes('/passport/open/get_access_ticket/')) {
            // CSR 必须是「PEM 文本再 base64」；顺带把这一条钉在模拟层里。
            const csr = payload.headers['bd-ticket-guard-client-csr'] || '';
            const decoded = Buffer.from(String(csr), 'base64').toString('utf8');
            if (!decoded.startsWith('-----BEGIN CERTIFICATE REQUEST-----')) {
                return send({ err_no: 10001, data: { description: 'CSR is not a PEM text' } });
            }
            return { status: 200, headers: GUARD_HEADERS, body: JSON.stringify({ err_no: 0, data: {} }) };
        }
        if (url.includes('/me/info/')) {
            return send({ err_no: 0, data: { my_info: { id: 'UID-1', nickname: '测试账号' } } });
        }
        return send({ err_no: 0, data: {} });
    },
};

const loginCar = createQishuiCar({ transport: loginTransport });
const started = await attempt('login.qr (mock upstream)', async () => {
    const result = await loginCar.startLogin();
    if (!result.key) throw new Error('no key');
    return 'key ok';
});
if (started) {
    const qr = await loginCar.startLogin();
    const check = await attempt('login.check with real key → confirmed', async () => {
        const result = await loginCar.checkLogin(qr.key);
        if (result.state !== 'confirmed') throw new Error('state=' + result.state);
        return 'confirmed';
    });
    if (check) {
        await attempt('status after login (mock upstream)', async () => {
            const status = await loginCar.status();
            if (!status.loggedIn) throw new Error('loggedIn=false');
            if (status.profile?.id !== 'UID-1') throw new Error('profile id mismatch: ' + status.profile?.id);
            const credential = loginCar.sessions.get();
            if (!credential?.ticket || credential.ticket !== 'FAKE-TICKET') throw new Error('ticket not stored');
            return `loggedIn, user=${status.profile.nickname}, expiresAt=${new Date(credential.expiresAt).toISOString()}`;
        });
        // 重启后账号还在不在，就看凭据有没有落到原生那一档（真机 = SharedPreferences）。
        await attempt('session persisted to native store', async () => {
            const raw = nativeStore.get('session');
            if (!raw) throw new Error('native store has no session (would be lost on restart)');
            const parsed = JSON.parse(raw);
            if (parsed.ticket !== 'FAKE-TICKET') throw new Error('native session mismatch');
            if (!nativeStore.get('device-id')) throw new Error('device id not persisted');
            return 'native session + device-id ok';
        });
        // 模拟重启：新起一个 car 实例，只读存储，不做任何登录。
        await attempt('session survives a restart', async () => {
            const rebooted = createQishuiCar({ transport: loginTransport });
            const status = await rebooted.status();
            if (!status.loggedIn) throw new Error('loggedIn=false after restart');
            if (status.storage !== 'native') throw new Error('storage=' + status.storage);
            return `loggedIn after restart, storage=${status.storage}`;
        });
        // 诊断必须能一眼分清「没写进来」和「读出来是空的」：真机上再说账号丢了，
        // 只有这两个字段能指路。deviceIdReused 尤其关键 —— 它每次启动都重新生成，
        // 就说明那一档存储压根没读出来，凭据自然也读不回来。
        await attempt('restart diagnostics name the store tiers', async () => {
            const rebooted = createQishuiCar({ transport: loginTransport });
            const status = await rebooted.status();
            const store = status.store;
            if (store?.session !== 'native') throw new Error('store.session=' + store?.session);
            if (store?.deviceId !== 'native') throw new Error('store.deviceId=' + store?.deviceId);
            if (store?.deviceIdReused !== true) throw new Error('device id was regenerated on restart');
            if (store?.read !== 'native') throw new Error('store.read=' + store?.read);
            return JSON.stringify(store);
        });
        // 「重启后账号没了」最坏的一种：桥自己那份存储（真机 = SharedPreferences）
        // 整个空了。桥这边已经救不回来，只有 App 主 WebView 那份凭据能把它复活 ——
        // 这就是 session.export / session.import 存在的理由，这条断言专门钉它。
        await attempt('a bridge that lost its own store is revived by the copy the app kept', async () => {
            const kept = loginCar.exportSession().credential;
            if (!kept?.ticket || !kept?.guardKey) throw new Error('session.export gave no usable credential');
            // ⚠ 必须把**三档全清掉**（原生 / localStorage / 内存）。只清外两档不够：
            // car/storage.js 的内存兜底是模块级的，同一个进程里它照样把凭据递回来，
            // 「存储被清空」根本没被模拟到 —— 这一条断言会假通过。storage.remove 正好
            // 是三档一起删的那个动作，等价于「真机重启后 SharedPreferences 空了」。
            const storage = await import('./src/car/storage.js');
            storage.remove('session');
            storage.remove('device-id');
            try {
                const rebooted = createQishuiCar({ transport: loginTransport });
                const before = await rebooted.status();
                if (before.loggedIn) throw new Error(`expected the rebooted bridge to have lost the session`
                    + ` (storage=${before.storage} store=${JSON.stringify(before.store)})`);
                const imported = rebooted.importSession(JSON.parse(JSON.stringify(kept)));
                if (imported.restored !== true) throw new Error('import refused: ' + imported.reason);
                const after = await rebooted.status();
                if (!after.loggedIn) throw new Error('still not logged in after the import');
                return `lost (storage=${before.storage}) → restored, user=${after.profile?.nickname}`;
            } finally {
                // 后面的断言还要看这份凭据：写回三档，别把现场留在坏状态。
                loginCar.sessions.set(loginCar.sessions.get());
            }
        });
        // 反方向也要钉住：渲染层每次查登录态都先灌一次，而桥这份可能是**刚续过期**的。
        // 拿 App 那份旧的盖回去，等于把一次成功的续期作废。
        await attempt('the import leaves a fresher session in the bridge alone', async () => {
            const stale = { ...loginCar.exportSession().credential, ticket: 'STALE-TICKET', expiresAt: Date.now() - 1000 };
            const result = loginCar.importSession(stale);
            if (result.restored !== false || result.kept !== true) throw new Error(JSON.stringify(result));
            if (loginCar.sessions.get()?.ticket !== 'FAKE-TICKET') throw new Error('the live session was clobbered');
            return `kept=${result.kept} (${result.reason})`;
        });
        // 带凭据的曲目读取。两条都要跑：accountTrack 只在**失败**那一支里调 log()，
        // 而 `log` 曾经没在本文件里绑过 → `ReferenceError: log is not defined`，
        // 一次把 audio 与 lyrics 全打挂，成功路径却完全测不出来。
        await attempt('song.detail on the account path', async () => {
            const detail = await loginCar.songDetail('T-1');
            if (!detail.song?.name) throw new Error('song missing');
            return detail.song.name;
        });
        // 旧 ticket 被拒时不能急着退回公共令牌：那等于把这一首判成「只剩试听」，
        // 用户看到的就是「有 VIP 也听不了」。补一次续期再试，救得回来就走账号那条路。
        await attempt('a ticket rejected once is renewed and the track read retried', async () => {
            mgetAuthOnce = true;
            let failure = null;
            let detail = null;
            try { detail = await loginCar.songDetail('T-1'); }
            catch (error) { failure = error; }
            finally { mgetAuthOnce = false; }
            if (failure) throw new Error('the read gave up instead of renewing: ' + failure.message);
            if (!detail.song?.name) throw new Error('song missing after the retry');
            return 'renewed and retried, account path restored';
        });
        await attempt('account read failure stays a QishuiError (never a ReferenceError)', async () => {
            mgetBroken = true;
            let failure = null;
            try { await loginCar.songDetail('T-1'); }
            catch (error) { failure = error; }
            finally { mgetBroken = false; }
            if (!failure) throw new Error('expected the account read to fail on the broken payload');
            if (failure instanceof ReferenceError || /is not defined/.test(String(failure.message))) {
                throw new Error(`a ReferenceError leaked out: ${failure.message}`);
            }
            return `${failure.constructor?.name || 'Error'}: ${failure.message}`;
        });
    }
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL OK');
process.exitCode = failures ? 1 : 0;
