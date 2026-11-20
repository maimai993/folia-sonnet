// src/services/onlineMusic/qq/qqLyricProvider.ts

/**
 * QQ Music lyrics provider module.
 * Provides search and download/decryption capabilities for QQ Music lyrics.
 */

import { SongResult } from '../../../types';
import { parseLyricsByFormat } from '../../../utils/lyrics/parserCore';
import { detectTimedLyricFormat } from '../../../utils/lyrics/formatDetection';
import { qrcDecrypt } from './qrcDecrypt';
import { applyDetectedChorusEffects, applyChorusRangesByTime } from '../../../utils/lyrics/chorusEffects';
import type { ChorusRange } from '../../../utils/lyrics/chorusEffects';
import { getOriginalCoverUrl } from '../../../utils/coverUrl';
import { resolveProxiedUrl } from '../../proxiedUrl';
import {
  ANONYMOUS_LITE_COMM,
  ANONYMOUS_LITE_COOKIE,
  ANONYMOUS_SONG_SEARCH_TYPE,
  LITE_SEARCH_MAX_KEYWORD_LENGTH,
  liteSearchParams,
} from '../../../nativeBridge/api/qq/anonymousSearch';

// 只认 platform（只有 Electron 的 preload 会写）：安卓端的模组 shim 也装了
// `window.electron`，按对象存在与否判断会让安卓绕过同源代理、并且丢掉 cookie。
const isElectron = typeof window !== 'undefined' && typeof (window as any).electron?.platform === 'string';

/**
 * Sends a POST request to u.y.qq.com via proxy or directly in Electron.
 *
 * 匿名身份（comm、未登录标头、搜索类型）不在这里写：桥侧的
 * `src/nativeBridge/api/qq/explore.js` 对的是同一条上游，两份常数各记各的实验结论迟早
 * 会漂移（issue M27）。唯一来源是 `src/nativeBridge/api/qq/anonymousSearch.js`。
 */
async function requestQQ(method: string, module: string, param: any): Promise<any> {
  const payload = {
    comm: { ...ANONYMOUS_LITE_COMM },
    request: {
      method,
      module,
      param,
    },
  };

  const targetUrl = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
  const url = isElectron ? targetUrl : resolveProxiedUrl(targetUrl);

  const response = await fetch(url, {
    method: 'POST',
    credentials: isElectron ? 'omit' : 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `${ANONYMOUS_LITE_COOKIE};`,
      'User-Agent': 'okhttp/3.14.9',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`QQ Music API request failed: ${response.status}`);
  }

  const data = await response.json();
  if (data.code !== 0 || data.request?.code !== 0) {
    throw new Error(`QQ Music API error: code ${data.code || data.request?.code}`);
  }

  return data.request.data;
}

/**
 * Encodes string to Base64 in UTF-8.
 */
function toBase64(str: string): string {
  try {
    return btoa(unescape(encodeURIComponent(str)));
  } catch {
    return btoa(
      encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) =>
        String.fromCharCode(parseInt(p1, 16))
      )
    );
  }
}

/**
 * Detects if a lyric string is in QRC format.
 */
function detectIsQrc(content: string): boolean {
  return content.includes('(') && content.includes(')') && /\[\d+,\d+\]/.test(content);
}

/**
 * Searches songs on QQ Music anonymously and throws on upstream refusal (e.g. the frequent code 2001).
 */
export async function searchQQSongs(keyword: string, page = 1, pageSize = 20): Promise<SongResult[]> {
  const safeKeyword = keyword.trim();
  if (!safeKeyword) return [];

  // 参数模板与 search_type 都来自共用常数（issue M27）：匿名送 7，上游已经不认 0，
  // 送 0 一律回 2001（2026-10-17 实测，见 #695）；同一请求换成 7 就有结果。别在这里改回去。
  const param = liteSearchParams({
    keyword: safeKeyword.slice(0, LITE_SEARCH_MAX_KEYWORD_LENGTH),
    page,
    limit: pageSize,
    searchType: ANONYMOUS_SONG_SEARCH_TYPE,
  });

  const data = await requestQQ("DoSearchForQQMusicLite", "music.search.SearchCgiService", param);
  const songs = data?.body?.item_song || [];

  return songs.map((info: any) => {
    const artists = (info.singer || []).map((s: any, idx: number) => ({
      id: s.id || idx,
      name: s.name || 'Unknown Artist',
    }));

    const albumMid = info.album?.mid;
    const picUrl = albumMid
      ? getOriginalCoverUrl(`https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg?max_age=2592000`)
      : undefined;

    return {
      id: Number(info.id || 0),
      name: info.title || 'Unknown Song',
      artists,
      album: {
        id: Number(info.album?.id || 0),
        name: info.album?.name || 'Unknown Album',
        coverUrl: picUrl,
      },
      durationMs: (info.interval || 0) * 1000,
      qqMid: info.mid,
    };
  });
}

/**
 * Searches songs on QQ Music for lyric and metadata matching: a refused search is just "no candidates".
 */
export async function searchQQLyrics(keyword: string, page = 1, pageSize = 20): Promise<SongResult[]> {
  try {
    return await searchQQSongs(keyword, page, pageSize);
  } catch (error) {
    console.error('[QQMusic] Search failed:', error);
    return [];
  }
}

/**
 * Fetches and decrypts QQ Music lyrics.
 */
export async function fetchQQLyrics(
  song: SongResult,
  options: { chorusRanges?: ChorusRange[] } = {}
): Promise<any | null> {
  if (!song.id || !song.qqMid) {
    throw new Error('Missing song ID or mid');
  }

  const artistsStr = song.artists?.map(a => a.name).join(', ') || '';
  
  const param = {
    albumName: toBase64(song.album?.name || ''),
    crypt: 1,
    ct: 19,
    cv: 2111,
    interval: Math.floor(song.durationMs / 1000),
    lrc_t: 0,
    qrc: 1,
    qrc_t: 0,
    roma: 1,
    roma_t: 0,
    singerName: toBase64(artistsStr),
    songID: Number(song.id),
    songName: toBase64(song.name),
    trans: 1,
    trans_t: 0,
    type: 0,
  };

  try {
    const data = await requestQQ("GetPlayLyricInfo", "music.musichallSong.PlayLyricInfo", param);
    const encryptedLyricHex = data?.lyric;
    const encryptedTransHex = data?.trans;
    const encryptedRomanizationHex = data?.roma;

    if (!encryptedLyricHex) {
      return null;
    }

    const decryptedLyric = await qrcDecrypt(encryptedLyricHex);
    const decryptedTrans = encryptedTransHex ? await qrcDecrypt(encryptedTransHex) : '';
    const decryptedRomanization = encryptedRomanizationHex ? await qrcDecrypt(encryptedRomanizationHex) : '';

    const isQrc = detectIsQrc(decryptedLyric);
    const format = isQrc ? 'qrc' : detectTimedLyricFormat(decryptedLyric);

    const parsed = parseLyricsByFormat(format, decryptedLyric, decryptedTrans, {}, decryptedRomanization);
    if (!parsed) {
      return null;
    }
    parsed.isWordByWord = isQrc;
    if (options.chorusRanges && options.chorusRanges.length > 0) {
      return applyChorusRangesByTime(parsed, options.chorusRanges);
    }
    return applyDetectedChorusEffects(parsed, decryptedLyric);
  } catch (error) {
    console.error('[QQMusic] Fetch lyrics failed:', error);
    return null;
  }
}
