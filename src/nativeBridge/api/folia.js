import { eapiRequest } from './eapi.js';
import { weapiRequest, UA } from './weapi.js';
// 游客会话：桌面端由内嵌后端注册，安卓这边原先只回一个空 cookie，后面每个 weapi 请求
// 于是都不带 cookie（csrf_token 取不到，上游一律答 301），探索页每一栏都是空的。
// 具体实现放在这一家自己的目录下（桥的配额只数共享文件里出现的平台名）。
import { registerAnonymousCookie } from './netease/anonimous.js';
import { clearSessionOnLogout } from './netease/logout.js';
import { noteLibraryStep, describePayload } from './libraryTrace.js';
import {
  getNeteaseCookie,
  hasNeteaseLogin,
  parseCookieString,
  qqCookieUin,
} from './cookies.js';
import {
  getLoginInfo,
  handleLoginQrCheck,
  handleLoginQrCreate,
  handleLoginQrKey,
  handleSongLike,
  handleSongLikeCheck,
  handleSongUrl,
  handleLyric,
} from './netease.js';
import {
  getQQCookie,
  getQQLoginStatus,
  handleQQLoginQrCreate,
  handleQQLoginQrCheck,
  handleQQSearch,
  handleQQSongUrl,
  handleQQLyric,
  handleQQUserPlaylists,
  handleQQPlaylistTracks,
  qqSongDetail,
  qqMusicRequest,
  qqGetJSON,
  buildQQAuthComm,
  qqSongDetailsBatch,
  handleQQGuessYouLike,
  handleQQDailySongs,
  handleQQRecommendPlaylists,
  handleQQPlaylistTracksWrite,
  handleQQPlaylistSubscribe,
  handleQQSubscriptionStatus,
  handleQQSongLikeWrite,
  handleQQAlbumSubscribe,
  readNewSongs,
  readNewAlbums,
  readToplists,
  readToplistSongs,
  readPlaylistCategories,
  readCategoryPlaylists,
  readRadar,
  readRadioList,
  readRadioTracks,
  readSimilarSongs,
  readUserVip,
  readUserCloud,
  createPlaylist,
  searchCatalog,
} from './qq.js';
import {
  qqWechatGetLoginQr,
  qqWechatCheckLoginQr,
  qqWechatCancelLoginQr,
} from './qq-wechat-login.js';
import {
  qqAppGetLoginQr,
  qqAppCheckLoginQr,
  qqAppCancelLoginQr,
} from './qq/appLogin.js';
import { clearQQPlatformSessionCookies } from './qq-login-qr.js';
import {
  claimKGYouthDayVip,
  clearKGSessionOnLogout,
  ensureKGCookie,
  getKGYouthUnionVip,
  getKGLoginStatus,
  getKGUserVipDetail,
  handleKGArtistDetail,
  handleKGEverydayHistory,
  handleKGEverydayRecommend,
  handleKGLoginQrCheck,
  handleKGLoginQrCreate,
  handleKGLoginQrKey,
  handleKGLyric,
  handleKGPersonalFm,
  handleKGPlaylistTracks,
  handleKGSearch,
  handleKGTopCardYouth,
  handleKGSongUrl,
  handleKGUserPlaylists,
  searchKGLyricCandidates,
  downloadKGLyricByCandidate,
  kgPostAndroidSigned,
  upgradeKGYouthDayVip,
  handlePlaylistAdd,
  handlePlaylistDel,
  handlePlaylistTracksAdd,
  handlePlaylistTracksDel,
} from './kugou.js';
import { handleBodianRequest } from './bodian.js';

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value) !== '') return value;
  }
  return '';
}

function numberValue(...values) {
  const value = Number(firstValue(...values));
  return Number.isFinite(value) ? value : 0;
}

function parseInput(input) {
  const url = new URL(String(input?.path || input?.operation || '/'), 'https://folia.local');
  Object.entries(input?.query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  });
  let body = input?.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (_) {
      body = {};
    }
  }
  if (!body || typeof body !== 'object') body = {};
  return { url, body, method: String(input?.method || 'GET').toUpperCase() };
}

// 探索页这一组请求的路径（见下面 --- Explore --- 那段）：留痕用，
// 页面空的时候先看诊断里有没有这几条。
const EXPLORE_PATHS = new Set([
  '/homepage/block/page',
  '/recommend/resource',
  '/toplist',
  '/simi/song',
  '/top/song',
  '/album/new',
  '/top/playlist',
]);

// 听歌档案那几条读接口的路径（见下面 --- 听歌档案 --- 那段）：与探索页一样留痕，
// 页面空着的时候先看诊断里有没有这几条。
const ARCHIVE_PATHS = new Set([
  '/user/record',
  '/listen/data/total',
  '/listen/data/realtime/report',
]);

async function eapiJson(path, data, cookie) {
  const result = await eapiRequest(path, data || {}, cookie || '');
  const body = result?.body || {};
  if (result?.status >= 500) {
    throw new Error(body.message || body.msg || `Netease EAPI ${path} failed (${result.status})`);
  }
  return body;
}

/*
 * 走 weapi（网页端那套）而不是 eapi：下面「探索页」那一组在桌面端的内嵌后端里就是 weapi
 * （那份后端的同名模块里写的），安卓这边必须答出同样的形状，
 * 否则会出现「桌面能显示、安卓读不到」。
 *
 * 顺手补上 csrf_token —— weapi 这几个接口认它，缺了会答 `{code: 301}` 之类。
 * 这里**不抛错**：探索页要自己看 code（比如登录失效的 301 是「这一栏不显示」而不是
 * 整页失败），抛了反而把它变成了读不出来。
 */
/*
 * 未加密的 /api/ 网关兜底：同一条路径，参数挂在 query 上，cookie 走请求头。
 *
 * 它当初是**主路径**：那时 `weapi.js` 的 `RSA_MODULUS` 被写坏，weapi 一律答
 * 「HTTP 200 + 空 body」，而未加密这条老网关还答得出内容（`toplist`、
 * `homepage/block/page`、`album/new`、`v1/discovery/new/songs`、
 * `v1/discovery/recommend/resource` 都实测过）。
 *
 * 模数已经在 2026-10-21 修好（见 `weapi.js` 里那个常量的注释），所以现在 weapi 才是主路径，
 * 这条降级为**第二道防线**：哪天 weapi 又答不出东西，读接口还有一条退路，界面不至于整页空白。
 * 走了哪条路会留痕（`api:fallback`），线上再空着时能一眼看出是网关没了还是会话没带上。
 */
async function plainApiJson(path, data, cookie) {
  const query = new URLSearchParams();
  Object.entries(data || {}).forEach(([key, value]) => {
    // csrf_token 是 weapi 那套自己要的，放到 query 上只是噪声。
    if (value == null || value === '' || key === 'csrf_token') return;
    query.set(key, String(value));
  });
  const search = query.toString();
  let body = {};
  try {
    const resp = await fetch(`https://music.163.com${path}${search ? `?${search}` : ''}`, {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        Referer: 'https://music.163.com/',
        Cookie: cookie || '',
        Accept: 'application/json',
      },
    });
    try {
      body = await resp.json();
    } catch (_) {
      body = {};
    }
  } catch (_) {
    body = {};
  }
  return body;
}

/** 什么都没答（空 body、非 JSON）＝网关这条路径没了，不是「没有内容」。 */
const isBlankAnswer = (answer) => !answer || typeof answer !== 'object' || Object.keys(answer).length === 0;

/**
 * 读一条：先走 weapi（主路径），答不出内容或会话不被认时改走未加密的 /api/。
 *
 * 只用于**读**（下面探索页那一组都是读）：写操作的路径不能靠 GET 兜底。兜底那条答不出
 * 内容时仍把 weapi 的原答案交回去 —— 于是最坏的情况与现在一样，不会更差。
 * 走了哪条路会留痕：线上再整页空着时，一眼看出是「网关没了」还是「会话没带」。
 */
async function readJson(path, data, cookie) {
  const answer = await weapiJson(path, data, cookie);
  if (!isBlankAnswer(answer) && answer.code !== 301 && answer.code !== 401 && answer.code !== 403) return answer;
  const plain = await plainApiJson(path, data, cookie);
  if (isBlankAnswer(plain)) return answer;
  noteLibraryStep('netease', 'api:fallback', { path, source: 'plain', code: answer?.code ?? null });
  return plain;
}

async function weapiJson(path, data, cookie) {
  const cookies = parseCookieString(cookie || '');
  const payload = Object.assign({}, data, { csrf_token: cookies.__csrf || '' });
  return await weapiRequest(path, payload, cookie || '');
}

/**
 * 听歌档案那几条读接口的统一出口（见下面 `--- 听歌档案 ---` 那段）。
 *
 * 上游答 5xx 时不再往外抛，回桥自己的错误码：抛出去会被上面那层一律当成 network
 * （「连不上，请稍后重试」），而这里其实是「上游没答对」，两者的排查方向完全不同。
 */
async function archiveAnswer(path, run) {
  try {
    return await run();
  } catch (error) {
    console.warn('[FoliaBridge] 听歌档案读取失败', path, error);
    return {
      __foliaBridgeError: 'NETWORK',
      path,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function profileFromLoginInfo(info) {
  if (!info?.loggedIn) return null;
  return {
    userId: info.userId || '',
    nickname: info.nickname || 'Netease User',
    avatarUrl: info.avatar || '',
    backgroundUrl: '',
    vipType: info.vipType || 0,
    vipLevel: info.vipLevel || 'none',
  };
}

async function requireLoginInfo(cookie) {
  return await getLoginInfo(cookie);
}

function jsonBody(body) {
  return body && typeof body === 'object' ? body : {};
}

function encodeBridgeKey(value) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(value || {}))));
}

function decodeBridgeKey(value) {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(String(value || '')))));
  } catch (_) {
    return {};
  }
}

/** 扫码通道归一：wechat 走微信 Web OAuth，app 走 QQ 音乐 App 那条（三合一），其余按 qq 处理。 */
function qqChannelOf(value) {
  const channel = String(value || '').toLowerCase();
  if (channel === 'wechat') return 'wechat';
  if (channel === 'qqmusic' || channel === 'app') return 'qqmusic';
  return 'qq';
}

/** 只回报主机名：头像 URL 里带着用户 hash，整条写进报告没有必要。 */
function describeUrlHost(value) {
  try {
    return new URL(String(value)).host || 'empty';
  } catch (_) {
    return 'unparseable';
  }
}

function qqProfile(status) {
  if (!status?.loggedIn) return null;
  return {
    uin: status.uin || status.userId || '',
    str_musicid: status.uin || status.userId || '',
    musicid: status.uin || status.userId || '',
    nickname: status.nickname || status.name || '',
    nick: status.nickname || status.name || '',
    logo: status.avatar || status.avatarUrl || '',
    avatarUrl: status.avatar || status.avatarUrl || '',
    vipType: status.vipType || 0,
  };
}

function qqPlaylistRow(item) {
  return {
    tid: item?.id,
    dirId: Number(item?.dirid || item?.dirId || 0) || undefined,
    dirName: item?.name || '',
    name: item?.name || '',
    songNum: Number(item?.trackCount || 0),
    songnum: Number(item?.trackCount || 0),
    bigpicUrl: item?.cover || '',
    picUrl: item?.cover || '',
    dirShow: 1,
    subscribed: !!item?.subscribed,
  };
}

function kgCollectionRow(item) {
  const data = item?.providerData || {};
  return {
    listid: data.listId || item?.id,
    list_id: data.listId || item?.id,
    global_collection_id: data.globalCollectionId || item?.id,
    specialid: data.specialId,
    name: item?.name || '',
    listname: item?.name || '',
    song_count: item?.trackCount,
    count: item?.trackCount,
    img: item?.coverUrl || '',
    cover: item?.coverUrl || '',
    type: item?.type === 'album' ? 1 : 0,
    source: item?.type === 'album' ? 2 : 1,
    is_pri: item?.isOwned ? 0 : 1,
    create_userid: data.creatorUserId,
    list_create_userid: data.creatorUserId,
    list_create_listid: data.creatorListId,
    list_create_gid: data.creatorGid,
  };
}

function mergeOperationParams(input, url) {
  return {
    ...Object.fromEntries(url.searchParams.entries()),
    ...(input?.params || {}),
    ...(input?.body && typeof input.body === 'object' ? input.body : {}),
  };
}

function pathSegments(url) {
  return String(url.pathname || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
}

function qqGtk(cookieHeader) {
  const cookie = parseCookieString(cookieHeader);
  const key = cookie.qm_keyst || cookie.qqmusic_key || cookie.skey || cookie.p_skey || '';
  if (!key) return 5381;
  let hash = 5381;
  for (let index = 0; index < key.length; index += 1) {
    hash += (hash << 5) + key.charCodeAt(index);
    hash &= 0x7fffffff;
  }
  return hash & 0x7fffffff;
}

async function handleLoginStatus(cookie) {
  const info = await requireLoginInfo(cookie);
  return {
    code: 200,
    data: {
      code: 200,
      account: info.loggedIn ? { id: info.userId || null } : null,
      profile: profileFromLoginInfo(info),
    },
  };
}

async function handleUserAccount(cookie) {
  const info = await requireLoginInfo(cookie);
  return {
    code: 200,
    account: info.loggedIn ? {
      id: info.userId || null,
      userName: info.nickname || '',
      type: 1,
      status: 0,
    } : null,
    profile: profileFromLoginInfo(info),
  };
}

async function handleSearch(url, cookie) {
  const keywords = String(firstValue(url.searchParams.get('keywords'), url.searchParams.get('s'))).trim();
  if (!keywords) return { code: 200, result: { songs: [], songCount: 0 } };
  const limit = Math.max(1, Math.min(100, numberValue(url.searchParams.get('limit'), 30)));
  const offset = Math.max(0, numberValue(url.searchParams.get('offset'), 0));
  /*
   * 搜什么：1 单曲（默认，URL 上可以不给）、10 专辑、1000 歌单。之前这里写死 1，
   * 于是安卓上专辑和歌单的搜索永远是空 —— 页面侧的 cloudSearch 把 type 拼进 URL，
   * 这一侧却只按单曲搜。每种的回答字段不同（songs / albums / playlists），
   * 按种类取列表、回种类的计数。
   */
  const searchType = numberValue(url.searchParams.get('type'), 1);
  const kindOf = (t) => (t === 10 ? 'albums' : t === 1000 ? 'playlists' : 'songs');
  const kind = kindOf(searchType);
  const body = await eapiJson('/api/cloudsearch/pc', {
    s: keywords,
    type: searchType,
    limit,
    offset,
    total: true,
  }, cookie);
  if (Array.isArray(body?.result?.[kind]) && body.result[kind].length > 0) return body;
  const fallback = await eapiJson('/api/search/pc', {
    s: keywords,
    type: searchType,
    limit,
    offset,
  }, cookie);
  if (Array.isArray(fallback?.result?.[kind]) && fallback.result[kind].length > 0) return fallback;

  const response = await fetch('https://music.163.com/api/search/get/web', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://music.163.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams({
      s: keywords,
      type: String(searchType),
      limit: String(limit),
      offset: String(offset),
      total: 'true',
    }).toString(),
  });
  if (!response.ok) return { code: response.status, result: { [kind]: [], songCount: 0, albumCount: 0, playlistCount: 0 } };
  const publicBody = await response.json();
  return publicBody?.result ? publicBody : { code: 200, result: { [kind]: [], songCount: 0, albumCount: 0, playlistCount: 0 } };
}

async function handleSongDetail(url, cookie) {
  const ids = String(firstValue(url.searchParams.get('ids'), url.searchParams.get('id')))
    .split(',')
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return { code: 200, songs: [], privileges: [] };
  const detail = await eapiJson('/api/v3/song/detail', {
    c: JSON.stringify(ids.map((id) => ({ id }))),
  }, cookie);
  return {
    ...detail,
    code: Number(detail.code) || 200,
    songs: Array.isArray(detail.songs) ? detail.songs : [],
    privileges: Array.isArray(detail.privileges) ? detail.privileges : [],
  };
}

async function handleSongUrlV1(url, cookie) {
  const ids = String(firstValue(url.searchParams.get('id'), url.searchParams.get('ids')))
    .split(',')
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isFinite(id) && id > 0);
  const level = String(firstValue(url.searchParams.get('level'), 'exhigh'));
  if (!ids.length) return { code: 200, data: [] };
  const data = await Promise.all(ids.map(async (id) => {
    const result = await handleSongUrl(id, cookie, level);
    return {
      id,
      url: result?.url || null,
      br: result?.br || 0,
      size: 0,
      md5: null,
      code: result?.url ? 200 : 404,
      expi: 1200,
      type: 'mp3',
      gain: 0,
      peak: 0,
      fee: 0,
      uf: null,
      payed: 0,
      flag: 0,
      canExtend: false,
      freeTrialInfo: result?.trial ? { start: 0, end: 0 } : null,
      level: result?.level || level,
      encodeType: 'mp3',
      channelLayout: null,
      freeTrialPrivilege: result?.restriction ? { resConsumable: false, userConsumable: false } : null,
      freeTimeTrialPrivilege: null,
      urlSource: 0,
      rightSource: 0,
      podcastCid: null,
      effectTypes: null,
      time: 0,
    };
  }));
  return { code: 200, data };
}

async function handleLyricNew(url, cookie) {
  const id = firstValue(url.searchParams.get('id'), url.searchParams.get('ids'));
  if (!id) return { code: 200, lrc: { lyric: '' }, tlyric: { lyric: '' }, yrc: { lyric: '' } };
  let body = {};
  try {
    body = await eapiJson('/api/song/lyric/v1', {
      id,
      cp: false,
      tv: 0,
      lv: 0,
      rv: 0,
      kv: 0,
      yv: 0,
      ytv: 0,
      yrv: 0,
    }, cookie);
  } catch (_) {
    const fallback = await handleLyric(id, cookie);
    body = {
      lrc: { lyric: fallback?.lyric || '' },
      tlyric: { lyric: fallback?.tlyric || '' },
      yrc: { lyric: fallback?.yrc || '' },
    };
  }
  return {
    ...body,
    code: Number(body.code) || 200,
    lrc: body.lrc || { lyric: '' },
    tlyric: body.tlyric || { lyric: '' },
    yrc: body.yrc || { lyric: '' },
  };
}

async function handleUserPlaylists(url, cookie) {
  const info = await requireLoginInfo(cookie);
  const uid = numberValue(url.searchParams.get('uid'), info.userId);
  if (!info.loggedIn || !uid) return { code: 200, playlist: [], more: false };
  const body = await eapiJson('/api/user/playlist', {
    uid,
    limit: numberValue(url.searchParams.get('limit'), 50),
    offset: numberValue(url.searchParams.get('offset'), 0),
  }, cookie);
  return {
    ...body,
    code: Number(body.code) || 200,
    playlist: Array.isArray(body.playlist) ? body.playlist : [],
  };
}

// 顺序一律按上游来：接口给什么顺序就往下传什么顺序，桥里不重排。
// （2026-10-13 撤掉了之前那版「按 trackIds 归位」—— 排序方法恢复上游，只有酷狗按
//  RemnantCloudGodofWar/folia-android 的修法单独处理。）

async function handlePlaylistDetail(url, cookie) {
  const id = firstValue(url.searchParams.get('id'), url.searchParams.get('pid'));
  if (!id) return { code: 200, playlist: null };
  const body = await eapiJson('/api/v6/playlist/detail', { id, n: 1000, s: 8 }, cookie);
  return { ...body, code: Number(body.code) || 200 };
}

async function handlePlaylistTrackAll(url, cookie) {
  const detail = await handlePlaylistDetail(url, cookie);
  const playlist = detail?.playlist || {};
  return {
    code: Number(detail.code) || 200,
    songs: Array.isArray(playlist.tracks) ? playlist.tracks : [],
    privileges: Array.isArray(playlist.privileges) ? playlist.privileges : [],
    playlist,
  };
}

async function handleArtistDetail(url, cookie) {
  const id = firstValue(url.searchParams.get('id'), url.searchParams.get('artistId'));
  if (!id) return { code: 200, data: null };
  const body = await eapiJson('/api/artist/head/info/get', { id }, cookie);
  return { ...body, code: Number(body.code) || 200 };
}

async function handleArtistTopSongs(url, cookie) {
  const id = firstValue(url.searchParams.get('id'), url.searchParams.get('artistId'));
  if (!id) return { code: 200, songs: [], privileges: [] };
  const body = await eapiJson('/api/artist/top/song', { id }, cookie);
  return {
    ...body,
    code: Number(body.code) || 200,
    songs: Array.isArray(body.songs) ? body.songs : [],
    privileges: Array.isArray(body.privileges) ? body.privileges : [],
  };
}

async function handleArtistSongs(url, cookie) {
  const id = firstValue(url.searchParams.get('id'), url.searchParams.get('artistId'));
  if (!id) return { code: 200, songs: [], privileges: [] };
  const body = await eapiJson('/api/v1/artist/songs', {
    id,
    order: String(firstValue(url.searchParams.get('order'), 'hot')),
    limit: numberValue(url.searchParams.get('limit'), 50),
    offset: numberValue(url.searchParams.get('offset'), 0),
  }, cookie);
  return {
    ...body,
    code: Number(body.code) || 200,
    songs: Array.isArray(body.songs) ? body.songs : [],
    privileges: Array.isArray(body.privileges) ? body.privileges : [],
  };
}

async function handleArtistAlbums(url, cookie) {
  const id = firstValue(url.searchParams.get('id'), url.searchParams.get('artistId'));
  if (!id) return { code: 200, hotAlbums: [], more: false };
  const body = await weapiJson(`/api/artist/albums/${id}`, {
    limit: numberValue(url.searchParams.get('limit'), 30),
    offset: numberValue(url.searchParams.get('offset'), 0),
    total: true,
  }, cookie);
  return {
    ...body,
    code: Number(body.code) || 200,
    hotAlbums: Array.isArray(body.hotAlbums) ? body.hotAlbums : [],
    more: !!body.more,
  };
}

async function handleAlbum(url, cookie) {
  const id = firstValue(url.searchParams.get('id'), url.searchParams.get('albumId'));
  if (!id) return { code: 200, album: null, songs: [] };
  const body = await weapiJson(`/api/v1/album/${id}`, {}, cookie);
  return {
    ...body,
    code: Number(body.code) || 200,
    songs: Array.isArray(body.songs) ? body.songs : [],
    privileges: Array.isArray(body.privileges) ? body.privileges : [],
  };
}

async function handleLikedList(url, cookie) {
  const info = await requireLoginInfo(cookie);
  if (!info.loggedIn || !info.userId) return { code: 200, ids: [] };
  const body = await weapiJson('/api/song/like/get', { uid: info.userId }, cookie);
  const ids = body?.ids || body?.data?.ids || [];
  return { ...body, code: Number(body.code) || 200, ids: Array.isArray(ids) ? ids : [] };
}

async function handleLike(url, body, cookie) {
  const id = firstValue(url.searchParams.get('id'), body.id);
  const like = String(firstValue(url.searchParams.get('like'), body.like, 'true')) !== 'false';
  return await handleSongLike(id, like, cookie);
}

async function handleLikeCheck(url, cookie) {
  const ids = String(firstValue(url.searchParams.get('ids'), url.searchParams.get('id')))
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return await handleSongLikeCheck(ids, cookie);
}

async function handleDailyRecommend(url, cookie) {
  const afresh = String(firstValue(url.searchParams.get('afresh'), 'false')) === 'true';
  const params = { limit: 30, offset: 0, total: true, n: 1000, ...(afresh ? { afresh: true } : {}) };
  // 每日推荐试两条上游路径、两种签名：不同客户端版本上 v3 eapi 可能被拒（code 400/301），
  // 旧接口或 weapi 仍能回同一批歌。全部失败才报错，并留痕说明试过哪些。
  const attempts = [
    { name: 'eapi-v3', run: () => eapiJson('/api/v3/discovery/recommend/songs', {}, cookie) },
    { name: 'weapi-v3', run: () => weapiJson('/api/v3/discovery/recommend/songs', params, cookie) },
    { name: 'eapi-legacy', run: () => eapiJson('/api/recommend/songs', {}, cookie) },
    { name: 'weapi-legacy', run: () => weapiJson('/api/recommend/songs', params, cookie) },
  ];
  const tried = [];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const body = await attempt.run();
      const songs = Array.isArray(body?.data?.dailySongs) ? body.data.dailySongs
        : Array.isArray(body?.dailySongs) ? body.dailySongs
          : Array.isArray(body?.songs) ? body.songs : [];
      noteLibraryStep('netease', 'explore:daily:source', { via: attempt.name, songs: songs.length, code: body?.code });
      return body;
    } catch (error) {
      tried.push(attempt.name);
      lastError = error;
    }
  }
  noteLibraryStep('netease', 'explore:daily:failed', { tried: tried.join(',') });
  throw lastError || new Error('Daily recommendation request failed');
}

async function handleHistoryRecommend(url, cookie) {
  const date = url.searchParams.get('date');
  const path = date ? '/api/history/recommend/songs/detail' : '/api/history/recommend/songs';
  return await eapiJson(path, date ? { date } : {}, cookie);
}

async function handlePersonalFm(url, cookie) {
  const mode = url.searchParams.get('mode');
  if (!mode || mode === 'DEFAULT') {
    return await eapiJson('/api/v1/radio/get', {}, cookie);
  }
  const body = { mode };
  const submode = url.searchParams.get('submode');
  if (submode) body.submode = submode;
  try {
    const result = await eapiJson('/api/personal/fm/mode', body, cookie);
    if (Array.isArray(result?.data) && result.data.length) return result;
  } catch (_) {}
  return await eapiJson('/api/v1/radio/get', {}, cookie);
}

async function handlePlaylistTracks(url, body, cookie) {
  const op = String(firstValue(url.searchParams.get('op'), body.op, 'add'));
  const pid = firstValue(url.searchParams.get('pid'), body.pid);
  const tracks = firstValue(url.searchParams.get('tracks'), body.tracks);
  return await eapiJson('/api/playlist/tracks', { op, pid, tracks }, cookie);
}

async function handleSubscribe(url, body, cookie, path) {
  const id = firstValue(url.searchParams.get('id'), body.id);
  const t = numberValue(url.searchParams.get('t'), body.t, 1);
  return await eapiJson(path, { id, t }, cookie);
}

async function handleFoliaQqRequest(input, url) {
  const operation = String(input.operation || url.pathname);
  const params = mergeOperationParams(input, url);
  const segments = pathSegments(url);
  const cookie = await getQQCookie();
  const cookieObject = parseCookieString(cookie || '');
  noteLibraryStep('qq', 'request', {
    operation,
    hasUin: Boolean(qqCookieUin(cookie || '')),
    hasMusicKey: Boolean(
      cookieObject.qm_keyst || cookieObject.qqmusic_key || cookieObject.music_key,
    ),
    cookieCount: String(cookie || '').split(';').filter(Boolean).length,
  });
  try {
    const result = await routeFoliaQqRequest(operation, params, segments, url, cookie);
    noteLibraryStep('qq', 'result', {
      operation,
      code: result && typeof result === 'object' ? result.code : undefined,
      songs: Array.isArray(result?.songs) ? result.songs.length : undefined,
      playlist: Array.isArray(result?.playlist) ? result.playlist.length : undefined,
      albums: Array.isArray(result?.albums) ? result.albums.length : undefined,
      total: result && typeof result === 'object' ? result.total : undefined,
      keys: describePayload(result && typeof result === 'object' ? result : null),
    });
    return result;
  } catch (error) {
    noteLibraryStep('qq', 'error', {
      operation,
      name: error && error.name ? error.name : 'Error',
      message: error && error.message ? error.message : String(error),
    });
    throw error;
  }
}

async function routeFoliaQqRequest(operation, params, segments, url, cookie) {

  if (operation === 'login_channels') {
    // 三条扫码通道都有：qq（ptlogin 网页码，只有手机 QQ 能扫）、wechat（微信 OAuth）、
    // qqmusic（QQ 音乐 App 的码，QQ音乐 App / 手机QQ / 微信 任一款都能扫）。
    // `sessionMode` 说会话存在本机（不是 Serverless 的 sealed 令牌）—— 前端据此认「桌面/Docker 那种
    // 后端」，于是不再让人先选通道，直接用三合一那张码。
    return { code: 200, data: { channels: ['qq', 'wechat', 'qqmusic'], sessionMode: 'stored' } };
  }
  if (operation === 'login_status') {
    const status = await getQQLoginStatus(cookie);
    const profile = qqProfile(status);
    // 「用户名 / 头像不显示」时，报告里必须能直接看出是登录态没认出来，还是上游资料页没给这两个字段。
    noteLibraryStep('qq', 'login-status:profile', {
      loggedIn: Boolean(status?.loggedIn),
      uinTail: status?.uin ? `…${String(status.uin).slice(-4)}` : 'missing',
      nickname: profile?.nickname ? `present(len=${String(profile.nickname).length})` : 'missing',
      avatar: profile?.logo ? describeUrlHost(profile.logo) : 'missing',
      source: status?.profileSource || 'unknown',
      profileUnavailable: Boolean(status?.profileUnavailable),
      missing: status?.missing
        ? Object.entries(status.missing).filter(([, absent]) => absent).map(([key]) => key).join(',') || 'none'
        : undefined,
    });
    return {
      code: 200,
      data: {
        profile,
        account: status?.loggedIn ? { id: status.uin || status.userId || null } : null,
      },
    };
  }
  if (operation === 'user_detail') {
    const status = await getQQLoginStatus(cookie);
    return { code: 200, profile: qqProfile(status) };
  }
  if (operation === 'logout') {
    // 登出必须连 cookie 罐里的平台凭据一起清掉：只清前端会话的话，
    // 下一条通道登录（微信 → QQ 这种）会把旧凭据当成自己的拼出一个用不了的会话。
    await clearQQPlatformSessionCookies();
    return { code: 200 };
  }
  if (operation === 'login_qr_key') {
    let channel = qqChannelOf(firstValue(params.channel, url.searchParams.get('channel')));
    let qr;
    if (channel === 'qqmusic') {
      // 三合一那张码要一条到 mu.y.qq.com 的 WebSocket（见 qq/appLogin.js）。WebView 里被拦、或上游
      // 拒收时不能让登录整个不可用：退回手机 QQ 的网页码，照样能登，只是那张码只认手机 QQ。
      try {
        qr = await qqAppGetLoginQr();
      } catch (error) {
        noteLibraryStep('qq', 'login-qr:app-fallback', {
          message: error && error.message ? error.message : String(error),
        });
        channel = 'qq';
        qr = await handleQQLoginQrCreate();
      }
    } else {
      qr = channel === 'wechat' ? await qqWechatGetLoginQr() : await handleQQLoginQrCreate();
    }
    const key = encodeBridgeKey({
      channel,
      qrsig: qr.qrsig,
      ptqrtoken: qr.ptqrtoken,
      qrimg: qr.qrimg || qr.img,
    });
    return { code: 200, data: { code: 200, unikey: key } };
  }
  if (operation === 'login_qr_create') {
    const key = decodeBridgeKey(firstValue(params.key, url.searchParams.get('key')));
    return {
      code: 200,
      data: {
        qrimg: key.qrimg || '',
        qrurl: '',
      },
    };
  }
  if (operation === 'login_qr_check') {
    const key = decodeBridgeKey(firstValue(params.key, url.searchParams.get('key')));
    const result = key.channel === 'wechat'
      ? await qqWechatCheckLoginQr({ qrsig: key.qrsig, ptqrtoken: key.ptqrtoken })
      : key.channel === 'qqmusic'
        ? await qqAppCheckLoginQr(key.qrsig)
        : await handleQQLoginQrCheck(key.qrsig, key.ptqrtoken);
    if (result?.isOk || result?.loggedIn) {
      /*
       * 803 必须**带着会话一起交出去**。
       *
       * 页面侧只认这个字段：qqTransport 的 persistConfirmedSession 与 qqProvider 的
       * checkLogin 都是 `code === 803` 时把 `response.cookie` 写进 localStorage。
       * 给空串等于「手机上明明确认了、会话却没存下」—— 紧接着的 user_detail 因为
       * hasQqSession() 为假直接跳过，诊断里就只剩那两行
       * `session: backend session stored=no` / `no backend session stored`。
       *
       * 换票拿到的 cookie 已经写进 jar 了（handleQQLoginQrCheck 里 saveProviderCookie），
       * 所以这里从 jar 读回一份完整的即可；换票那份能用就先用它。
       */
      const cookie = String(result?.session?.cookie || '').trim()
        || String((await getQQCookie()) || '').trim();
      return { code: 803, message: result.message || 'Login successful', cookie };
    }
    if (result?.refresh) return { code: 800, message: result.message || 'QR expired' };
    if (result?.status === 'scanned' || Number(result?.code) === 67 || Number(result?.code) === 802) {
      return { code: 802, message: result.message || 'Scanned' };
    }
    // 上游已经确认、换票却连续失败：这是终态错误，不能再当成「等待扫码」吞掉 ——
    // 否则界面会一直转圈，而手机上早就提示登录成功了。
    if (result?.retryable === false && result?.status === 'error') {
      return {
        code: 0,
        message: result.message || '登录失败',
        failureStage: result.failureStage,
        failureReason: result.failureReason,
        ticketExchangeAttempts: result.ticketExchangeAttempts,
      };
    }
    return { code: 801, message: result?.message || 'Waiting for scan' };
  }
  if (operation === 'login_qr_cancel') {
    const key = decodeBridgeKey(firstValue(params.key, url.searchParams.get('key')));
    if (key.channel === 'wechat') qqWechatCancelLoginQr(key.qrsig);
    if (key.channel === 'qqmusic') qqAppCancelLoginQr(key.qrsig);
    return { code: 200 };
  }
  if (operation === 'music_play') {
    const songmid = firstValue(params.songmid, segments[segments.length - 1]);
    const result = await handleQQSongUrl(
      songmid,
      firstValue(params.mediaId, params.media_mid),
      firstValue(params.quality, '320'),
      cookie,
    );
    return {
      code: 200,
      data: {
        playUrl: {
          [songmid]: {
            url: result?.url || '',
            error: result?.error || '',
            message: result?.message || '',
          },
        },
        sip: [],
      },
    };
  }
  if (operation === 'song_info') {
    const songmid = firstValue(params.songmid, segments[1], segments[0]);
    const track = await qqSongDetail(songmid, params, cookie);
    return {
      code: 0,
      response: {
        code: 0,
        songinfo: { data: { track_info: track } },
      },
    };
  }
  if (operation === 'song_list_detail') {
    const disstid = firstValue(params.disstid, segments[segments.length - 1]);
    const result = await handleQQPlaylistTracks(disstid, cookie, {
      dirid: params.dirid,
      hostUin: params.hostUin,
    });
    return {
      code: 0,
      response: {
        code: 0,
        cdlist: [{
          disstid,
          dissname: result?.playlist?.name || result?.name || '',
          logo: result?.playlist?.cover || result?.cover || '',
          songlist: result?.songs || [],
          total_song_num: Number(result?.playlist?.trackCount || result?.songs?.length || 0),
        }],
      },
    };
  }
  if (operation === 'user_playlist') {
    try {
      const result = await handleQQUserPlaylists(cookie);
      // 凭据失效时上游一路「未登录」的业务码，收集到的结果是空数组 —— 回
      // `{ code: 0, playlist: [] }` 就等于告诉上层「这个人没有歌单」，界面只剩一句
      // 没有来由的「暂无内容」。如实报 AUTH_REQUIRED，上层才会提示重新登录。
      if (result?.loginRequired || result?.loggedIn === false) {
        noteLibraryStep('qq', 'playlists:login-required', {
          loginExpired: Boolean(result?.loginExpired),
          message: result?.message || '',
        });
        return {
          __foliaBridgeError: 'AUTH_REQUIRED',
          message: result?.message || 'QQ 登录已失效，请重新登录',
        };
      }
      const playlist = (result?.playlists || []).map(qqPlaylistRow);
      noteLibraryStep('qq', 'playlists', {
        count: playlist.length,
        keys: describePayload(result),
      });
      return { code: 0, playlist, total: playlist.length, more: false };
    } catch (error) {
      noteLibraryStep('qq', 'playlists:error', {
        message: error && error.message ? error.message : String(error),
      });
      throw error;
    }
  }
  if (operation === 'user_liked_songs') {
    const offset = numberValue(params.offset, 0);
    const limit = Math.min(100, Math.max(1, numberValue(params.limit, 100)));
    const uin = qqCookieUin(cookie);
    noteLibraryStep('qq', 'liked:start', { offset, limit, hasUin: Boolean(uin) });

    // DissInfo is the only endpoint that returns complete song records (name,
    // artists, album, duration) in one call, so ask it first. The map-based
    // path below only yields mids and used to leave every row unnamed.
    try {
      const cookieObject = parseCookieString(cookie);
      const encryptedUin = firstValue(
        cookieObject.encryptUin,
        cookieObject.encrypt_uin,
        cookieObject.str_musicid,
        cookieObject.wxuin,
        uin,
      );
      const json = await qqMusicRequest({
        comm: buildQQAuthComm(cookie),
        req_0: {
          module: 'music.srfDissInfo.DissInfo',
          method: 'CgiGetDiss',
          param: {
            disstid: 0,
            dirid: 201,
            tag: true,
            song_begin: offset,
            song_num: limit,
            userinfo: true,
            orderlist: true,
            enc_host_uin: String(encryptedUin || ''),
          },
        },
      }, cookie);
      const block = json?.req_0 || {};
      const data = block.data || {};
      const songs = data.songlist || data.songList || [];
      const total = numberValue(data.total_song_num, data.total, data.song_num, songs.length);
      noteLibraryStep('qq', 'liked:path2', {
        code: Number(block.code) || 0,
        songCount: Array.isArray(songs) ? songs.length : 0,
        total,
        keys: describePayload(data),
      });
      if (Array.isArray(songs) && songs.length) {
        return {
          code: Number(block.code) || 0,
          songs,
          total,
          more: Boolean(data.hasmore) || offset + songs.length < total,
        };
      }
    } catch (error) {
      noteLibraryStep('qq', 'liked:path2:error', {
        message: error && error.message ? error.message : String(error),
      });
    }

    try {
      const fav = await qqGetJSON('https://c.y.qq.com/splcloud/fcgi-bin/fcg_musiclist_getmyfav.fcg', {
        dirid: 201,
        dirinfo: 1,
        g_tk: qqGtk(cookie),
        format: 'json',
        loginUin: uin,
        hostUin: uin,
      }, cookie);
      const midMap = fav?.mapmid || fav?.data?.mapmid || {};
      const idMap = fav?.map || fav?.data?.map || {};
      const allMids = Object.keys(midMap).filter(Boolean);
      noteLibraryStep('qq', 'liked:path1', {
        code: fav?.code,
        midCount: allMids.length,
        keys: describePayload(fav),
      });
      if (allMids.length) {
        const pageMids = allMids.slice(offset, offset + limit);
        const songs = pageMids.map((mid) => ({
          mid,
          songmid: mid,
          id: midMap[mid] || idMap[mid],
        }));
        await qqSongDetailsBatch(songs, cookie);
        return {
          code: 0,
          songs,
          total: allMids.length,
          more: offset + songs.length < allMids.length,
        };
      }
    } catch (error) {
      noteLibraryStep('qq', 'liked:path1:error', {
        message: error && error.message ? error.message : String(error),
      });
    }

    try {
      const json = await qqMusicRequest({
        comm: buildQQAuthComm(cookie),
        req_0: {
          module: 'music.musicasset.PlaylistFavRead',
          method: 'GetSongList',
          param: {
            dirId: 201,
            uin: Number(uin) || uin,
            order: 1,
            begin: offset,
            num: limit,
          },
        },
      }, cookie);
      const block = json?.req_0 || {};
      const data = block.data || {};
      const songs = data.songlist || data.songList || data.list || [];
      noteLibraryStep('qq', 'liked:path3', {
        code: Number(block.code) || 0,
        subcode: block.subcode,
        songCount: Array.isArray(songs) ? songs.length : 0,
        total: numberValue(data.total, data.total_song_num, data.totalSongNum, 0),
        keys: describePayload(data),
      });
      return {
        code: Number(block.code) || 0,
        songs: Array.isArray(songs) ? songs : [],
        total: numberValue(data.total, data.total_song_num, data.totalSongNum, songs.length),
        more: Array.isArray(songs) && songs.length >= limit,
      };
    } catch (error) {
      noteLibraryStep('qq', 'liked:path3:error', {
        message: error && error.message ? error.message : String(error),
      });
      return { code: 0, songs: [], total: 0, more: false };
    }
  }
  if (operation === 'user_playlist_detail') {
    const result = await handleQQPlaylistTracks(firstValue(params.tid, params.id), cookie, {
      dirid: params.dirid,
      hostUin: params.hostUin,
    });
    return {
      code: 0,
      songs: result?.songs || [],
      total: result?.songs?.length || 0,
      more: false,
    };
  }
  if (operation === 'user_albums') {
    const offset = Math.max(0, numberValue(params.offset, 0));
    const limit = Math.min(100, Math.max(1, numberValue(params.limit, 20)));
    const uin = qqCookieUin(cookie);
    const json = await qqGetJSON('https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg', {
      ct: 20,
      cid: 205360956,
      userid: uin,
      reqtype: 2,
      sin: offset,
      ein: offset + limit - 1,
      format: 'json',
    }, cookie);
    const data = json?.data || json || {};
    const albums = data.albumlist || data.cdlist || data.list || data.albums || [];
    const total = numberValue(data.totalalbum, data.total_album, data.total, data.album_total, albums.length);
    return {
      code: Number(json?.code) || 0,
      albums: Array.isArray(albums) ? albums : [],
      total,
      more: offset + (Array.isArray(albums) ? albums.length : 0) < total,
    };
  }
  if (operation === 'album_info') {
    const albummid = firstValue(params.albummid, segments[segments.length - 1]);
    const json = await qqGetJSON(
      'https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg',
      { albummid, format: 'json', outCharset: 'utf-8' },
      cookie,
    );
    return { code: 0, response: { code: Number(json?.code) || 0, data: json?.data || {} } };
  }
  if (operation === 'artist_songs') {
    const singermid = firstValue(params.singermid, segments[segments.length - 1]);
    const limit = numberValue(params.limit, 30);
    const page = numberValue(params.page, 1);
    const json = await qqMusicRequest({
      comm: { ct: 24, cv: 0 },
      singer: {
        module: 'music.web_singer_info_svr',
        method: 'get_singer_detail_info',
        param: { sort: 5, singermid, sin: Math.max(0, (page - 1) * limit), num: limit },
      },
    }, cookie);
    return { code: 0, response: { singer: json?.singer || { code: 0, data: {} } } };
  }
  if (operation === 'artist_albums') {
    const singermid = firstValue(params.singermid, segments[segments.length - 1]);
    const limit = numberValue(params.limit, 30);
    const page = numberValue(params.page, 0);
    const json = await qqMusicRequest({
      comm: { ct: 24, cv: 0 },
      singer: {
        module: 'music.musichallAlbum.AlbumListServer',
        method: 'GetAlbumList',
        param: { sort: 5, singermid, begin: page, num: limit },
      },
    }, cookie);
    return { code: 0, response: { singer: json?.singer || { code: 0, data: {} } } };
  }

  // ---- 推荐（qq-music-api 3.2.0 / 3.3.0）—— 与自建后端同一套字段，读不出来就是空结果 ----
  if (operation === 'user_guess_you_like') {
    return await handleQQGuessYouLike(cookie);
  }
  if (operation === 'user_daily_songs') {
    return await handleQQDailySongs(cookie);
  }
  if (operation === 'recommend_playlists') {
    const limit = numberValue(params.limit, 25);
    return await handleQQRecommendPlaylists(limit, cookie);
  }
  // ---- 写入：正文已经在 mergeOperationParams 里并进 params，不重试 ----
  if (operation === 'user_playlist_tracks') {
    return await handleQQPlaylistTracksWrite(params, cookie);
  }
  if (operation === 'user_playlist_subscribe') {
    return await handleQQPlaylistSubscribe(params, cookie);
  }
  if (operation === 'user_subscription_status') {
    return await handleQQSubscriptionStatus(
      firstValue(params.type, 'playlist'),
      firstValue(params.ids, ''),
      cookie,
    );
  }
  // ---- 红心与收藏专辑（qq-music-api 3.3.1）：同样只写一次，读回确认后才回成功 ----
  if (operation === 'user_song_like') {
    return await handleQQSongLikeWrite(params, cookie);
  }
  if (operation === 'user_album_subscribe') {
    return await handleQQAlbumSubscribe(params, cookie);
  }

  // ---- 探索页那一组（3.3.3）—— 新歌、新碟、榜单、分类是公开内容，其余要登录 ----
  if (operation === 'recommend_new_songs') {
    return await readNewSongs(params, cookie);
  }
  if (operation === 'recommend_new_albums') {
    return await readNewAlbums(params, cookie);
  }
  if (operation === 'recommend_toplists') {
    return await readToplists(cookie);
  }
  if (operation === 'recommend_toplist') {
    return await readToplistSongs(params, cookie);
  }
  if (operation === 'recommend_categories') {
    return await readPlaylistCategories(cookie);
  }
  if (operation === 'recommend_category_playlists') {
    return await readCategoryPlaylists(params, cookie);
  }
  if (operation === 'recommend_radar') {
    return await readRadar(params, cookie);
  }
  if (operation === 'radio_list') {
    return await readRadioList(cookie);
  }
  if (operation === 'radio_tracks') {
    return await readRadioTracks(params, cookie);
  }
  if (operation === 'song_similar') {
    return await readSimilarSongs(params, cookie);
  }
  // ---- 账号的两条与建歌单 ----
  if (operation === 'user_vip') {
    return await readUserVip(cookie);
  }
  if (operation === 'user_cloud') {
    return await readUserCloud(params, cookie);
  }
  if (operation === 'user_playlist_create') {
    return await createPlaylist(params, cookie);
  }
  if (operation === 'search') {
    return await searchCatalog(params, cookie);
  }
  // `login_refresh` 是 Serverless 后端换 token 的那条路由：本地桥的会话就是 cookie 本身，
  // 没有可换的东西。服务层把这里的 UNSUPPORTED 当成「后端没有这条路由」，不再来问。

  return {
    __foliaBridgeError: 'UNSUPPORTED',
    provider: 'qq',
    operation,
    message: `Folia QQ bridge does not implement ${operation}`,
  };
}

async function handleFoliaKugouRequest(input, url) {
  const operation = String(input.operation || url.pathname);
  const params = mergeOperationParams(input, url);
  // 登出不能先恢复会话：宿主读罐不回包时，也必须能进入有界清理。
  if (operation === 'logout') {
    await clearKGSessionOnLogout();
    return { status: 1, error_code: 0, code: 200 };
  }
  const cookie = await ensureKGCookie();

  if (operation === 'register_dev') {
    return { status: 1, error_code: 0, data: { dfid: params.dfid || '' } };
  }
  if (operation === 'login_qr_key') return await handleKGLoginQrKey();
  if (operation === 'login_qr_create') {
    return await handleKGLoginQrCreate(firstValue(params.key, params.qrcode));
  }
  if (operation === 'login_qr_check') {
    return await handleKGLoginQrCheck(firstValue(params.key, params.qrcode));
  }
  if (operation === 'user_detail') {
    const info = await getKGLoginStatus(cookie);
    return {
      status: 1,
      error_code: 0,
      data: {
        user_info: {
          userid: info?.userId || info?.userid || '',
          nickname: info?.nickname || '',
          pic: info?.avatar || info?.avatarUrl || '',
          vip_type: info?.vipType || 0,
        },
      },
    };
  }
  if (operation === 'user_vip_detail') {
    return await getKGUserVipDetail(cookie);
  }
  if (operation === 'search') {
    const limit = numberValue(params.pagesize, params.limit, 16);
    const page = numberValue(params.page, 1);
    const songs = await handleKGSearch(
      firstValue(params.keywords, params.keyword),
      limit,
      cookie,
      page,
    );
    return { status: 1, error_code: 0, data: { lists: songs, total: songs.length } };
  }
  if (operation === 'audio' || operation === 'krm_audio') {
    const hash = String(firstValue(params.hash, params.id)).toLowerCase();
    const info = await handleKGSongUrl(hash, params.album_id, params.album_audio_id, 'standard', cookie, {});
    return {
      status: 1,
      error_code: 0,
      data: {
        hash,
        FileHash: hash,
        url: info?.url || '',
        play_url: info?.url || '',
      },
    };
  }
  if (operation === 'song_url' || operation === 'user_cloud_url') {
    const result = await handleKGSongUrl(
      firstValue(params.hash, params.id),
      params.album_id,
      params.album_audio_id,
      params.quality,
      cookie,
      {
        hash320: params.hash320 || params.hash_320,
        hashSq: params.hashSq || params.hash_sq || params.sqhash,
      },
    );
    return {
      status: 1,
      error_code: result?.url ? 0 : 20027,
      data: {
        play_url: result?.url || '',
        url: result?.url || '',
        level: result?.level || 'standard',
        volume: 0,
      },
      ...result,
    };
  }
  if (operation === 'search_lyric') {
    const candidates = await searchKGLyricCandidates(
      firstValue(params.hash, params.id),
      params.album_audio_id,
      numberValue(params.duration, 0),
      params.keyword || params.keywords || '',
    );
    return { status: 1, error_code: 0, candidates };
  }
  if (operation === 'lyric') {
    const content = await downloadKGLyricByCandidate({
      id: firstValue(params.id, params.lyric_id),
      accesskey: params.accesskey,
    });
    return { status: 1, error_code: 0, decodeContent: content, content };
  }
  if (operation === 'song_climax') {
    return { status: 1, error_code: 0, data: [] };
  }
  if (operation === 'user_playlist') {
    const result = await handleKGUserPlaylists(cookie, numberValue(params.pagesize, 100));
    const lists = (result?.playlists || []).map(kgCollectionRow);
    return {
      status: 1,
      error_code: 0,
      data: { lists, total: lists.length, count: lists.length },
    };
  }
  if (operation === 'playlist_track_all') {
    const result = await handleKGPlaylistTracks(
      firstValue(params.id, params.global_collection_id),
      cookie,
      params.globalCollectionId,
    );
    const songs = result?.songs || result?.tracks || [];
    return {
      status: 1,
      error_code: 0,
      data: { songs, info: songs, total: songs.length, count: songs.length },
    };
  }
  if (operation === 'playlist_detail') {
    const result = await handleKGPlaylistTracks(firstValue(params.ids, params.id), cookie);
    const playlist = result?.playlist || {};
    const row = {
      listid: playlist.id,
      list_id: playlist.id,
      global_collection_id: playlist.id,
      name: playlist.name,
      listname: playlist.name,
      song_count: playlist.trackCount,
      count: playlist.trackCount,
      img: playlist.cover,
      cover: playlist.cover,
    };
    return { status: 1, error_code: 0, data: { info: [row], list: [row], ...row } };
  }
  if (operation === 'album_detail') {
    const id = firstValue(params.id, params.album_id);
    const body = await kgPostAndroidSigned(
      'https://openapi.kugou.com',
      '/kmr/v2/albums',
      cookie,
      {
        data: [{ album_id: String(id) }],
        is_buy: numberValue(params.is_buy, 0),
        fields: 'album_id,album_name,publish_date,sizable_cover,intro,language,is_publish,heat,type,quality,authors,exclusive,author_name,trans_param',
      },
      {},
      { 'x-router': 'openapi.kugou.com', 'kg-tid': '255' },
    );
    // `kgPostAndroidSigned` 没有 userid / token 时返回 null（这条端点要带账号签名）。
    // 以前这里拿 20017 的空壳顶上，界面上就成了「这张专辑没有歌」—— 现在把原因写进 errmsg。
    return body || { status: 0, error_code: 20017, errmsg: 'album detail needs a signed-in account', data: { info: [], list: [] } };
  }
  if (operation === 'album_songs') {
    const id = firstValue(params.id, params.album_id);
    const body = await kgPostAndroidSigned(
      'https://openapi.kugou.com',
      '/v1/album_audio/lite',
      cookie,
      {
        album_id: String(id),
        is_buy: firstValue(params.is_buy, ''),
        page: numberValue(params.page, 1),
        pagesize: numberValue(params.pagesize, 30),
      },
      {},
      { 'x-router': 'openapi.kugou.com', 'kg-tid': '255' },
    );
    // 同上：签不出名（没登录）就明说，不要伪装成「这张专辑没有歌」。
    return body || { status: 0, error_code: 20017, errmsg: 'album songs need a signed-in account', data: { info: [], list: [], songs: [], total: 0 } };
  }
  if (operation === 'artist_albums') {
    const id = firstValue(params.id, params.author_id);
    const body = await kgPostAndroidSigned(
      'https://openapi.kugou.com',
      '/kmr/v1/author/albums',
      cookie,
      {
        author_id: String(id),
        pagesize: numberValue(params.pagesize, 30),
        page: numberValue(params.page, 1),
        sort: 1,
        category: 1,
        area_code: 'all',
      },
      {},
      { 'x-router': 'openapi.kugou.com', 'kg-tid': '36' },
    );
    return body || { status: 0, error_code: 20017, data: { info: [], list: [], total: 0 } };
  }
  if (operation === 'artist_detail' || operation === 'artist_audios') {
    const result = await handleKGArtistDetail(
      firstValue(params.id, params.singerid),
      params.name,
      numberValue(params.pagesize, params.limit, 36),
    );
    if (operation === 'artist_detail') {
      return { status: 1, error_code: 0, data: result?.artist || {} };
    }
    const items = result?.songs || [];
    return {
      status: 1,
      error_code: 0,
      data: { info: items, list: items, songs: items, total: items.length },
    };
  }
  // 推荐类接口以前这里是直接返回空数组，UI 上就表现为「私人 FM / 每日推荐没有歌」。
  // 现在都真的去打酷狗的推荐服务；拿不到（没登录 / 被风控）时再退化成空列表，至少不会报错。
  if (operation === 'everyday_recommend') {
    const body = await handleKGEverydayRecommend(cookie, params.platform);
    return body || { status: 1, error_code: 0, data: { songs: [], total: 0 } };
  }
  if (operation === 'personal_fm') {
    const body = await handleKGPersonalFm(cookie, {
      action: params.action,
      hash: params.hash,
      songid: params.songid,
      playtime: params.playtime,
      mode: params.mode,
      song_pool_id: params.song_pool_id,
      is_overplay: params.is_overplay,
      remain_songcnt: params.remain_songcnt,
      platform: params.platform,
    });
    return body || { status: 1, error_code: 0, data: { songs: [], total: 0 } };
  }
  if (operation === 'top_card_youth') {
    const body = await handleKGTopCardYouth(cookie, {
      card_id: params.card_id,
      pagesize: params.pagesize,
      tagid: params.tagid,
    });
    return body || { status: 1, error_code: 0, data: { songs: [], total: 0 } };
  }
  if (operation === 'everyday_history') {
    const body = await handleKGEverydayHistory(cookie, {
      mode: params.mode,
      date: params.date,
      history_name: params.history_name,
      platform: params.platform,
    });
    return body || { status: 1, error_code: 0, data: { info: [], list: [], total: 0 } };
  }
  if (operation === 'user_cloud') {
    return { status: 1, error_code: 0, data: { info: [], songs: [], total: 0 } };
  }
  if (operation === 'youth_union_vip') return await getKGYouthUnionVip(cookie);
  if (operation === 'youth_day_vip') return await claimKGYouthDayVip(cookie, params.receive_day);
  if (operation === 'youth_day_vip_upgrade') {
    return await upgradeKGYouthDayVip(cookie, firstValue(params.userid, params.kugouid));
  }

  // ---- 歌单的写入：收藏 / 取消收藏歌单与专辑，往歌单加歌、从歌单删歌 ----
  if (operation === 'playlist_add') {
    return await handlePlaylistAdd(params, cookie);
  }
  if (operation === 'playlist_del') {
    return await handlePlaylistDel(params, cookie);
  }
  if (operation === 'playlist_tracks_add') {
    return await handlePlaylistTracksAdd(params, cookie);
  }
  if (operation === 'playlist_tracks_del') {
    return await handlePlaylistTracksDel(params, cookie);
  }

  return {
    __foliaBridgeError: 'UNSUPPORTED',
    provider: 'kugou',
    operation,
    message: `Folia KuGou bridge does not implement ${operation}`,
  };
}

export async function handleFoliaApiRequest(input) {
  const { url, body, method } = parseInput(input);
  if (input?.provider === 'bodian') {
    return await handleBodianRequest(String(input.operation || ''), input.params || body || {});
  }
  if (input?.provider === 'qq') {
    return await handleFoliaQqRequest(input, url);
  }
  if (input?.provider === 'kugou') {
    return await handleFoliaKugouRequest(input, url);
  }
  if (input?.provider === 'qq_raw') {
    if (input.operation !== 'musicu') {
      return { __foliaBridgeError: 'UNSUPPORTED', message: `Unknown QQ raw operation: ${input.operation}` };
    }
    return await qqMusicRequest(body, await getQQCookie());
  }
  // ⚠️ 只认原生 cookie 罐是不够的：登录是渲染层自己存的会话值，罐里可能根本没有 ——
  // 那这边就等于没登录，weapi 一律答 `{code: 301}`；而 weapiJson 为了让整页不至于失败
  // 是**不抛错**的，于是每一栏都空着，探索页看上去就是「空的」而不是「读不出来」。
  // 只有带着登录态的那个才优先：渲染层没登录时会拿匿名 cookie 来，那不能盖住罐里真登录的。
  // （这一行要在 params 声明之前，直接用 url.searchParams，避免压缩后的 TDZ。）
  const sent = firstValue(url.searchParams.get('cookie'), body.cookie);
  const cookie = (sent && hasNeteaseLogin(sent) ? sent : '') || await getNeteaseCookie();
  const path = url.pathname;
  const params = url.searchParams;

  if (path === '/register/anonimous') {
    // 真的去注册一个游客：拿到的是带 MUSIC_A / __csrf 的那份 cookie，weapi 才答得出东西。
    // 拿不到就还是空串，与原来一样 —— 并不比空壳更差。
    const guest = await registerAnonymousCookie();
    noteLibraryStep('netease', 'auth:anonimous', { ok: guest ? 'yes' : 'no' });
    return { code: 200, cookie: guest, anonymous: true };
  }
  if (path === '/login/status') return await handleLoginStatus(cookie);
  if (path === '/user/account') return await handleUserAccount(cookie);
  // 登出必须连罐里的登录态一起清掉，否则重开应用又被自动登录（见该模块的说明）。
  if (path === '/logout') {
    await clearSessionOnLogout();
    return { code: 200 };
  }
  if (path === '/login/qr/key') {
    const result = await handleLoginQrKey();
    return { code: 200, data: { code: 200, unikey: result.key } };
  }
  if (path === '/login/qr/create') {
    const key = firstValue(params.get('key'), body.key);
    const result = await handleLoginQrCreate(key);
    return { code: 200, data: { qrimg: result.qrimg || result.img, qrurl: result.url } };
  }
  if (path === '/login/qr/check') {
    const key = firstValue(params.get('key'), body.key);
    return await handleLoginQrCheck(key);
  }
  if (path === '/cloudsearch' || path === '/search') return await handleSearch(url, cookie);
  if (path === '/song/detail') return await handleSongDetail(url, cookie);
  if (path === '/song/url/v1' || path === '/song/url') return await handleSongUrlV1(url, cookie);
  if (path === '/lyric/new' || path === '/lyric') return await handleLyricNew(url, cookie);
  if (path === '/song/chorus') {
    const id = firstValue(params.get('id'), body.id);
    return await eapiJson('/api/song/chorus', { id }, cookie);
  }
  if (path === '/user/playlist') return await handleUserPlaylists(url, cookie);
  if (path === '/playlist/detail') return await handlePlaylistDetail(url, cookie);
  if (path === '/playlist/track/all') return await handlePlaylistTrackAll(url, cookie);
  if (path === '/playlist/tracks') return await handlePlaylistTracks(url, body, cookie);
  if (path === '/playlist/subscribe') return await handleSubscribe(url, body, cookie, '/api/playlist/subscribe');
  if (path === '/playlist/detail/dynamic') {
    const id = firstValue(params.get('id'), body.id);
    return await eapiJson('/api/playlist/detail/dynamic', { id }, cookie);
  }
  if (path === '/album') return await handleAlbum(url, cookie);
  if (path === '/album/sub') return await handleSubscribe(url, body, cookie, '/api/album/sub');
  if (path === '/album/sublist') {
    return await weapiJson('/api/album/sublist', {
      limit: numberValue(params.get('limit'), 25),
      offset: numberValue(params.get('offset'), 0),
    }, cookie);
  }
  if (path === '/album/detail/dynamic') {
    const id = firstValue(params.get('id'), body.id);
    return await eapiJson('/api/album/detail/dynamic', { id }, cookie);
  }
  if (path === '/artist/detail') return await handleArtistDetail(url, cookie);
  if (path === '/artist/top/song') return await handleArtistTopSongs(url, cookie);
  if (path === '/artist/songs') return await handleArtistSongs(url, cookie);
  if (path === '/artist/album') return await handleArtistAlbums(url, cookie);
  if (path === '/likelist') return await handleLikedList(url, cookie);
  if (path === '/like') return await handleLike(url, body, cookie);
  if (path === '/like/check') return await handleLikeCheck(url, cookie);
  if (path === '/recommend/songs') return await handleDailyRecommend(url, cookie);
  if (path === '/recommend/songs/dislike') {
    const id = firstValue(params.get('id'), body.id);
    return await eapiJson('/api/recommend/songs/dislike', { id }, cookie);
  }
  if (path === '/history/recommend/songs' || path === '/history/recommend/songs/detail') {
    return await handleHistoryRecommend(url, cookie);
  }
  if (path === '/personal_fm' || path === '/personal/fm/mode') return await handlePersonalFm(url, cookie);
  if (path === '/personalized') {
    return await eapiJson('/api/personalized/playlist', {
      limit: numberValue(params.get('limit'), 35),
    }, cookie);
  }
  if (path === '/fm_trash') {
    const id = firstValue(params.get('id'), body.id);
    return await eapiJson('/api/radio/trash', { id }, cookie);
  }
  if (path === '/scrobble/v1') return { code: 200 };
  if (path === '/user/cloud') return { code: 200, data: [], songs: [] };
  if (path === '/user/cloud/detail') return { code: 200, data: [], songs: [] };
  if (path === '/cloud/lyric/get') return { code: 200, lyric: '', lrc: { lyric: '' } };
  if (path === '/song/copyright/rcmd') return { code: 200, data: null };

  /*
   * --- Explore ---
   *
   * 探索页那一组。安卓上没有本地后端，请求全走这个桥 —— 而这一组一直没实现，
   * 于是整个探索页读不出来（日志里就是 `Folia bridge does not implement ...`）。
   * 目标路径照桌面端内嵌后端那份写（它模块目录下的同名文件），答出来的字段必须对得上
   * 探索页适配器读的那几个：
   *   /homepage/block/page → data.blocks
   *   /recommend/resource  → recommend
   *   /toplist             → list
   *   /simi/song           → songs
   *   /top/song            → data
   *   /album/new           → albums
   *   /top/playlist        → playlists
   */
  // 探索页与听歌档案这两组走的路由：留痕能看出哪一条被问过（页面空却一条都没有 = 请求根本没到桥）。
  // 顺带记 cookie 的长度：0 就是这次请求压根没带登录态，上游只会答 301。
  const routeTrace = EXPLORE_PATHS.has(path) ? 'explore:route' : ARCHIVE_PATHS.has(path) ? 'archive:route' : '';
  if (routeTrace) noteLibraryStep('netease', routeTrace, { path, cookie: cookie ? cookie.length : 0 });
  if (path === '/homepage/block/page') {
    // 没有 cursor 时**绝不能带 `cursor: ''`**：首页区块这条带上空游标就答不出 blocks，
    // 探索页于是只剩每日推荐那一栏（看着就是「页面是空的」）。
    const cursor = firstValue(params.get('cursor'));
    return await readJson('/api/homepage/block/page', {
      refresh: String(firstValue(params.get('refresh'), 'false')) !== 'false',
      ...(cursor ? { cursor } : {}),
    }, cookie);
  }
  if (path === '/recommend/resource') {
    // 每日推荐歌单：weapi 这条账号类接口常只答 `{code: 301}`（csrf 对不上或认成未登录），
    // 而 weapiJson 为了不让整页失败是**不抛错**的 —— 光靠 try/catch 换不了路，这一栏会一直 0 张。
    // 所以「没答出 recommend 就换 eapi 再问一次」，网络层真抛错时同样换路。
    try {
      const answer = await readJson('/api/v1/discovery/recommend/resource', {}, cookie);
      if (Array.isArray(answer?.recommend) || Array.isArray(answer?.data?.recommend)) return answer;
      noteLibraryStep('netease', 'explore:daily-playlists:fallback', { code: answer?.code });
    } catch (error) {
      noteLibraryStep('netease', 'explore:daily-playlists:fallback', {
        message: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
      });
    }
    return await eapiJson('/api/v1/discovery/recommend/resource', {}, cookie);
  }
  if (path === '/toplist') return await readJson('/api/toplist', {}, cookie);
  if (path === '/simi/song') {
    return await readJson('/api/v1/discovery/simiSong', {
      songid: numberValue(params.get('id')),
      limit: numberValue(params.get('limit'), 50),
      offset: numberValue(params.get('offset')),
    }, cookie);
  }
  // 新歌速递：`type` 是地区（0 全部 / 7 华语 / 96 欧美 / 8 日本 / 16 韩国）。
  if (path === '/top/song') {
    // 新歌速递要明说一页多少条：不给 limit/offset 时上游只回很少几首，这一栏几乎是空的。
    return await readJson('/api/v1/discovery/new/songs', {
      areaId: numberValue(params.get('type')),
      limit: numberValue(params.get('limit'), 100),
      offset: numberValue(params.get('offset'), 0),
      total: true,
    }, cookie);
  }
  if (path === '/album/new') {
    return await readJson('/api/album/new', {
      limit: numberValue(params.get('limit'), 30),
      offset: numberValue(params.get('offset')),
      area: firstValue(params.get('area'), 'ALL'),
      total: true,
    }, cookie);
  }
  if (path === '/top/playlist') {
    return await readJson('/api/playlist/list', {
      cat: firstValue(params.get('cat'), '全部'),
      order: firstValue(params.get('order'), 'hot'),
      limit: numberValue(params.get('limit'), 30),
      offset: numberValue(params.get('offset')),
      total: true,
    }, cookie);
  }

  /*
   * --- 听歌档案（#223）---
   *
   * 模组读「听歌档案」不走 omni 的 rpc，而是 `platform.raw` → `omni.requestProviderRaw` →
   * 平台目录里的 raw 模块（`src/services/onlineMusic/<平台>/` 下那个），落到这个桥。
   * 路径是上游模块名把下划线换成 `/`：`user_record` → `/user/record`、
   * `listen_data_total` → `/listen/data/total`、`listen_data_realtime_report` →
   * `/listen/data/realtime/report`。
   *
   * 这三条原先一条都没有，全部落到下面末尾的 `ROUTE_NOT_IMPLEMENTED`。上层见到
   * `__foliaBridgeError` 就抛错，`raw` 那一层把它归成 network，模组界面于是整页显示
   * 「无法连接，请稍后重试」—— 看着像断网，其实是桥里没这条路由。桌面端走 Electron
   * 内置后端，这三条本来就有，所以只补桥这一侧。
   *
   * 上游包里这三条模块怎么问就怎么抄（`module/` 下的同名文件）：
   *   user_record                  → weapi POST /api/v1/play/record                 { uid, type }
   *   listen_data_total            → eapi  POST /api/content/activity/listen/data/total            {}
   *   listen_data_realtime_report  → eapi  POST /api/content/activity/listen/data/realtime/report  { type }
   * 加密方式照上游 `util/option.js` 的 `createOption(query, 'weapi')`：只有 `user_record` 显式写
   * weapi，另外两条吃该包默认的 eapi（config 里 `encrypt: true`）。所以前者用 `readJson`
   * （weapi + 未加密网关兜底，与 `/album/new` 那一组读接口一样），后者用 `eapiJson`
   * （与 `/personalized`、`/fm_trash` 一样）。应答原样交回去：`allData`/`weekData`、
   * `data.totalDuration`、`data.listenTimeDistributionBlock.playDuration` 都靠上游给。
   * 其它 `listen_data_*` 模块这次不补：模组只用这三条。
   */
  if (path === '/user/record') {
    // 听歌排行。`uid` 由 omni 的 selfParam 填当前登录账号；没给时回退到会话里的 userId
    // （与 `/likelist` 那条约定的做法一致）。`type` 是上游的取值：1 最近一周，0 所有时间。
    const uid = firstValue(params.get('uid'), body.uid) || (await requireLoginInfo(cookie))?.userId || '';
    const type = numberValue(params.get('type'), body.type);
    return await archiveAnswer(path, () => readJson('/api/v1/play/record', { uid, type }, cookie));
  }
  if (path === '/listen/data/total') {
    // 总收听时长：上游不带参数，账号只从会话里认。
    return await archiveAnswer(path, () => eapiJson('/api/content/activity/listen/data/total', {}, cookie));
  }
  if (path === '/listen/data/realtime/report') {
    // 本周/本月收听时长。上游只认 `week` / `month`，缺省是 week。
    const type = firstValue(params.get('type'), body.type, 'week');
    return await archiveAnswer(
      path,
      () => eapiJson('/api/content/activity/listen/data/realtime/report', { type }, cookie),
    );
  }

  /*
   * 「歌曲评论」模组（song-comments）问的两条：
   *   comment_hot   → weapi POST /api/v1/resource/comments/hotflow              { id, type, limit, offset }
   *   comment_music → weapi POST /api/v1/resource/comments/R_SO_4_<id>          { limit, offset }
   *
   * 和上面那三条一样，原先这里一条都没有，全落到末尾的 ROUTE_NOT_IMPLEMENTED；
   * 上层见到 `__foliaBridgeError` 就抛错、`raw` 那层一律归成 network，模组界面于是显示
   * 「无法连接，请稍后重试」—— 看着像断网，其实是桥里没这条路由。
   *
   * 两条都走 weapi（与上游 `module/comment_hot.js`、`module/comment_music.js` 一致）：
   * `type` 是评论所属的資源类型，歌单/歌曲共用这个接口，模组传的是 0（歌曲）。
   * `R_SO_4_` 是网易给「单曲」的线程前缀，`comment_music` 要拼在路径里而不是放进参数。
   * 应答原样交回去：`hotComments` / `comments` / `total` 都由上游给。
   */
  if (path === '/comment/hot') {
    const id = firstValue(params.get('id'), body.id);
    if (!id) return { __foliaBridgeError: 'INVALID_PARAMS', path, message: 'comment_hot 缺少 id' };
    const payload = {
      id,
      // numberValue 取第一个「能转成数字」的值，所以缺省值要放在取值前面。
      type: numberValue(body.type, params.get('type'), 0),
      limit: numberValue(params.get('limit'), body.limit, 20),
      offset: numberValue(params.get('offset'), body.offset, 0),
    };
    return await archiveAnswer(path, () => readJson('/api/v1/resource/comments/hotflow', payload, cookie));
  }
  if (path === '/comment/music') {
    const id = firstValue(params.get('id'), body.id);
    if (!id) return { __foliaBridgeError: 'INVALID_PARAMS', path, message: 'comment_music 缺少 id' };
    const payload = {
      limit: numberValue(params.get('limit'), body.limit, 20),
      offset: numberValue(params.get('offset'), body.offset, 0),
    };
    return await archiveAnswer(
      path,
      () => readJson(`/api/v1/resource/comments/R_SO_4_${id}`, payload, cookie),
    );
  }

  return {
    __foliaBridgeError: 'ROUTE_NOT_IMPLEMENTED',
    path,
    method,
    message: `Folia bridge does not implement ${method} ${path}`,
  };
}

export async function getFoliaBridgeStatus() {
  const cookie = await getNeteaseCookie();
  const info = await getLoginInfo(cookie);
  return {
    netease: {
      loggedIn: !!info?.loggedIn,
      nickname: info?.nickname || '',
      avatar: info?.avatar || '',
      hasCookie: hasNeteaseLogin(cookie),
    },
  };
}

export async function diagnoseQqLikedSongs() {
  const cookie = await getQQCookie();
  const cookieObject = parseCookieString(cookie);
  const uin = qqCookieUin(cookie);
  const report = {
    hasUin: Boolean(uin),
    hasMusicKey: Boolean(cookieObject.qm_keyst || cookieObject.qqmusic_key || cookieObject.music_key),
    steps: [],
  };

  try {
    const fav = await qqGetJSON('https://c.y.qq.com/splcloud/fcgi-bin/fcg_musiclist_getmyfav.fcg', {
      dirid: 201,
      dirinfo: 1,
      g_tk: qqGtk(cookie),
      format: 'json',
      loginUin: uin,
      hostUin: uin,
    }, cookie);
    const midMap = fav?.mapmid || fav?.data?.mapmid || {};
    const idMap = fav?.map || fav?.data?.map || {};
    report.steps.push({
      name: 'getmyfav',
      code: fav?.code,
      subcode: fav?.subcode,
      topKeys: Object.keys(fav || {}).slice(0, 30),
      midCount: Object.keys(midMap || {}).length,
      idCount: Object.keys(idMap || {}).length,
      sampleMids: Object.keys(midMap || {}).slice(0, 3),
    });
  } catch (error) {
    report.steps.push({ name: 'getmyfav', error: error?.message || String(error) });
  }

  try {
    const encryptedUin = firstValue(
      cookieObject.encryptUin,
      cookieObject.encrypt_uin,
      cookieObject.str_musicid,
      cookieObject.wxuin,
      uin,
    );
    const json = await qqMusicRequest({
      comm: buildQQAuthComm(cookie),
      req_0: {
        module: 'music.srfDissInfo.DissInfo',
        method: 'CgiGetDiss',
        param: {
          disstid: 0,
          dirid: 201,
          tag: true,
          song_begin: 0,
          song_num: 5,
          userinfo: true,
          orderlist: true,
          enc_host_uin: String(encryptedUin || ''),
        },
      },
    }, cookie);
    const block = json?.req_0 || {};
    const data = block.data || {};
    const songs = data.songlist || data.songList || [];
    report.steps.push({
      name: 'cgiGetDiss',
      code: block.code,
      subcode: block.subcode,
      dataKeys: Object.keys(data).slice(0, 30),
      songlistCount: Array.isArray(songs) ? songs.length : 0,
      total: numberValue(data.total_song_num, data.total, data.song_num, 0),
      sampleSongKeys: Array.isArray(songs) && songs[0] ? Object.keys(songs[0]).slice(0, 20) : [],
    });
  } catch (error) {
    report.steps.push({ name: 'cgiGetDiss', error: error?.message || String(error) });
  }

  try {
    const json = await qqMusicRequest({
      comm: buildQQAuthComm(cookie),
      req_0: {
        module: 'music.musicasset.PlaylistFavRead',
        method: 'GetSongList',
        param: {
          dirId: 201,
          uin: Number(uin) || uin,
          order: 1,
          begin: 0,
          num: 5,
        },
      },
    }, cookie);
    const block = json?.req_0 || {};
    const data = block.data || {};
    const songs = data.songlist || data.songList || data.list || [];
    report.steps.push({
      name: 'playlistFavRead',
      code: block.code,
      subcode: block.subcode,
      dataKeys: Object.keys(data).slice(0, 30),
      songlistCount: Array.isArray(songs) ? songs.length : 0,
      total: numberValue(data.total, data.total_song_num, data.totalSongNum, 0),
      sampleSongKeys: Array.isArray(songs) && songs[0] ? Object.keys(songs[0]).slice(0, 20) : [],
    });
  } catch (error) {
    report.steps.push({ name: 'playlistFavRead', error: error?.message || String(error) });
  }

  try {
    const json = await qqGetJSON('https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg', {
      ct: 20,
      cid: 205360956,
      userid: uin,
      reqtype: 2,
      sin: 0,
      ein: 4,
      format: 'json',
    }, cookie);
    const data = json?.data || json || {};
    const albums = data.albumlist || data.cdlist || data.list || data.albums || [];
    const firstAlbum = Array.isArray(albums) ? albums[0] : null;
    report.steps.push({
      name: 'favoriteAlbums',
      code: json?.code,
      subcode: json?.subcode,
      dataKeys: Object.keys(data).slice(0, 30),
      albumCount: Array.isArray(albums) ? albums.length : 0,
      total: numberValue(data.totalalbum, data.total_album, data.total, data.album_total, 0),
      sampleAlbumKeys: Array.isArray(albums) && albums[0] ? Object.keys(albums[0]).slice(0, 20) : [],
    });
    const firstAlbumMid = firstValue(
      firstAlbum?.albumMID,
      firstAlbum?.albummid,
      firstAlbum?.albumMid,
      firstAlbum?.mid,
    );
    if (firstAlbumMid) {
      const detail = await qqGetJSON(
        'https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg',
        { albummid: firstAlbumMid, format: 'json', outCharset: 'utf-8' },
        cookie,
      );
      const detailData = detail?.data || {};
      report.steps.push({
        name: 'favoriteAlbumDetail',
        code: detail?.code,
        albumMid: firstAlbumMid,
        albumName: detailData.name,
        dataKeys: Object.keys(detailData).slice(0, 30),
        trackCount: Array.isArray(detailData.list) ? detailData.list.length : 0,
      });
    }
  } catch (error) {
    report.steps.push({ name: 'favoriteAlbums', error: error?.message || String(error) });
  }

  return report;
}
