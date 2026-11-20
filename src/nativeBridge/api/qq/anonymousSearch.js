// src/nativeBridge/api/qq/anonymousSearch.js
//
// QQ 匿名搜索的**身份**：只有这一份（issue M27）。
//
// 同一条上游知识原先散在两处，各自记录着不同的实验结论：
//   · 这里（桥侧，安卓上探索页与歌词匹配真正走的那条）：`ANONYMOUS_LITE_COMM` /
//     `ANONYMOUS_LITE_COOKIE` / `ANONYMOUS_SONG_SEARCH_TYPE` 自建了一套；
//   · src/services/onlineMusic/qq/qqLyricProvider.ts（页面侧歌词匹配的直连）：把 comm 与
//     `search_type: 7` 又写了一遍。
// 任一侧被改，另一侧不会有人发现 —— 而它们对的是同一条上游，身份不同就是两个不同的实验。
//
// 现在两侧都从这里取。放在桥侧目录而不是 src/services/onlineMusic/qq/：
//   · 页面侧的 qqLyricProvider.ts 本来就要能在非 Electron 环境里跑（它是 web 与安卓共用的），
//     从这里 import 一个纯常数表不需要任何 Electron / Capacitor 能力；
//   · 反过来让桥 import 页面侧模块会把 UI 侧代码拉进桥的打包，方向是错的。
// 待确认条件的答案在这里落地：安卓上探索页的搜索走的是桥侧 `searchCatalog`，页面侧的
// `searchQQSongs` 只服务于歌词匹配 —— 所以常数放在桥侧，两侧共用同一份。
//
// 不在这个文件里做的事：不负责请求、不负责「被拒」的语义。被上游拒绝时，桥侧回
// `__foliaBridgeError: 'NETWORK'`（M25），页面侧抛 OnlineProviderError —— 两侧都不退化成
// 空清单，这是它们唯一一致的约定。

/**
 * 不登录搜歌要送 7：上游已经不认 0，送 0 一律回 2001（2026-10-17 实测，见 #695）。
 * 带会话时照旧送 0 —— 7 只是匿名时的替代品（#473 记录过匿名被周期性拒绝的对照）。
 */
export const ANONYMOUS_SONG_SEARCH_TYPE = 7;

/**
 * 精简版客户端的匿名身份：只放协议需要的应用与版本常数，**不带设备指纹**
 * （os_ver / phonetype / rom 这些是页面侧那份手抄的客户端字段，这里不跟）。
 */
export const ANONYMOUS_LITE_COMM = {
    ct: 11,
    cv: '1003006',
    v: '1003006',
    tmeAppID: 'qqmusiclight',
    nettype: 'NETWORK_WIFI',
    udid: '0',
    uid: '0',
};

/** 标头里的 `tmeLoginType=-1` 表示未登录。 */
export const ANONYMOUS_LITE_COOKIE = 'tmeLoginType=-1';

/** 精简版搜索一次最多收几个字；两侧都按它截断关键词。 */
export const LITE_SEARCH_MAX_KEYWORD_LENGTH = 60;

/** 每次搜索带一个随机数字串；不需要密码学强度。 */
export const liteSearchIdOf = () => `${Math.floor(Math.random() * 9 + 1)}${Array.from(
    { length: 17 }, () => Math.floor(Math.random() * 10),
).join('')}`;

/**
 * 精简版 `DoSearchForQQMusicLite` 的参数模板。两侧共用，免得一份多 `page_id`、另一份少
 * `grp` 这种漂移再出现。
 */
export const liteSearchParams = ({
    keyword,
    page,
    limit,
    searchType,
    id = liteSearchIdOf(),
}) => ({
    search_id: id,
    remoteplace: 'search.android.keyboard',
    query: String(keyword ?? '').slice(0, LITE_SEARCH_MAX_KEYWORD_LENGTH),
    search_type: searchType,
    num_per_page: limit,
    page_num: page,
    highlight: 0,
    nqc_flag: 0,
    page_id: 1,
    grp: 1,
});
