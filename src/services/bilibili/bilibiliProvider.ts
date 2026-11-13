import type { OnlineMusicProvider, ProviderPage } from '../../types/onlineMusic';
import type { BilibiliSearchHit } from '../../types/bilibili';
import {
    fetchBilibiliRecommendations,
    fetchBilibiliPlayUrl,
    fetchBilibiliVideoInfo,
    searchBilibiliVideos,
} from './api';
import { bilibiliBvidOf, bilibiliSongId, normalizeBilibiliSong } from './bilibiliNormalize';
import { useBilibiliAuthStore } from '../../stores/useBilibiliAuthStore';
import { isBilibiliAvailable } from './transport';
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
    items: hits.map(normalizeBilibiliSong),
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
        userLibrary: false,
        playlists: false,
        albums: false,
        artists: false,
        // 推荐就是首页那一屏。
        recommendations: true,
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
            return { id: status.uid || 'bilibili', nickname: status.uid ? `UID ${status.uid}` : 'Bilibili' };
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
         * 第二步：把 key 变成能画出来的二维码内容。
         *
         * bilibili 这里给的是可以直接编码的 URL（不是图片），界面自己画码。
         */
        async createQr(key) {
            if (pendingQr && pendingQr.qrcodeKey === key) return pendingQr.url;
            // 拿不到那一次的结果（重进面板之类），重新要一张。
            const code = await generateQrCode();
            pendingQr = code;
            return code.url;
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
            const info = await fetchBilibiliVideoInfo(bvid);
            const track = await fetchBilibiliPlayUrl(bvid, info.cid, quality);
            // 拿不到独立音轨（老投稿只有 durl）时退回那条合成流，画面和声音在一起。
            return {
                url: track.audioUrl || track.url,
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

    recommendations: {
        /** 首页推荐。登录了就带 Cookie，B 站自己会回个性化内容。 */
        async getDailySongs() {
            const hits = await fetchBilibiliRecommendations();
            return hits.map(normalizeBilibiliSong);
        },
        async getRecommendedCollections() {
            // 投稿没有「歌单 / 专辑」这种集合，推荐页只给一排视频。
            return [];
        },
    },

    explore: {
        /** 探索页也是这一屏推荐：对视频来说「给你推荐」就是唯一的内容面。 */
        async getHome() {
            const hits = await fetchBilibiliRecommendations();
            return { sections: [{ id: 'recommend', songs: hits.map(normalizeBilibiliSong) }] };
        },
    } as never,
};

/** 这个 id 是不是本平台的。别的模块拿它判「要不要走视频那条路」。 */
export const isBilibiliSongId = (id: string | number | null | undefined): boolean => (
    String(id ?? '').startsWith('bilibili:')
);

export { bilibiliSongId };
