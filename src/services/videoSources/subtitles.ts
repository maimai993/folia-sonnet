// src/services/videoSources/subtitles.ts
// 「歌词位置」在影视播放时用来挂字幕：搜全网字幕、下载、转成浏览器认的 WebVTT。
//
// 字幕源是 OpenSubtitles 的公开检索端点（rest.opensubtitles.org，不需要 API key）：
//   GET /search/query-<关键词>  →  JSON 数组，每条带 SubFileName / SubLanguageID / SubDownloadLink。
// 注意它只认英文名与拼音，中文剧名直接搜通常是 0 条（所以界面上把搜索词做成可改的）。
// 下载下来的是 .gz，要在渲染层用 DecompressionStream('gzip') 解，再转 VTT。

import { desktopFetch } from './net';
import { fetchVideoText } from './net';

export type SubtitleHit = {
    id: string;
    /** 字幕文件名，常见形如 Joy of Life S01E01.srt —— 集号就在里面。 */
    name: string;
    /** 语言代码，eng / chi / zht … */
    language: string;
    downloads: number;
    /** 下载地址（.gz）。 */
    url: string;
    /** 文件名里带的集号（1 起），没有就是 0。 */
    episode: number;
};

const SEARCH_ENDPOINT = 'https://rest.opensubtitles.org/search/query-';

/** 从字幕文件名里抠集号：S01E03 / E03 / 第03集 都认。 */
const episodeOf = (name: string): number => {
    const se = name.match(/S\d{1,2}E(\d{1,3})/i);
    if (se) return Number(se[1]);
    const e = name.match(/[.\s_-]E(\d{1,3})/i);
    if (e) return Number(e[1]);
    const cn = name.match(/第\s*(\d{1,3})\s*集/);
    if (cn) return Number(cn[1]);
    return 0;
};

/** 搜字幕。返回命中的条目（最多 60 条）与一句提示。 */
export const searchSubtitles = async (keyword: string): Promise<{ hits: SubtitleHit[]; note: string }> => {
    const word = keyword.trim();
    if (!word) return { hits: [], note: '先填一个搜索词。' };
    let response;
    try {
        response = await fetchVideoText(SEARCH_ENDPOINT + encodeURIComponent(word));
    } catch (error) {
        return { hits: [], note: `连不上字幕站：${error instanceof Error ? error.message : String(error)}` };
    }
    if (!response.ok) return { hits: [], note: `字幕站返回 HTTP ${response.status}` };
    let data: unknown;
    try {
        data = JSON.parse(response.bodyText);
    } catch {
        return { hits: [], note: '字幕站返回的不是可解析的 JSON（可能是被拦了）。' };
    }
    if (!Array.isArray(data)) return { hits: [], note: '' };
    const hits: SubtitleHit[] = (data as Array<Record<string, unknown>>)
        .map((item, at) => {
            const name = String(item.SubFileName ?? '');
            return {
                id: String(item.IDSubtitleFile ?? at),
                name,
                language: String(item.SubLanguageID ?? ''),
                downloads: Number(item.SubDownloadsCnt ?? 0),
                url: String(item.SubDownloadLink ?? ''),
                episode: episodeOf(name),
            };
        })
        .filter(hit => hit.url && hit.name);
    return {
        hits: hits.slice(0, 60),
        note: hits.length === 0 ? '这个搜索词没有结果。中文剧名通常搜不到，换成英文名或拼音试试（庆余年 → qing yu nian / Joy of Life）。' : '',
    };
};

/** SRT → WebVTT：逗号小数改成点，抬头补 WEBVTT，去掉 BOM。 */
export const srtToVtt = (raw: string): string => {
    const body = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const timed = body.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    if (/^WEBVTT/.test(timed)) return timed;
    return `WEBVTT\n\n${timed}`;
};

/** 字幕站的下载票据只认这个 UA，带错了会被 301 走。 */
const SUB_UA = { 'User-Agent': 'TemporaryUserAgent' };

/**
 * 经主进程那条字节通道取数据，并且自己跟 3xx：
 * `folia-lx://stream` 是把上游响应原样透传的，不替我们跟随跳转，而字幕下载地址恰恰会 301。
 * 顺带把 UA 带上——字幕站按 UA 决定给文件还是给跳转页。
 */
const fetchBytesFollow = async (url: string): Promise<Blob> => {
    const desktop = desktopFetch();
    let target = url;
    for (let hop = 0; hop < 4; hop += 1) {
        const proxied = desktop
            // eslint-disable-next-line no-restricted-syntax -- 这个自定义协议的地址只能由这里拼
            ? `folia-lx://stream?url=${encodeURIComponent(target)}&headers=${encodeURIComponent(btoa(JSON.stringify(SUB_UA)))}`
            : target;
        const response = await fetch(proxied);
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) throw new Error(`HTTP ${response.status}`);
            target = new URL(location, target).toString();
            continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.blob();
    }
    throw new Error('字幕地址跳转太多次，放弃了');
};

/** 下载并转成 VTT 文本。.gz 先解压。 */
export const loadSubtitleVtt = async (url: string): Promise<string> => {
    const blob = await fetchBytesFollow(url);
    let text: string;
    const gzipped = /\.gz($|\?)/i.test(url) || (blob.type || '').includes('gzip');
    if (gzipped && typeof DecompressionStream !== 'undefined') {
        const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
        text = await new Response(stream).text();
    } else {
        text = await blob.text();
    }
    return srtToVtt(text);
};

/** 语言代码给一个人看的名字。 */
export const languageName = (code: string): string => {
    const table: Record<string, string> = {
        chi: '中文', zht: '繁体中文', eng: '英文', jpn: '日文', kor: '韩文',
        fre: '法文', ger: '德文', spa: '西班牙文', rus: '俄文', ita: '意大利文',
    };
    return table[code] || code || '未知';
};
