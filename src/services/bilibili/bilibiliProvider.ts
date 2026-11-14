import type { OnlineMusicProvider, ProviderCollection, ProviderExploreItem, ProviderPage } from '../../types/onlineMusic';
import i18n from '../../i18n/config';
import {
    fetchBilibiliUserProfile,
    listBilibiliShelves,
    loadBilibiliUserUploads,
    searchBilibiliUsers,
} from './library';
import { listBangumiEpisodes, listBangumiSeasons, searchBangumiSeasons, type BangumiSeason } from './bangumi';
import type { BilibiliSearchHit } from '../../types/bilibili';
import QRCode from 'qrcode';
import {
    BILIBILI_ZONES,
    fetchBilibiliNavProfile,
    fetchBilibiliZoneFeed,
    fetchBilibiliRecommendations,
    fetchBilibiliPlayUrl,
    fetchBilibiliVideoInfo,
    fetchBilibiliPages,
    fetchBilibiliSubtitle,
    fetchBilibiliSubtitles,
    searchBilibiliVideos,
} from './api';
import { hasRealLyrics, stripPlaceholderLines } from './subtitleFilter';
import { pickSubtitleTracks } from './bilibiliLyrics';
import { buildLyricsFromCues } from './bilibiliLyrics';
import {
    bilibiliArtistId,
    bilibiliBvidOf,
    bilibiliBvidOfVideoCollectionId,
    bilibiliCidOf,
    bilibiliEpIdOf,
    bilibiliMidOfArtistId,
    bilibiliSongId,
    normalizeBilibiliSong,
    normalizeBilibiliEpisode,
} from './bilibiliNormalize';
import { useBilibiliAuthStore } from '../../stores/useBilibiliAuthStore';
import { isBilibiliAvailable, proxyBilibiliStream } from './transport';
import { generateQrCode, pollQrCode, exchangeLogin } from './login';
import { readBilibiliAuthNative, saveBilibiliCookiesNative as bilibiliSaveCookies, clearBilibiliCookiesNative as clearBilibiliCookies } from '../../platform/foliaNative';

// src/services/bilibili/bilibiliProvider.ts
// B 站作为一个平台接进 omni。
//
// 它是一个**视频**平台：推荐页给的是一条条投稿，点开就放那条视频的画面和声音。
// 之所以还做成 provider 而不是另起一套，是因为播放、队列、进度、标题、封面这些
// 设施都在 provider 这一层之后，挂在它下面就不用再写一条平行的播放路径。
//
// 它只提供「推荐、搜索、播放」三件事：
// - 没有歌词（capabilities.lyrics: false）
// - 没有收藏 / 歌单（capabilities.likes / playlistTrackMutations: false）——
//   界面上那颗红心之类的东西读这些开关，所以会自动不出现。
//
// 登录态不是这里管的：useBilibiliAuthStore 自己扫自己的码。登录了就带上 Cookie，
// 推荐接口回的是这个人自己的推荐；没登录回平台默认 —— 同一个接口，不用在这里分叉。

/** 一条投稿 → 一次分页结果。视频搜索没有可靠的「还有下一页」，所以不做翻页。 */
const pageOf = (hits: BilibiliSearchHit[], offset: number): ProviderPage<ReturnType<typeof normalizeBilibiliSong>> => ({
    items: hits.map(hit => normalizeBilibiliSong(hit)),
    hasMore: false,
    nextOffset: offset + hits.length,
});

/**
 * 这一次扫码的二维码。key 和它的内容是同一次请求的两个产物，必须一起留着 ——
 * 再请求一次会得到另一个 key，poll 就对不上了。
 */
let pendingQr: { qrcodeKey: string; url: string } | null = null;

/**
 * 这一站按哪一档去取流。
 *
 * 通用那个音质偏好是给音乐平台听的，默认 high；放到这一站它就是 1080P 的 DASH，
 * 在手机上一放就卡。所以**用户从没动过那个选项**的时候，这里按 720P 走；他自己选过
 * 就照他选的来 —— 不能因为他选了 1080P 又偷偷降回去。
 *
 * 「动过没有」看的是那个键有没有被写过，不是值是多少：写进去一个 high 也是选。
 */
const pickBilibiliQuality = (quality: string): string => {
    try {
        return localStorage.getItem('default_audio_quality') === null ? 'standard' : quality;
    } catch {
        return 'standard';
    }
};

/**
 * 搜到过的季：season_id → 它自己那条记录。
 *
 * 只为一件事：季接口偶尔只认 ep_id，而 ep_id 只在搜索结果里有。点进分集列表时
 * 搜索早就过去了，所以在这里留一份。有上限，翻太多季也不会一直涨。
 */
const seasonsById = new Map<number, BangumiSeason>();

const rememberSeason = (season: BangumiSeason): void => {
    seasonsById.set(season.seasonId, season);
    // 最多留 200 条，超了丢最早的（Map 的插入顺序就是迭代顺序）。
    if (seasonsById.size > 200) {
        const oldest = seasonsById.keys().next();
        if (!oldest.done) seasonsById.delete(oldest.value);
    }
};

/**
 * 歌单名：固定的那几个是词条 key，收藏夹是真名字。
 *
 * 词条在 home 那一组里（和探索页的分区名同一处），查不到就原样返回 —— 收藏夹的
 * 名字是用户起的，不能当成 key 去翻。
 */
const shelfTitle = (title: string): string => {
    const key = `home.${title}`;
    // i18next 查不到时会把 key 原样吐回来，那样就等于没查到。
    const text = i18n.t(key) as string;
    return text === key ? title : text;
};

export const bilibiliProvider: OnlineMusicProvider = {
    id: 'bilibili',
    displayName: 'Bilibili',
    shortName: 'B站',
    mark: { letter: 'B', color: '#fb7299' },

    getAvailability: () => (isBilibiliAvailable()
        ? { configured: true }
        : { configured: false, reason: 'runtime-unavailable' as const }),

    capabilities: {
        search: true,
        playback: true,
        // 视频没有歌词。
        lyrics: false,
        wordByWordLyrics: false,
        // 扫码登录走统一的平台登录设施（见 auth 那一段）：登录了就带 Cookie，
        // 推荐和取流都因此拿到大会员画质。
        auth: true,
        userLibrary: true,
        // 收藏夹 / 稍后再看 / 投稿这些歌单都实现了（library.getUserPlaylists /
        // catalog.getPlaylistTracks）—— 这个开关以前是 false（那时还没写），
        // 首页的「歌单」页签因此一直被禁用（canUsePlaylists = userLibrary &&
        // playlists），用户看到的就是一排灰页签点不动。
        playlists: true,
        albums: true,
        // UP 主按歌手注册：歌手页、封面上的歌手、搜索跳转都用已有的那一套。
        artists: true,
        // 推荐就是首页那一屏。
        // 不提供「推荐」：这一家的首页就是分区，多一个推荐页只会让人多点一次。
        recommendations: false,
        mutations: false,
        // 这两条让界面上的红心 / 收藏入口自动消失。
        likes: false,
        playlistTrackMutations: false,
        explore: true,
        personalFmModes: false,
    },

    normalizeSong(raw) {
        // raw 已经是 BilibiliSearchHit 的形状：进到这里的都经过本文件的两个出口。
        return normalizeBilibiliSong(raw as BilibiliSearchHit);
    },

    /** 点标题打开网页版原视频（长按「在浏览器里打开」用得上）。 */
    getSongPageUrl: song => {
        const bvid = bilibiliBvidOf(song);
        return bvid ? `https://www.bilibili.com/video/${bvid}` : null;
    },

    search: {
        /*
         * 单曲和视频是同一份结果。
         *
         * 这一家搜出来的每条本来就是一条投稿，点开就当一首歌放 —— 所以两档都走这里，
         * 差别只在页签上摆哪个名字。以前单曲那条把**没归一化的搜索结果**直接交给了
         * 分页，界面认不出来，表现就是「视频搜得到、单曲搜不到」。
         */
        async searchSongs(query, limit, offset) {
            if (!query.trim()) return { items: [], hasMore: false, nextOffset: offset };
            const hits = await searchBilibiliVideos(query);
            const window = hits.slice(offset, offset + limit);
            return {
                items: window.map(hit => normalizeBilibiliSong(hit)),
                hasMore: hits.length > offset + limit,
                nextOffset: offset + window.length,
            };
        },

        /*
         * 「视频」那一档。和单曲其实是同一份结果 —— 这一家搜出来的每条本来就是一条投稿，
         * 点开就当一首歌放。分成两档是为了让搜索页那排页签和别处一致（01 视频 / 02 番剧
         * / 03 电影 / 04 用户），而不是另画一套按钮。
         */
        async searchVideos(query, limit, offset) {
            if (!query.trim()) return { items: [], hasMore: false, nextOffset: offset };
            const hits = await searchBilibiliVideos(query);
            const window = hits.slice(offset, offset + limit);
            return {
                items: window.map(hit => normalizeBilibiliSong(hit)),
                hasMore: hits.length > offset + limit,
                nextOffset: offset + window.length,
            };
        },

        /** 「番剧 / 电影」：一季是一个集合，点开是分集（一集一首歌）。 */
        async searchSeasons(query, seasonKind, limit, offset) {
            if (!query.trim()) return { items: [], hasMore: false, nextOffset: offset };
            const seasons = await searchBangumiSeasons(query, seasonKind);
            // 记下这一季（含第一集的 ep_id），点进去时季接口可能会用它。
            seasons.forEach(rememberSeason);
            const window = seasons.slice(offset, offset + limit);
            return {
                items: window.map(season => ({ ...seasonAsCollection(season), type: 'album' as const })),
                hasMore: seasons.length > offset + limit,
                nextOffset: offset + window.length,
            };
        },

        /**
         * 「用户」：搜到一个人，当作**歌手**。
         *
         * UP 主在别处就是这首歌的 artist（参见 normalizeBilibiliSong：投稿的 UP 主
         * 填进 artists），所以这里也按歌手注册 —— 点进去是歌手页，不是一份叫「某某
         * 的投稿」的歌单。已有的歌手页、歌手封面、跳转都用同一套，不必另做一个界面。
         */
        async searchPeople(query, limit, offset) {
            if (!query.trim()) return { items: [], hasMore: false, nextOffset: offset };
            const people = await searchBilibiliUsers(query);
            const window = people.slice(offset, offset + limit);
            return {
                items: window.map(person => ({
                    providerId: 'bilibili' as const,
                    id: bilibiliArtistId(person.mid),
                    name: person.name,
                    type: 'artist' as const,
                    coverUrl: person.avatarUrl || undefined,
                    description: person.sign || undefined,
                    trackCount: person.videoCount,
                })),
                hasMore: people.length > offset + limit,
                nextOffset: offset + window.length,
            };
        },
    },

    auth: {
        /** 登录态直接问原生 CookieManager：凭据在那边，渲染层拿不到也不存。 */
        async getLoginStatus() {
            if (!isBilibiliAvailable()) return null;
            const status = await readBilibiliAuthNative();
            if (!status.signedIn) return null;
            /*
             * 原生那边只知道「有没有 SESSDATA、uid 是谁」。昵称和头像得问 nav ——
             * 拿不到（网络不通、或那个接口正忙）就退回 UID，别因为一个装饰性的
             * 信息就让登录态在界面上整个消失。
             */
            const profile = await fetchBilibiliNavProfile();
            const uid = profile?.uid || status.uid;
            return {
                id: uid || 'bilibili',
                nickname: profile?.nickname || (uid ? `UID ${uid}` : 'Bilibili'),
                avatarUrl: profile?.avatarUrl || undefined,
                vipType: profile?.vip ? 1 : undefined,
            };
        },

        /** 退出：清掉原生那边的那组 cookie。 */
        async logout() {
            await clearBilibiliCookies();
            useBilibiliAuthStore.getState().markSignedOut();
        },

        /** 二维码登录第一步：问 bilibili 要一个 key，同时把它的二维码内容留着。 */
        async startLogin() {
            const code = await generateQrCode();
            // 二维码内容和 key 是同一次请求的两个产物，得一起留着：再请求一次会得到
            // 另一个 key，poll 就对不上了。
            pendingQr = code;
            return code.qrcodeKey;
        },

        /**
         * 第二步：把 key 变成能直接画出来的二维码图。
         *
         * bilibili 给的是二维码的**内容**（一串 URL），不是图；而 omni 这一层约定
         * `createQr` 回的是**能塞进 <img src> 的图**（别的平台回 base64 / data URL）。
         * 所以这里要自己编码一次 —— 直接把内容交出去，界面拿它当 src 就是一格裂图。
         */
        async createQr(key) {
            let content = pendingQr && pendingQr.qrcodeKey === key ? pendingQr.url : '';
            if (!content) {
                // 拿不到那一次的结果（重进面板之类），重新要一张。
                const code = await generateQrCode();
                pendingQr = code;
                content = code.url;
            }
            return QRCode.toDataURL(content, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
        },

        /** 第三步：问一次扫码状态；确认后换出 cookie 落进原生，再读回登录态。 */
        async checkLogin(key) {
            const poll = await pollQrCode(key);
            switch (poll.state) {
                case 'confirmed': {
                    if (!poll.redirectUrl) return { state: 'error', message: 'bilibili 没有给跳转地址' };
                    const exchange = await exchangeLogin(poll.redirectUrl);
                    const saved = await bilibiliSaveCookies(exchange.cookie);
                    if (!saved) return { state: 'error', message: '凭据没能存进设备' };
                    // 顺手把昵称 / 头像 / 大会员取回来：登录窗口和清晰度档位都要用。
                    const profile = await fetchBilibiliNavProfile();
                    useBilibiliAuthStore.getState().markSignedIn(exchange.uid, {
                        nickname: profile?.nickname,
                        avatarUrl: profile?.avatarUrl,
                        isVip: profile?.vip,
                    });
                    return { state: 'confirmed' };
                }
                case 'scanned':
                    return { state: 'scanned' };
                case 'expired':
                    return { state: 'expired' };
                case 'error':
                    return { state: 'error', message: poll.message ?? '' };
                default:
                    return { state: 'waiting' };
            }
        },
    },

    lyrics: {
        /**
         * 这条视频的字幕就是它的歌词。
         *
         * 没有字幕就是没有歌词 —— 这里**不**去找别的平台借一份：B 站视频和别的平台的
         * 歌曲没有对应关系，硬匹配只会给出一份不相干的词（见 provider 头部关于
         * 「自动匹配」的说明）。
         *
         * 中英两条轨都在时，英文那条当翻译（见 bilibiliLyrics.ts）。
         */
        async getLyrics(song) {
            const empty = { lyrics: null, isPureMusic: false };
            const bvid = bilibiliBvidOf(song);
            if (!bvid) return empty;
            try {
                // 字幕不在取流里，得单独问 player/v2（见 fetchBilibiliSubtitles）。
                const cid = bilibiliCidOf(song) ?? (await fetchBilibiliVideoInfo(bvid)).cid;
                const tracks = await fetchBilibiliSubtitles(bvid, cid);
                if (tracks.length === 0) return empty;
                const { primary, secondary } = pickSubtitleTracks(tracks);
                if (!primary?.subtitle_url) return empty;
                const primaryCues = await fetchBilibiliSubtitle(primary.subtitle_url);
                if (primaryCues.length === 0) return empty;
                const secondaryCues = secondary?.subtitle_url
                    ? await fetchBilibiliSubtitle(secondary.subtitle_url).catch(() => [])
                    : [];
                const built = buildLyricsFromCues(primaryCues, secondaryCues, {
                    title: song.name,
                    artist: typeof song.artists?.[0]?.name === 'string' ? song.artists[0].name : undefined,
                });
                if (built.lines.length === 0) return empty;
                /*
                 * 这一家的字幕经常不是歌词：`♪音乐♪`、`[音乐]`、（前奏）这类占位行
                 * 实测很常见，有的整份字幕就那一句。摆上去比没有更糟 —— 屏幕上会
                 * 一直挂着同一句，看着像歌词卡住了。
                 *
                 * 所以先剔掉占位行，剩下的不足两行真歌词就当成「没有字幕」：
                 * 交回 null，上层会去用原来那份歌词来源。
                 */
                const lyrics = stripPlaceholderLines(built);
                if (!hasRealLyrics(lyrics)) return empty;
                // 有译文就把它整段交出去，界面据此显示「翻译」那一栏。
                const translationText = secondaryCues.length > 0
                    ? lyrics.lines.map(line => line.translation ?? '').filter(Boolean).join('\n')
                    : null;
                return {
                    lyrics,
                    mainText: lyrics.lines.map(line => line.fullText).join('\n'),
                    translationText: translationText || null,
                    isPureMusic: false,
                };
            } catch (error) {
                // 字幕取不到不是播放失败：没有歌词而已，别把错抛到播放那边。
                console.warn('[Bilibili] Subtitle read failed', error);
                return empty;
            }
        },
    },

    playback: {
        /*
         * 原生播放器的取流表里没有这一家（它只认识音乐平台那几家），拿不到地址就
         * 一声不出。标了它，Web 会先把地址取好、随队列一起交给原生。
         */
        audioResolvedByWeb: true,
        /*
         * 清晰度档位不能在模块加载时算死。
         *
         * 以前写成 `useBilibiliAuthStore.getState().isVip ? 五档 : 三档` —— provider
         * 模块在登录 hydrate 之前就求值了，那次 getState 拿到的永远是未登录：大会员
         * 也只看到三档，而且之后登录了也不会变。改成 getter，每次界面问都按当下
         * 的登录态算（未登录时接口本来就只给 480P，选了高档会回落，不算说谎）。
         */
        get audioQualityLevels(): readonly ('standard' | 'high' | 'ultra' | 'lossless' | 'hires')[] {
            return useBilibiliAuthStore.getState().isVip
                ? ['standard', 'high', 'ultra', 'lossless', 'hires']
                : ['standard', 'high', 'ultra'];
        },

        /**
         * 这首歌要放什么：取 B 站 DASH 的那条**声音轨**。
         *
         * 画面不从这里走 —— 播放器只认一个音频地址，画面由 BilibiliMvLayer 注入到
         * 视频层里。两端来自同一个投稿，所以进度条、歌词、可视化全都照旧，
         * 不需要音画偏移。
         */
        async getAudioSource(song, quality) {
            /*
             * 番剧分集（`bilibili:ep:<epId>:<cid>`）没有 bvid：取流按 PGC 走，
             * playurl 给 ep_id 而不是 bvid —— 两个接口是同一个，参数不同而已。
             */
            const epId = bilibiliEpIdOf(song);
            const bvid = bilibiliBvidOf(song);
            if (!bvid && !epId) return null;
            // 多P 投稿的每一集都有自己的 cid，取流要用那一集的。
            const cid = bilibiliCidOf(song) ?? (bvid ? (await fetchBilibiliVideoInfo(bvid)).cid : 0);
            if (!cid) return null;
            /*
             * 这一家的「音质」其实是**画质**（画面和声音是一起取的）。
             *
             * 通用那个音质偏好是给音乐平台听的，默认 high，放到这一站就是 1080P 的
             * DASH —— 在手机上一放就卡。没单独选过的话按 720P 走，选过的照选。
             */
            const track = await fetchBilibiliPlayUrl(bvid, cid, quality === 'high' ? 'standard' : quality, epId);
            // 拿不到独立音轨（老投稿只有 durl）时退回那条合成流，画面和声音在一起。
            const candidates = track.audioUrls.length > 0 ? track.audioUrls : track.urls;
            /*
             * 走原生中转。
             *
             * 这一站的取流地址是**一组**候选地址（主地址 + 备用），其中总有几个节点
             * 对某些投稿回 403。直连时抽到坏节点，这首歌就是一声都不出；主地址在名单
             * 里的位置还是随机的。中转由原生按顺序试，403 就换下一台 —— 播放器那边
             * 只看到一个本机地址，不必知道这一层。
             */
            const local = await proxyBilibiliStream(candidates, {
                Referer: 'https://www.bilibili.com/',
                Origin: 'https://www.bilibili.com',
            });
            return {
                url: local ?? (track.audioUrl || track.url),
                fetchedAt: Date.now(),
                quality,
            };
        },

        /** 按 id 取一条投稿的完整信息：推荐列表里的行被点开时用它补全。 */
        async getSongDetail(id) {
            /*
             * 番剧分集没有 bvid，也问不到普通投稿那套信息 —— 它被点开时手里的
             * 标题 / 封面已经全了（normalizeBilibiliEpisode 填好），不必再补，
             * 也补不了。null 会让上层以为是「查无此歌」，所以这里把手里这份直接还回去。
             */
            const epId = bilibiliEpIdOf({ id });
            if (epId) {
                // 手里只有 epId：回一份占位（标题/时长留空，队列里已有的一份才是全的）。
                return normalizeBilibiliEpisode({ epId, title: '', cid: 0, durationSec: 0 }, '');
            }
            const bvid = bilibiliBvidOf({ id });
            if (!bvid) return null;
            const info = await fetchBilibiliVideoInfo(bvid);
            return normalizeBilibiliSong({
                bvid,
                title: info.title,
                author: info.author,
                durationSec: info.durationSec,
                coverUrl: info.coverUrl ?? '',
                playCount: 0,
            });
        },
    },

    explore: {
        /** 探索页也是这一屏推荐：对视频来说「给你推荐」就是唯一的内容面。 */
        /**
         * 推荐页：接口给什么就摆什么，一屏就是一节。
         *
         * 登录了是**自己的**推荐，没登录是平台默认给的 —— 这条差异全在接口那一侧
         * （cookie 由原生带过去），这里不用管。
         */
        async getFeed() {
            /*
             * 探索页 = 这一家的分区。
             *
             * 番剧、电影是「一季 = 一个歌单（点开是分集）」，其余分区是「一条投稿 = 一首歌」，
             * 所以两种 item 混在同一个列表里 —— 界面按 kind 分别摆。
             *
             * 分区一起并发取：一个一个来会让这一页等上好几秒，而每个分区都是独立请求，
             * 谁先回来都不影响别的。取不到的分区直接不摆，而不是把整页判成失败。
             */
            const zoneFeeds = await Promise.all([
                ...BILIBILI_ZONES.map(zone =>
                    fetchBilibiliZoneFeed(zone.rid, 12)
                        .then(hits => ({ id: `zone-${zone.rid}`, titleKey: zone.titleKey, hits }))
                        .catch(() => ({ id: `zone-${zone.rid}`, titleKey: zone.titleKey, hits: [] })),
                ),
                listBangumiSeasons('bangumi')
                    .then(seasons => ({ id: 'bangumi', titleKey: 'zoneBangumi', seasons, hits: [] as BilibiliSearchHit[] }))
                    .catch(() => ({ id: 'bangumi', titleKey: 'zoneBangumi', seasons: [], hits: [] as BilibiliSearchHit[] })),
                listBangumiSeasons('movie')
                    .then(seasons => ({ id: 'movie', titleKey: 'zoneMovie', seasons, hits: [] as BilibiliSearchHit[] }))
                    .catch(() => ({ id: 'movie', titleKey: 'zoneMovie', seasons: [], hits: [] as BilibiliSearchHit[] })),
            ]);

            const asCollection = (season: BangumiSeason): ProviderExploreItem => ({
                kind: 'collection',
                collection: seasonAsCollection(season),
            });

            const sections = zoneFeeds
                .map(entry => {
                    const items: ProviderExploreItem[] = 'seasons' in entry && entry.seasons.length > 0
                        ? entry.seasons.map(asCollection)
                        : entry.hits.map(hit => ({ kind: 'song' as const, song: normalizeBilibiliSong(hit) }));
                    return { id: entry.id, title: entry.titleKey, items };
                })
                .filter(section => section.items.length > 0);

            return { sections, refreshReadsAnew: true };
        },
    },

    /**
     * 账号自己的歌单：收藏夹、稍后再看、投稿、追番追剧、投币、点赞。
     *
     * 每个收藏夹单独一个 —— B 站自己就是这个粒度，合成一个反而找不到东西。
     * 没登录时回空表（这些本来就属于某个人），界面据此显示「先登录」。
     */
    library: {
        async getUserPlaylists() {
            const shelves = await listBilibiliShelves();
            return {
                items: shelves.map(shelf => ({
                    providerId: 'bilibili' as const,
                    // id 带上前缀：曲目要靠它认回来是哪个歌单。
                    id: shelf.id,
                    /*
                     * 收藏夹的名字是用户自己起的，照抄；其余几个是固定的，存的是词条
                     * key（`shelfToview` 之类），在这里就翻成当前语言 —— 摆出去的名字
                     * 不该是变量名。
                     */
                    name: shelfTitle(shelf.title),
                    type: 'playlist' as const,
                    coverUrl: shelf.coverUrl,
                    trackCount: shelf.count,
                })),
                hasMore: false,
                nextOffset: shelves.length,
            };
        },
    },

    /**
     * 番剧季当专辑：一集一首歌。
     *
     * 走 album 那一条是因为它的语义正好对上 —— 一张专辑有一组曲目、有自己的
     * 封面和标题，点开是曲目表。「下一集」于是就是播放器的下一首。
     */
    catalog: {
        async getAlbumDetail(id) {
            const seasonId = Number(id);
            if (!Number.isFinite(seasonId)) return null;
            /*
             * 先问搜索时记下的那份索引（有标题、封面、第一集），索引里没有就**直接
             * 问分集接口**。以前只认索引：探索页点进来的季从没被搜索过，索引里自然
             * 没有 —— 表现就是「点进去专辑是空的」。分集接口反正总要调，它回的分集
             * 同样能拼出这一季的名字和封面。
             */
            const seasons = await listBangumiSeasons('bangumi').catch(() => []);
            const hit = seasons.find(season => season.seasonId === seasonId)
                ?? seasonsById.get(seasonId)
                ?? null;
            if (hit) return seasonAsCollection(hit);
            // 索引里没有：分集接口就是「这一季存不存在」的裁决。
            const episodes = await listBangumiEpisodes(seasonId, null).catch(() => []);
            if (episodes.length === 0) return null;
            return {
                providerId: 'bilibili',
                id: seasonId,
                name: episodes[0].title || `Season ${seasonId}`,
                type: 'album' as const,
            };
        },

        /** 收藏夹等歌单里的曲目。id 就是 library 那边给的 shelf.id。 */
        async getPlaylistTracks(id) {
            /*
             * 「点了歌单没反应」先分清两头：卡片点的动作有没有走到这里、走到了
             * 这里数据给没给出来。这条日志就是给设备上抓现场用的 —— id 是什么、
             * 有没有匹配到 shelf，一眼可判。
             */
            console.info('[Bilibili] getPlaylistTracks asked', String(id));
            /*
             * 「用户」那一档点开的是**某个人的投稿**（id 形如 `user:<mid>`）。
             * 它不在账号自己的歌单列表里（那是自己名下的），所以先认这个前缀。
             */
            const raw = String(id);
            const artistMid = bilibiliMidOfArtistId(raw);
            if (artistMid) {
                const videos = await loadBilibiliUserUploads(artistMid);
                return {
                    items: videos.map(video => normalizeBilibiliSong({
                        bvid: video.bvid,
                        title: video.title,
                        author: video.author,
                        durationSec: video.durationSec,
                        coverUrl: video.coverUrl,
                        playCount: video.playCount,
                    })),
                    hasMore: false,
                    nextOffset: videos.length,
                };
            }
            const shelves = await listBilibiliShelves();
            const shelf = shelves.find(item => item.id === raw);
            if (!shelf) {
                console.info('[Bilibili] getPlaylistTracks: no shelf matched', raw,
                    'have:', shelves.map(s => s.id).join(','));
                return { items: [], hasMore: false, nextOffset: 0 };
            }
            const videos = await shelf.load();
            console.info('[Bilibili] getPlaylistTracks: shelf loaded', raw, videos.length, 'items');
            return {
                items: videos.map(video => {
                    /*
                     * 追番 / 追剧摊平出来的条目 bvid 是 `ep:<epId>`：它是番剧分集，
                     * 没有 bvid —— 按分集转成歌（取流走 ep_id 那条路）。
                     */
                    if (video.bvid.startsWith('ep:')) {
                        const epId = Number(video.bvid.slice('ep:'.length));
                        return Number.isFinite(epId) && epId > 0
                            ? normalizeBilibiliEpisode(
                                { epId, title: video.title, cid: video.cid ?? 0, durationSec: video.durationSec },
                                video.author,
                                video.coverUrl,
                            )
                            : normalizeBilibiliSong({
                                bvid: video.bvid,
                                title: video.title,
                                author: video.author,
                                durationSec: video.durationSec,
                                coverUrl: video.coverUrl,
                                playCount: video.playCount,
                            });
                    }
                    return normalizeBilibiliSong({
                        bvid: video.bvid,
                        title: video.title,
                        author: video.author,
                        durationSec: video.durationSec,
                        coverUrl: video.coverUrl,
                        playCount: video.playCount,
                    });
                }),
                hasMore: false,
                nextOffset: videos.length,
            };
        },

        /**
         * 歌手页的「全部歌曲」：一个 UP 主名下的投稿。
         *
         * UP 主在这家就是这首歌的歌手（投稿的 author 填进 artists），所以歌手页
         * 直接给投稿列表 —— 和音乐平台的歌手页是同一个东西，不另做界面。
         */
        async getArtistSongs(id) {
            const mid = bilibiliMidOfArtistId(id);
            if (!mid) return { items: [], hasMore: false, nextOffset: 0 };
            const videos = await loadBilibiliUserUploads(mid);
            return {
                items: videos.map(video => normalizeBilibiliSong({
                    bvid: video.bvid,
                    title: video.title,
                    author: video.author,
                    durationSec: video.durationSec,
                    coverUrl: video.coverUrl,
                    playCount: video.playCount,
                })),
                hasMore: false,
                nextOffset: videos.length,
            };
        },

        /**
         * 歌手页的「专辑」那一栏。
         *
         * 这一家没有专辑这个概念（投稿就是投稿），所以诚实地回空：页面上那一栏
         * 不出现，比摆一堆假专辑好。
         */
        async getArtistAlbums() {
            return { items: [], hasMore: false, nextOffset: 0 };
        },

        /** 歌手页的表头：名字、头像、简介。 */
        async getArtistDetail(id) {
            const mid = bilibiliMidOfArtistId(id);
            if (!mid) return null;
            const profile = await fetchBilibiliUserProfile(mid);
            if (!profile) return null;
            /*
             * 投稿数一并带回去：歌手页的表头就是读这个显示「共 N 首」的。
             *
             * 没有它，页面只能显示成 0 —— 数据其实拿得到，只是没往上传。
             * 取不到就留 undefined，让界面照旧不显示，而不是写一个 0。
             */
            const uploads = await loadBilibiliUserUploads(mid);
            return {
                providerId: 'bilibili' as const,
                id: bilibiliArtistId(mid),
                name: profile.name,
                type: 'artist' as const,
                coverUrl: profile.avatarUrl || undefined,
                description: profile.sign || undefined,
                trackCount: uploads.length > 0 ? uploads.length : undefined,
            };
        },

        async getAlbumTracks(id, limit = 100, offset = 0) {
            /*
             * 分P 专辑（`bilibili:video:<bvid>`）：一条投稿的全部分P，一P 一首歌。
             *
             * 搜索结果行里的专辑名点进来就是这里 —— KKk 的「分P 面板」在这边的对应物。
             * KKk 是解析一条链接后弹面板选 P；这边是同样的东西换了个入口：点开专辑，
             * 分P 列表就是选 P 的面板，选一P 放一P。
             */
            const videoBvid = bilibiliBvidOfVideoCollectionId(String(id));
            if (videoBvid) {
                const info = await fetchBilibiliPages(videoBvid);
                const hit: BilibiliSearchHit = {
                    bvid: videoBvid,
                    title: info.title,
                    author: info.author,
                    durationSec: 0,
                    coverUrl: info.coverUrl,
                    playCount: 0,
                };
                const page = info.pages.slice(offset, offset + limit);
                return {
                    items: page.map(p => normalizeBilibiliSong(hit, p)),
                    hasMore: offset + limit < info.pages.length,
                    nextOffset: offset + limit,
                };
            }

            const seasonId = Number(id);
            if (!Number.isFinite(seasonId)) return { items: [], hasMore: false, nextOffset: 0 };
            /*
             * 两条路都试：season_id 与 ep_id。这一家的季接口偶尔只认其中一条，
             * 单走 season_id 时会是空列表 —— 表现就是「点进番剧是零首」。
             *
             * ep_id 从搜索时带回来的第一集拿；拿不到就只用 season_id。
             */
            const season = seasonsById.get(seasonId);
            const episodes = await listBangumiEpisodes(seasonId, season?.firstEpId ?? null);
            // 设备上抓现场用：分集数与走的参数，一眼判断「零首」卡在哪一层。
            console.info('[Bilibili] getAlbumTracks', seasonId,
                'firstEpId:', season?.firstEpId ?? null,
                'episodes:', episodes.length);
            /*
             * 一集一首歌，按分集自己的 id 走（`bilibili:ep:<epId>:<cid>`）。
             *
             * 以前这里走 normalizeBilibiliSong：那一条要求 bvid，而番剧（PGC）的
             * 分集**没有 bvid** —— 正片全部被丢掉，就算分集列表拉到了也摆不出来，
             * 用户看到的就是「第几集解析不出来」。取流见 getAudioSource 里的 ep 分支。
             */
            const title = season?.title ?? episodes[0]?.title ?? `Season ${seasonId}`;
            const cover = season?.coverUrl ?? '';
            const page = episodes.slice(offset, offset + limit);
            return {
                items: page.map(episode => normalizeBilibiliEpisode(episode, title, cover)),
                hasMore: offset + limit < episodes.length,
                nextOffset: offset + limit,
            };
        },
    },
};

/** 一季 → 应用里的一个「专辑」（点开是分集列表）。 */
const seasonAsCollection = (season: BangumiSeason): ProviderCollection => ({
    providerId: 'bilibili',
    id: season.seasonId,
    name: season.title,
    type: 'album',
    coverUrl: season.coverUrl || undefined,
    description: season.indexShow || undefined,
});

/** 这个 id 是不是本平台的。别的模块拿它判「要不要走视频那条路」。 */
export const isBilibiliSongId = (id: string | number | null | undefined): boolean => (
    String(id ?? '').startsWith('bilibili:')
);

export { bilibiliSongId };
