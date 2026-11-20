import { qqCookieUin } from '../cookies.js';
import { qqAuthRequired, qqBridgeFailure, qqMusicuBatch, qqMusicuCall } from '../qq.js';
import { noteLibraryStep } from '../libraryTrace.js';

// src/nativeBridge/api/qq/explore.js
//
// qq-music-api 3.3.3 那一组：探索页的新歌 / 新碟 / 排行榜 / 分类 / 雷达 / 电台 / 相似歌曲，
// 加上会员等级、音乐云盘、建自己的歌单，以及带会话的关键字搜索。
//
// module / method / param 一字不改照抄上游后端的 services/recommend、services/rank、
// services/user 与 services/search；差别只在凭据：上游后端手里是 Android 端会话（comm 里带
// 设备信息），本地桥只有网页 / 扫码登录拿到的 cookie，所以沿用曲库与私人 FM 一直在用的
// buildQQAuthComm。公开内容（新歌、新碟、榜单、分类）匿名就读得到，其余要登录。
//
// 与上游同一条约定：读不出来就是空结果（上游是 422，本地桥回空数组），探索页据此跳过这一栏；
// 要登录而没有会话的回 AUTH_REQUIRED —— 不让「没登录」伪装成「没有内容」。

// ---- 上游字段的读法：只收认识的形状，其余当作「没有」 ----

/** 只认纯数字的正整数；小数、带字母、0、负数一律不算。 */
const positiveId = (value) => (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
);

/** 上游的计数。不是正常整数就不给，调用方据此决定报不报「还有下一页」。 */
const countOf = (value) => (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
);

/** 上游的文字字段：只收非空字符串。 */
const textOf = (value) => (typeof value === 'string' && value.length > 0 ? value : undefined);

const dictOf = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

/** 上游的清单：null / 缺省当作没有，其他非数组是格式变了。 */
const listOf = (value) => (Array.isArray(value) ? value : []);

/** 分页参数：不是正整数用默认值，超过上限压到上限。 */
const pageSizeOf = (value, fallback, max) => {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
    return Math.min(max, parsed);
};

const offsetOf = (value) => {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
};

/** 必填的 id：只认纯数字正整数。 */
const requiredId = (value) => {
    const raw = String(value ?? '').trim();
    if (!/^\d{1,15}$/.test(raw)) return undefined;
    return positiveId(Number(raw));
};

/** 会话里的 uin；没有会话返回空串。 */
const numericUin = (cookieHeader) => {
    const uin = qqCookieUin(cookieHeader);
    return uin ? (Number(uin) || uin) : '';
};

/** 需要登录的那几条：没有 uin 就回 AUTH_REQUIRED。 */
const needsLogin = (where, cookieHeader) => (
    qqCookieUin(cookieHeader) ? null : qqAuthRequired(where)
);

// ---- 歌单分类 ----

/** 分类是 `get_hot_category`：上游给的是分组，每组里才是分类。 */
export async function readPlaylistCategories(cookieHeader) {
    const result = await qqMusicuCall(
        'music.web_category_svr', 'get_hot_category',
        { qq: '' },
        cookieHeader,
    );
    if (!result.ok) {
        return result.loginRequired ? qqAuthRequired('playlist-categories') : { code: 0, groups: [] };
    }
    const groups = listOf(dictOf(result.data).category).map((entry) => {
        const group = dictOf(entry);
        const categories = listOf(group.items).map((item) => {
            const id = positiveId(dictOf(item).item_id);
            return id === undefined ? null : { id, name: String(dictOf(item).item_name || '') };
        }).filter(Boolean);
        const groupId = positiveId(group.group_id);
        return categories.length && groupId !== undefined
            ? { id: groupId, name: String(group.group_name || ''), categories }
            : null;
    }).filter(Boolean);
    return { code: 0, groups };
}

// ---- 分类歌单 ----

/** 与推荐歌单同一套字段名；没有可用 tid 的跳过。 */
const toPlaylist = (entry) => {
    const item = dictOf(dictOf(entry).basic);
    const tid = positiveId(item.tid);
    if (tid === undefined) return null;
    const playCount = countOf(item.play_cnt);
    const cover = dictOf(item.cover);
    const creator = dictOf(item.creator);
    return {
        tid,
        title: String(item.title || ''),
        desc: String(item.desc || ''),
        picurl: [cover.big_url, cover.medium_url, cover.small_url, cover.default_url]
            .map(textOf).find((url) => url !== undefined) ?? '',
        ...(playCount === undefined ? {} : { play_cnt: playCount }),
        creator: {
            ...(creator.uin !== undefined ? { uin: creator.uin } : {}),
            ...(textOf(creator.nick) ? { nick: creator.nick } : {}),
            ...(textOf(creator.avatar) ? { avatar: creator.avatar } : {}),
        },
    };
};

/** `page` 对外从 1 起，上游减 1；total 只看 content.total_cnt。 */
export async function readCategoryPlaylists(params, cookieHeader) {
    const id = requiredId(params.id);
    if (id === undefined) return { code: 0, playlists: [] };
    const page = pageSizeOf(params.page, 1);
    const size = pageSizeOf(params.limit, 20, 40);
    const result = await qqMusicuCall(
        'music.playlist.PlayListCategory', 'get_category_content',
        { caller: '0', category_id: id, page: page - 1, size, use_page: 1 },
        cookieHeader,
        { uin: 0 },
    );
    if (!result.ok) {
        return result.loginRequired ? qqAuthRequired('category-playlists') : { code: 0, playlists: [] };
    }
    const data = dictOf(result.data);
    const content = dictOf(data.content);
    const playlists = listOf(content.v_item).map(toPlaylist).filter(Boolean);
    const total = countOf(content.total_cnt);
    return {
        code: 0,
        playlists,
        ...(total === undefined ? {} : { total }),
        more: total !== undefined && page * size < total,
    };
}

// ---- 新歌速递 ----

/** 上游的「最新」是地区 5；`lanlist` 是地区清单。 */
const DEFAULT_NEW_SONG_AREA = 5;

/** 歌曲条目原样交出去（与 track_info 同形），由前端自己正规化。 */
export async function readNewSongs(params, cookieHeader) {
    const area = params.area === undefined || params.area === null || params.area === ''
        ? DEFAULT_NEW_SONG_AREA
        : (requiredId(params.area) ?? DEFAULT_NEW_SONG_AREA);
    const result = await qqMusicuCall(
        'newsong.NewSongServer', 'get_new_song_info',
        { type: area },
        cookieHeader,
    );
    if (!result.ok) {
        return result.loginRequired ? qqAuthRequired('new-songs') : { code: 0, songs: [], areas: [] };
    }
    const data = dictOf(result.data);
    const areas = listOf(data.lanlist).map((entry) => {
        const id = positiveId(dictOf(entry).type);
        return id === undefined ? null : { id, name: String(dictOf(entry).name || '') };
    }).filter(Boolean);
    return { code: 0, area: positiveId(data.type) ?? area, songs: listOf(data.songlist), areas };
}

// ---- 新碟上架 ----

/** 地区清单没有「最新」，默认 1；专辑翻页用 `start`，`sin` 一律 0。 */
const DEFAULT_NEW_ALBUM_AREA = 1;

const toAlbum = (entry) => {
    const item = dictOf(entry);
    const mid = textOf(item.mid);
    if (mid === undefined) return null;
    const trackCount = countOf(dictOf(item.ex).track_nums);
    return {
        mid,
        name: String(item.name || ''),
        singers: listOf(item.singers).map((singer) => {
            const singerMid = textOf(dictOf(singer).mid);
            return singerMid === undefined ? null : { mid: singerMid, name: String(dictOf(singer).name || '') };
        }).filter(Boolean),
        ...(positiveId(item.id) === undefined ? {} : { id: positiveId(item.id) }),
        ...(textOf(item.release_time) === undefined ? {} : { publishDate: textOf(item.release_time) }),
        ...(trackCount === undefined ? {} : { trackCount }),
    };
};

/** 两支放在同一次请求里：地区清单读不到不影响专辑。 */
export async function readNewAlbums(params, cookieHeader) {
    const area = params.area === undefined || params.area === null || params.area === ''
        ? DEFAULT_NEW_ALBUM_AREA
        : (requiredId(params.area) ?? DEFAULT_NEW_ALBUM_AREA);
    const start = offsetOf(params.offset);
    const size = pageSizeOf(params.limit, 20, 40);
    const [areas, albums] = await qqMusicuBatch([
        {
            module: 'newalbum.NewAlbumServer',
            method: 'get_new_album_area',
            param: {},
        },
        {
            module: 'newalbum.NewAlbumServer',
            method: 'get_new_album_info',
            param: { area, sin: 0, start, num: size },
        },
    ], cookieHeader);
    if (!albums.ok) {
        return albums.loginRequired ? qqAuthRequired('new-albums') : { code: 0, albums: [], areas: [] };
    }
    const data = dictOf(albums.data);
    const entries = listOf(data.albums);
    const total = countOf(data.total);
    return {
        code: 0,
        area,
        albums: entries.map(toAlbum).filter(Boolean),
        areas: areas.ok ? listOf(dictOf(areas.data).area).map((entry) => {
            const id = positiveId(dictOf(entry).id);
            return id === undefined ? null : { id, name: String(dictOf(entry).name || '') };
        }).filter(Boolean) : [],
        ...(total === undefined ? {} : { total }),
        more: total !== undefined && start + entries.length < total,
    };
}

// ---- 排行榜 ----

/** 榜单的公开资料；缺字段或型别不对的就不给。 */
const toChart = (entry) => {
    const item = dictOf(entry);
    const id = positiveId(item.topId);
    if (id === undefined) return null;
    const optional = [
        ['intro', textOf(item.intro)],
        ['period', textOf(item.period)],
        ['updateType', countOf(item.updateType)],
        ['updateTime', textOf(item.updateTime)],
        ['total', countOf(item.totalNum)],
        ['listenNum', countOf(item.listenNum)],
        ['cover', textOf(item.headPicUrl) ?? textOf(item.frontPicUrl) ?? textOf(item.musichallPicUrl)],
    ];
    return {
        id,
        title: String(item.title || ''),
        ...Object.fromEntries(optional.filter(([, value]) => value !== undefined)),
    };
};

const toPreview = (entry) => {
    const item = dictOf(entry);
    const rank = positiveId(item.rank);
    return rank === undefined
        ? null
        : { rank, title: String(item.title || ''), singer: String(item.singerName || '') };
};

/** 清单是 `GetAll`（分组 → 榜），每组带几首预览。 */
export async function readToplists(cookieHeader) {
    const result = await qqMusicuCall(
        'musicToplist.ToplistInfoServer', 'GetAll',
        {},
        cookieHeader,
    );
    if (!result.ok) {
        return result.loginRequired ? qqAuthRequired('toplists') : { code: 0, groups: [] };
    }
    const groups = listOf(dictOf(result.data).group).map((entry) => {
        const group = dictOf(entry);
        const charts = listOf(group.toplist).map((item) => {
            const info = toChart(item);
            if (!info) return null;
            return { ...info, preview: listOf(dictOf(item).song).map(toPreview).filter(Boolean) };
        }).filter(Boolean);
        const groupId = positiveId(group.groupId);
        return charts.length && groupId !== undefined
            ? { id: groupId, name: String(group.groupName || ''), toplists: charts }
            : null;
    }).filter(Boolean);
    return { code: 0, groups };
}

/** 单榜是 `GetDetail`；参数要全小写的 `topid`，大写的 `topId` 会被忽略。 */
export async function readToplistSongs(params, cookieHeader) {
    const id = requiredId(params.id);
    if (id === undefined) return { code: 0, songs: [] };
    const rawPeriod = params.period === undefined || params.period === null ? '' : String(params.period);
    if (!/^[0-9_-]{0,20}$/.test(rawPeriod)) return { code: 0, songs: [] };
    const offset = offsetOf(params.offset);
    const size = pageSizeOf(params.limit, 20, 100);
    const result = await qqMusicuCall(
        'musicToplist.ToplistInfoServer', 'GetDetail',
        { topid: id, offset, num: size, period: rawPeriod },
        cookieHeader,
    );
    if (!result.ok) {
        return result.loginRequired ? qqAuthRequired('toplist') : { code: 0, songs: [] };
    }
    const data = dictOf(result.data);
    const info = toChart(data.data);
    if (!info) return { code: 0, songs: [] };
    const songs = listOf(data.songInfoList);
    const total = countOf(info.total);
    return {
        code: 0,
        toplist: info,
        songs,
        ...(total === undefined ? {} : { total }),
        more: total !== undefined && offset + songs.length < total,
    };
}

// ---- 刷歌模式（雷达） ----

/** 歌在 `VecSongs[].Track`；`HasMore` 是布尔。 */
export async function readRadar(params, cookieHeader) {
    const parsed = Number.parseInt(String(params.page ?? ''), 10);
    const page = Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(100, parsed) : 1;
    const result = await qqMusicuCall(
        'music.recommend.TrackRelationServer', 'GetRadarSong',
        { Page: page, ReqType: 0, FavSongs: [], EntranceSongs: [] },
        cookieHeader,
    );
    if (!result.ok) {
        return result.loginRequired ? qqAuthRequired('radar') : { code: 0, songs: [] };
    }
    const data = dictOf(result.data);
    const entries = listOf(data.VecSongs);
    /*
     * 上游把曲目放在 `Track` 里，但不同版本字段名换过（track / TrackInfo / 也有直接平铺的），
     * 曲目 id 也不一定叫 `mid`。只认 `Track.mid` 会在上游换名时把整栏刷歌模式缩成 0～1 首 ——
     * 探索页第一页只剩这一栏时，用户看到的就是「页面是空的」。
     */
    const songs = entries.map((entry) => {
        const box = dictOf(entry);
        const track = dictOf(box.Track || box.track || box.TrackInfo || box.track_info || box);
        const mid = textOf(track.mid) ?? textOf(track.songmid) ?? textOf(track.songMid);
        return mid === undefined ? null : { ...track, mid };
    }).filter(Boolean);
    // 上游只给 1 首时，报告里要能直接看出是「上游就给了这么点」还是「我们把字段认丢了」。
    noteLibraryStep('qq', 'radar:decode', { entries: entries.length, songs: songs.length });
    return { code: 0, page, songs, more: data.HasMore === true };
}

// ---- 电台 ----

/** 猜你喜欢（id 99）走自己的接口，其他电台走 `GetRadiosonglist`。 */
const PERSONAL_RADIO_ID = 99;

const toRadio = (entry) => {
    const radio = dictOf(entry);
    const id = positiveId(radio.id);
    if (id === undefined) return null;
    const listenNum = countOf(radio.listenNum);
    return {
        id,
        title: String(radio.title || ''),
        picurl: String(radio.pic_url || ''),
        ...(listenNum === undefined ? {} : { listenNum }),
    };
};

/** 清单是 `GetRadiolist`（分组 → `list[]` 电台）。空分组（还没听过的「最近」）照样保留。 */
export async function readRadioList(cookieHeader) {
    const login = needsLogin('radio-list', cookieHeader);
    if (login) return login;
    const result = await qqMusicuCall(
        'pf.radiosvr', 'GetRadiolist',
        { uin: numericUin(cookieHeader) },
        cookieHeader,
    );
    if (!result.ok) {
        return result.loginRequired ? qqAuthRequired('radio-list') : { code: 0, groups: [] };
    }
    const groups = listOf(dictOf(result.data).radio_list).map((entry) => {
        const group = dictOf(entry);
        const id = positiveId(group.id);
        if (id === undefined) return null;
        return {
            id,
            title: String(group.title || ''),
            radios: listOf(group.list).map(toRadio).filter(Boolean),
        };
    }).filter(Boolean);
    return { code: 0, groups };
}

/** 一次给一批（约 9 首），没有下一页。 */
export async function readRadioTracks(params, cookieHeader) {
    const login = needsLogin('radio-tracks', cookieHeader);
    if (login) return login;
    const id = requiredId(params.id);
    if (id === undefined) return { code: 0, songs: [] };
    const result = id === PERSONAL_RADIO_ID
        ? await qqMusicuCall(
            'music.radioProxy.MbTrackRadioSvr', 'get_radio_track',
            { id: PERSONAL_RADIO_ID, firstplay: 1, num: 15 },
            cookieHeader,
        )
        : await qqMusicuCall(
            'pf.radiosvr', 'GetRadiosonglist',
            { id, firstplay: 0, num: 9 },
            cookieHeader,
        );
    if (!result.ok) {
        return result.loginRequired ? qqAuthRequired('radio-tracks') : { code: 0, songs: [] };
    }
    const data = dictOf(result.data);
    return {
        code: 0,
        songs: listOf(data.tracks && data.tracks.length ? data.tracks : data.track_list),
        ...(Array.isArray(data.extras) ? { extras: data.extras } : {}),
    };
}

// ---- 相似歌曲 ----

/** 匿名时上游回 code 0 但清单是空的，所以这条要登录；资料在 `vecSongNew[].songs[].track`。 */
export async function readSimilarSongs(params, cookieHeader) {
    const login = needsLogin('similar-songs', cookieHeader);
    if (login) return login;
    const songId = requiredId(params.id);
    if (songId === undefined) return { code: 0, songs: [] };
    const result = await qqMusicuCall(
        'music.recommend.TrackRelationServer', 'GetSimilarSongs',
        { songid: songId },
        cookieHeader,
    );
    if (!result.ok) {
        return result.loginRequired ? qqAuthRequired('similar-songs') : { code: 0, songs: [] };
    }
    const rows = listOf(dictOf(result.data).vecSongNew)
        .flatMap((group) => listOf(dictOf(group).songs));
    const songs = rows
        .map((row) => dictOf(row).track)
        .filter((track) => typeof dictOf(track).mid === 'string' && dictOf(track).mid.length > 0);
    return { code: 0, songs };
}

// ---- 会员等级 ----

/** 只有三级：HugeVip 为 1 是超级会员；为 0 时 iVipFlag 为 1 是绿钻、为 0 是免费。 */
const vipLevelOf = (flags) => {
    if (flags.HugeVip === 1) return 'super';
    if (flags.HugeVip !== 0) return 'unknown';
    if (flags.iVipFlag === 1) return 'green';
    return flags.iVipFlag === 0 ? 'free' : 'unknown';
};

/** 已观察的会员旗标按原值保留；账号与未知字段不带出去。 */
const VIP_FIELDS = [
    'iVipFlag', 'iSuperVip', 'iNewSuperVip', 'iNewVip', 'HugeVip', 'AdVipFlag', 'AdActiveFlag',
    'AdSigned', 'AdGotVipTs', 'MainAdsFreeEndTs', 'OverseaFlag', 'iYellowVip', 'iMusicLevel',
    'iCurLevel', 'UnionFreeEndTs', 'SongTiyanEndts',
];

export async function readUserVip(cookieHeader) {
    const login = needsLogin('user-vip', cookieHeader);
    if (login) return login;
    const uin = numericUin(cookieHeader);
    const result = await qqMusicuCall(
        'userInfo.VipQueryServer', 'SRFVipQuery_V2',
        { uin_list: [uin] },
        cookieHeader,
    );
    if (!result.ok) {
        return result.loginRequired ? qqAuthRequired('user-vip') : { code: 0, vipLevel: 'unknown' };
    }
    const info = dictOf(dictOf(dictOf(result.data).infoMap)[uin]);
    if (typeof info.iVipFlag !== 'number' || !Number.isSafeInteger(info.iVipFlag)) {
        return { code: 0, vipLevel: 'unknown' };
    }
    const upstream = Object.fromEntries(VIP_FIELDS.flatMap((key) => (
        typeof info[key] === 'string' || typeof info[key] === 'boolean'
        || (typeof info[key] === 'number' && Number.isFinite(info[key]))
            ? [[key, info[key]]] : []
    )));
    return { code: 0, isVip: info.iVipFlag === 1, vipLevel: vipLevelOf(upstream), upstream };
}

// ---- 音乐云盘 ----

/** 上游的页长；外面要的分页在本地切，所以一般一次请求只打一次上游。 */
const CLOUD_PAGE_SIZE = 2000;
/** 最多接着读几页（2 万首）。 */
const CLOUD_MAX_PAGES = 10;
/** 这个值表示按原文件处理、不是曲库里的歌，放不了。 */
const MATCHED_ORIGINAL_FILE = 2;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$|^[A-Za-z0-9+/]{2}==$|^[A-Za-z0-9+/]{3}=$/;

/** 文件名是 base64 编码的 UTF-8；解不出来就照原样给，不猜别的编码。 */
const cloudFileNameOf = (value) => {
    if (typeof value !== 'string') return '';
    if (!BASE64.test(value)) return value;
    try {
        const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        // 文件名里不该有控制字符。
        return decoded && !/[\u0000-\u001f\u007f]/.test(decoded) ? decoded : value;
    } catch (_) {
        return value;
    }
};

/** 只交出歌曲、文件名、加入时间和能不能播；文件 id 与上传用的字段不带出去。 */
const toCloudSong = (entry) => {
    const row = dictOf(entry);
    const song = dictOf(row.song_info);
    const mid = typeof song.mid === 'string' ? song.mid.trim() : '';
    const addTime = typeof row.timestamp === 'number' && Number.isSafeInteger(row.timestamp)
        && row.timestamp > 0 ? (row.timestamp < 1e11 ? row.timestamp * 1000 : row.timestamp) : null;
    return {
        song: row.song_info,
        fileName: cloudFileNameOf(row.filename),
        addTime,
        playable: mid !== '' && row.matched !== MATCHED_ORIGINAL_FILE,
    };
};

export async function readUserCloud(params, cookieHeader) {
    const login = needsLogin('user-cloud', cookieHeader);
    if (login) return login;
    const offset = Math.max(0, offsetOf(params.offset));
    const limit = Math.min(1000, Math.max(1, Number.parseInt(String(params.limit ?? ''), 10) || 200));
    const uin = numericUin(cookieHeader);
    const entries = [];
    let total;
    let hasMore = true;
    for (let page = 1; page <= CLOUD_MAX_PAGES && hasMore; page += 1) {
        const result = await qqMusicuCall(
            'music.WeiyunMusic.WeiyunMusicRead', 'GetMatchAudio',
            { uin, file_id: '', page_no: page, page_size: CLOUD_PAGE_SIZE },
            cookieHeader,
        );
        if (!result.ok) {
            // 第一页就读不出来才是失败；已经读到一些就交出这些。
            return entries.length
                ? { code: 0, data: [], count: entries.length, hasMore: false }
                : (result.loginRequired ? qqAuthRequired('user-cloud') : { code: 0, data: [], count: 0 });
        }
        const data = dictOf(result.data);
        if (total === undefined) total = countOf(data.total);
        entries.push(...listOf(data.info_list));
        hasMore = data.has_more === 1 && listOf(data.info_list).length > 0;
        if (entries.length >= offset + limit) break;
    }
    /*
     * 总数有两种情况，不能混成一个数（issue H31）。
     *
     * 服务端给了 total 就用它；没给的时候以前是 `Math.max(total ?? 0, entries.length)` ——
     * 把「已经读到的条数」当成总数交出去。于是调用方看到 count 恰好等于本页条数，判定
     * 「没有更多了」，列表被静默截断在这一次读到的量上。
     *
     * 现在分成两个字段：count 是**知道的**总数（未知就是已读条数，别处拿来显示没关系），
     * hasMore 单独按服务端的 has_more 与是否取满来判断，不再被 count 带偏。
     */
    const knownTotal = typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null;
    const count = knownTotal != null ? Math.max(knownTotal, entries.length) : entries.length;
    const slice = entries.slice(offset, offset + limit)
        .filter((entry) => entry && typeof entry === 'object')
        .map(toCloudSong);
    const end = Math.min(offset + limit, entries.length);
    /*
     * 还有没有更多：
     *   · 这一页是截出来的（end 还没读到 entries 末尾）→ 有；
     *   · 读到末尾了 → 看服务端最后一页的 has_more，**不要**跟 count 比：
     *     总数未知时 count 就是已读条数，比一下永远「没了」，那正是列表被截断的病根。
     */
    const reachedEnd = end >= entries.length;
    return {
        code: 0,
        data: slice,
        count,
        hasMore: reachedEnd ? Boolean(hasMore) : true,
    };
}

// ---- 建自己的歌单 ----

/** 写入回包要 `retCode` 为 0 才算成功。 */
const playlistWriteResult = (data) => {
    const result = dictOf(data);
    if (result.retCode !== 0 || !dictOf(result.result).tid) return null;
    return result.result;
};

/**
 * 建一张空歌单：写一次、从自建清单读回才回成功。读不回来说失败而不重送 ——
 * 可能已经建好了，重送会建出第二张。名称用读回来的那个。
 */
export async function createPlaylist(params, cookieHeader) {
    const login = needsLogin('playlist-create', cookieHeader);
    if (login) return login;
    const name = String(params.name ?? '').trim();
    if (!name || [...name].length > 20) {
        return { __foliaBridgeError: 'UNSUPPORTED', message: 'QQ playlist create: bad name' };
    }
    const uin = numericUin(cookieHeader);
    const write = await qqMusicuCall(
        'music.musicasset.PlaylistBaseWrite', 'AddPlaylist',
        { dirName: name },
        cookieHeader,
    );
    if (!write.ok) {
        return write.loginRequired
            ? qqAuthRequired('playlist-create')
            : qqBridgeFailure('playlist-create', write.code);
    }
    const written = playlistWriteResult(write.data);
    const tid = positiveId(written && written.tid);
    const dirId = positiveId(written && written.dirId);
    if (tid === undefined || dirId === undefined || dirId >= 200) {
        return qqBridgeFailure('playlist-create', (write.data && write.data.retCode) || 'unconfirmed');
    }
    const owned = await qqMusicuCall(
        'music.musicasset.PlaylistBaseRead', 'GetPlaylistByUin',
        { uin },
        cookieHeader,
    );
    if (owned.ok) {
        const row = listOf(dictOf(owned.data).v_playlist)
            .find((item) => positiveId(dictOf(item).tid) === tid);
        if (row && typeof dictOf(row).dirName === 'string') {
            return { code: 0, tid, dirId, name: dictOf(row).dirName, verified: true };
        }
    }
    // 写了但读不回来：把写回包里的 tid / dirId 交出去，前端据此报错，不重送。
    return { code: 0, tid, dirId, name, verified: false };
}

// ---- 关键字搜索 ----

const SEARCH_TYPES = { song: 0, singer: 1, album: 2, playlist: 3 };
/** 精简版把各类型的条目直接放在 `body` 下的数组里；歌手那组没有 `item_` 前缀。 */
const SEARCH_LIST_KEYS = {
    song: 'item_song', singer: 'singer', album: 'item_album', playlist: 'item_songlist',
};
/** 不登录搜歌要送 7：上游已经不认 0，送 0 一律回 2001。带会话照旧送 0。 */
const ANONYMOUS_SONG_SEARCH_TYPE = 7;
/** 精简版客户端的匿名身份：只放协议需要的应用与版本常数，不带设备指纹。 */
const ANONYMOUS_LITE_COMM = {
    ct: 11, cv: '1003006', v: '1003006', tmeAppID: 'qqmusiclight', nettype: 'NETWORK_WIFI', udid: '0', uid: '0',
};
/** 标头里的 `tmeLoginType=-1` 表示未登录。 */
const ANONYMOUS_LITE_COOKIE = 'tmeLoginType=-1';

/** 每次搜索带一个随机数字串；不需要密码学强度。 */
const searchIdOf = () => `${Math.floor(Math.random() * 9 + 1)}${Array.from(
    { length: 17 }, () => Math.floor(Math.random() * 10),
).join('')}`;

/**
 * 有会话就带会话搜（匿名搜歌常被上游以 2001 拒绝），没有会话用精简版的匿名身份。
 * 条目原样交出去（保留各种 MID），由前端自己正规化。
 */
export async function searchCatalog(params, cookieHeader) {
    const type = typeof params.type === 'string' && SEARCH_TYPES[params.type] !== undefined
        ? params.type : 'song';
    const keyword = String(params.keyword ?? '').trim();
    if (!keyword || keyword.length > 60) return { code: 0, type, items: [], more: false };
    const page = pageSizeOf(params.page, 1);
    const limit = pageSizeOf(params.limit, 10, 20);
    const signedIn = Boolean(qqCookieUin(cookieHeader));
    const result = await qqMusicuCall(
        'music.search.SearchCgiService', 'DoSearchForQQMusicLite',
        {
            search_id: searchIdOf(),
            remoteplace: 'search.android.keyboard',
            query: keyword,
            search_type: !signedIn && type === 'song' ? ANONYMOUS_SONG_SEARCH_TYPE : SEARCH_TYPES[type],
            num_per_page: limit,
            page_num: page,
            highlight: 0,
            nqc_flag: 0,
            page_id: 1,
            grp: 1,
        },
        signedIn ? cookieHeader : ANONYMOUS_LITE_COOKIE,
        signedIn ? undefined : ANONYMOUS_LITE_COMM,
    );
    if (!result.ok) {
        return result.loginRequired
            ? qqAuthRequired('search')
            : { code: 0, type, items: [], more: false };
    }
    const data = dictOf(result.data);
    const items = listOf(dictOf(data.body)[SEARCH_LIST_KEYS[type]])
        .filter((item) => item && typeof item === 'object');
    const meta = dictOf(data.meta);
    const total = countOf(meta.sum);
    return {
        code: 0,
        type,
        page,
        limit,
        items,
        ...(total === undefined ? {} : { total }),
        more: typeof meta.nextpage === 'number' && Number.isSafeInteger(meta.nextpage)
            && meta.nextpage > 0,
    };
}
