// src/utils/lyrics/providers/qqLyricProvider.ts

/**
 * QQ Music lyrics provider module.
 * Provides search and download/decryption capabilities for QQ Music lyrics.
 */

import { SongResult } from '../../../types';
import { parseLyricsByFormat } from '../parserCore';
import { detectTimedLyricFormat } from '../formatDetection';
import { qrcDecrypt } from './qrcDecrypt';
import { applyDetectedChorusEffects, applyNeteaseChorusByTime } from '../chorusEffects';
import type { NeteaseChorusRange } from '../chorusEffects';
import { resolveProxiedUrl } from '../../../services/proxiedUrl';
import { resolveFoliaApiUrl } from '../../../services/webApi';
import { getOriginalCoverUrl } from '../../coverUrl';

const isElectron = typeof window !== 'undefined' && (window as any).electron;

/**
 * Sends a POST request to u.y.qq.com via proxy or directly in Electron.
 */
async function requestQQ(method: string, module: string, param: any): Promise<any> {
  const payload = buildQQPayload(method, module, param);
  const targetUrl = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
  const directUrl = isElectron ? targetUrl : resolveProxiedUrl(targetUrl);
  const data = await postQQ(directUrl, payload);
  const code = data.code ?? data.request?.code;
  if (code === 0) {
    return data.request.data;
  }
  /*
   * 带本地登录态（Android 上走桥、cookie 罐里是扫码登录得到的那些）被判失效时，
   * QQ 会回一个非零 code（常见就是 2001）；而匿名请求往往照样拿得到歌词 ——
   * 这个接口本身就是匿名可用的（comm 里 uid/udid 都是 0，Cookie 也只是 tmeLoginType=-1）。
   * 所以失败时退回一次服务端代理（不带本机 cookie），别一上来就把歌词判死。
   */
  const proxyUrl = isElectron ? '' : resolveFoliaApiUrl(`lyric-proxy?url=${encodeURIComponent(targetUrl)}`);
  if (proxyUrl && proxyUrl !== directUrl) {
    try {
      const retryData = await postQQ(proxyUrl, payload);
      if ((retryData.code ?? retryData.request?.code) === 0) {
        return retryData.request.data;
      }
    } catch {
      // 代理也拿不到就按原来的错误抛，别把重试的异常盖上去。
    }
  }
  throw new Error(`QQ Music API error: code ${code}`);
}

function buildQQPayload(method: string, module: string, param: any) {
  const payload = {
    comm: {
      ct: 11,
      cv: "1003006",
      v: "1003006",
      os_ver: "15",
      phonetype: "24122RKC7C",
      rom: "Redmi/miro/miro:15/AE3A.240806.005/OS2.0.102.0.VOMCNXM:user/release-keys",
      tmeAppID: "qqmusiclight",
      nettype: "NETWORK_WIFI",
      udid: "0",
      uid: "0",
    },
    request: {
      method,
      module,
      param,
    },
  };
  return payload;
}

async function postQQ(url: string, payload: any): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: isElectron ? 'omit' : 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': 'tmeLoginType=-1;',
      'User-Agent': 'okhttp/3.14.9',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`QQ Music API request failed: ${response.status}`);
  }

  return response.json();
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
 * Searches songs on QQ Music.
 */
export async function searchQQLyrics(keyword: string, page = 1, pageSize = 20): Promise<SongResult[]> {
  const safeKeyword = keyword.trim();
  if (!safeKeyword) return [];

  const pagesize = pageSize;
  const param = {
    search_id: String(
      Math.floor(
        Math.random() * 100000000000000 + Date.now() % 86400000
      )
    ),
    remoteplace: "search.android.keyboard",
    query: safeKeyword.length > 60 ? safeKeyword.slice(0, 60) : safeKeyword,
    search_type: 0, // 0 = SONG
    num_per_page: pagesize,
    page_num: page,
    highlight: 0,
    nqc_flag: 0,
    page_id: 1,
    grp: 1,
  };

  try {
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
  options: { chorusRanges?: NeteaseChorusRange[] } = {}
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
      return applyNeteaseChorusByTime(parsed, options.chorusRanges);
    }
    return applyDetectedChorusEffects(parsed, decryptedLyric);
  } catch (error) {
    console.error('[QQMusic] Fetch lyrics failed:', error);
    return null;
  }
}
