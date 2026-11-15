// android/qishui-bridge/src/car/api.js
//
// 车机协议层的对外门面：把 client / auth / catalog / feed / library 组装起来，
// 并做掉「Folia 的 operation」与「车机端点」之间的那一层翻译（虚拟歌单 id 等）。
//
// 上层（entry.js）只认这一层的方法与 Folia 形状，不直接碰协议常量。

import { createClient, QishuiError } from './client.js';
import { createAuth, createSessions } from './auth.js';
import { createCatalog, likedPlaylist } from './catalog.js';
import { createFeed } from './feed.js';
import { createDiscover } from './discover.js';
import { createLibrary } from './library.js';
import { resolveAudio } from './playback.js';
import { createFetch } from './transport.js';
import { coverFromUrlInfo, lyricsFromTrack, toFoliaPlaylists, toFoliaSong, toFoliaSongs } from './shape.js';
import { QISHUI_QR_SCOPE } from './protocol.js';
import { storageMode, storageParseError, storageWriteMode, whereIs } from './storage.js';

// 渲染层用这两个虚拟 id 拉「我的喜欢」与推荐流（见 qishuiCatalog.ts）。
export const QISHUI_LIKED_ID = 'qishui-liked';
export const QISHUI_FEED_ID = 'qishui-feed';

const text = value => (value == null ? '' : String(value));

export function createQishuiCar(options = {}) {
    const fetcher = options.fetch || createFetch(options.transport);
    const sessions = options.sessions || createSessions();
    const client = createClient({ sessions, fetch: fetcher });
    // ⚠ 必须在这里绑一个自己的 log：早先它只是**作为参数**传给 createAuth，
    // 本文件里并没有这个名字，结果 accountTrack 在回退分支里一调 log() 就是
    // `ReferenceError: log is not defined` —— 而且只在「凭据那条路失败」时才踩到，
    // 成功路径完全测不出来（那次 audio 与 lyrics 全挂，就是这个）。
    const log = options.log || (() => {});
    const auth = createAuth(client, { log });
    const catalog = createCatalog(client);
    const feed = createFeed(client);
    const discover = createDiscover({ client });
    const library = createLibrary(client);
    const { platform } = client;

    // 我的喜欢的真实歌单 id：车机里它是 type 1 的普通歌单，id 每个账号不同，
    // 而渲染层只认 'qishui-liked' 这一个入口，所以这里缓存一次映射。
    let likedReal = null;

    /**
     * 歌单封面的兜底。
     *
     * 实测：上游给的歌单封面（`display_info.url_cover`）一律取不到字节 ——
     * 它的 uri 落在 `tos-cn-i-*` 这个桶里，任何尺寸后缀都回 403
     * `{"code":3403,"error":"fail to get resource"}`（换主机、加 UA / Referer 都一样）；
     * 而**歌曲**封面落在 `tos-cn-v-*` 桶里，同一个后缀是 200。
     * 两个桶的 url 结构完全一样（template_prefix、need_complete_url 都相同），
     * 所以不是拼错了，是那个桶根本不发图。
     *
     * 因此这里不是「没封面才补」，而是**只要有第一首歌的封面就换掉**：留着 403 的地址，
     * 界面上看到的就是一张占位图。一次 /playlist/detail/ 只取第一首（count=1），
     * 结果按歌单 id 缓存 —— 同一份歌单在首页刷十次也只问一次。
     *
     * 连第一首歌自己也没封面时，把它的名字带进 providerData，交给渲染层去别的平台借
     * （协议层没有跨平搜索的能力，见 qishuiNormalize 的 backfillQishuiCollectionCovers）。
     */
    const coverCache = new Map();
    const COVER_FALLBACK_BUDGET = 12;

    async function firstTrack(id, ownerId) {
        const key = String(id || '');
        if (!key) return null;
        if (coverCache.has(key)) return coverCache.get(key);
        let found = null;
        try {
            const page = await catalog.playlistTracks({
                id: key, ownerId: String(ownerId || ''), limit: 1, offset: 0, count: 1,
            });
            const [song] = toFoliaSongs(page.items);
            if (song) found = { cover: song.cover || '', name: song.name || '', artist: song.artist || '' };
        } catch (_) {
            found = null;
        }
        coverCache.set(key, found);
        return found;
    }

    /** 用第一首歌的封面顶掉歌单封面；它也没有封面时，把歌名留给渲染层。 */
    function applyCoverFallback(playlist, track) {
        if (!playlist) return;
        if (track?.cover) {
            playlist.cover = track.cover;
            return;
        }
        // 只有「连歌名都拿得到」才值得让渲染层再去搜一次；拿不到就维持现状。
        if (track?.name) {
            playlist.providerData = {
                ...(playlist.providerData || {}),
                coverSongName: track.name,
                coverSongArtist: track.artist || '',
            };
        }
    }

    /**
     * 曲目详情是**账号级**读取。
     *
     * 实测：用公共客户端令牌问 /media/mget/，`player_type=1` 的曲子还给 full
     * （video_list 全是 cenc 加密，但 full 里带的 url_player_info 能换出一条明文 m4a），
     * 而 `player_type=2` 的（受版权保护那批）**响应里压根没有 full**，只有 preview ——
     * 表现就是「每首歌都 only offers a preview for this account」，其实跟账号没关系，
     * 是这条请求没带凭据。
     *
     * 带上登录凭据优先；没登录或凭据这条路失败（过期 / guard 拒绝）就退回公共令牌，
     * 详情与歌词至少还能看。
     */
    /** 补一次续期（`auth.status()` 就是 renew）。成功返回 true，续不上返回 false。 */
    async function renewOnce() {
        try {
            await auth.status();
            return Boolean(sessions.get()?.ticket);
        } catch (error) {
            log(`[Qishui] renew failed (${error?.code || error?.message || error})`);
            return false;
        }
    }

    async function accountTrack(id) {
        const credential = sessions.get();
        // ⚠「没凭据」与「有凭据但这条路失败了」是两种完全不同的故障，必须分得开：
        // 前者是登录态没恢复，后者是签名/接口那一路的问题。合成的 accountError
        // 会一路带到渲染层的报错文案里（`audioMeta`），否则它只躺在隐藏 WebView
        // 的 console 里 —— 那份日志用户根本看不到。
        if (!credential) return { track: await catalog.track(id), account: false, accountError: 'no-session' };
        try {
            return { track: await catalog.track(id, { credential }), account: true };
        } catch (error) {
            const reason = error instanceof QishuiError
                ? `${error.code}${error.stage ? '/' + error.stage : ''}`
                : String(error?.code || error?.message || error);
            log(`[Qishui] account track read failed (${reason}), renewing once before giving up`);
            // ⚠ 凭据过期是最常见的那一种：续期（renew）只在 status 那一问里发生，
            // 而那一问在冷启动时常常还没跑（甚至被丢单），于是这里拿到的还是旧 ticket，
            // 上游判 auth-required。直接退回公共令牌，受保护的曲子就只剩试听 ——
            // 用户看到的就是「有 VIP 也听不了」。先补一次续期再试一遍。
            const renewed = await renewOnce();
            if (renewed) {
                try {
                    return { track: await catalog.track(id, { credential: sessions.get() }), account: true, renewed };
                } catch (retryError) {
                    const retryReason = retryError instanceof QishuiError
                        ? `${retryError.code}${retryError.stage ? '/' + retryError.stage : ''}`
                        : String(retryError?.code || retryError?.message || retryError);
                    log(`[Qishui] the account read still fails after renewing (${retryReason})`);
                    return { track: await catalog.track(id), account: false, accountError: `${reason} → renewed → ${retryReason}` };
                }
            }
            return { track: await catalog.track(id), account: false, accountError: reason };
        }
    }

    async function resolveLiked() {
        if (likedReal) return likedReal;
        likedReal = await likedPlaylist(platform);
        return likedReal;
    }

    const userShape = user => (user ? {
        id: text(user.id),
        nickname: text(user.nickname),
        avatarUrl: coverFromUrlInfo(user.avatar) || (typeof user.avatar === 'string' ? user.avatar : ''),
        ...(typeof user.isVip === 'boolean' ? { vipType: user.isVip ? 1 : 0 } : {}),
    } : null);

    return {
        sessions,

        /**
         * 登录态。
         *
         * 判定只认手里有没有 ticket 凭据：车机协议没有 cookie 这一层，旧协议那套
         * 「cookie 里有 sid_tt 就算登录」的坑（sid_tt 登录前就有）在这里不存在。
         * 续期（renew）失败不推翻已登录结论 —— 凭据还没过期就继续用，错误只进诊断。
         */
        async status() {
            const credential = sessions.get();
            const base = {
                provider: 'qishui',
                configured: true,
                loggedIn: Boolean(credential?.ticket),
                webSession: Boolean(credential?.ticket),
                cookieReady: Boolean(credential?.ticket),
                protocol: 'luna-car',
                scope: QISHUI_QR_SCOPE,
                cookieKeys: '(car-protocol)',
                // 凭据落在哪一档存储：真机上「重启后账号没了」先看这个字段
                // （native=SharedPreferences / local=localStorage / memory=只在这个进程）。
                // ⚠ 这是**读档**：写档几乎恒为 native（设备 ID 每次启动都要写一次），
                // 混着看会被带到错的方向，所以两个分开给。
                storage: storageMode(),
                store: {
                    read: storageMode(),
                    write: storageWriteMode(),
                    session: whereIs('session'),
                    deviceId: whereIs('device-id'),
                    // 每次启动都重新生成设备 ID＝这一档存储没读出来，凭据当然也没有。
                    deviceIdReused: sessions.deviceIdReused === true,
                    ...(storageParseError() ? { parseError: storageParseError() } : {}),
                },
                loginKeys: credential?.ticket ? 'ticket=y' : 'ticket=n',
                userId: text(credential?.userId),
                libraryReady: Boolean(credential?.ticket),
                libraryErrors: [],
            };
            if (!credential?.ticket) {
                return { ...base, profileReady: false, profile: null, message: '未登录：请用抖音/汽水 App 扫码授权' };
            }
            let user = credential.user || null;
            let profileError = '';
            try {
                const fresh = await auth.status();
                if (fresh) user = fresh;
            } catch (error) {
                // 凭据还没过期就保留登录态，只把原因写进诊断。
                profileError = error instanceof QishuiError
                    ? `${error.code}${error.stage ? '/' + error.stage : ''}: ${error.message}`
                    : String(error?.message || error);
                if (Number(credential.expiresAt) > 0 && Number(credential.expiresAt) <= Date.now()) {
                    return {
                        ...base,
                        loggedIn: false,
                        webSession: false,
                        cookieReady: false,
                        profileReady: false,
                        profile: null,
                        profileError,
                        message: 'Qishui session expired; scan the QR code again',
                    };
                }
            }
            return {
                ...base,
                profileReady: Boolean(user?.id),
                profile: userShape(user),
                ...(profileError ? { profileError } : {}),
                expiresAt: Number(credential.expiresAt) || 0,
            };
        },

        async startLogin() {
            const result = await auth.start();
            return { key: result.key, qrDataUrl: result.imageUrl };
        },

        qr: key => auth.qr(key).imageUrl,
        checkLogin: key => auth.check(key),
        cancelLogin: key => { auth.cancel(key); },

        /**
         * 把当前凭据原样导出，交给渲染层存进 **App 自己**那一份存储。
         *
         * 为什么要有这一手：桥自己那份（隐藏 WebView 的 SharedPreferences /
         * localStorage）在真机上并不总是读得回来 —— 重启后它空了，登录态就凭空没了，
         * 而播放地址那一路也会退回公共令牌（audioMeta 的 account=false，
         * 受保护的曲子只剩试听）。App 主 WebView 的 localStorage 是另一条通道，
         * 网易 / QQ / 酷狗的登录态都靠它跨重启活着，所以凭据在两边各留一份。
         */
        exportSession() {
            return { provider: 'qishui', credential: sessions.get() || null };
        },

        /**
         * 灌回一份凭据：启动时桥说没登录，就先把 App 存的那份塞回去再问一次。
         *
         * 只认形状不认内容 —— ticket 与 guardKey 缺一个就签不出请求。
         *
         * ⚠ 不是无条件覆盖：渲染层每次查登录态都会先灌一次（它不知道桥此刻有没有），
         * 而桥这份可能是**刚续过期的**（renew 写过新 ticket）。拿 App 那份旧的盖回去，
         * 等于把一次成功的续期作废。所以只在两种情况下真的写：桥现在没有凭据，
         * 或者灌进来的这份过期时间更晚。
         */
        importSession(credential) {
            const value = credential && typeof credential === 'object' ? credential : null;
            if (!value || !value.ticket || !value.guardKey) {
                return { provider: 'qishui', restored: false, reason: 'the saved session has no ticket or guard key' };
            }
            const current = sessions.get();
            const currentExpiry = Number(current?.expiresAt) || 0;
            const nextExpiry = Number(value.expiresAt) || 0;
            if (current?.ticket && nextExpiry <= currentExpiry) {
                return { provider: 'qishui', restored: false, kept: true, reason: 'the bridge already holds this session' };
            }
            sessions.set(value);
            // 换账号后同一个歌单 id 的曲目可能不同。
            coverCache.clear();
            log('[Qishui] the session kept by the app was put back into the bridge');
            return { provider: 'qishui', restored: true };
        },

        logout() {
            auth.logout();
            feed.clear();
            likedReal = null;
            // 换账号后同一个歌单 id 的曲目可能不同，封面缓存要跟着作废。
            coverCache.clear();
            return { provider: 'qishui', loggedIn: false, webSession: false, cookieReady: false, configured: true };
        },

        async search(keywords, limit, offset) {
            const page = await catalog.searchSongs({ query: keywords, limit, offset });
            const songs = toFoliaSongs(page.items);
            return {
                provider: 'qishui',
                songs,
                rawCount: page.items.length,
                offset,
                limit,
                nextOffset: page.nextOffset,
                hasMore: page.hasMore,
            };
        },

        // 搜索出来的歌单同样带着那个 403 的封面，但一次搜索就是十几张卡片，
        // 逐张再发一次 /playlist/detail/ 换图不划算 —— 点进去看详情时再兜（见上）。
        async searchPlaylists(keywords, limit, offset) {
            const page = await catalog.searchPlaylists({ query: keywords, limit, offset });
            return {
                provider: 'qishui',
                playlists: toFoliaPlaylists(page.items),
                nextOffset: page.nextOffset,
                hasMore: page.hasMore,
            };
        },

        async songDetail(id) {
            const { track } = await accountTrack(id);
            return { provider: 'qishui', song: toFoliaSong(track) };
        },

        async lyrics(id) {
            const { track } = await accountTrack(id);
            const lyrics = lyricsFromTrack(track);
            return {
                provider: 'qishui',
                lyric: lyrics.lyric,
                yrc: lyrics.yrc,
                tlyric: lyrics.tlyric,
                source: lyrics.lyric || lyrics.yrc ? 'luna-car' : 'none',
            };
        },

        async audio(id, quality) {
            const { track, account, accountError, renewed } = await accountTrack(id);
            const audio = await resolveAudio(client, track, quality);
            // 这几个字段只为排查「为什么只剩试听」：有没有带凭据（没带的话为什么）、
            // 上游给的是哪一型、full 那套到底有没有下发。渲染层在判成试听时会把它们
            // 写进报错文案 —— 用户报「VIP 歌曲听不了」时，全靠这一串分清
            // 「没登录」/「登录了但这首只授权试听」/「登录了但 full 换不出明文」。
            const player = track?.player_info || {};
            return {
                provider: 'qishui',
                ...audio,
                audioMeta: {
                    account,
                    ...(accountError ? { accountError } : {}),
                    // 这一首是靠「补一次续期」才走上账号那条路的：说明 status 那一问
                    // 没能在启动阶段把凭据续上（原生侧的排队修复之前，这是常态）。
                    ...(renewed ? { renewed } : {}),
                    playerType: Number.isFinite(Number(player.player_type)) ? Number(player.player_type) : -1,
                    fullModel: Boolean(player.full?.video_model_info),
                    previewModel: Boolean(player.preview?.video_model_info),
                    // full 那套换没换出明文：换不出就会掉到 preview，这是同一现象的
                    // 另一半原因（凭据在手也照样只剩试听）。
                    gotFull: audio?.trial === false,
                },
            };
        },

        /**
         * 我的歌单：真实列表 + 两个虚拟入口（我的喜欢 / 推荐流）。
         * 车机的「我的喜欢」本身就在真实列表里（type 1），这里把它换成统一入口，
         * 免得同一个歌单在界面上出现两次。
         */
        async userPlaylists(limit, offset) {
            const page = await catalog.userPlaylists({ limit: 10000, offset: 0 });
            const real = page.items.filter(item => Number(item?.base_info?.type) !== 1);
            const liked = await resolveLiked().catch(() => null);
            // 虚拟歌单没有自己的封面，也从它指向的真实歌单里借第一首歌的。
            const likedTrack = liked ? await firstTrack(liked.id, liked.ownerId) : null;
            const virtual = [
                {
                    id: QISHUI_LIKED_ID,
                    name: '我的喜欢',
                    cover: '',
                    description: '',
                    trackCount: 0,
                    creator: undefined,
                    artists: [],
                    isOwned: true,
                    owned: true,
                    virtual: true,
                },
                {
                    id: QISHUI_FEED_ID,
                    name: '汽水推荐',
                    cover: '',
                    description: '',
                    trackCount: 0,
                    creator: undefined,
                    artists: [],
                    isOwned: true,
                    owned: true,
                    virtual: true,
                    playbackMode: 'recommend-match',
                },
            ];
            applyCoverFallback(virtual[0], likedTrack);
            const mapped = toFoliaPlaylists(real);
            // 歌单自己的封面取不到（403），一律去换第一首歌的。限条数：一个歌单一次请求，
            // 几百个歌单全兜一遍会把首页拖死；渲染层对这份列表有 60s 缓存，不会每次都付。
            const pending = [];
            for (let i = 0; i < mapped.length && pending.length < COVER_FALLBACK_BUDGET; i++) {
                pending.push({ index: i, id: String(real[i]?.base_info?.id || ''), ownerId: String(real[i]?.base_info?.owner_id || '') });
            }
            await Promise.all(pending.map(async entry => {
                applyCoverFallback(mapped[entry.index], await firstTrack(entry.id, entry.ownerId));
            }));
            const items = [...virtual, ...mapped];
            return {
                provider: 'qishui',
                playlists: items.slice(offset, offset + limit),
                total: items.length,
                nextOffset: offset + Math.min(limit, Math.max(0, items.length - offset)),
                hasMore: offset + limit < items.length,
                libraryErrors: liked ? [] : ['liked-playlist: not found'],
            };
        },

        async playlistTracks(id, limit, offset, ownerId = '') {
            const key = text(id);
            if (key === QISHUI_FEED_ID || key === 'qishui-feed') {
                const page = await feed.songs({ count: Math.max(limit, 6) });
                const songs = toFoliaSongs(page.items);
                return {
                    provider: 'qishui',
                    tracks: songs,
                    songs,
                    total: songs.length,
                    offset,
                    nextOffset: offset + songs.length,
                    hasMore: Boolean(page.hasMore),
                };
            }
            if (key === QISHUI_LIKED_ID || key === 'qishui-liked') {
                const liked = await resolveLiked();
                if (!liked) {
                    return {
                        provider: 'qishui', tracks: [], songs: [], total: 0, offset,
                        nextOffset: offset, hasMore: false, libraryErrors: ['liked-playlist: not found'],
                    };
                }
                return this.playlistTracks(liked.id, limit, offset, liked.ownerId);
            }
            const page = await catalog.playlistTracks({ id: key, ownerId, limit, offset });
            const tracks = toFoliaSongs(page.items);
            const card = page.collection ? toFoliaPlaylists([page.collection])[0] || null : null;
            // 详情页的大图同理。这一首已经在手上了，不用再发一次请求。
            applyCoverFallback(card, tracks[0] ? { cover: tracks[0].cover, name: tracks[0].name, artist: tracks[0].artist } : null);
            return {
                provider: 'qishui',
                tracks,
                songs: tracks,
                playlist: card,
                total: tracks.length,
                offset,
                nextOffset: page.nextOffset,
                hasMore: page.hasMore,
            };
        },

        async artist(artistId, limit, offset) {
            const page = await catalog.artistSongs({ id: artistId, limit: limit || 50, offset: offset || 0 });
            const songs = toFoliaSongs(page.items);
            let artist = null;
            try {
                const info = await catalog.artistDetail({ id: artistId });
                if (info) {
                    artist = {
                        id: text(info.id || artistId),
                        name: text(info.name),
                        cover: coverFromUrlInfo(info.url_avatar || info.avatar),
                        trackCount: Number(info.count_tracks || songs.length) || 0,
                        artists: [{ id: text(info.id || artistId), name: text(info.name) }],
                    };
                }
            } catch (_) {
                // 歌手详情不是必须：热门曲目拿到了就够列歌。
            }
            return { provider: 'qishui', artist, songs, total: page.total, nextOffset: page.nextOffset, hasMore: page.hasMore };
        },

        async feed(limit, scene) {
            // scene 是场景分类 id（来自 /feed/mode/）；给了就按这个场景拉歌，否则是默认 FM。
            const page = await feed.songs({ count: Math.max(limit, 6), ...(scene != null ? { scene } : {}) });
            const songs = toFoliaSongs(page.items);
            return { provider: 'qishui', songs, hasMore: Boolean(page.hasMore) };
        },

        feedModes: () => feed.modes(),

        // 手机端「发现 → 模式探索」：public /luna/discover，每次请求内容会换。
        discoverModes: () => discover.modes(),
        discoverTracks: (id, limit, cursor) => discover.tracks(id, limit, cursor),

        likedSongs: () => library.likedSongs(),
        recentPlayed: (limit, offset) => library.recentPlayed({ limit, offset }).then(page => ({
            provider: 'qishui', songs: toFoliaSongs(page.items), hasMore: page.hasMore,
        })),
        checkTracks: ids => library.checkTracks({ ids }),
        likeSong: (id, liked) => library.likeSong({ id, liked }).then(() => ({ provider: 'qishui', success: true })),
        addSongs: (playlistId, ids) => library.editPlaylist({ operation: 'add', id: playlistId, ids })
            .then(() => ({ provider: 'qishui', success: true })),
        removeSongs: (playlistId, ids) => library.editPlaylist({ operation: 'remove', id: playlistId, ids })
            .then(() => ({ provider: 'qishui', success: true })),
        dislikeSong: (id, disliked) => library.dislikeSong({ id, disliked }).then(() => ({ provider: 'qishui', success: true })),
    };
}

export default { createQishuiCar };
