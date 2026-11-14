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
    readFeiniuUser,
    rememberFeiniuUser,
    syncFeiniuGatewayCredentials,
} from './feiniuTransport';
import { feiniuServerUrlForLoginInput } from './feiniuLoginInput';
import { feiniuPage, normalizeFeiniuCollection, normalizeFeiniuSong, normalizeFeiniuUser } from './feiniuNormalize';
import { backfillSongCovers, prewarmCollectionCovers, resolveProxiedCollectionCover } from './onlineCoverFallback';
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
 * 飞牛只有一个登录入口。
 *
 * 「NAS 在哪」对用户来说是同一件事：人在外面记得住 FN ID，人在家里抄得到 IP，
 * 但**用户不该先判断自己在哪种网络里**再挑一个入口 —— 挑错的代价是「连不上」，
 * 而那句话对两种错法一模一样。所以第一栏收两种写法，由 `feiniuServerUrlFromFnId`
 * 认：一串不带点的短码当 FN ID 拼中继域名（`abcd1234` → `https://abcd1234.fnos.net`），
 * 带点的一律当地址（`nas.lan:5666`）照原样走局域网直连。
 *
 * 没有方式可选的平台走的是「一张表单」那条路（`enterPasswordStage(..., null, ...)`）：
 * 不出现方式选择器，点进来直接是账号 + 密码。
 */
const FEINIU_LOGIN_METHODS: LoginMethod[] = [];

// 第一栏填的东西怎么变成地址（含「短码当 FN ID」的判定）抽到了 ./feiniuLoginInput，
// 这样这段「两个口合一」的逻辑能脱离整个 provider 图单独测试。

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
        // 方式已经合成一个口，methodId 不再参与判断：第一栏填什么，就按内容认。
        async loginWithPassword({ username, password, serverUrl }) {
            const data = await feiniuPasswordLogin(username, password, feiniuServerUrlForLoginInput(serverUrl));
            const user = normalizeFeiniuUser(data);
            rememberFeiniuUser(user);
            return user;
        },
        getLoginMethods: () => FEINIU_LOGIN_METHODS,
        /**
         * 表单式登录的声明。
         *
         * 这一项是**必需的**：登录窗口按 `omni.getLoginForm(providerId)` 有没有返回值决定走哪一幕
         * （见 login/window/loginView.ts 里 `lead === 'sign-in' && omni.getLoginForm(providerId)` 那行）。
         * 没有它就落到扫码那一幕 —— 飞牛根本没有二维码，扫的框里永远等不来东西。本 fork 早先
         * 靠 dev 自己那条 `'password'` 场景撑住，合并到上游 v0.7.26 后被表单式取代，所以声明要补上。
         *
         * 字段与 `FEINIU_LOGIN_METHODS` 为空这件事是一回事：NAS 在哪对用户是同一件事，第一栏
         * 由内容自己认（短码 / IP:端口 / 整条 URL），不再先选一种登录方式。
         */
        getLoginForm: () => ({
            fields: [
                { key: 'serverUrl', type: 'url', labelKey: 'fnmusic.serverUrl', placeholderKey: 'fnmusic.serverUrlPlaceholder', required: true },
                { key: 'username', type: 'text', labelKey: 'fnmusic.username', placeholderKey: 'fnmusic.usernamePlaceholder', required: true },
                { key: 'password', type: 'password', labelKey: 'fnmusic.password', required: true },
            ],
            submitLabelKey: 'fnmusic.login',
            noteKey: 'fnmusic.loginNote',
            errorKeys: {
                'auth-required': 'fnmusic.errorBadCredentials',
                network: 'fnmusic.errorNetwork',
                'invalid-response': 'fnmusic.errorBadResponse',
            },
        }),
        /**
         * 表单提交：与 `loginWithPassword` 同一条路，只是值从表单来。
         * 第一栏照样过 `feiniuServerUrlForLoginInput`（短码 → 中继域名），所以填什么都认得。
         */
        async submitLoginForm(values) {
            const data = await feiniuPasswordLogin(
                String(values.username ?? ''),
                String(values.password ?? ''),
                feiniuServerUrlForLoginInput(String(values.serverUrl ?? '')),
            );
            const user = normalizeFeiniuUser(data);
            rememberFeiniuUser(user);
            return user;
        },
        /**
         * 上次填过的第一栏预填进表单：登出不清地址，重登时少填一项。
         *
         * 中继的地址落盘时是整条 `https://abcd1234.fnos.net`，但用户当初填的是短码 ——
         * 还他短码：一栏里那一串 URL 会让人以为要粘贴地址，而短码就是他记得住的那个东西。
         * 认不出 FN ID 的（IP 地址）原样填回去。
         */
        getPasswordLoginDefaults: () => {
            const last = getFeiniuServerUrl();
            return { serverUrl: feiniuFnIdFromServerUrl(last) || last };
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
                const items = pickFeiniuList(data).map(item => normalizeFeiniuCollection(item, 'playlist'));
                // 电台页签的卡片走这条出口（feiniuLibrary 那两处修不到它，issue #204 的漏网）：
                // 与歌单 / 专辑列表同一趟 —— 先预热成代理地址，渲染层兜底不广播，靠出口首屏就有图。
                await prewarmCollectionCovers(items.map(item => item.coverUrl));
                return items.map(item => ({ ...item, coverUrl: resolveProxiedCollectionCover(item.coverUrl) }));
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
