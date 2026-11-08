// src/services/onlineMusic/lxmusic/lxPublicApi.ts
//
// 洛雪的「平台侧」：直接读各家公开接口，把搜索结果、歌单广场、排行榜取回来。
//
// 为什么不用 folia 自带的 provider：那些 provider 是围绕「登录态 + 自建 API」写的，安卓上没有
// 自建服务，未登录时路径会断在 CORS / 401 上；而 LX 客户端用的是各家网页端那套公开接口，
// 不需要任何账号。这里照同一套接口实现，于是「导入音源之前」也能搜、能看歌单与榜单。
//
// 网络：地址一律过 resolveProxiedUrl——安卓上这些主机由原生 OkHttp 桥接管（不受 CORS 约束），
// 网页端交给本地 lyric-proxy 转发。所有接口都是 GET。

import { resolveProxiedUrl } from '../../proxiedUrl';
import { hasNativeHttp, nativeHttpRequest } from '../../nativeAndroidBridge';

export type LxPublicPlatform = 'wy' | 'kg' | 'kw' | 'tx';

export const LX_PUBLIC_PLATFORMS: ReadonlyArray<{ key: LxPublicPlatform; label: string; color: string }> = [
    { key: 'wy', label: '网易云', color: '#dc2626' },
    { key: 'tx', label: 'QQ音乐', color: '#16a34a' },
    { key: 'kg', label: '酷狗', color: '#2563eb' },
    { key: 'kw', label: '酷我', color: '#f59e0b' },
];

export const LX_PUBLIC_PLATFORM_KEYS: readonly LxPublicPlatform[] = LX_PUBLIC_PLATFORMS.map((p) => p.key);

export type LxApiArtist = { id?: string; name: string };

export type LxApiSong = {
    platform: LxPublicPlatform;
    id: string;
    name: string;
    artists: LxApiArtist[];
    album: { id?: string; name: string; coverUrl?: string };
    durationMs: number;
    coverUrl?: string;
};

export type LxApiCollection = {
    platform: LxPublicPlatform;
    id: string;
    name: string;
    kind: 'playlist' | 'album';
    coverUrl?: string;
    description?: string;
    trackCount?: number;
    playCount?: number;
    creatorName?: string;
    updatedAt?: number;
};

export type LxApiChart = {
    platform: LxPublicPlatform;
    id: string;
    name: string;
    coverUrl?: string;
    description?: string;
};

/** 电台节目：名字与封面是节目的，`song` 是真正能播的那首（网易云主音轨）。 */
export type LxApiRadioProgram = {
    platform: LxPublicPlatform;
    id: string;
    name: string;
    coverUrl?: string;
    djName?: string;
    description?: string;
    song: LxApiSong;
};

export type LxApiPage<T> = { items: T[]; hasMore: boolean };

// ---------------------------------------------------------------- 基础工具

type Raw = Record<string, any>;

const asRecord = (value: unknown): Raw | null => (value && typeof value === 'object' ? value as Raw : null);

const asArray = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter((v): v is Raw => Boolean(asRecord(v))) : []);

const pick = <T>(record: Raw | null | undefined, ...keys: string[]): T | undefined => {
    for (const key of keys) {
        const value = record?.[key];
        if (value !== undefined && value !== null && value !== '') return value as T;
    }
    return undefined;
};

const toText = (value: unknown): string => (value == null ? '' : String(value)).trim();

/** 酷我的标题里带 `&nbsp;` 这类实体，酷狗会带 `<em>` 高亮标签：一起清掉。 */
const decodeEntities = (value: string): string => value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');

const stripTags = (value: unknown): string => decodeEntities(toText(value).replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

const toNumber = (value: unknown): number => {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
};

/**
 * 封面地址统一成能直接给 <img> 的 https 绝对地址：
 * 酷狗带 `{size}` 模板、协议相对地址 `//`、还有 `http://`（App 里是 https 页面，混内容会被拦）。
 */
const normalizeCover = (value: unknown, size = 240): string | undefined => {
    const raw = toText(value);
    if (!raw) return undefined;
    const sized = raw.replace('{size}', String(size));
    if (sized.startsWith('//')) return `https:${sized}`;
    if (/^http:\/\//i.test(sized)) return `https://${sized.slice('http://'.length)}`;
    return sized;
};

// 酷我封面 CDN 的路径前缀；短路径 `120/85/1/4091887608.jpg` 拼在 albumcover 下面。
const KUWO_COVER_BASE = 'https://img1.kuwo.cn/star/albumcover/';
const KUWO_COVER_SHORT_PATH = /^\d+\/[\w.-]+\/[\w.-]+\/[\w.-]+\.(?:jpe?g|png|webp)$/i;

/**
 * 酷我的搜索接口经常只给 `120/85/1/4091887608.jpg` 这种相对短路径，直接塞进 <img> 会当成
 * 页面内的相对文件去取（一定 404），还曾在启动自检里被当成「资源加载失败」整屏挡住。
 */
const normalizeKuwoCover = (value: unknown, size = 240): string | undefined => {
    const raw = toText(value);
    if (!raw) return undefined;
    const path = raw.replace(/^\/+/, '');
    if (/^star\//i.test(path) && !/^https?:/i.test(raw)) return `https://img1.kuwo.cn/${path}`;
    if (KUWO_COVER_SHORT_PATH.test(path)) return `${KUWO_COVER_BASE}${path}`;
    return normalizeCover(raw, size);
};

const splitArtists = (value: unknown): LxApiArtist[] => toText(value)
    .split(/[、,&/]| feat\.? /i)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name }));

/** 酷我 r.s 返回的是单引号 JSON；解析失败时退一步把它们换成双引号再试。 */
export const parseLooseJson = (text: string): unknown => {
    const trimmed = text.trim().replace(/^\uFEFF/, '');
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        // 继续往下试
    }
    try {
        return JSON.parse(trimmed.replace(/'/g, '"'));
    } catch {
        return null;
    }
};

const REQUEST_TIMEOUT_MS = 12000;

/**
 * 一次 GET，返回响应文本。
 *
 * 安卓上直接走原生 OkHttp：这几家的接口和音频地址散在很多 CDN 主机上，WebView 直连
 * 会被 CORS 挡掉，而 `resolveProxiedUrl` 在白名单外的主机上等于当场失败。
 */
export const httpGetText = async (
    url: string,
    timeoutMs: number,
    headers: Record<string, string>,
): Promise<Response> => {
    if (hasNativeHttp()) {
        return nativeHttpRequest(url, { method: 'GET', headers, timeoutMs });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(resolveProxiedUrl(url), {
            method: 'GET',
            signal: controller.signal,
            credentials: 'omit',
            headers,
        });
    } finally {
        clearTimeout(timer);
    }
};

const fetchJson = async (
    url: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
    referer = 'https://music.163.com/',
): Promise<unknown> => {
    // 网易云对没有 referer 的请求偶尔回 403；安卓桥会原样带过去，网页端由浏览器忽略。
    const response = await httpGetText(url, timeoutMs, { Referer: referer });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseLooseJson(await response.text());
};

const fetchText = async (url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string> => {
    const response = await httpGetText(url, timeoutMs, {});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.text()).trim();
};

const pageOf = <T>(items: T[], limit: number): LxApiPage<T> => ({
    items: items.slice(0, limit),
    hasMore: items.length >= limit,
});

const pageIndex = (offset: number, limit: number): number => Math.floor(Math.max(0, offset) / Math.max(1, limit)) + 1;

// ---------------------------------------------------------------- 网易云

const NETEASE_BASE = 'https://music.163.com';

const neteaseSong = (raw: Raw): LxApiSong => {
    const album = asRecord(raw.album) ?? asRecord(raw.al);
    const artists = asArray(raw.artists ?? raw.ar);
    return {
        platform: 'wy',
        id: toText(raw.id),
        name: toText(raw.name),
        artists: artists
            .map((artist) => ({ id: artist.id != null ? String(artist.id) : undefined, name: toText(artist.name) }))
            .filter((artist) => artist.name),
        album: {
            id: album?.id != null ? String(album.id) : undefined,
            name: toText(album?.name),
            coverUrl: normalizeCover(pick(album, 'picUrl', 'coverUrl')),
        },
        durationMs: toNumber(pick(raw, 'duration', 'dt', 'durationMs')),
        coverUrl: normalizeCover(pick(album, 'picUrl', 'coverUrl')),
    };
};

const neteaseCollection = (raw: Raw): LxApiCollection => ({
    platform: 'wy',
    id: toText(raw.id),
    name: toText(raw.name),
    kind: 'playlist',
    coverUrl: normalizeCover(pick(raw, 'coverImgUrl', 'picUrl')),
    description: toText(raw.description) || undefined,
    trackCount: toNumber(pick(raw, 'trackCount')) || undefined,
    playCount: toNumber(pick(raw, 'playCount')) || undefined,
    creatorName: toText(asRecord(raw.creator)?.nickname) || undefined,
    updatedAt: toNumber(pick(raw, 'updateTime', 'trackNumberUpdateTime')) || undefined,
});

/** 网易云偶尔回 `code: -462`（风控要求验证）之类的错误，这时不能当成「空歌单」糊过去。 */
const ensureNetease = (payload: unknown): Raw | null => {
    const record = asRecord(payload);
    const code = record ? Number(record.code) : Number.NaN;
    if (Number.isFinite(code) && code !== 200 && code !== 0) {
        throw new Error(`网易云返回 ${code}${record?.message ? `：${String(record.message)}` : ''}`);
    }
    return record;
};

const NETEASE_SEARCH_KIND = { song: 1, album: 10, playlist: 1000 } as const;

const neteaseSearch = async (
    keyword: string,
    kind: keyof typeof NETEASE_SEARCH_KIND,
    limit: number,
    offset: number,
): Promise<unknown> => {
    // 搜歌走 cloudsearch：`search/get/web` 的 songs 里不带封面（album.picUrl 整个字段缺失），
    // 搜索结果、歌手页、歌单详情全靠这份数据画封面，换接口之前那里一律是灰底转圈。
    // cloudsearch 的 al(专辑) / ar(歌手) / dt(时长) 与老接口同形，neteaseSong 不用改就能吃下。
    if (kind === 'song') {
        return fetchJson(
            `${NETEASE_BASE}/api/cloudsearch/pc?s=${encodeURIComponent(keyword)}&type=1&limit=${limit}&offset=${offset}`,
        );
    }
    return fetchJson(
        `${NETEASE_BASE}/api/search/get/web?s=${encodeURIComponent(keyword)}&type=${NETEASE_SEARCH_KIND[kind]}&limit=${limit}&offset=${offset}`,
    );
};

// 网易云的榜单就是四个固定歌单：直接按歌单详情读，曲目字段与搜索一致。
/** 网易云的榜：照洛雪 wy/leaderboard.js 全量 43 条，榜本身就是歌单，取曲目走 playlist/detail。 */
const NETEASE_CHARTS: ReadonlyArray<{ id: string; name: string }> = [
    { id: '19723756', name: '飙升榜' },
    { id: '3779629', name: '新歌榜' },
    { id: '2884035', name: '原创榜' },
    { id: '3778678', name: '热歌榜' },
    { id: '991319590', name: '说唱榜' },
    { id: '71384707', name: '古典音乐榜' },
    { id: '1978921795', name: '电音榜' },
    { id: '5453912201', name: '黑胶VIP爱听榜' },
    { id: '71385702', name: 'ACG榜' },
    { id: '745956260', name: '韩语榜' },
    { id: '10520166', name: '国电榜' },
    { id: '180106', name: 'UK排行榜周榜' },
    { id: '60198', name: '美国Billboard榜' },
    { id: '3812895', name: 'Beatport全球电子舞曲榜' },
    { id: '21845217', name: 'KTV唛榜' },
    { id: '60131', name: '日本Oricon榜' },
    { id: '2809513713', name: '欧美热歌榜' },
    { id: '2809577409', name: '欧美新歌榜' },
    { id: '27135204', name: '法国NRJ周榜' },
    { id: '3001835560', name: 'ACG动画榜' },
    { id: '3001795926', name: 'ACG游戏榜' },
    { id: '3001890046', name: 'ACG VOCALOID榜' },
    { id: '3112516681', name: '中国新乡村音乐榜' },
    { id: '5059644681', name: '日语榜' },
    { id: '5059633707', name: '摇滚榜' },
    { id: '5059642708', name: '国风榜' },
    { id: '5338990334', name: '潜力爆款榜' },
    { id: '5059661515', name: '民谣榜' },
    { id: '6688069460', name: '听歌识曲榜' },
    { id: '6723173524', name: '网络热歌榜' },
    { id: '6732051320', name: '俄语榜' },
    { id: '6732014811', name: '越南语榜' },
    { id: '6886768100', name: '中文DJ榜' },
    { id: '6939992364', name: '俄罗斯top hit榜' },
    { id: '7095271308', name: '泰语榜' },
    { id: '7356827205', name: 'BEAT中文慢摇榜' },
    { id: '7325478166', name: '编辑推荐VOL.44' },
    { id: '7603212484', name: 'LOOK直播榜' },
    { id: '7775163417', name: '赏音榜' },
    { id: '7785123708', name: '黑胶VIP新歌榜' },
    { id: '7785066739', name: '黑胶VIP热歌榜' },
    { id: '7785091694', name: '黑胶VIP爱搜榜' },
    { id: '2250011882', name: '抖音热歌榜' },
];

// ---------------------------------------------------------------- 酷狗

const KUGOU_SEARCH_HOST = 'https://mobiles.kugou.com';
const KUGOU_WEB_HOST = 'https://m.kugou.com';

/** 酷狗把「歌手 - 歌名」塞在 filename 里，缺字段时用它拆。 */
const kugouSongName = (raw: Raw): { name: string; artist: string } => {
    const name = stripTags(pick(raw, 'songname', 'song_name', 'name'));
    const artist = stripTags(pick(raw, 'singername', 'singer_name', 'author_name'));
    if (name && artist) return { name, artist };
    const filename = stripTags(pick(raw, 'filename', 'fileName'));
    const split = filename.split(' - ');
    if (split.length >= 2) {
        return { name: name || split.slice(1).join(' - '), artist: artist || split[0] };
    }
    return { name: name || filename, artist };
};

const kugouSong = (raw: Raw): LxApiSong => {
    const { name, artist } = kugouSongName(raw);
    const trans = asRecord(raw.trans_param);
    const cover = normalizeCover(pick(trans, 'union_cover', 'album_sizable_cover') ?? pick(raw, 'imgurl', 'album_sizable_cover'));
    return {
        platform: 'kg',
        id: toText(pick(raw, 'hash', 'hash_128', 'FileHash')),
        name,
        artists: splitArtists(artist),
        album: {
            id: toText(pick(raw, 'album_id', 'albumid')) || undefined,
            name: stripTags(pick(raw, 'album_name', 'albumname')),
            coverUrl: cover,
        },
        // 酷狗的时长单位是秒。
        durationMs: toNumber(pick(raw, 'duration', 'timelength', 'timeLength')) * 1000,
        coverUrl: cover,
    };
};

const kugouCollection = (raw: Raw): LxApiCollection => ({
    platform: 'kg',
    id: toText(pick(raw, 'specialid', 'specialId', 'id')),
    name: stripTags(pick(raw, 'specialname', 'special_name', 'name')),
    kind: 'playlist',
    coverUrl: normalizeCover(pick(raw, 'imgurl', 'img_9', 'album_img_9', 'cover', 'img')),
    description: stripTags(pick(raw, 'intro', 'description')) || undefined,
    trackCount: toNumber(pick(raw, 'songcount', 'song_count')) || undefined,
    playCount: toNumber(pick(raw, 'playcount', 'play_count')) || undefined,
    creatorName: stripTags(pick(raw, 'nickname', 'username', 'create_user_name')) || undefined,
    updatedAt: toNumber(pick(raw, 'publishtime', 'create_time')) || undefined,
});

const kugouChart = (raw: Raw): LxApiChart => ({
    platform: 'kg',
    id: toText(pick(raw, 'rankid', 'rank_id', 'id')),
    name: stripTags(pick(raw, 'rankname', 'rank_name', 'name')),
    coverUrl: normalizeCover(pick(raw, 'imgurl', 'img_9', 'album_img_9', 'banner_9')),
    description: stripTags(pick(raw, 'intro')) || undefined,
});

// ---------------------------------------------------------------- 酷我

/** 酷我的榜单 id 是固定编号（网页端一直在用），没有目录接口。 */
/** 酷我的榜：照洛雪 kw/leaderboard.js 全量，名字与洛雪一致（旧表里 26/62/145 的名字是错的）。 */
const KUWO_CHARTS: ReadonlyArray<{ id: string; name: string }> = [
    { id: '93', name: '飙升榜' },
    { id: '17', name: '新歌榜' },
    { id: '16', name: '热歌榜' },
    { id: '158', name: '抖音热歌榜' },
    { id: '292', name: '铃声榜' },
    { id: '284', name: '热评榜' },
    { id: '290', name: 'ACG新歌榜' },
    { id: '286', name: '台湾KKBOX榜' },
    { id: '279', name: '冬日暖心榜' },
    { id: '281', name: '巴士随身听榜' },
    { id: '255', name: 'KTV点唱榜' },
    { id: '280', name: '家务进行曲榜' },
    { id: '282', name: '熬夜修仙榜' },
    { id: '283', name: '枕边轻音乐榜' },
    { id: '278', name: '古风音乐榜' },
    { id: '264', name: 'Vlog榜' },
    { id: '242', name: '电音榜' },
    { id: '187', name: '流行趋势榜' },
    { id: '204', name: '现场音乐榜' },
    { id: '186', name: 'ACG神曲榜' },
    { id: '185', name: '最强翻唱榜' },
    { id: '26', name: '经典怀旧榜' },
    { id: '104', name: '华语榜' },
    { id: '182', name: '粤语榜' },
    { id: '22', name: '欧美榜' },
    { id: '184', name: '韩语榜' },
    { id: '183', name: '日语榜' },
    { id: '145', name: '会员畅听榜' },
    { id: '153', name: '网红新歌榜' },
    { id: '64', name: '影视金曲榜' },
    { id: '176', name: 'DJ嗨歌榜' },
    { id: '106', name: '真声音榜' },
    { id: '12', name: 'Billboard榜' },
    { id: '49', name: 'iTunes榜' },
    { id: '180', name: 'beatport榜' },
    { id: '13', name: '英国UK榜' },
    { id: '164', name: '百大DJ榜' },
    { id: '246', name: 'YouTube榜' },
    { id: '265', name: '韩国Genie榜' },
    { id: '14', name: '韩国M-net榜' },
    { id: '8', name: '香港电台榜' },
    { id: '15', name: '日本公信榜' },
    { id: '151', name: '腾讯音乐人原创榜' },
];

/** 酷我的歌曲 id 在接口里写作 `MUSIC_123456`。 */
const kuwoIdOf = (value: unknown): string => toText(value).replace(/^MUSIC_/i, '');

const kuwoSong = (raw: Raw): LxApiSong => {
    const cover = normalizeKuwoCover(pick(raw, 'web_albumpic_short', 'web_album_short', 'albumpic', 'pic'));
    // 榜单里的 `duration` 不是时长（有时是 2），`song_duration` 才是秒数；搜索结果是 `DURATION`。
    const seconds = Math.max(toNumber(pick(raw, 'DURATION', 'duration')), toNumber(pick(raw, 'song_duration')));
    return {
        platform: 'kw',
        id: kuwoIdOf(pick(raw, 'MUSICRID', 'musicrid', 'rid', 'id')),
        name: stripTags(pick(raw, 'SONGNAME', 'name', 'songname')),
        artists: splitArtists(stripTags(pick(raw, 'ARTIST', 'artist', 'aartist'))),
        album: {
            id: kuwoIdOf(pick(raw, 'ALBUMID', 'albumid')) || undefined,
            name: stripTags(pick(raw, 'ALBUM', 'album')),
            coverUrl: cover,
        },
        durationMs: seconds * 1000,
        coverUrl: cover,
    };
};

const kuwoCollection = (raw: Raw): LxApiCollection => ({
    platform: 'kw',
    id: toText(pick(raw, 'id')),
    name: stripTags(pick(raw, 'name', 'title')),
    kind: 'playlist',
    coverUrl: normalizeKuwoCover(pick(raw, 'img', 'pic')),
    description: stripTags(pick(raw, 'desc', 'info')) || undefined,
    trackCount: toNumber(pick(raw, 'total')) || undefined,
    playCount: toNumber(pick(raw, 'listencnt')) || undefined,
    creatorName: stripTags(pick(raw, 'uname')) || undefined,
});

// ---------------------------------------------------------------- QQ 音乐

const QQ_REFERER = 'https://y.qq.com/';
const QQ_CGI = 'https://c.y.qq.com';
const QQ_MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

/** QQ 的封面靠专辑 mid 拼：`T002R300x300M000<albummid>.jpg`。 */
const qqCover = (albumMid: string, size = 300): string | undefined => (
    albumMid ? `https://y.qq.com/music/photo_new/T002R${size}x${size}M000${albumMid}.jpg` : undefined
);

const qqSong = (raw: Raw): LxApiSong => {
    const album = asRecord(raw.album);
    const albumMid = toText(pick(raw, 'albummid') ?? album?.mid);
    const cover = qqCover(albumMid) ?? normalizeCover(pick(raw, 'albumcover'));
    const singers = asArray(raw.singer);
    return {
        platform: 'tx',
        // 音源脚本认 songmid，所以 id 就用 mid（不是那个数字 id）。
        id: toText(pick(raw, 'mid', 'songmid')),
        name: stripTags(pick(raw, 'name', 'title', 'songname')),
        artists: singers
            .map((singer) => ({ id: toText(singer.id) || undefined, name: stripTags(singer.name) }))
            .filter((artist) => artist.name),
        album: {
            id: toText(pick(raw, 'albumid') ?? album?.id) || undefined,
            name: stripTags(pick(raw, 'albumname') ?? album?.name),
            coverUrl: cover,
        },
        // QQ 的 interval 是秒。
        durationMs: toNumber(pick(raw, 'interval')) * 1000,
        coverUrl: cover,
    };
};

const qqCollection = (raw: Raw): LxApiCollection => ({
    platform: 'tx',
    id: toText(pick(raw, 'dissid', 'disstid', 'id')),
    name: stripTags(pick(raw, 'dissname', 'title')),
    kind: 'playlist',
    coverUrl: normalizeCover(pick(raw, 'imgurl', 'logo')),
    description: stripTags(pick(raw, 'introduction', 'desc')) || undefined,
    trackCount: toNumber(pick(raw, 'song_count', 'cur_song_num')) || undefined,
    playCount: toNumber(pick(raw, 'listennum', 'visitnum')) || undefined,
    creatorName: stripTags(asRecord(raw.creator)?.name) || undefined,
});

const qqChart = (raw: Raw): LxApiChart => ({
    platform: 'tx',
    id: toText(pick(raw, 'topId', 'topid', 'id')),
    name: stripTags(pick(raw, 'title', 'name')),
    coverUrl: normalizeCover(pick(raw, 'frontPicUrl', 'headPicUrl')),
    description: stripTags(pick(raw, 'intro')) || undefined,
});

/** musicu.fcg 只吃一整套 comm 参数，少一个就回 500001；拼好了 GET 也能用。 */
const QQ_COMM = {
    cv: 4747474,
    ct: 24,
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    notice: 0,
    platform: 'yqq.json',
    needNewCode: 1,
    uin: '0',
    g_tk_new_20200303: 5381,
    g_tk: 5381,
} as const;

const qqMusicu = async (module: string, method: string, param: Raw): Promise<Raw | null> => {
    const data = encodeURIComponent(JSON.stringify({
        comm: QQ_COMM,
        req_1: { module, method, param },
    }));
    return asRecord(await fetchJson(`${QQ_MUSICU}?format=json&data=${data}`, REQUEST_TIMEOUT_MS, QQ_REFERER));
};

// ---------------------------------------------------------------- 对外接口

export const lxApiSearchSongs = async (
    platform: LxPublicPlatform,
    keyword: string,
    limit: number,
    offset: number,
): Promise<LxApiPage<LxApiSong>> => {
    const page = pageIndex(offset, limit);
    if (platform === 'wy') {
        const payload = asRecord(await neteaseSearch(keyword, 'song', limit, offset));
        const songs = asArray(asRecord(payload?.result)?.songs).map(neteaseSong).filter((s) => s.id && s.name);
        return pageOf(songs, limit);
    }
    if (platform === 'kg') {
        const payload = asRecord(await fetchJson(
            `${KUGOU_SEARCH_HOST}/api/v3/search/song?format=json&keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${limit}&showtype=1`,
        ));
        const songs = asArray(asRecord(payload?.data)?.info).map(kugouSong).filter((s) => s.id && s.name);
        return pageOf(songs, limit);
    }
    if (platform === 'tx') {
        const payload = asRecord(await fetchJson(
            `${QQ_CGI}/soso/fcgi-bin/client_search_cp?format=json&p=${page}&n=${limit}&w=${encodeURIComponent(keyword)}`,
            REQUEST_TIMEOUT_MS,
            QQ_REFERER,
        ));
        const songs = asArray(asRecord(asRecord(payload?.data)?.song)?.list).map(qqSong).filter((s) => s.id && s.name);
        return pageOf(songs, limit);
    }
    const payload = asRecord(await fetchJson(
        `https://search.kuwo.cn/r.s?all=${encodeURIComponent(keyword)}&ft=music&itemset=web_2013&client=kt&pn=${page - 1}&rn=${limit}&rformat=json&encoding=utf8`,
    ));
    const songs = asArray(payload?.abslist).map(kuwoSong).filter((s) => s.id && s.name);
    return pageOf(songs, limit);
};

export const lxApiSearchPlaylists = async (
    platform: LxPublicPlatform,
    keyword: string,
    limit: number,
    offset: number,
): Promise<LxApiPage<LxApiCollection>> => {
    const page = pageIndex(offset, limit);
    if (platform === 'wy') {
        const payload = asRecord(await neteaseSearch(keyword, 'playlist', limit, offset));
        const list = asArray(asRecord(payload?.result)?.playlists).map(neteaseCollection).filter((c) => c.id && c.name);
        return pageOf(list, limit);
    }
    if (platform === 'kg') {
        const payload = asRecord(await fetchJson(
            `${KUGOU_SEARCH_HOST}/api/v3/search/special?format=json&keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${limit}`,
        ));
        const list = asArray(asRecord(payload?.data)?.info).map(kugouCollection).filter((c) => c.id && c.name);
        return pageOf(list, limit);
    }
    if (platform === 'tx') {
        // t=8 是 QQ 的「歌单」搜索类型。
        const payload = asRecord(await fetchJson(
            `${QQ_CGI}/soso/fcgi-bin/client_search_cp?format=json&p=${page}&n=${limit}&t=8&w=${encodeURIComponent(keyword)}`,
            REQUEST_TIMEOUT_MS,
            QQ_REFERER,
        ));
        const list = asArray(asRecord(asRecord(payload?.data)?.special)?.list).map(qqCollection).filter((c) => c.id && c.name);
        return pageOf(list, limit);
    }
    return { items: [], hasMore: false };
};

export const lxApiSearchAlbums = async (
    platform: LxPublicPlatform,
    keyword: string,
    limit: number,
    offset: number,
): Promise<LxApiPage<LxApiCollection>> => {
    if (platform !== 'wy') return { items: [], hasMore: false };
    const payload = asRecord(await neteaseSearch(keyword, 'album', limit, offset));
    const list = asArray(asRecord(payload?.result)?.albums).map((raw) => ({
        platform: 'wy' as const,
        id: toText(raw.id),
        name: toText(raw.name),
        kind: 'album' as const,
        coverUrl: normalizeCover(pick(raw, 'picUrl', 'blurPicUrl')),
        trackCount: toNumber(raw.size) || undefined,
        creatorName: toText(asRecord(raw.artist)?.name) || undefined,
        updatedAt: toNumber(pick(raw, 'publishTime')) || undefined,
    })).filter((item) => item.id && item.name);
    return pageOf(list, limit);
};

/** 歌单广场的排序：只有「最热」和「最新」两种，且各家支持程度不同（见下面的实测注释）。 */
export type LxSquareOrder = 'hot' | 'new';

export type LxSquareOptions = {
    /** 排序：默认按最热。不支持这个排序的平台会退回它自己的默认序，不会报错。 */
    order?: LxSquareOrder;
    /** 分类（只对网易云真的生效；别家传了也会被忽略）。'全部' 等价于不筛选。 */
    cat?: string;
    /** 二级分类标签 id，来自 lxApiPlaylistTags。四家语义不同，由本文件内部翻译：
     *  网易云 = 标签名（cat），QQ = categoryId，酷狗 = tagid，酷我 = 标签 id（「专区」再带 qz: 前缀）。 */
    tagId?: string;
};

/**
 * 歌单广场：各家「热门歌单」首页。
 *
 * 排序/分类是逐家试出来的，别照着洛雪桌面版的参数直接抄：
 *   wy  —— `order=hot` 有效，**`order=new` 这个接口返回空**，所以网易云的「最新」只能靠 cat 换内容；
 *          `cat`（华语/流行/摇滚…）真的会换出一批完全不同的歌单，是四家里唯一分类可用的。
 *   kw  —— `order=hot` 与 `order=new` 都有效且内容不同，`order=index` 返回空。
 *   tx  —— `sortId=5` 与 `1` 是同一批（实测前三条一模一样），`sortId=2` 是另一批，拿来当「最新」。
 *   kg  —— 广场接口固定热门序，没有排序参数，两者都返回同一批。
 */

// ---------------------------------------------------------------- 歌单分类标签
//
// 首页歌单页的二级分类不是写死的文案：每一组都来自各家自己的「分类目录」接口，
// 拿到的 id 直接就是该家「按标签取歌单」的参数，所以点下去一定真有内容。
// 四家目录结构各不相同，这里统一成 { hot: 热门标签, groups: [{ title, tags }] }。
//
//   · 网易云 playlist/catalogue：sub 里 hot=true 的是热门标签，其余按 categories 的
//     0..4（语种/风格/场景/情感/主题）分组；
//   · QQ fcg_get_diss_tag_conf：categories 数组本身就是组，每组带 categoryId；
//     热门标签只在网页 HTML 里有，正则抓 data-id；
//   · 酷狗 getSpecial?is_smarty=1：data.hotTag 是热门，data.tagids 是六组；
//   · 酷我 getRcmTagList 是热门，getTagList 是七组；其中「专区」的标签走另一套
//     接口取歌单，id 前面加 qz: 区分。

export type LxSquareTag = { id: string; name: string; coverUrl?: string };
export type LxSquareTagGroup = { title: string; tags: LxSquareTag[] };
export type LxSquareTagCatalog = { hot: LxSquareTag[]; groups: LxSquareTagGroup[] };

const EMPTY_TAG_CATALOG: LxSquareTagCatalog = { hot: [], groups: [] };

/** 网易云 catalogue 里 categories 的编号→组名。 */
const NETEASE_TAG_GROUP_NAMES: Record<string, string> = {
    '0': '语种',
    '1': '风格',
    '2': '场景',
    '3': '情感',
    '4': '主题',
};

const QQ_TAG_CONF_URL = `${QQ_CGI}/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg?g_tk=5381&loginUin=0&hostUin=0`
    + '&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0';
/** QQ 的热门标签只有网页端有，接口不给。 */
const QQ_HOT_TAG_URL = 'https://c.y.qq.com/node/pc/wk_v15/category_playlist.html';
const KUGOU_TAG_HOST = 'http://www2.kugou.kugou.com';
const KUWO_TAG_BASE = 'https://wapi.kuwo.cn/api/pc/classify/playlist';
/** 酷我这些接口统一要这三个空账号参数，缺了会返回空列表。 */
const KUWO_APP = 'loginUid=0&loginSid=0&appUid=76039576';

const tagOf = (record: Raw, idKey: string, nameKey: string, coverKey?: string): LxSquareTag => {
    const coverUrl = coverKey ? normalizeCover(pick(record, coverKey)) : undefined;
    return {
        id: toText(pick(record, idKey)),
        name: stripTags(pick(record, nameKey)),
        ...(coverUrl ? { coverUrl } : {}),
    };
};

const neteaseTagCatalog = async (): Promise<LxSquareTagCatalog> => {
    const payload = asRecord(await fetchJson(`${NETEASE_BASE}/api/playlist/catalogue`));
    const sub = asArray(payload?.sub);
    if (sub.length === 0) return EMPTY_TAG_CATALOG;
    // 网易云的标签名本身就是 cat 参数，所以 id 和 name 一样。
    const tagFromSub = (item: Raw): LxSquareTag => ({ id: toText(item.name), name: stripTags(item.name) });
    const hot = sub.filter((item) => item.hot === true).map(tagFromSub).filter((tag) => tag.id && tag.name);
    const groups = Object.keys(NETEASE_TAG_GROUP_NAMES).map((key) => ({
        title: NETEASE_TAG_GROUP_NAMES[key],
        tags: sub
            .filter((item) => String(item.category ?? '') === key && item.hot !== true)
            .map(tagFromSub)
            .filter((tag) => tag.id && tag.name),
    })).filter((group) => group.tags.length > 0);
    return { hot, groups };
};

const qqHotTags = async (): Promise<LxSquareTag[]> => {
    try {
        const response = await httpGetText(QQ_HOT_TAG_URL, REQUEST_TIMEOUT_MS, { Referer: QQ_REFERER });
        if (!response.ok) return [];
        const html = await response.text();
        const pattern = /class="c_bg_link js_tag_item" data-id="(\w+)">(.+?)<\/a>/g;
        const tags: LxSquareTag[] = [];
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(html)) !== null) {
            const name = stripTags(match[2]).replace(/<[^>]*>/g, '');
            if (name) tags.push({ id: match[1], name });
        }
        return tags;
    } catch {
        return [];
    }
};

const qqTagCatalog = async (): Promise<LxSquareTagCatalog> => {
    const [payload, hot] = await Promise.all([
        fetchJson(QQ_TAG_CONF_URL, REQUEST_TIMEOUT_MS, QQ_REFERER).catch(() => null),
        qqHotTags(),
    ]);
    const categories = asArray(asRecord(asRecord(payload)?.data)?.categories);
    const groups = categories.map((category) => ({
        title: String(category.categoryGroupName ?? ''),
        tags: asArray(category.items)
            .map((item) => tagOf(item, 'categoryId', 'categoryName'))
            .filter((tag) => tag.id && tag.name),
    })).filter((group) => group.title && group.tags.length > 0);
    return { hot, groups };
};

const kugouTagCatalog = async (): Promise<LxSquareTagCatalog> => {
    const payload = asRecord(await fetchJson(`${KUGOU_TAG_HOST}/yueku/v9/special/getSpecial?is_smarty=1&cdn=cdn&t=5&c=`));
    const data = asRecord(payload?.data);
    const hotRaw = asRecord(data?.hotTag)?.data;
    const hot = (hotRaw && typeof hotRaw === 'object' ? Object.values(hotRaw as Raw) : [])
        .map((item) => tagOf(asRecord(item) ?? {}, 'special_id', 'special_name', 'img'))
        .filter((tag) => tag.id && tag.name);
    const tagids = asRecord(data?.tagids);
    const groups = Object.keys(tagids ?? {}).map((key) => {
        const group = asRecord((tagids as Raw)[key]);
        return {
            title: String(group?.pname ?? key),
            tags: asArray(group?.data).map((item) => tagOf(item, 'id', 'name', 'img')).filter((tag) => tag.id && tag.name),
        };
    }).filter((group) => group.title && group.tags.length > 0);
    return { hot, groups };
};

const kuwoTagCatalog = async (): Promise<LxSquareTagCatalog> => {
    const [hotPayload, listPayload] = await Promise.all([
        fetchJson(`${KUWO_TAG_BASE}/getRcmTagList?${KUWO_APP}`, REQUEST_TIMEOUT_MS, 'https://www.kuwo.cn/').catch(() => null),
        fetchJson(
            `${KUWO_TAG_BASE}/getTagList?cmd=rcm_keyword_playlist&user=0&prod=kwplayer_pc_9.0.5.0`
            + `&vipver=9.0.5.0&source=kwplayer_pc_9.0.5.0&${KUWO_APP}`,
            REQUEST_TIMEOUT_MS,
            'https://www.kuwo.cn/',
        ).catch(() => null),
    ]);
    // 酷我这两个接口的负载都包在 { code, data } 里：先剥一层 data 再摊平，
    // 否则拿到的是对象，按数组解析永远是空的（表现为「这家暂时没有分类目录」）。
    // 热门标签返回的是「一组组小卡片」，把每组的 data 摊平。
    const hot = asArray(asRecord(hotPayload)?.data)
        .flatMap((block) => asArray(asRecord(block)?.data))
        .map((item) => tagOf(item, 'id', 'name', 'img'))
        .filter((tag) => tag.id && tag.name);
    const groups = asArray(asRecord(listPayload)?.data)
        .map((group) => ({
            title: String(group.name ?? ''),
            // 「专区」不是整组，而是组里那几个 digest=43 的标签：组级 mdigest 恒为 5，
            // 所以必须看标签自己的 digest。这类歌单走 er.s 接口，靠 qz: 前缀区分。
            tags: asArray(group.data)
                .map((item) => {
                    const tag = tagOf(item, 'id', 'name', 'img');
                    const tagDigest = String(item.digest ?? '');
                    return tagDigest === '43' && tag.id ? { ...tag, id: `qz:${tag.id}` } : tag;
                })
                .filter((tag) => tag.id && tag.name),
        }))
        .filter((group) => group.title && group.tags.length > 0);
    return { hot, groups };
};

/**
 * 拉某一家歌单广场的二级分类目录。失败只返回空目录，不抛：调用方据此决定要不要显示那一行。
 */
export const lxApiPlaylistTags = async (platform: LxPublicPlatform): Promise<LxSquareTagCatalog> => {
    try {
        if (platform === 'wy') return await neteaseTagCatalog();
        if (platform === 'tx') return await qqTagCatalog();
        if (platform === 'kg') return await kugouTagCatalog();
        return await kuwoTagCatalog();
    } catch (error) {
        console.warn('[lxmusic] 拉分类标签失败：', platform, error);
        return EMPTY_TAG_CATALOG;
    }
};

export const lxApiPlaylistSquare = async (
    platform: LxPublicPlatform,
    limit: number,
    offset: number,
    options?: LxSquareOptions,
): Promise<LxApiPage<LxApiCollection>> => {
    const page = pageIndex(offset, limit);
    const order = options?.order ?? 'hot';
    const tagId = options?.tagId?.trim() ?? '';
    if (platform === 'wy') {
        // 网易云没有可用的「最新」序（实测返回空数组），照发会变成空页，直接按最热处理。
        const payload = asRecord(await fetchJson(
            `${NETEASE_BASE}/api/playlist/list?cat=${encodeURIComponent(tagId || options?.cat || '全部')}&order=hot&offset=${offset}&limit=${limit}`,
        ));
        const list = asArray(payload?.playlists).map(neteaseCollection).filter((c) => c.id && c.name);
        return pageOf(list, limit);
    }
    if (platform === 'kg') {
        if (tagId) {
            // 带标签：酷狗分类歌单在这个老域名下，返回 special_db 数组（字段与 plist 不同，映射函数已兼容）。
            const payload = asRecord(await fetchJson(
                `${KUGOU_TAG_HOST}/yueku/v9/special/getSpecial?is_ajax=1&cdn=cdn&t=${order === 'new' ? 2 : 5}`
                + `&c=${encodeURIComponent(tagId)}&p=${page}`,
            ));
            const list = asArray(payload?.special_db).map(kugouCollection).filter((c) => c.id && c.name);
            return { items: list, hasMore: list.length >= limit };
        }
        const payload = asRecord(await fetchJson(`${KUGOU_WEB_HOST}/plist/index&json=true&page=${page}`));
        const info = asRecord(asRecord(asRecord(payload?.plist)?.list));
        const list = asArray(info?.info).map(kugouCollection).filter((c) => c.id && c.name);
        return pageOf(list, limit);
    }
    if (platform === 'kw') {
        if (tagId.startsWith('qz:')) {
            // 专区：er.s 一次给一组歌单，没有分页，取第一页即可。
            const payload = await fetchJson(
                `https://mobileinterfaces.kuwo.cn/er.s?type=get_pc_qz_data&f=web&id=${encodeURIComponent(tagId.slice(3))}&prod=pc`,
                REQUEST_TIMEOUT_MS,
                'https://www.kuwo.cn/',
            );
            const blocks = Array.isArray(payload) ? payload.map((block) => asRecord(block)) : [];
            const list = blocks
                .flatMap((block) => asArray(block?.list).map(kuwoCollection))
                .filter((c) => c.id && c.name);
            return { items: list.slice(0, limit), hasMore: list.length > limit };
        }
        if (tagId) {
            const payload = asRecord(await fetchJson(
                `${KUWO_TAG_BASE}/getTagPlayList?${KUWO_APP}&pn=${page}&id=${encodeURIComponent(tagId)}&rn=${limit}`,
                REQUEST_TIMEOUT_MS,
                'https://www.kuwo.cn/',
            ));
            const list = asArray(asRecord(payload?.data)?.data).map(kuwoCollection).filter((c) => c.id && c.name);
            return { items: list, hasMore: list.length >= limit };
        }
        // 酷我网页端那个 www 接口要 csrf/cookie，wapi 这套公开接口不要。
        const payload = asRecord(await fetchJson(
            `https://wapi.kuwo.cn/api/pc/classify/playlist/getRcmPlayList?rn=${limit}&pn=${page}&order=${order === 'new' ? 'new' : 'hot'}`,
            REQUEST_TIMEOUT_MS,
            'https://www.kuwo.cn/',
        ));
        const list = asArray(asRecord(payload?.data)?.data).map(kuwoCollection).filter((c) => c.id && c.name);
        return { items: list, hasMore: list.length >= limit };
    }
    {
        // QQ：categoryId=10000000 是「全部」；带标签时换成目录接口给的 categoryId。
        // 5 是推荐/最热，2 是另一批（当「最新」用）——两个都实测换内容。
        const categoryId = tagId || '10000000';
        const payload = asRecord(await fetchJson(
            `${QQ_CGI}/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?picmid=1&rnd=0.1&g_tk=5381`
            + `&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0`
            + `&platform=yqq.json&needNewCode=0&categoryId=${encodeURIComponent(categoryId)}&sortId=${order === 'new' ? 2 : 5}`
            + `&sin=${offset}&ein=${offset + limit - 1}`,
            REQUEST_TIMEOUT_MS,
            QQ_REFERER,
        ));
        const list = asArray(asRecord(payload?.data)?.list).map(qqCollection).filter((c) => c.id && c.name);
        return { items: list, hasMore: list.length >= limit };
    }
};

export const lxApiCharts = async (platform: LxPublicPlatform): Promise<LxApiChart[]> => {
    if (platform === 'kg') {
        const payload = asRecord(await fetchJson(`${KUGOU_WEB_HOST}/rank/list&json=true`));
        const list = asArray(asRecord(payload?.rank)?.list).map(kugouChart).filter((c) => c.id && c.name);
        if (list.length > 0) return list;
    }
    if (platform === 'tx') {
        const payload = await qqMusicu('musicToplist.ToplistInfoServer', 'GetAll', {});
        const groups = asArray(asRecord(asRecord(payload?.req_1)?.data)?.group);
        const list = groups
            .flatMap((group) => asArray(group.toplist).map(qqChart))
            .filter((chart) => chart.id && chart.name);
        if (list.length > 0) return list;
    }
    if (platform === 'wy') {
        return NETEASE_CHARTS.map((chart) => ({ platform, id: chart.id, name: chart.name }));
    }
    return KUWO_CHARTS.map((chart) => ({ platform, id: chart.id, name: chart.name }));
};

export const lxApiChartTracks = async (
    platform: LxPublicPlatform,
    chartId: string,
    limit: number,
    offset: number,
): Promise<LxApiPage<LxApiSong>> => {
    const page = pageIndex(offset, limit);
    if (platform === 'wy') {
        // 网易云的榜单本身就是歌单。
        return lxApiPlaylistTracks(platform, chartId, limit, offset);
    }
    if (platform === 'kg') {
        const payload = asRecord(await fetchJson(`${KUGOU_WEB_HOST}/rank/info/?rankid=${encodeURIComponent(chartId)}&page=${page}&json=true`));
        const songs = asArray(asRecord(payload?.songs)?.list).map(kugouSong).filter((s) => s.id && s.name);
        return pageOf(songs, limit);
    }
    if (platform === 'tx') {
        const payload = asRecord(await fetchJson(
            `${QQ_CGI}/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=${encodeURIComponent(chartId)}`
            + `&format=json&page=detail&type=top&song_begin=${offset}&song_num=${limit}`,
            REQUEST_TIMEOUT_MS,
            QQ_REFERER,
        ));
        const songs = asArray(payload?.songlist)
            .map((item) => asRecord(item.data))
            .filter((data): data is Raw => Boolean(data))
            .map(qqSong)
            .filter((song) => song.id && song.name);
        return { items: songs, hasMore: songs.length >= limit };
    }
    const payload = asRecord(await fetchJson(
        `https://kbangserver.kuwo.cn/ksong.s?from=pc&fmt=json&pn=${page - 1}&rn=${limit}&type=bang&data=content&id=${encodeURIComponent(chartId)}&show_copyright_off=1`,
    ));
    const songs = asArray(payload?.musiclist).map(kuwoSong).filter((s) => s.id && s.name);
    return pageOf(songs, limit);
};

export const lxApiPlaylistTracks = async (
    platform: LxPublicPlatform,
    playlistId: string,
    limit: number,
    offset: number,
): Promise<LxApiPage<LxApiSong>> => {
    const page = pageIndex(offset, limit);
    if (platform === 'wy') {
        const payload = ensureNetease(await fetchJson(`${NETEASE_BASE}/api/playlist/detail?id=${encodeURIComponent(playlistId)}`));
        const tracks = asArray(asRecord(payload?.result)?.tracks).map(neteaseSong).filter((s) => s.id && s.name);
        // 歌单详情一次给全（上限 1000 首），在本地切片。
        return { items: tracks.slice(offset, offset + limit), hasMore: tracks.length > offset + limit };
    }
    if (platform === 'kg') {
        const payload = asRecord(await fetchJson(
            `${KUGOU_SEARCH_HOST}/api/v3/special/song?specialid=${encodeURIComponent(playlistId)}&page=${page}&pagesize=${limit}&plat=0&version=8000`,
        ));
        const songs = asArray(asRecord(payload?.data)?.info).map(kugouSong).filter((s) => s.id && s.name);
        return pageOf(songs, limit);
    }
    if (platform === 'kw') {
        // 少 `vipver=1&mobi=1` 时 total 有值但 musiclist 是空的（踩过）。
        const payload = asRecord(await fetchJson(
            `https://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=${encodeURIComponent(playlistId)}&pn=${page - 1}&rn=${limit}`
            + '&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=1&mobi=1',
            REQUEST_TIMEOUT_MS,
            'https://www.kuwo.cn/',
        ));
        const songs = asArray(payload?.musiclist).map(kuwoSong).filter((s) => s.id && s.name);
        return { items: songs, hasMore: songs.length >= limit };
    }
    if (platform === 'tx') {
        const payload = asRecord(await fetchJson(
            `${QQ_CGI}/v8/fcg-bin/fcg_v8_playlist_cp.fcg?id=${encodeURIComponent(playlistId)}&format=json&newsong=1&skin=1`,
            REQUEST_TIMEOUT_MS,
            QQ_REFERER,
        ));
        const cdlist = asArray(asRecord(payload?.data)?.cdlist);
        const all = asArray(cdlist[0]?.songlist).map(qqSong).filter((s) => s.id && s.name);
        return { items: all.slice(offset, offset + limit), hasMore: all.length > offset + limit };
    }
    return { items: [], hasMore: false };
};

export const lxApiAlbumTracks = async (
    platform: LxPublicPlatform,
    albumId: string,
    limit: number,
    offset: number,
): Promise<LxApiPage<LxApiSong>> => {
    const page = pageIndex(offset, limit);
    if (platform === 'wy') {
        const payload = ensureNetease(await fetchJson(`${NETEASE_BASE}/api/album/${encodeURIComponent(albumId)}`));
        const songs = asArray(asRecord(payload?.album)?.songs).map(neteaseSong).filter((s) => s.id && s.name);
        return { items: songs.slice(offset, offset + limit), hasMore: songs.length > offset + limit };
    }
    if (platform === 'kg') {
        const payload = asRecord(await fetchJson(
            `${KUGOU_SEARCH_HOST}/api/v3/album/song?albumid=${encodeURIComponent(albumId)}&page=${page}&pagesize=${limit}&plat=0&version=8000`,
        ));
        const songs = asArray(asRecord(payload?.data)?.info).map(kugouSong).filter((s) => s.id && s.name);
        return pageOf(songs, limit);
    }
    if (platform === 'tx') {
        // QQ 的专辑页接口数字 albumid 与 albummid 都认，两个都试一下（别家给的 id 可能是后者）。
        const param = /^\d+$/.test(albumId) ? 'albumid' : 'albummid';
        const payload = asRecord(await fetchJson(
            `${QQ_CGI}/v8/fcg-bin/fcg_v8_album_info_cp.fcg?${param}=${encodeURIComponent(albumId)}`
            + `&format=json&song_begin=${offset}&song_num=${limit}`,
            REQUEST_TIMEOUT_MS,
            QQ_REFERER,
        ));
        const songs = asArray(asRecord(payload?.data)?.list).map(qqSong).filter((s) => s.id && s.name);
        return { items: songs, hasMore: songs.length >= limit };
    }
    return { items: [], hasMore: false };
};

/** 新碟 / 热门专辑：网易云与酷狗有公开入口，QQ 与酷我没有。 */
export const lxApiAlbumSquare = async (
    platform: LxPublicPlatform,
    limit: number,
    offset: number,
): Promise<LxApiPage<LxApiCollection>> => {
    const page = pageIndex(offset, limit);
    if (platform === 'wy') {
        const payload = ensureNetease(await fetchJson(
            `${NETEASE_BASE}/api/album/new?area=ALL&limit=${limit}&offset=${offset}`,
        ));
        const list = asArray(payload?.albums).map((raw) => ({
            platform: 'wy' as const,
            id: toText(raw.id),
            name: stripTags(raw.name),
            kind: 'album' as const,
            coverUrl: normalizeCover(pick(raw, 'picUrl', 'blurPicUrl')),
            trackCount: toNumber(raw.size) || undefined,
            creatorName: asArray(raw.artists).map((artist) => stripTags(artist.name)).filter(Boolean).join(' / ') || undefined,
            updatedAt: toNumber(pick(raw, 'publishTime')) || undefined,
        })).filter((item) => item.id && item.name);
        return { items: list, hasMore: list.length >= limit };
    }
    if (platform === 'kg') {
        const payload = asRecord(await fetchJson(
            `${KUGOU_SEARCH_HOST}/api/v3/album/list?format=json&page=${page}&pagesize=${limit}`,
        ));
        const list = asArray(asRecord(payload?.data)?.info).map((raw) => ({
            platform: 'kg' as const,
            id: toText(pick(raw, 'albumid', 'album_id')),
            name: stripTags(pick(raw, 'albumname', 'album_name')),
            kind: 'album' as const,
            coverUrl: normalizeCover(pick(raw, 'imgurl')),
            trackCount: toNumber(pick(raw, 'songcount')) || undefined,
            creatorName: stripTags(pick(raw, 'singername')) || undefined,
            description: stripTags(pick(raw, 'intro')) || undefined,
        })).filter((item) => item.id && item.name);
        return { items: list, hasMore: list.length >= limit };
    }
    return { items: [], hasMore: false };
};

/**
 * 电台节目：网易云有「推荐节目」公开接口，每条节目自带主音轨（能直接播）。
 * 其余几家没有不需要登录态的电台入口。
 */
export const lxApiRadioPrograms = async (
    platform: LxPublicPlatform,
    limit: number,
    offset: number,
): Promise<LxApiPage<LxApiRadioProgram>> => {
    if (platform !== 'wy') return { items: [], hasMore: false };
    const payload = ensureNetease(await fetchJson(
        `${NETEASE_BASE}/api/personalized/djprogram?limit=${limit}&offset=${offset}`,
    ));
    const list = asArray(payload?.result)
        .map((raw) => {
            const program = asRecord(raw.program);
            const main = asRecord(program?.mainSong);
            const song = main ? neteaseSong(main) : null;
            return {
                platform: 'wy' as const,
                id: toText(pick(raw, 'id', program?.id)),
                name: stripTags(pick(raw, 'name', program?.name)),
                coverUrl: normalizeCover(pick(raw, 'picUrl', program?.coverUrl, program?.blurCoverUrl)),
                djName: stripTags(asRecord(program?.dj)?.nickname) || undefined,
                description: stripTags(pick(raw, 'copywriter', program?.description)) || undefined,
                song,
            };
        })
        // 没有主音轨的节目播不了，直接不列。
        .filter((item) => Boolean(item.song && item.song.id && item.name))
        .map((item) => ({ ...item, song: item.song as LxApiSong }));
    return { items: list, hasMore: list.length >= limit };
};

/**
 * 酷狗 `m.kugou.com` 的播放信息接口：免费曲目直接给一条 CDN 直链，付费 / 独家曲目的 url 是空串。
 * 先把能放的那批放出来，剩下的再交给导入的 LX 音源。
 */
const kugouFreeAudioUrl = async (hash: string): Promise<string | null> => {
    try {
        const payload = asRecord(await fetchJson(
            `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(hash)}`,
            9000,
            'https://m.kugou.com/',
        ));
        const url = toText(payload?.url);
        return /^https?:\/\//i.test(url) ? url : null;
    } catch {
        return null;
    }
};

/** 酷我 / 酷狗有免费直链（其余靠音源续）。返回 null 表示这次没取到，交给音源。 */
export const lxApiFreeAudioUrl = async (platform: LxPublicPlatform, songId: string): Promise<string | null> => {
    if (platform === 'kg') return kugouFreeAudioUrl(songId);
    if (platform === 'wy') {
        /**
         * 网易云的免登录外链：免费曲目会直接 302 到 CDN，付费/下架的曲目回一段 HTML。
         * 这里只负责给出候选地址，能不能播由调用方探活决定（HTML 会被拒掉）。
         * 实测 `起风了` 这类免费曲目能拿到 206 audio/mpeg。
         */
        return `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(songId)}.mp3`;
    }
    if (platform !== 'kw') return null;
    try {
        const url = await fetchText(
            `https://antiserver.kuwo.cn/anti.s?type=convert_url&rvid=MUSIC_${encodeURIComponent(songId)}&format=mp3&response=url`,
            9000,
        );
        return /^https?:\/\//i.test(url) ? url : null;
    } catch {
        return null;
    }
};

const LRC_TIME = (seconds: number): string => {
    const safe = Math.max(0, seconds);
    const minutes = Math.floor(safe / 60);
    const rest = safe - minutes * 60;
    return `[${String(minutes).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}]`;
};

/** 歌词：网易云 / 酷我都有关联的公开接口，酷狗只能走音源。 */
export const lxApiLyric = async (
    platform: LxPublicPlatform,
    songId: string,
): Promise<{ main: string | null; translation: string | null }> => {
    if (platform === 'wy') {
        const payload = asRecord(await fetchJson(
            `${NETEASE_BASE}/api/song/lyric?id=${encodeURIComponent(songId)}&lv=1&kv=1&tv=-1`,
        ));
        return {
            main: toText(asRecord(payload?.lrc)?.lyric) || null,
            translation: toText(asRecord(payload?.tlyric)?.lyric) || null,
        };
    }
    if (platform === 'kw') {
        const payload = asRecord(await fetchJson(
            `https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encodeURIComponent(songId)}`,
        ));
        const lines = asArray(asRecord(payload?.data)?.lrclist);
        if (lines.length === 0) return { main: null, translation: null };
        const main = lines
            .map((line) => `${LRC_TIME(toNumber(line.time))}${toText(line.lineLyric)}`)
            .join('\n');
        return { main, translation: null };
    }
    return { main: null, translation: null };
};

/**
 * 按平台的歌曲 id 反查一首歌（歌名 / 歌手 / 专辑 / 封面）。
 *
 * 为什么需要：早期版本的「喜欢」只在本机存了 id（`folia.lxmusic.likes`），没有歌名与封面，
 * 首页那张「我的喜欢」卡因此拼不出来。这是唯一能把老数据补回来的路——按 id 回各家详情接口问一次。
 *
 * 实测（2026-11）：
 *   · wy  `api/song/detail?ids=[id]` 可用，字段是老的 artists / album（不是 ar / al）；
 *   · kg  `m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=` 可用，字段名是 songName / author_name / imgUrl；
 *   · tx  `c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=` 可用，封面靠 album.mid 拼；
 *   · kw  没有能只凭 musicid 反查的公开接口（www 接口要 csrf、mobi 只给直链、r.s 对已下架曲目返回 TOTAL=0），
 *         所以返回 null，调用方跳过这首，不编造歌名。
 */
export const lxApiSongById = async (
    platform: LxPublicPlatform,
    id: string,
): Promise<LxApiSong | null> => {
    const songId = String(id || '').trim();
    if (!songId) return null;
    try {
        if (platform === 'wy') {
            const payload = asRecord(await fetchJson(`${NETEASE_BASE}/api/song/detail?ids=[${encodeURIComponent(songId)}]`));
            const raw = asArray(payload?.songs)[0];
            if (!raw) return null;
            const song = neteaseSong(raw);
            return song.name ? song : null;
        }
        if (platform === 'kg') {
            const payload = asRecord(await fetchJson(
                `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(songId)}`,
                8000,
                'https://m.kugou.com/',
            ));
            if (!payload || toText(payload.error)) return null;
            // 这股接口的键名和搜索接口不同：songName / author_name / imgUrl。
            const song = kugouSong({
                ...payload,
                hash: songId,
                songname: payload.songName,
                singername: payload.author_name,
                album_name: payload.album_name,
                imgurl: payload.imgUrl,
            });
            return song.name ? song : null;
        }
        if (platform === 'tx') {
            const payload = asRecord(await fetchJson(
                `${QQ_CGI}/v8/fcg-bin/fcg_play_single_song.fcg?songmid=${encodeURIComponent(songId)}&platform=yqq&format=json`,
                8000,
                QQ_REFERER,
            ));
            const raw = asArray(payload?.data)[0];
            if (!raw) return null;
            const song = qqSong(raw);
            return song.name ? song : null;
        }
        return null;
    } catch {
        return null;
    }
};
