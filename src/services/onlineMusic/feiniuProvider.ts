import type {
    LoginMethod,
    OnlineMusicProvider,
    OnlinePlaybackReportProvider,
    ProviderAudioSource,
    ProviderCollection,
} from '../../types/onlineMusic';
import type { SongResult } from '../../types';
import { OnlineProviderError } from '../../types/onlineMusic';
import { createProviderSongMetadata } from '../../utils/songMetadata';
import { getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { proxyNativeRemoteAudioUrl } from '../nativeRemoteAudio';
import {
    clearFeiniuSession,
    feiniuPasswordLogin,
    feiniuRequest,
    pickFeiniuList,
    pickFeiniuTotal,
    feiniuStreamUrl,
    getFeiniuDeviceId,
    feiniuResourceHeaders,
    getFeiniuServerUrl,
    getFeiniuTransportAvailability,
    feiniuFnIdFromServerUrl,
    feiniuServerUrlFromFnId,
    readFeiniuUser,
    rememberFeiniuUser,
    syncFeiniuGatewayCredentials,
} from './feiniuTransport';
import { feiniuPage, normalizeFeiniuCollection, normalizeFeiniuSong, normalizeFeiniuUser } from './feiniuNormalize';
import { backfillSongCovers } from './onlineCoverFallback';
import { feiniuAlbumPage, feiniuArtistPage, feiniuCatalog, feiniuTrackDetail } from './feiniuCatalog';
import { feiniuLibrary, feiniuPlayHistory } from './feiniuLibrary';
import { feiniuMutations, reportFeiniuPlayback } from './feiniuMutations';
import { parseFeiniuLyrics, pickFeiniuLyricText, type FeiniuLyricPayload } from './feiniuLyrics';

// src/services/onlineMusic/feiniuProvider.ts
// 飞牛（FNOS）音乐：用户自己的 NAS 上跑的那套音乐服务。与其它 provider 最大的两点不同：
//   1. 没有二维码登录，只有用户名 + 密码（外加服务器地址，因为地址每家都不一样）；
//   2. 没有中间的 API 服务器，前端直连 NAS，凭据靠一个 `music-token` Cookie。

const mediaIdOf = (song: SongResult): string => {
    const source = getPlaybackSourceRef(song);
    if (source.kind !== 'online' || source.providerId !== 'feiniu') {
        throw new OnlineProviderError('unsupported', 'Song does not belong to FeiNiu', 'feiniu');
    }
    return String(source.mediaId);
};

const playbackReports: OnlinePlaybackReportProvider = {
    async reportPlayback(song) {
        await reportFeiniuPlayback(song);
    },
};

/**
 * 登录飞牛的两种方式：连的是同一套账号，区别只在「 NAS 在哪、你怎么找到它」。
 *
 * - `fnid`：FN ID —— 飞牛给这台 NAS 的远程访问 ID，App 只要它就能拼出地址
 *   （`abcd1234` → `https://abcd1234.fnid.cc`），人在外面也能连回家；
 * - `server`：局域网地址 —— 自己手写 `IP:端口`（默认 5666），人在家里用。
 *
 * 两种方式最后都要用户名 + 密码。
 */
const FEINIU_LOGIN_METHODS: LoginMethod[] = [
    { id: 'fnid', labelKey: 'home.loginMethodFeiniuFnid', iconKey: 'feiniu', passwordField: { labelKey: 'home.loginFeiniuFnId', placeholderKey: 'home.loginFeiniuFnIdPlaceholder' } },
    { id: 'server', labelKey: 'home.loginMethodFeiniuServer', iconKey: 'feiniu', passwordField: { labelKey: 'home.loginServerUrl', placeholderKey: 'home.loginServerUrlPlaceholder' } },
];

/** 选了哪一种就把第一栏填的东西翻译成地址：「填 ID」的那一种要拼域名，另一种照原样。 */
const serverUrlForMethod = (methodId: string | null | undefined, raw: string | undefined): string | undefined => (
    methodId === 'fnid' ? feiniuServerUrlFromFnId(raw ?? '') : raw
);

export const feiniuProvider: OnlineMusicProvider = {
    id: 'feiniu',
    displayName: '飞牛音乐',
    shortName: '飞牛',
    getAvailability: getFeiniuTransportAvailability,
    capabilities: {
        search: true, playback: true, lyrics: true, wordByWordLyrics: false, auth: true,
        playlists: true, albums: true, artists: true, recommendations: true,
        userLibrary: true, userAlbums: true, likes: true, mutations: true,
        playlistTrackMutations: true, playbackReports: true,
        passwordLogin: true, passwordLoginServerUrl: true,
    },
    mark: { letter: '飞', color: '#0ea5e9' },
    normalizeSong: normalizeFeiniuSong,
    normalizeUser: normalizeFeiniuUser,
    normalizeCollection: normalizeFeiniuCollection,
    songMetadata: { getSongMetadata: createProviderSongMetadata },

    search: {
        async searchSongs(query, limit, offset) {
            if (!query.trim()) return feiniuPage([], 0, offset, limit);
            const page = Math.floor(offset / limit) + 1;
            const skip = offset % limit;
            const size = Math.min(limit + skip, 300);
            const data = await feiniuRequest<unknown>('/search/track', {
                query: { q: query, page, size },
            });
            const all = pickFeiniuList(data);
            const songs = await backfillSongCovers(all.slice(skip, skip + limit).map(normalizeFeiniuSong));
            return feiniuPage(songs, pickFeiniuTotal(data), offset, limit);
        },
    },

    playback: {
        async getSongDetail(id) {
            return feiniuTrackDetail(id);
        },
        async getAudioSource(song) {
            const guid = mediaIdOf(song);
            const url = feiniuStreamUrl(guid);
            if (!url) throw new OnlineProviderError('unavailable', 'FeiNiu server address is not configured', 'feiniu');
            // 飞牛的音频流只认 `Cookie: music-token=...`，而 <audio> 加不了请求头 ——
            // 真机上交给原生回环服务代转（它把 Cookie 带上再转发），别的平台原样直连。
            // 地址是用户自己填的，不在原生那张 CDN 白名单里，所以要显式放行。
            const proxied = await proxyNativeRemoteAudioUrl(url, {
                headers: feiniuResourceHeaders() ?? undefined,
                allowAnyHost: true,
            });
            const source: ProviderAudioSource = {
                url: proxied || url,
                fetchedAt: Date.now(),
                quality: 'lossless',
            };
            return source;
        },
        getAvailability(song) {
            const source = getPlaybackSourceRef(song);
            const unavailable = source.kind === 'online' && source.providerData?.unavailable === true;
            return unavailable ? { state: 'unavailable' } : { state: 'unknown' };
        },
    },

    lyrics: {
        async getLyrics(song) {
            const guid = mediaIdOf(song);
            const data = await feiniuRequest<FeiniuLyricPayload>('/lyric/list', { query: { trackGUID: guid } });
            return parseFeiniuLyrics(pickFeiniuLyricText(data));
        },
    },

    auth: {
        getLoginTexts: () => ({ title: 'home.loginTitleFeiniu', note: 'home.loginNoteFeiniu' }),
        async getLoginStatus() {
            const user = readFeiniuUser();
            // 没填过地址就是没登录，别把「地址缺失」报成一次刷新失败。
            if (!user || !getFeiniuServerUrl()) return null;
            try {
                // 没有专门的「我是谁」接口：取一页曲目顺带验一下 token 还认不认。
                await feiniuRequest('/track/list', { query: { page: 1, size: 1 } });
            } catch (error) {
                if (error instanceof OnlineProviderError && error.code === 'auth-required') {
                    clearFeiniuSession();
                    return null;
                }
                // 网络抖动不该把一次本来好着的登录判成掉线，照旧认为在线。
            }
            return user;
        },
        async logout() {
            clearFeiniuSession();
        },
        async loginWithPassword({ username, password, serverUrl, methodId }) {
            const data = await feiniuPasswordLogin(username, password, serverUrlForMethod(methodId, serverUrl));
            const user = normalizeFeiniuUser(data);
            rememberFeiniuUser(user);
            return user;
        },
        getLoginMethods: () => FEINIU_LOGIN_METHODS,
        /**
         * 上次填过的第一栏预填进表单：登出不清地址，重登时少填一项。
         * 按方式分开：「填 ID」那一种只认上次的 FN ID（上次填的是 IP 就别往那栏里塞），反之同理。
         */
        getPasswordLoginDefaults: (methodId) => {
            const last = getFeiniuServerUrl();
            return methodId === 'fnid' ? { serverUrl: feiniuFnIdFromServerUrl(last) } : { serverUrl: last };
        },
    },

    catalog: feiniuCatalog,
    library: feiniuLibrary,
    mutations: feiniuMutations,
    playbackReports,

    recommendations: {
        /** 飞牛的「漫游」就是随机播放；每次开一轮新的。 */
        async getPersonalFm() {
            try {
                const data = await feiniuRequest<{ current?: { track?: unknown }; next?: { track?: unknown } }>(
                    '/track/roam-start',
                    { query: { deviceId: getFeiniuDeviceId() } },
                );
                const tracks = [data?.current?.track, data?.next?.track].filter(Boolean) as unknown[];
                return backfillSongCovers(tracks.map(normalizeFeiniuSong), 2);
            } catch {
                return [];
            }
        },
        /** 自建服务没有「推荐歌单」这回事，拿用户的歌单顶上。 */
        async getRecommendedCollections(limit) {
            try {
                const data = await feiniuRequest<unknown>('/playlist/list', { query: { page: 1, size: limit } });
                return pickFeiniuList(data).map(item => normalizeFeiniuCollection(item, 'playlist'));
            } catch {
                return [] as ProviderCollection[];
            }
        },
        async getHistorySongs() {
            try {
                return await feiniuPlayHistory(100);
            } catch {
                return [];
            }
        },
    },

    /*
     * 原生兜底切歌要自己拼取流地址与 Cookie，地址和登录态都得推过去。
     *
     * 由这里实现而不是让 hook 直接调 feiniuTransport：按依赖方向 hooks 只该经过 omni
     * （见 docs/CODEMAP.md 的分层边界）。
     */
    nativeGateway: {
        syncCredentials: () => syncFeiniuGatewayCredentials(),
    },
};

/** 专辑 / 歌手页用的列表（首页外壳不走 omni 的推荐接口时直接调它）。 */
export { feiniuAlbumPage, feiniuArtistPage };
