import type { OnlineMusicProvider, ProviderCollection, ProviderExploreItem, ProviderPage } from '../../types/onlineMusic';
import { listBilibiliShelves } from './library';
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
    fetchBilibiliSubtitle,
    fetchBilibiliSubtitles,
    searchBilibiliVideos,
} from './api';
import { pickSubtitleTracks } from './bilibiliLyrics';
import { buildLyricsFromCues } from './bilibiliLyrics';
import { bilibiliBvidOf, bilibiliCidOf, bilibiliSongId, normalizeBilibiliSong } from './bilibiliNormalize';
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
        playlists: false,
        albums: true,
        artists: false,
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
        async searchSongs(query, limit, offset) {
            if (!query.trim()) return { items: [], hasMore: false, nextOffset: offset };
            const hits = await searchBilibiliVideos(query);
            // 搜索接口一次给一批，这里按 limit 切，保持和其它平台一样的契约。
            return pageOf(hits.slice(offset, offset + limit), offset);
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
                    useBilibiliAuthStore.getState().markSignedIn(exchange.uid);
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
                const lyrics = buildLyricsFromCues(primaryCues, secondaryCues, {
                    title: song.name,
                    artist: typeof song.artists?.[0]?.name === 'string' ? song.artists[0].name : undefined,
                });
                if (lyrics.lines.length === 0) return empty;
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
        // 只声明三档：对视频来说这三个就是 480P / 720P / 1080P（未登录上限 480P）。
        // 界面上这几档会显示成清晰度而不是音质（见 AccountTab 的 VIDEO_QUALITY_LABEL_KEYS）。
        audioQualityLevels: ['standard', 'high', 'ultra'],

        /**
         * 这首歌要放什么：取 B 站 DASH 的那条**声音轨**。
         *
         * 画面不从这里走 —— 播放器只认一个音频地址，画面由 BilibiliMvLayer 注入到
         * 视频层里。两端来自同一个投稿，所以进度条、歌词、可视化全都照旧，
         * 不需要音画偏移。
         */
        async getAudioSource(song, quality) {
            const bvid = bilibiliBvidOf(song);
            if (!bvid) return null;
            // 多P 投稿的每一集都有自己的 cid，取流要用那一集的。
            const cid = bilibiliCidOf(song) ?? (await fetchBilibiliVideoInfo(bvid)).cid;
            const track = await fetchBilibiliPlayUrl(bvid, cid, quality);
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
                        .then(hits => ({ id: `zone-${zone.rid}`, title: zone.title, hits }))
                        .catch(() => ({ id: `zone-${zone.rid}`, title: zone.title, hits: [] })),
                ),
                listBangumiSeasons('bangumi')
                    .then(seasons => ({ id: 'bangumi', title: '番剧', seasons, hits: [] as BilibiliSearchHit[] }))
                    .catch(() => ({ id: 'bangumi', title: '番剧', seasons: [], hits: [] as BilibiliSearchHit[] })),
                listBangumiSeasons('movie')
                    .then(seasons => ({ id: 'movie', title: '电影', seasons, hits: [] as BilibiliSearchHit[] }))
                    .catch(() => ({ id: 'movie', title: '电影', seasons: [], hits: [] as BilibiliSearchHit[] })),
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
                    return { id: entry.id, title: entry.title, items };
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
                    name: shelf.title,
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
            const seasons = await listBangumiSeasons('bangumi').catch(() => []);
            const hit = seasons.find(season => season.seasonId === seasonId);
            if (!hit) return null;
            return seasonAsCollection(hit);
        },

        /** 收藏夹等歌单里的曲目。id 就是 library 那边给的 shelf.id。 */
        async getPlaylistTracks(id) {
            const shelves = await listBilibiliShelves();
            const shelf = shelves.find(item => item.id === String(id));
            if (!shelf) return { items: [], hasMore: false, nextOffset: 0 };
            const videos = await shelf.load();
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

        async getAlbumTracks(id, limit = 100, offset = 0) {
            const seasonId = Number(id);
            if (!Number.isFinite(seasonId)) return { items: [], hasMore: false, nextOffset: 0 };
            const episodes = await listBangumiEpisodes(seasonId);
            const artist = 'B站';
            const page = episodes.slice(offset, offset + limit);
            return {
                items: page.map(episode => normalizeBilibiliSong(
                    {
                        bvid: episode.bvid,
                        title: episode.title,
                        author: artist,
                        durationSec: episode.durationSec,
                        coverUrl: '',
                        playCount: 0,
                    },
                    { cid: episode.cid, title: episode.title, durationSec: episode.durationSec },
                )),
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
